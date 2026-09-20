"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  BlockingExtensionUiRequest,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  UserMessage,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { normalizeToolCalls } from "@/lib/normalize";
import { isPromptRejectedError, sendAgentCommand } from "@/lib/agent-client";
import { clearDraft, rekeyDraft, restoreDraftSubmission } from "@/lib/draft-store";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import { getImageGenPreferences } from "@/lib/image-gen-preferences";
import type { ImageComposerOptions } from "@/lib/image-gen-shared";
import { getPresetFromToolNames, getToolNamesForPreset, type ToolEntry, type ToolPreset } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { mergeSessionStats, type SessionFileStats } from "@/lib/session-stats";
import { mergeTailSnapshot, tailAnchorIndex } from "@/lib/session-reload";
import { userMessageKey } from "@/lib/prompt-recovery";
import { claimSessionFolderDraft, promoteSessionFolderDraft } from "@/lib/session-folder-drafts";
import { AgentEventConnection } from "@/lib/agent-event-connection";
import { getToolExecutionProgress } from "@/lib/tool-execution-progress";
import {
  CHAT_SCROLL_REATTACH_TOLERANCE,
  CHAT_SCROLL_TAIL_TOLERANCE,
  getLiveFollowAttached,
  loadChatAnchorMode,
  persistChatAnchorMode,
  type ChatStreamAnchorMode,
} from "@/lib/chat-lazy-load";
import {
  INITIAL_STREAMING_STATE,
  streamReducer,
  type ClientAssistantMessageEvent,
} from "@/lib/streaming-message";

export interface SessionData {
  sessionId: string;
  filePath: string;
  totalActiveMs: number;
  tree: SessionTreeNode[];
  leafId: string | null;
  toolNames?: string[];
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    oldestEntryId: string | null;
    hasMore: boolean;
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  /** Cumulative usage over ALL session-file entries (incl. compacted history). */
  stats?: SessionFileStats;
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  model?: { provider: string; id: string };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isGeneratingImage?: boolean;
  isCompacting?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; progress?: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  /** Registers an action that lazily starts the session and loads its prompt and tools. */
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: ToolPreset) => void;
  deferInitialScroll?: boolean;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_READY_TIMEOUT_MS = 60_000;
const EVENT_STREAM_RECONNECT_DELAY_MS = 1_000;
// Retry temporary model-list failures without requiring a page refresh.
const MODELS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  replaceMessage: (message: UserMessage) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: Array<{ data: string; mimeType: string }>, targetDraftKey?: string) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  imageModelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [entryIds, setEntryIds] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(false);
  const [streamState, dispatch] = useReducer(streamReducer, INITIAL_STREAMING_STATE);
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [imageModelList, setImageModelList] = useState<ModelEntry[]>([]);
  const [imageModel, setImageModel] = useState<SelectedModel | null>(() => getImageGenPreferences().model);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const imageGeneratingRef = useRef(false);
  const imageRequestPendingRef = useRef(false);
  const imageRunIdRef = useRef(0);
  // Local POST ownership is independent of SSE reconciliation run increments.
  const imageSubmissionIdRef = useRef(0);
  const imageModelRef = useRef<SelectedModel | null>(imageModel);
  imageModelRef.current = imageModel;
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>("auto");
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  // Fork mutates the backend wrapper: reject concurrent rows synchronously,
  // and retain admission until the POST settles even if this page is left.
  const forkRequestRef = useRef<{ sid: string } | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [liveModel, setLiveModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [promptAnchorActive, setPromptAnchorActive] = useState(false);
  const [chatAnchorMode, setChatAnchorModeState] = useState<ChatStreamAnchorMode>("tail");
  const chatAnchorModeRef = useRef<ChatStreamAnchorMode>("tail");
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });

  const eventConnectionRef = useRef<AgentEventConnection | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const sessionPropIdRef = useRef<string | null>(session?.id ?? null);
  const sessionRunningRef = useRef(Boolean(sessionRunning));
  const agentRunningRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  // Recovery polling has its own epoch; it must not revoke a live submission.
  const bashSubmissionIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(Boolean(opts.deferInitialScroll));
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const liveFollowFrameRef = useRef<number | null>(null);
  // Set when the user has scrolled up during a live-follow stream; any pending
  // auto-scroll frame must respect this instead of reading the stale
  // isNearBottomRef snapshot taken when the frame was scheduled.
  const userScrolledUpRef = useRef(false);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<Exclude<ThinkingLevelOption, "auto"> | null>(null);
  const promptRunIdRef = useRef(0);
  // Owned by the logical run, not the POST promise (which can settle much later).
  const promptRequestRef = useRef<{ sid: string; runId: number; token: string } | null>(null);
  // Stop can cancel local startup before a session ID or prompt RPC exists.
  const cancelPendingPromptRef = useRef<(() => void) | null>(null);
  // Dispatch is not admission: GET can still see idle while the POST is in transit.
  // Run-scoped so a late HTTP response cannot release a newer submission's guard.
  const promptAdmissionPendingRunRef = useRef<number | null>(null);
  const cancelPendingBashRef = useRef<(() => void) | null>(null);
  const cancelPendingImageRef = useRef<(() => void) | null>(null);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  // The optimistic message object itself, so a background reload that does not
  // yet contain the pending submission can re-append it (the key ref alone
  // cannot restore the bubble).
  const optimisticUserMessageRef = useRef<AgentMessage | null>(null);
  // Monotonic ticket shared by loadSession/loadContext: the reload that started
  // last wins; a slower earlier response is discarded once it resolves.
  const reloadSeqRef = useRef(0);
  // A branch transaction includes both the backend mutation and its context.
  // Keep a rejected selection fail-closed until a successful explicit reselection.
  const branchSelectionSeqRef = useRef(0);
  const branchNavigationRef = useRef<Promise<void> | null>(null);
  // Only mutations queue behind one another; obsolete context reads may hang.
  const branchMutationRef = useRef<Promise<void> | null>(null);
  const branchNavigationFailedRef = useRef(false);
  // Render-visible gate: pending and failed selections must not page old history.
  // Releasing it after success re-arms pagination even when the cursor is unchanged.
  const [branchNavigationBlocked, setBranchNavigationBlocked] = useState(false);
  // Mirrors of the pagination states, readable synchronously while merging a
  // reloaded tail snapshot inside a setMessages functional update.
  const entryIdsRef = useRef<string[]>([]);
  const historyCursorRef = useRef<string | null>(null);
  const hasEarlierMessagesRef = useRef(false);
  const modelSwitchPendingRef = useRef(false);
  const draftKeyAliasesRef = useRef(new Map<string, string>());
  const sessionHookMountedRef = useRef(true);

  // Builtins must not deliver deferred UI effects into a later page lifetime,
  // including a switch away and back to the same session or a StrictMode remount.
  const builtinCommandLifetimeRef = useRef(0);
  useLayoutEffect(() => {
    builtinCommandLifetimeRef.current += 1;
    return () => { builtinCommandLifetimeRef.current += 1; };
  }, [session?.id, newSessionCwd, newSessionDraftKey]);

  sessionPropIdRef.current = session?.id ?? null;
  sessionRunningRef.current = Boolean(sessionRunning);

  if (!eventConnectionRef.current) {
    eventConnectionRef.current = new AgentEventConnection({
      createSource: (sid) => new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`),
      onEvent: (event) => handleAgentEventRef.current?.(event as AgentEvent),
      shouldMaintain: (sid) => (
        sessionHookMountedRef.current
        && sessionIdRef.current === sid
        && (
          agentRunningRef.current
          || imageGeneratingRef.current
          || eventStreamGraceActiveRef.current
          || (sessionPropIdRef.current === sid && sessionRunningRef.current)
        )
      ),
      readinessTimeoutMs: EVENT_STREAM_READY_TIMEOUT_MS,
      reconnectDelayMs: EVENT_STREAM_RECONNECT_DELAY_MS,
      onUnexpectedError: (error) => {
        console.error("Failed to maintain the agent event stream:", error);
      },
    });
  }

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;
  const existingSessionId = session?.id;

  useLayoutEffect(() => {
    if (!existingSessionId && (!isNew || sessionIdRef.current)) return;
    setToolPresetState(getPreferredToolPreset());
  }, [existingSessionId, isNew, setToolPresetState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // Scroll the chat container itself instead of scrolling a sentinel element
    // into view: that propagates to every scrollable ancestor, and on mobile
    // the keyboard-shifted document layer visibly jumps the whole app while
    // streaming content follows the tail.
    container.scrollTo({ top: container.scrollHeight, behavior });
    previousScrollTopRef.current = container.scrollTop;
  }, []);

  // Load the persisted anchor mode once on the client (localStorage is not
  // available during SSR; the default "tail" renders identically).
  useEffect(() => {
    const mode = loadChatAnchorMode();
    chatAnchorModeRef.current = mode;
    setChatAnchorModeState(mode);
  }, []);

  const setChatAnchorMode = useCallback((mode: ChatStreamAnchorMode) => {
    chatAnchorModeRef.current = mode;
    setChatAnchorModeState(mode);
    persistChatAnchorMode(mode);
  }, []);

  const currentModel = currentModelOverride ?? liveModel ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;
  const composerDraftKey = session?.id ?? newSessionDraftKey ?? undefined;

  const syncLiveModel = useCallback((state?: AgentStateResponse) => {
    setLiveModel(state?.model
      ? { provider: state.model.provider, modelId: state.model.id }
      : null);
  }, []);

  const resolveComposerDraftKey = useCallback((key: string | undefined) => {
    if (!key) return undefined;
    let resolved = key;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const next = draftKeyAliasesRef.current.get(resolved);
      if (!next) break;
      resolved = next;
    }
    return resolved;
  }, []);

  const restoreSubmission = useCallback((
    text: string,
    images: AttachedImage[] | undefined,
    targetDraftKey: string | undefined,
  ) => {
    const draftImages = images?.map(({ data, mimeType }) => ({ data, mimeType }));
    const destinationDraftKey = resolveComposerDraftKey(targetDraftKey);
    if (
      !sessionHookMountedRef.current
      && !newSessionPromotedRef.current
      && targetDraftKey === newSessionDraftKey
    ) return;
    const input = opts.chatInputRef?.current;
    if (input) {
      input.restoreSubmission(text, draftImages, destinationDraftKey);
    } else if (destinationDraftKey) {
      restoreDraftSubmission(destinationDraftKey, text, draftImages);
    }
  }, [newSessionDraftKey, opts.chatInputRef, resolveComposerDraftKey]);

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) {
      return {
        ...sessionStatsOverride,
        totalActiveMs: data?.totalActiveMs,
        ...(contextUsage ? { contextUsage } : {}),
      };
    }
    const fileStats = data?.stats;
    const stats = mergeSessionStats(fileStats, data?.context.messages ?? [], messages);
    if (stats.tokens.total === 0 && messages.length === 0 && !fileStats) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      ...stats,
      totalActiveMs: data?.totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.context.messages, data?.filePath, data?.totalActiveMs, data?.stats, session?.id, session?.name]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false) => {
    let messagesLoaded = false;
    // Reload timing barrier shared with loadContext. Many paths call loadSession
    // concurrently (agent_end, prompt_done, agent_settled, compaction_end, slash
    // commands, model switches); a slower earlier response must not overwrite a
    // newer snapshot with stale messages.
    const seq = ++reloadSeqRef.current;
    try {
      if (showLoading) setLoading(true);
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
      if (res.status === 404) {
        if (showLoading) {
          setData(null);
          setActiveLeafId(null);
          setMessages([]);
          setEntryIds([]);
          setHistoryCursor(null);
          setHasEarlierMessages(false);
          entryIdsRef.current = [];
          historyCursorRef.current = null;
          hasEarlierMessagesRef.current = false;
          setError(null);
        }
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as SessionData;
      if (sessionIdRef.current !== sid || reloadSeqRef.current !== seq) return null;
      const persistedMessages = d.context.messages;
      setData(d);
      setActiveLeafId(d.leafId);
      // The server always answers with the most-recent `tail` window. Splice it
      // onto any earlier pages the user already paged in (a background reload
      // must not drop loaded history), and keep an optimistic user message
      // visible until its message_end consumes it.
      const prevEntryIds = entryIdsRef.current;
      const prevCursor = historyCursorRef.current;
      const prevHasMore = hasEarlierMessagesRef.current;
      const optimistic = optimisticUserMessageRef.current;
      const optimisticKey = optimisticUserMessageKeyRef.current;
      const incomingEntryIds = d.context.entryIds ?? [];
      const anchor = tailAnchorIndex(prevEntryIds, d.context.oldestEntryId);
      const retainedPrefix = anchor > 0;
      const nextEntryIds = retainedPrefix
        ? [...prevEntryIds.slice(0, anchor), ...incomingEntryIds]
        : incomingEntryIds;
      const nextCursor = retainedPrefix ? prevCursor : d.context.oldestEntryId;
      const nextHasMore = retainedPrefix ? (prevHasMore || d.context.hasMore) : d.context.hasMore;
      setMessages((prev) => {
        const merged = mergeTailSnapshot(prevEntryIds, prev, prevCursor, prevHasMore, {
          messages: persistedMessages,
          entryIds: incomingEntryIds,
          oldestEntryId: d.context.oldestEntryId,
          hasMore: d.context.hasMore,
        });
        // A just-sent optimistic message is not in the server snapshot yet
        // (delivery or persistence lag); re-append it so the reload cannot
        // wipe the pending submission. When the snapshot's last message is the
        // delivered copy, the key matches and no duplicate is added.
        if (optimistic && optimisticKey) {
          const last = merged.messages[merged.messages.length - 1];
          if (!last || last.role !== "user" || userMessageKey(last) !== optimisticKey) {
            return [...merged.messages, optimistic];
          }
        }
        return merged.messages;
      });
      setEntryIds(nextEntryIds);
      setHistoryCursor(nextCursor);
      setHasEarlierMessages(nextHasMore);
      entryIdsRef.current = nextEntryIds;
      historyCursorRef.current = nextCursor;
      hasEarlierMessagesRef.current = nextHasMore;
      setToolPresetState(d.toolNames !== undefined ? getPresetFromToolNames(d.toolNames) : "default");
      setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
      setError(null);
      if (d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setThinkingLevel(d.context.thinkingLevel as ThinkingLevelOption);
      }

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      if (!includeState) return null;

      try {
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid || reloadSeqRef.current !== seq) return null;

        const liveState = agentState.state;
        syncLiveModel(liveState);
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) setThinkingLevel((liveState.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, [setToolPresetState, syncLiveModel]);

  const loadContext = useCallback(async (sid: string, leafId: string | null, before?: string | null, options?: { tail?: number; signal?: AbortSignal }) => {
    // Paging the old displayed history must not supersede the selected branch's
    // context reload. Leave its cursor untouched so paging can retry afterwards.
    if (before && (branchNavigationRef.current || branchNavigationFailedRef.current)) return;
    // Shares the reload sequence with loadSession so the two act as one timing
    // barrier: a reload that started later discards this response when it
    // resolves late, and vice versa.
    const seq = ++reloadSeqRef.current;
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      // Page upward: ask the server for the `tail` ancestors preceding `before`,
      // then prepend them. Omitting `before` fetches the most-recent `tail`.
      if (before) params.set("before", before);
      if (options?.tail) params.set("tail", String(options.tail));
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url, { signal: options?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { context: SessionData["context"] };
      if (sessionIdRef.current !== sid || options?.signal?.aborted || !sessionHookMountedRef.current) return;
      if (reloadSeqRef.current !== seq) return;
      setHistoryCursor(d.context.oldestEntryId);
      setHasEarlierMessages(d.context.hasMore);
      historyCursorRef.current = d.context.oldestEntryId;
      hasEarlierMessagesRef.current = d.context.hasMore;
      setData((prev) => {
        if (!prev || prev.sessionId !== sid) return prev;
        const context = before ? {
          ...prev.context,
          messages: [...d.context.messages, ...prev.context.messages],
          entryIds: [...d.context.entryIds, ...prev.context.entryIds],
          oldestEntryId: d.context.oldestEntryId,
          hasMore: d.context.hasMore,
        } : d.context;
        return { ...prev, context };
      });
      if (before) {
        // Older page: prepend so scroll position stays anchored.
        setMessages((prev) => [...d.context.messages, ...prev]);
        setEntryIds((prev) => [...d.context.entryIds, ...prev]);
        entryIdsRef.current = [...d.context.entryIds ?? [], ...entryIdsRef.current];
      } else {
        setMessages(d.context.messages);
        setEntryIds(d.context.entryIds ?? []);
        entryIdsRef.current = d.context.entryIds ?? [];
      }
      return d.context;
    } catch (e) {
      if (!options?.signal?.aborted) console.error("Failed to load context:", e);
    }
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (!tools || !sessionHookMountedRef.current || sessionIdRef.current !== sid) return null;
      const { getPresetFromTools } = await import("@/lib/tool-presets");
      setToolPresetState(getPresetFromTools(tools));
      onSystemToolsChange?.(tools);
      return tools;
    } catch (e) {
      console.error("Failed to load tools:", e);
      return null;
    }
  }, [onSystemToolsChange, setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    const provisionalDraftKey = newSessionDraftKey;
    if (!provisionalDraftKey) return;
    if (provisionalDraftKey !== sid) {
      draftKeyAliasesRef.current.set(provisionalDraftKey, sid);
      const input = opts.chatInputRef?.current;
      if (input) input.rekeyDraft(provisionalDraftKey, sid);
      else rekeyDraft(provisionalDraftKey, sid);
    }
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      transient: true,
    }, provisionalDraftKey);
  }, [isNew, newSessionCwd, newSessionDraftKey, onSessionCreated, opts.chatInputRef]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const requestedModel = newSessionModelOverrideRef.current;
      const selectedModel = requestedModel && modelList.some(
        (model) => model.provider === requestedModel.provider && model.id === requestedModel.modelId,
      )
        ? requestedModel
        : null;
      // A model configuration change can leave an already-open composer with
      // an explicit selection that no longer exists. Do not send that stale
      // provider/model pair to session startup; let the server select the
      // current scoped default instead.
      if (requestedModel && !selectedModel) {
        newSessionModelOverrideRef.current = null;
        setNewSessionModel(null);
        setPendingModel(null);
      }
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
        }),
      });
      const result = await res.json().catch(() => ({})) as {
        error?: string;
        sessionId?: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
      };
      if (!res.ok) throw new Error(result.error ?? `HTTP ${res.status}`);
      if (!result.sessionId) throw new Error("Session creation returned no session ID");
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      // A real server session now exists (or is seconds away). Claim the
      // folder intent so composer navigation cannot discard it, and promote
      // immediately — the session must land in its folder even if the user
      // leaves before the first prompt finishes (or never sends one).
      if (newSessionDraftKey) {
        claimSessionFolderDraft(newSessionDraftKey);
        promoteSessionFolderDraft(newSessionDraftKey, realId);
      }
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.thinkingLevel);
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, toolPreset, newSessionDraftKey, modelList]);

  // Opening the System or Tools panel may initialize an otherwise dormant
  // session. This is deliberately a non-prompt command: it creates no message
  // or model run, but lets users inspect the exact prompt before sending one.
  const loadSystemInfo = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;

    const [state] = await Promise.all([
      sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" }),
      loadTools(sid),
    ]);
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid) return;
    syncLiveModel(state);
    setSystemPrompt(state.systemPrompt ?? "");
  }, [ensureNewSession, loadTools, syncLiveModel]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventConnectionRef.current?.close();
  }, []);

  const ensureEventsConnected = useCallback((sid: string) => (
    eventConnectionRef.current!.ensureConnected(sid)
  ), []);

  const maintainEventsConnected = useCallback((sid: string) => {
    eventConnectionRef.current!.maintain(sid);
  }, []);

  // A different browser can start this session after it was opened here.
  // The sidebar's lightweight running-state poll gives us a cheap signal to
  // attach to the existing SSE stream without adding another synchronization
  // protocol to the chat.
  useEffect(() => {
    if (!session?.id || !sessionRunning) return;
    maintainEventsConnected(session.id);
    return () => {
      if (
        sessionIdRef.current === session.id
        && !agentRunningRef.current
        && !eventStreamGraceActiveRef.current
        && (sessionPropIdRef.current !== session.id || !sessionRunningRef.current)
      ) {
        eventConnectionRef.current?.close();
      }
    };
  }, [maintainEventsConnected, session?.id, sessionRunning]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialog((current) => current?.id === request.id ? null : current);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (isBlockingExtensionUiRequest(request)) onAttentionNeeded?.(request);

    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, onAttentionNeeded, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    if (promptRequestRef.current?.runId === promptRunIdRef.current) promptRequestRef.current = null;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    dispatch({ type: "end" });
    return wasRunning;
  }, []);

  const notifyPromptStage = useCallback((runId: number) => {
    if (notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    onAgentEnd?.();
    return true;
  }, [onAgentEnd]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        syncLiveModel(state);
        const promptActive = Boolean(data.running && state && (state.isStreaming || state.isPromptRunning));
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isGeneratingImage) {
          imageGeneratingRef.current = true;
          setIsGeneratingImage(true);
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }

        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents, syncLiveModel]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (promptRunIdRef.current !== runId) return;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (promptRunIdRef.current !== runId) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      optimisticUserMessageRef.current = null;
      const wasRunning = settleUiStage();
      if (promptWasPending) {
        notifyPromptStage(runId);
      } else if (agentWasActive && wasRunning) {
        onAgentEnd?.();
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId = promptRunIdRef.current) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          if (!sessionHookMountedRef.current || sessionIdRef.current !== sid
            || (runId !== undefined && promptRunIdRef.current !== runId)) return;
          const state = data.state;
          syncLiveModel(state);
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream, syncLiveModel]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (!sessionHookMountedRef.current || bashRecoveryIdRef.current !== recoveryId
          || sessionIdRef.current !== sid) return;
        syncLiveModel(data.state);
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession, syncLiveModel]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    // Local startup (including SSE readiness) has not dispatched a prompt yet.
    // An idle server snapshot cannot settle it, even if dispatch starts while
    // this GET is in flight.
    if (!agentRunningRef.current || sessionIdRef.current !== sid || cancelPendingPromptRef.current) return;
    const runId = promptRunIdRef.current;
    const admissionWasPending = promptAdmissionPendingRunRef.current === runId;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (!sessionHookMountedRef.current || sessionIdRef.current !== sid
        || promptRunIdRef.current !== runId || cancelPendingPromptRef.current) return;
      const state = data.state;
      // A prompt-bearing busy snapshot proves admission, but compaction alone
      // may belong to unrelated work. Never let a pre-admission idle snapshot
      // settle this run, even if SSE/HTTP establishes admission during the GET.
      if (data.running && (state?.isStreaming || state?.isPromptRunning)) {
        if (promptAdmissionPendingRunRef.current === runId) promptAdmissionPendingRunRef.current = null;
      } else if (admissionWasPending || promptAdmissionPendingRunRef.current === runId) {
        return;
      }
      syncLiveModel(state);
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy) {
        sdkAgentActiveRef.current = Boolean(state.isStreaming);
        rpcPromptPendingRef.current = Boolean(state.isPromptRunning);
        return;
      }
      if (!agentRunningRef.current) return;
      if (state) {
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream, syncLiveModel]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  // Direct image requests have their own busy state, not SDK text streaming.
  // Polling also recovers a refresh or a missed terminal SSE event.
  useEffect(() => {
    if (!isGeneratingImage) return;
    const reconcile = async () => {
      const sid = sessionIdRef.current;
      const runId = imageRunIdRef.current;
      if (!sid || imageRequestPendingRef.current) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) return;
        const snapshot = await res.json() as { state?: AgentStateResponse };
        if (!sessionHookMountedRef.current || sessionIdRef.current !== sid || imageRunIdRef.current !== runId || imageRequestPendingRef.current) return;
        if (!snapshot.state?.isGeneratingImage) {
          imageGeneratingRef.current = false;
          setIsGeneratingImage(false);
          await loadSession(sid);
          scheduleEventStreamClose(sid);
        }
      } catch { /* Retry after connectivity returns. */ }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void reconcile(); };
    const timer = setInterval(() => void reconcile(), AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [isGeneratingImage, loadSession, scheduleEventStreamClose]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "connected": {
        // The server replays a message_start snapshot only while it still holds
        // a streamingMessage; reconnecting mid-run during a tool phase has no
        // snapshot to restore, so ending here would permanently drop the live
        // streaming bubble.
        if (event.isStreaming === true) {
          cancelEventStreamGrace();
          sdkAgentActiveRef.current = true;
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "waiting_model" });
        } else {
          dispatch({ type: "end" });
        }
        break;
      }
      case "image_generation_start":
        imageRunIdRef.current += 1;
        cancelEventStreamGrace();
        imageGeneratingRef.current = true;
        setIsGeneratingImage(true);
        break;
      case "image_generation_end": {
        const sid = sessionIdRef.current;
        // A local POST owns settlement until its response arrives; an older
        // terminal event must not unlock a newly submitted request.
        if (!imageRequestPendingRef.current) {
          imageGeneratingRef.current = false;
          setIsGeneratingImage(false);
          if (sid) scheduleEventStreamClose(sid);
        }
        if (sid) void loadSession(sid);
        break;
      }
      case "agent_start":
        promptAdmissionPendingRunRef.current = null;
        cancelEventStreamGrace();
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          const sid = sessionIdRef.current;
          const runId = promptRunIdRef.current;
          loadSession(sid);
          fetch(`/api/agent/${encodeURIComponent(sid)}`)
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (!sessionHookMountedRef.current || sessionIdRef.current !== sid
                || promptRunIdRef.current !== runId) return;
              syncLiveModel(d.state);
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages));
            })
            .catch(() => {});
        }
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive || rpcPromptPendingRef.current) break;

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning) onAgentEnd?.();
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          // The RPC request has settled even if an independent extension turn
          // remains active. Its completed token no longer owns that server run.
          if (promptRequestRef.current?.runId === runId) promptRequestRef.current = null;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          optimisticUserMessageRef.current = null;
          const firstNotification = notifyPromptStage(runId);
          if (!promptWasPending && !firstNotification) break;

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        if (event.type === "message_start") {
          const msg = event.message as AgentMessage | undefined;
          if (msg?.role === "user") break;
          if (msg?.role === "assistant") {
            dispatch({ type: "snapshot", message: msg });
            if (msg.content.length > 0) setAgentPhase(null);
            // A new assistant message means a retry attempt is actively
            // streaming its answer — pi only emits auto_retry_end(success)
            // when that answer completes, so clear the banner now instead of
            // showing "retrying" over the entire retried response.
            setRetryInfo(null);
          } else if (msg) {
            setAgentPhase(null);
          }
        } else {
          const delta = event.assistantMessageEvent as ClientAssistantMessageEvent | undefined;
          if (delta) {
            dispatch({ type: "delta", event: delta });
            if (delta.type !== "toolcall_start" && delta.type !== "toolcall_delta") {
              setAgentPhase(null);
            }
          }
        }
        // Live-follow the streaming output only when the user is already near
        // the bottom of the message list. If they scrolled up, leave them there.
        if (!pendingScrollToUserRef.current && isNearBottomRef.current && !userScrolledUpRef.current && liveFollowFrameRef.current === null) {
          // Defer the scroll so React has time to update the DOM with the new
          // streaming content; otherwise scrollIntoView may target stale layout.
          liveFollowFrameRef.current = requestAnimationFrame(() => {
            liveFollowFrameRef.current = null;
            // Re-check at frame time: the user may have scrolled up between
            // scheduling this frame and now — never yank them back down.
            if (isNearBottomRef.current && !userScrolledUpRef.current) scrollToBottom("auto");
          });
        }
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          optimisticUserMessageRef.current = null;
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        dispatch({ type: "end" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const progress = getToolExecutionProgress(event.partialResult);
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          const existing = tools.find((tool) => tool.id === id);
          const updated = {
            id,
            name: name || existing?.name || "tool",
            progress: progress ?? existing?.progress,
          };
          return {
            kind: "running_tools",
            tools: [...tools.filter((tool) => tool.id !== id), updated],
          };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
      case "extension_ui_closed":
        setExtensionDialog((current) => current?.id === event.id ? null : current);
        break;
    }
  }, [addNotice, cancelEventStreamGrace, handleExtensionUiRequest, loadSession, notifyPromptStage, onAgentEnd, scheduleEventStreamClose, scrollToBottom, settleUiStage, syncLiveModel]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (branchNavigationRef.current || branchNavigationFailedRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      addNotice({ type: "warning", message: "Wait for branch navigation to finish, or reselect the branch if navigation failed, before sending." });
      return;
    }
    if (agentRunningRef.current || bashRunningRef.current || imageGeneratingRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      return;
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) {
        restoreSubmission(message, images, composerDraftKey);
        return;
      }
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const promptRunId = promptRunIdRef.current + 1;
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    optimisticUserMessageRef.current = userMsg;
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    setPromptAnchorActive(chatAnchorModeRef.current === "prompt-anchor");
    userScrolledUpRef.current = false;

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;
    let cancelled = false;
    const isCurrentSubmission = () => !cancelled && sessionHookMountedRef.current
      && promptRunIdRef.current === promptRunId
      && (!session || sessionIdRef.current === session.id);
    let submissionRestored = false;
    const restoreUnacceptedSubmission = () => {
      if (submissionRestored) return;
      submissionRestored = true;
      // UI ownership can end before payload ownership: ChatInput already cleared
      // this submission. Recover existing-session drafts even after keyed unmount,
      // directly into their store so no stale input ref can touch the new session.
      if (!isCurrentSubmission() && session) {
        if (composerDraftKey) restoreDraftSubmission(composerDraftKey, message, images);
      } else {
        restoreSubmission(message, images, composerDraftKey);
      }
    };
    const cancelPendingPrompt = () => {
      if (promptRequestStarted || !isCurrentSubmission()) return;
      restoreUnacceptedSubmission();
      cancelled = true;
      cancelPendingPromptRef.current = null;
      // Invalidate outstanding reconciliation as well as this startup continuation.
      promptRunIdRef.current += 1;
      rpcPromptPendingRef.current = false;
      agentRunningRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      optimisticUserMessageRef.current = null;
      setMessages((prev) => prev.filter((item) => item !== userMsg));
      pendingScrollToUserRef.current = false;
      setPromptAnchorActive(false);
      closeEvents();
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    };
    cancelPendingPromptRef.current = cancelPendingPrompt;

    const preparePromptDispatch = (sid: string) => {
      // Slash commands can be handled by SDK built-ins/extensions rather than
      // starting a fresh user turn. Keep their existing uncorrelated semantics.
      const token = isSlashCommandPrompt ? undefined : `${Date.now()}:${crypto.randomUUID()}`;
      promptRequestRef.current = token ? { sid, runId: promptRunId, token } : null;
      cancelPendingPromptRef.current = null;
      promptRequestStarted = true;
      promptAdmissionPendingRunRef.current = promptRunId;
      return token ? { promptRequestId: token } : {};
    };

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        if (!isCurrentSubmission()) return;
        const sid = existingSid ?? await ensureNewSession();
        if (!isCurrentSubmission()) return;

        if (!sid) throw new Error("Unable to create a session for the prompt");
        sentSessionId = sid;
        if (selectedModel) {
          setPendingModel(selectedModel);
          if (existingSid) {
            await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
          }
        }
        if (!isCurrentSubmission()) return;
        await ensureEventsConnected(sid);
        if (!isCurrentSubmission()) return;
        const correlation = preparePromptDispatch(sid);
        await sendAgentCommand(sid, {
          type: "prompt",
          message,
          ...correlation,
          ...(piImages?.length ? { images: piImages } : {}),
        });
        promoteNewSession(1, message);
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        if (!isCurrentSubmission()) {
          restoreUnacceptedSubmission();
          return;
        }
        const correlation = preparePromptDispatch(session.id);
        await sendAgentCommand(session.id, {
          type: "prompt",
          message,
          ...correlation,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      } else {
        throw new Error("No active session for the prompt");
      }
      if (promptAdmissionPendingRunRef.current === promptRunId) promptAdmissionPendingRunRef.current = null;
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      // Rejection/lost response ends local admission uncertainty, not necessarily
      // the server run. Preserve the existing ambiguous-transport recovery path.
      if (promptAdmissionPendingRunRef.current === promptRunId) promptAdmissionPendingRunRef.current = null;
      const definitivelyRejected = !promptRequestStarted || isPromptRejectedError(e);
      // A stale UI must not hide an existing session's unaccepted payload. Stop
      // shares the once-only restoration guard; dispatched transport uncertainty
      // must never be restored because the server may already own the prompt.
      if (!isCurrentSubmission()) {
        if (definitivelyRejected && session) restoreUnacceptedSubmission();
        return;
      }
      if (cancelPendingPromptRef.current === cancelPendingPrompt) cancelPendingPromptRef.current = null;
      console.error("Failed to send message:", e);
      // A transport/proxy failure after dispatch is ambiguous: the server may
      // have accepted the prompt before the response was lost. Keep SSE alive
      // until server state confirms the run is idle.
      if (!definitivelyRejected && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      if (promptRequestRef.current?.runId === promptRunId) promptRequestRef.current = null;
      rpcPromptPendingRef.current = false;
      setMessages((prev) => {
        const optimisticIndex = prev.lastIndexOf(userMsg);
        return optimisticIndex === -1
          ? prev
          : [...prev.slice(0, optimisticIndex), ...prev.slice(optimisticIndex + 1)];
      });
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      restoreUnacceptedSubmission();
      optimisticUserMessageKeyRef.current = null;
      optimisticUserMessageRef.current = null;
      // Rejection only describes this submission. Another tab or an event we
      // missed may still have a real run active for the same session, so keep
      // its SSE connection until server state says the wrapper is idle.
      if (sentSessionId) {
        void reconcileAgentState(sentSessionId);
        return;
      }
      agentRunningRef.current = false;
      closeEvents();
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, composerDraftKey, reconcileAgentState, restoreSubmission]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current || imageGeneratingRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    bashRecoveryIdRef.current += 1;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    const submissionId = ++bashSubmissionIdRef.current;
    let ownedSessionId = sessionIdRef.current ?? session?.id ?? null;
    let requestStarted = false;
    let cancelled = false;
    let submissionRestored = false;
    const isCurrentSubmission = () => !cancelled && sessionHookMountedRef.current
      && bashSubmissionIdRef.current === submissionId
      && (ownedSessionId === null || sessionIdRef.current === ownedSessionId);
    const restoreUnacceptedSubmission = () => {
      if (submissionRestored) return;
      submissionRestored = true;
      if (isCurrentSubmission()) {
        restoreSubmission(inputText, undefined, composerDraftKey);
      } else if (session && composerDraftKey) {
        // Existing unsent drafts survive navigation; abandoned fresh drafts stay
        // owned by mount cleanup. Never write through a stale composer callback.
        restoreDraftSubmission(composerDraftKey, inputText);
      }
    };
    const cancelPendingBash = () => {
      if (!isCurrentSubmission() || cancelPendingBashRef.current !== cancelPendingBash) return;
      restoreUnacceptedSubmission();
      cancelled = true;
      cancelPendingBashRef.current = null;
      bashRecoveryIdRef.current += 1;
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    };
    cancelPendingBashRef.current = cancelPendingBash;
    try {
      const sid = ownedSessionId ?? await ensureNewSession();
      ownedSessionId ??= sid;
      if (!isCurrentSubmission()) {
        restoreUnacceptedSubmission();
        return;
      }
      if (!sid) throw new Error("Unable to create a session for the shell command");
      // From dispatch onward Stop must use the server's abort_bash path.
      cancelPendingBashRef.current = null;
      requestStarted = true;
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      if (!isCurrentSubmission()) return;
      await loadSession(sid);
      if (!isCurrentSubmission()) return;
      promoteNewSession(1, inputText);
    } catch (e) {
      if (!isCurrentSubmission()) {
        // A dispatched transport error is ambiguous: don't restore duplicate
        // shell work after navigation or a newer submission has taken over.
        if (!requestStarted) restoreUnacceptedSubmission();
        return;
      }
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      restoreSubmission(inputText, undefined, composerDraftKey);
    } finally {
      // Only this mounted session's current submission may release its UI.
      if (isCurrentSubmission()) {
        if (cancelPendingBashRef.current === cancelPendingBash) cancelPendingBashRef.current = null;
        bashRunningRef.current = false;
        setPendingBash(null);
        setBashRunning(false);
      }
    }
  }, [addNotice, composerDraftKey, ensureNewSession, loadSession, promoteNewSession, restoreSubmission, session]);
  executeBashRef.current = executeBash;

  /**
   * Direct composer-mode image generation. Sends one `image_generate` RPC and
   * reloads afterwards — the server appends the whole turn (user message,
   * generate_image toolCall, toolResult with images) through the SDK session
   * manager, so the reloaded history renders it like any agent-driven call.
   */
  const handleImageGenerate = useCallback(async (message: string, images: AttachedImage[], options: ImageComposerOptions) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images.length) return;
    if (branchNavigationRef.current || branchNavigationFailedRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      addNotice({ type: "warning", message: "Wait for branch navigation to finish, or reselect the branch if navigation failed, before sending." });
      return;
    }
    if (agentRunningRef.current || bashRunningRef.current || imageGeneratingRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      return;
    }
    const model = imageModelRef.current;
    if (!model) {
      addNotice({ type: "error", message: "No image model is configured. Store an OpenRouter API key in Models settings first." });
      restoreSubmission(message, images, composerDraftKey);
      return;
    }

    imageGeneratingRef.current = true;
    imageRequestPendingRef.current = true;
    imageRunIdRef.current += 1;
    cancelEventStreamGrace();
    setIsGeneratingImage(true);
    const piImages = images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    const submissionId = ++imageSubmissionIdRef.current;
    let ownedSessionId = sessionIdRef.current ?? session?.id ?? null;
    let requestStarted = false;
    let cancelled = false;
    let submissionRestored = false;
    const isCurrentSubmission = () => !cancelled && sessionHookMountedRef.current
      && imageSubmissionIdRef.current === submissionId
      && (ownedSessionId === null || sessionIdRef.current === ownedSessionId);
    const restoreUnacceptedSubmission = () => {
      if (submissionRestored) return;
      submissionRestored = true;
      if (!isCurrentSubmission()) {
        // Preserve an existing draft without touching another composer. Fresh
        // abandoned drafts remain owned by the mount cleanup, not this callback.
        if (session && composerDraftKey) restoreDraftSubmission(composerDraftKey, message, images);
      } else {
        restoreSubmission(message, images, composerDraftKey);
      }
    };
    const cancelPendingImage = () => {
      if (!isCurrentSubmission() || cancelPendingImageRef.current !== cancelPendingImage) return;
      restoreUnacceptedSubmission();
      cancelled = true;
      cancelPendingImageRef.current = null;
      // Invalidate outstanding image reconciliation before releasing the composer.
      imageRunIdRef.current += 1;
      imageRequestPendingRef.current = false;
      imageGeneratingRef.current = false;
      setIsGeneratingImage(false);
      closeEvents();
    };
    cancelPendingImageRef.current = cancelPendingImage;
    try {
      const sid = ownedSessionId ?? await ensureNewSession();
      ownedSessionId ??= sid;
      if (!isCurrentSubmission()) {
        restoreUnacceptedSubmission();
        return;
      }
      if (!sid) throw new Error("Unable to create a session for image generation");
      await ensureEventsConnected(sid);
      if (!isCurrentSubmission()) {
        restoreUnacceptedSubmission();
        return;
      }
      // From dispatch onward Stop must abort the server-owned image request.
      cancelPendingImageRef.current = null;
      requestStarted = true;
      const result = await sendAgentCommand<{ ok?: boolean; stopReason?: string; errorMessage?: string }>(sid, {
        type: "image_generate",
        prompt: trimmedMessage,
        imageModel: { provider: model.provider, modelId: model.modelId },
        ...(piImages.length ? { images: piImages } : {}),
        ...(options.aspectRatio ? { aspectRatio: options.aspectRatio } : {}),
        ...(options.count ? { count: options.count } : {}),
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
      });
      if (!isCurrentSubmission()) return;
      if (result?.stopReason === "aborted") {
        restoreSubmission(message, images, composerDraftKey);
        return;
      }
      if (result?.ok === false && result.errorMessage) {
        addNotice({ type: "error", message: result.errorMessage });
      }
      await loadSession(sid, false);
      if (!isCurrentSubmission()) return;
      promoteNewSession(1, trimmedMessage);
    } catch (e) {
      if (!isCurrentSubmission()) {
        // A dispatched transport failure is ambiguous; never revive stale paid
        // work as a draft. Keep the active callback's existing retry behavior.
        if (!requestStarted) restoreUnacceptedSubmission();
        return;
      }
      console.error("Failed to generate image:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      restoreSubmission(message, images, composerDraftKey);
    } finally {
      // Only this mounted session's local submission may release its flags/SSE.
      if (isCurrentSubmission()) {
        if (cancelPendingImageRef.current === cancelPendingImage) cancelPendingImageRef.current = null;
        imageRequestPendingRef.current = false;
        imageGeneratingRef.current = false;
        setIsGeneratingImage(false);
        const sid = sessionIdRef.current;
        if (sid) scheduleEventStreamClose(sid);
      }
    }
  }, [addNotice, cancelEventStreamGrace, closeEvents, composerDraftKey, ensureEventsConnected, ensureNewSession, loadSession, promoteNewSession, restoreSubmission, scheduleEventStreamClose, session]);

  const handleImageModelChange = useCallback((provider: string, modelId: string) => {
    setImageModel({ provider, modelId });
  }, []);

  const handleAbort = useCallback(async () => {
    if (cancelPendingPromptRef.current) {
      cancelPendingPromptRef.current();
      return;
    }
    if (cancelPendingBashRef.current) {
      cancelPendingBashRef.current();
      return;
    }
    if (cancelPendingImageRef.current) {
      cancelPendingImageRef.current();
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
        if (sessionHookMountedRef.current && sessionIdRef.current === sid) {
          addNotice({ type: "error", message: `Unable to stop shell command: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      return;
    }
    try {
      const request = imageGeneratingRef.current ? null : promptRequestRef.current;
      const token = request?.sid === sid
        && request.runId === promptRunIdRef.current ? request.token : undefined;
      // A remotely observed/legacy run has no locally owned token: retain the
      // global abort fallback. Do not clear ownership until actual settlement.
      await sendAgentCommand(sid, { type: "abort", ...(token ? { promptRequestId: token } : {}) });
    } catch (e) {
      console.error("Failed to abort:", e);
      if (sessionHookMountedRef.current && sessionIdRef.current === sid) {
        addNotice({ type: "error", message: `Unable to stop: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }, [addNotice]);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current || imageGeneratingRef.current || forkRequestRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid || !sessionHookMountedRef.current) return;
    const request = { sid };
    forkRequestRef.current = request;
    const isCurrentRequest = () => sessionHookMountedRef.current
      && sessionIdRef.current === sid && forkRequestRef.current === request;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (isCurrentRequest() && !cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      if (isCurrentRequest()) console.error("Fork failed:", e);
    } finally {
      if (isCurrentRequest()) setForkingEntryId(null);
      // Release our guard even when stale, but never a newer request's guard.
      if (forkRequestRef.current === request) forkRequestRef.current = null;
    }
  }, [onSessionForked]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (agentRunningRef.current || bashRunningRef.current || imageGeneratingRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid || !sessionHookMountedRef.current) return;
    const selection = ++branchSelectionSeqRef.current;
    setBranchNavigationBlocked(true);
    // Immediately invalidate an older context already in flight.
    reloadSeqRef.current += 1;
    setActiveLeafId(leafId);
    const isCurrentSelection = () => sessionHookMountedRef.current
      && sessionIdRef.current === sid && branchSelectionSeqRef.current === selection;
    const previous = branchMutationRef.current;
    const mutation = (async () => {
      // A sent mutation cannot be cancelled safely. Drain only its POST, never
      // its context GET, so a slow obsolete read cannot block newer selections.
      await previous;
      if (!isCurrentSelection()) return;
      // Null reads the current backend leaf rather than navigating to the root.
      // It still waits for older mutations before starting that read.
      if (leafId) {
        const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, { type: "navigate_tree", targetId: leafId });
        if (result?.cancelled) throw new Error("Branch navigation was cancelled. Select the branch again before sending.");
      }
    })();
    // Recover the queue independently of the selection's error handling.
    const drainedMutation = mutation.catch(() => {});
    branchMutationRef.current = drainedMutation;
    const navigation = (async () => {
      try {
        await mutation;
        if (!isCurrentSelection()) return;
        const context = await loadContext(sid, leafId);
        if (!isCurrentSelection()) return;
        if (!context) throw new Error("Unable to load the selected branch. Select the branch again before sending.");
        branchNavigationFailedRef.current = false;
      } catch (e) {
        if (!isCurrentSelection()) return;
        branchNavigationFailedRef.current = true;
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    branchNavigationRef.current = navigation;
    await navigation;
    if (branchNavigationRef.current === navigation) {
      branchNavigationRef.current = null;
      if (isCurrentSelection() && !branchNavigationFailedRef.current) {
        setBranchNavigationBlocked(false);
      }
    }
  }, [addNotice, loadContext]);

  const handleNavigate = useCallback(async (entryId: string) => {
    await handleLeafChange(entryId);
  }, [handleLeafChange]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      const selected = await sendAgentCommand<{ provider: string; id: string }>(sid, { type: "set_model", provider, modelId });
      setLiveModel({ provider: selected.provider, modelId: selected.id });
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      // A failed response can still follow a server-side write (for example, a
      // dropped connection), so let the session file settle the displayed model.
      await loadSession(sid, false, true);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, currentModelOverride, isNew, loadSession, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      // Compact reload must not unmount the chat scroller (showLoading=true
      // replaces it with a spinner), or the user's scroll position is lost.
      await loadSession(sid, false);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    let d: ModelsResponse;
    try {
      const res = await fetch(modelsUrl, signal ? { signal } : undefined);
      if (!res.ok) {
        let detail = "";
        try {
          const body: unknown = await res.json();
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
            detail = body.error;
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") throw e;
          // Non-JSON error responses fall back to the HTTP status.
        }
        throw new Error(detail || `Failed to load models (HTTP ${res.status})`);
      }
      d = await res.json() as ModelsResponse;
      signal?.throwIfAborted();
    } catch (e) {
      if (!signal?.aborted && !(e instanceof DOMException && e.name === "AbortError")) {
        setModelError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    const nextImageModelList = d.imageModelList ?? [];
    setImageModelList(nextImageModelList);
    setImageModel((current) => {
      if (current && nextImageModelList.some((m) => m.provider === current.provider && m.id === current.modelId)) {
        return current;
      }
      const fallback = nextImageModelList[0];
      return fallback ? { provider: fallback.provider, modelId: fallback.id } : null;
    });
    if (isNew && !sessionIdRef.current) {
      // The first listed model is not necessarily the runtime's automatic choice.
      const displayModel = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayModel && d.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "auto");
      }
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    // Unknown names belong to extension commands or prompt templates. Do not
    // initialize a session (or mutate any UI) merely to discover that here.
    if (!["compact", "reload", "name", "session", "copy", "clone"].includes(commandName)) {
      return { handled: false };
    }
    const args = rawArgs.trim();
    const lifetime = builtinCommandLifetimeRef.current;
    const initialPropId = sessionPropIdRef.current;
    let sid = sessionIdRef.current;
    let startedCompaction = false;
    const isCurrent = () => sessionHookMountedRef.current
      && builtinCommandLifetimeRef.current === lifetime
      && sessionPropIdRef.current === initialPropId
      && sessionIdRef.current === sid;
    const stale = (): BuiltinSlashCommandResult => ({ handled: true });
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!isCurrent()) return stale();
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      if (!isCurrent()) return stale();
      // Fresh startup assigns sessionIdRef itself; adopt only its returned id,
      // not an arbitrary ref value belonging to a newly selected page.
      if (!sid) sid = await ensureNewSession();
      if (!isCurrent()) return stale();
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          startedCompaction = true;
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          if (!isCurrent()) return stale();
          setCompactResult(readCompactResult(result, "manual"));
          // Keep showLoading=false so the compact reload leaves the scroller
          // mounted and the reading position survives.
          if (await loadSession(sid, false) && isCurrent()) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          if (!isCurrent()) return stale();
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (!isCurrent()) return stale();
          if (await loadSession(sid) && isCurrent()) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (!isCurrent()) return stale();
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          if (!isCurrent()) return stale();
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "clone": {
          if (!sid) return complete({ handled: true, error: "No active session to clone" });
          if (agentRunningRef.current || bashRunningRef.current) {
            return complete({ handled: true, error: "Cannot clone while the session is running" });
          }
          const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
            type: "clone",
            leafId: activeLeafId,
          });
          if (!isCurrent()) return stale();
          if (result?.cancelled || !result?.newSessionId) {
            return complete({ handled: true, error: "Cannot clone an empty or unsaved session" });
          }
          const completed = complete({ handled: true, message: "Cloned current session branch" });
          onSessionForked?.(result.newSessionId);
          return completed;
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (startedCompaction && isCurrent()) setIsCompacting(false);
    }
  }, [activeLeafId, addNotice, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionForked, onSessionStatsPanelOpen]);

  // Let AgentSession.prompt decide atomically whether to queue against the
  // current run or start a new turn if it settled while the request was in
  // flight. Direct steer/followUp calls can strand a message in an idle queue.
  const sendStreamingPrompt = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    const sid = sessionIdRef.current;
    const restore = () => restoreSubmission(message, images, composerDraftKey);
    if (!sid) {
      restore();
      addNotice({ type: "error", message: "No active session for the queued message" });
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to submit streaming prompt:", e);
      // A transport failure after dispatch is ambiguous: the server may have
      // accepted the queued prompt before the response was lost. Restoring in
      // that case would invite a duplicate turn.
      if (isPromptRejectedError(e)) restore();
      addNotice({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [addNotice, composerDraftKey, restoreSubmission]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[]) => {
    await sendStreamingPrompt(message, "steer", images);
  }, [sendStreamingPrompt]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
  ) => {
    await sendStreamingPrompt(message, behavior, images);
  }, [sendStreamingPrompt]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[]) => {
    await sendStreamingPrompt(message, "followUp", images);
  }, [sendStreamingPrompt]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const originDraftKey = composerDraftKey ?? sid;
    const lifetime = builtinCommandLifetimeRef.current;
    const isCurrent = () => sessionHookMountedRef.current
      && sessionIdRef.current === sid
      && builtinCommandLifetimeRef.current === lifetime;
    try {
      const result = await sendAgentCommand<{ steering?: string[]; followUp?: string[] }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      if (isCurrent()) setQueuedMessages({ steering: [], followUp: [] });
      const texts = [...(result?.steering ?? []), ...(result?.followUp ?? [])];
      if (texts.length > 0) {
        if (isCurrent()) {
          restoreSubmission(texts.join("\n\n"), undefined, originDraftKey);
        } else {
          // The server already removed these messages. Persist even after unmount,
          // without touching another session's live input or fresh-prompt cleanup.
          restoreDraftSubmission(resolveComposerDraftKey(originDraftKey) ?? sid, texts.join("\n\n"));
        }
      }
    } catch (e) {
      if (!isCurrent()) return;
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [addNotice, composerDraftKey, resolveComposerDraftKey, restoreSubmission]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level === "auto" ? null : level;
    }
    if (level === "auto") return; // "auto" leaves pi's current setting untouched
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
    } catch (e) {
      console.error("Failed to set thinking level:", e);
    }
  }, [isNew]);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    const toolNames = getToolNamesForPreset(preset);
    setPreferredToolPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ sessionId?: string; recreated?: boolean }>(sid, { type: "set_tools", toolNames });
      const activeSessionId = result?.sessionId ?? sid;
      if (activeSessionId !== sid) {
        cancelEventStreamGrace();
        closeEvents();
        sessionIdRef.current = activeSessionId;
      }
      setSlashCommands([]);
      setExtensionStatuses([]);
      setExtensionWidgets([]);
      const [state] = await Promise.all([
        sendAgentCommand<AgentStateResponse>(activeSessionId, { type: "get_state" }),
        loadTools(activeSessionId),
      ]);
      if (sessionHookMountedRef.current && sessionIdRef.current === activeSessionId) {
        setSystemPrompt(state.systemPrompt ?? "");
        syncLiveModel(state);
      }
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [cancelEventStreamGrace, closeEvents, loadTools, setToolPresetState, syncLiveModel]);

  const scrollToMessage = useCallback((element: HTMLElement, viewportOffset = 16) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    initialScrollDoneRef.current = true;
    pendingScrollToUserRef.current = false;
    isNearBottomRef.current = false;
    setPromptAnchorActive(false);
    container.scrollTo({
      top: element.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop
        - viewportOffset,
      behavior: "instant",
    });
    previousScrollTopRef.current = container.scrollTop;
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, elAbsTop - 16), maxScrollTop);

    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    isNearBottomRef.current = true;
    userScrolledUpRef.current = false;
    previousScrollTopRef.current = targetTop;
    container.scrollTo({ top: targetTop, behavior: "auto" });
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      const { scrollTop, clientHeight, scrollHeight } = container;
      const isAgentRunning = agentRunningRef.current;
      const wasAttached = isNearBottomRef.current;
      const isAttached = getLiveFollowAttached(
        wasAttached,
        previousScrollTopRef.current,
        scrollTop,
        clientHeight,
        scrollHeight,
        isAgentRunning
          ? CHAT_SCROLL_REATTACH_TOLERANCE
          : CHAT_SCROLL_TAIL_TOLERANCE,
      );
      // Track explicit upward user movement while the agent runs: a pending
      // live-follow frame scheduled before this scroll must not yank the
      // viewport back down after the user has deliberately scrolled up.
      if (isAgentRunning && scrollTop < previousScrollTopRef.current && !isAttached) {
        userScrolledUpRef.current = true;
      }
      isNearBottomRef.current = isAttached;
      previousScrollTopRef.current = scrollTop;
      if (!wasAttached && isAttached && isAgentRunning) {
        userScrolledUpRef.current = false;
        scrollToBottom("auto");
      } else if (!isAttached && liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
    }
  }, [scrollToBottom]);

  // Load session on mount
  useEffect(() => {
    sessionHookMountedRef.current = true;
    if (session) {
      sessionIdRef.current = session.id;
      loadSession(session.id, true, true).then((agentState) => {
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            sdkAgentActiveRef.current = Boolean(agentState.state.isStreaming);
            rpcPromptPendingRef.current = Boolean(agentState.state.isPromptRunning);
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void maintainEventsConnected(session.id);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
          if (agentState.state?.isGeneratingImage) {
            imageGeneratingRef.current = true;
            imageRunIdRef.current += 1;
            setIsGeneratingImage(true);
            cancelEventStreamGrace();
            void maintainEventsConnected(session.id);
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.thinkingLevel !== undefined) setThinkingLevel((agentState.state.thinkingLevel as ThinkingLevelOption) ?? "auto");
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(agentState.state.queuedMessages));
        }
      });
    }
    return () => {
      sessionHookMountedRef.current = false;
      const abandonedDraftKey = isNew ? newSessionDraftKey : null;
      if (abandonedDraftKey) {
        queueMicrotask(() => {
          if (!sessionHookMountedRef.current && !newSessionPromotedRef.current) {
            clearDraft(abandonedDraftKey);
          }
        });
      }
      if (liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
      bashRecoveryIdRef.current += 1;
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    onSystemInfoLoaderChange?.(loadSystemInfo);
    return () => onSystemInfoLoaderChange?.(null);
  }, [loadSystemInfo, onSystemInfoLoaderChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    previousScrollTopRef.current = container.scrollTop;
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange]);

  useEffect(() => {
    if (!agentRunning) setPromptAnchorActive(false);
  }, [agentRunning]);

  useLayoutEffect(() => {
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        if (chatAnchorModeRef.current === "prompt-anchor") {
          scrollUserMsgToTop();
        } else {
          // Tail mode: a new prompt keeps the viewport glued to the bottom,
          // where the reply will stream in.
          isNearBottomRef.current = true;
          userScrolledUpRef.current = false;
          scrollToBottom("auto");
        }
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && isNearBottomRef.current) {
        scrollToBottom("auto");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop]);

  // Load the model list with bounded retries; loadModels exposes each failure.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await loadModels(controller.signal);
          return;
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (attempt >= MODELS_RETRY_DELAYS_MS.length) return;
          await delay(MODELS_RETRY_DELAYS_MS[attempt]);
          if (controller.signal.aborted) return;
        }
      }
    })();
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  // Pause notice expiry while hovered or focused.
  // The remainingMs/startedAt/oldestId refs implement a true pause-and-resume instead of resetting the 5s timer.
  const [pausedNoticeId, setPausedNoticeId] = useState<string | null>(null);
  const noticeRemainingMsRef = useRef(NOTICE_VISIBLE_MS);
  const noticeTimerStartedAtRef = useRef<number | null>(null);
  const noticeOldestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (noticeState.visible.length === 0) {
      noticeOldestIdRef.current = null;
      return;
    }
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    // Oldest visible notice changed; restart the countdown
    if (noticeOldestIdRef.current !== oldest.id) {
      noticeOldestIdRef.current = oldest.id;
      noticeRemainingMsRef.current = NOTICE_VISIBLE_MS;
    }
    if (noticeState.visible.some((notice) => notice.id === pausedNoticeId)) return;
    noticeTimerStartedAtRef.current = Date.now();
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, noticeRemainingMsRef.current);
    return () => {
      clearTimeout(t);
      // Accrue the elapsed time so the countdown resumes from the remaining time
      if (noticeTimerStartedAtRef.current !== null) {
        noticeRemainingMsRef.current = Math.max(
          0,
          noticeRemainingMsRef.current - (Date.now() - noticeTimerStartedAtRef.current),
        );
        noticeTimerStartedAtRef.current = null;
      }
    };
  }, [noticeState.visible, pausedNoticeId]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, branchNavigationBlocked, messages, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    imageModelList, imageModel, handleImageModelChange, isGeneratingImage, handleImageGenerate,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices: noticeState.visible, extensionDialog, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    promptAnchorActive,
    chatAnchorMode,
    setChatAnchorMode,
    // Refs
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    setNoticePaused: setPausedNoticeId,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages, loadContext,
    scrollToBottom, scrollUserMsgToTop, scrollToMessage,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
