"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies } from "@/lib/session-family";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getProjectActivity, getRecentProjects, sessionsForProject } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { countSessionTreeNodes, groupSessionTrees, removeSessionOrganizationReferences } from "@/lib/session-tree-groups";
import { FOLDER_HIGHLIGHT_MS, registerAutoSessionFolderDraft, registerSessionFolderDraft, SESSION_ORGANIZATION_CHANGED_EVENT } from "@/lib/session-folder-drafts";
import { buildFolderTree, folderDescendantIds, folderSubtreeIds, removeFolderPromotingChildren, wouldCreateFolderCycle, type FolderNode } from "@/lib/session-folder-tree";
import { buildCurrentWorkSections, splitOlderSessionTrees, type SessionSidebarTimeSection } from "@/lib/session-sidebar-sections";
import {
  beginSessionOrganizationSync,
  createFolderId,
  EMPTY_SESSION_ORGANIZATION,
  fetchServerSessionOrganization,
  hasDirtySessionOrganization,
  loadSessionOrganization,
  markSessionOrganizationSynced,
  migrateLegacySessionOrganization,
  normalizeSessionOrganization,
  persistSessionOrganization,
  sessionMatchesQuery,
  SESSION_ORG_UNGROUPED,
  sessionOrgStorageKey,
  type SessionFolder,
  type SessionOrganization,
} from "@/lib/session-folders";
import { formatRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const RUNNING_SESSIONS_POLL_MS = 2500;

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 140;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    let frame: number | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
      setVisible(false);
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => setVisible(true));
      });
    } else {
      setVisible(false);
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      style={{
        ...style,
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.96)",
        transformOrigin: "top center",
        transition: `opacity ${DROPDOWN_ANIMATION_MS}ms ease, transform ${DROPDOWN_ANIMATION_MS}ms ease`,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}


interface SessionTreeNode {
  session: SessionInfo;
  children: SessionTreeNode[];
}

function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
  // Subagent sessions never render as sidebar rows (upstream semantics):
  // their state aggregates into the main session row instead. Filter them
  // before tree building so they cannot appear as children either.
  const visible = sessions.filter((s) => s.relation?.kind !== "subagent");
  const byId = new Map<string, SessionTreeNode>();
  for (const s of visible) {
    byId.set(s.id, { session: s, children: [] });
  }

  // Build a map of parentSessionId chains so we can resolve missing ancestors
  const parentOf = new Map<string, string>();
  for (const s of visible) {
    if (s.parentSessionId) parentOf.set(s.id, s.parentSessionId);
  }

  // Walk up the parentSessionId chain to find the nearest ancestor that exists in byId
  function resolveAncestor(id: string): string | null {
    let cur = parentOf.get(id);
    const visited = new Set<string>();
    while (cur) {
      if (visited.has(cur)) return null; // cycle guard
      visited.add(cur);
      if (byId.has(cur)) return cur;
      cur = parentOf.get(cur);
    }
    return null;
  }

  const roots: SessionTreeNode[] = [];
  for (const node of byId.values()) {
    const ancestor = resolveAncestor(node.session.id);
    if (ancestor) {
      byId.get(ancestor)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort each level by modified desc
  const sort = (nodes: SessionTreeNode[]) => {
    nodes.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    nodes.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*";

function useScramble(target: string, running: boolean): string {
  const [display, setDisplay] = useState(target);
  const frameRef = useRef<number | null>(null);
  const iterRef = useRef(0);

  useEffect(() => {
    if (!running) {
      setDisplay(target);
      return;
    }
    iterRef.current = 0;
    const totalFrames = target.length * 4;

    const step = () => {
      iterRef.current += 1;
      const progress = iterRef.current / totalFrames;
      const resolved = Math.floor(progress * target.length);

      setDisplay(
        target
          .split("")
          .map((char, i) => {
            if (char === " ") return " ";
            if (i < resolved) return char;
            return SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
          })
          .join("")
      );

      if (iterRef.current < totalFrames) {
        frameRef.current = requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    frameRef.current = requestAnimationFrame(step);
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current); };
  }, [target, running]);

  return display;
}

function PiWebTitle() {
  const [showVersion, setShowVersion] = useState(false);
  const [scrambling, setScrambling] = useState(false);
  const revertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const target = showVersion ? `${process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}p${process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0"}` : "Pi Web";
  const display = useScramble(target, scrambling);

  const triggerScramble = useCallback((toVersion: boolean) => {
    setShowVersion(toVersion);
    setScrambling(true);
    setTimeout(() => setScrambling(false), (toVersion ? 6 : 8) * 4 * (1000 / 60) + 100);
  }, []);

  const handleClick = useCallback(() => {
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);

    const next = !showVersion;
    triggerScramble(next);

    if (next) {
      revertTimerRef.current = setTimeout(() => triggerScramble(false), 3000);
    }
  }, [showVersion, triggerScramble]);

  useEffect(() => () => { if (revertTimerRef.current) clearTimeout(revertTimerRef.current); }, []);

  return (
    <button
      onClick={handleClick}
      style={{
        background: "none", border: "none", padding: 0, cursor: "default",
        fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em",
        color: showVersion ? "var(--accent)" : "var(--text)",
        fontFamily: "var(--font-mono)",
        minWidth: "6ch",
      }}
    >
      {display}
    </button>
  );
}

export function SessionSidebar({ selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  // Successful DELETEs disappear optimistically. Keep ids tombstoned across
  // stale in-flight list responses until the server confirms they are absent.
  const deletedSessionTombstonesRef = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [sessionRefreshDone, setSessionRefreshDone] = useState(false);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const sessionRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Session organization: search, pin, folders, bulk selection.
  const [sessionQuery, setSessionQuery] = useState("");
  const [sessionOrg, setSessionOrg] = useState<SessionOrganization>(EMPTY_SESSION_ORGANIZATION);
  const sessionOrgRef = useRef<SessionOrganization>(EMPTY_SESSION_ORGANIZATION);
  const replaceSessionOrg = useCallback((org: SessionOrganization) => {
    sessionOrgRef.current = org;
    setSessionOrg(org);
  }, []);
  // While the first server read for a project is in flight, user mutations are
  // replayed onto the returned server baseline. This prevents both lost edits
  // and stale-cache resurrection.
  const sessionOrgLoadingKeyRef = useRef<string | null>(null);
  const pendingSessionOrgMutationsRef = useRef<Array<(org: SessionOrganization) => SessionOrganization>>([]);
  const pendingExternalSessionOrgRef = useRef<SessionOrganization | null>(null);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(() => new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [folderMenuFor, setFolderMenuFor] = useState<string | null>(null);
  const [sessionView, setSessionViewState] = useState<"current" | "all">("current");
  useLayoutEffect(() => {
    try {
      if (window.localStorage.getItem("pi-web:session-sidebar-view") === "all") {
        setSessionViewState("all");
      }
    } catch { /* best effort */ }
  }, []);
  const [expandedOlderGroups, setExpandedOlderGroups] = useState<Set<string>>(() => new Set());
  // Folder rows that just received an auto-classified session; they flash
  // briefly (FOLDER_HIGHLIGHT_MS) so the silent assignment is noticeable.
  const [highlightedFolders, setHighlightedFolders] = useState<Set<string>>(() => new Set());
  const toggleOlderGroup = useCallback((groupId: string) => {
    setExpandedOlderGroups((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const setSessionView = useCallback((view: "current" | "all") => {
    setSessionViewState(view);
    try { window.localStorage.setItem("pi-web:session-sidebar-view", view); } catch { /* best effort */ }
  }, []);

  // (Organization effect + handlers live after `selectedProject` is defined —
  // they are scoped per workspace and need its key.)

  const exitBulkMode = useCallback(() => {
    setBulkMode(false);
    setBulkSelected(new Set());
    setBulkDeleting(false);
  }, []);

  const toggleBulkSelected = useCallback((sessionId: string) => {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      // Session ids are immutable and never reused, so tombstones live for the
      // sidebar lifetime. Releasing one after a confirming response would let
      // an older request that resolves later resurrect the deleted row.
      const visibleSessions = deletedSessionTombstonesRef.current.size === 0
        ? data.sessions
        : data.sessions.filter((session) => !deletedSessionTombstonesRef.current.has(session.id));
      setAllSessions(visibleSessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop unread markers for sessions that no longer exist (e.g. deleted)
      // and for subagents, whose completion is intentionally silent even if an
      // older client marked them unread.
      const unreadEligibleIds = new Set(
        visibleSessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
      if (!showLoading) {
        setSessionRefreshDone(true);
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => setSessionRefreshDone(false), 2000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);

  // Browser storage is unavailable during server rendering. Restore the panel
  // preference after hydration so a collapsed explorer stays collapsed on reload.
  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
  }, []);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          runningSessionIds?: string[];
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [validatedProject, worktreeState, allSessions, projectSelection]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
        // Session not found — notify parent so it can show the placeholder
        onInitialRestoreDone?.();
      }
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      saveLastCustomCwd(data.cwd);
      setCustomPathValue(data.cwd);
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo) => {
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s);
  }, [onSelectSession]);

  const createTemporarySessionId = () => (
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );

  const recentProjects = getRecentProjects(allSessions);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = projectFilter.trim()
    ? recentProjects.filter((project) => project.root.toLowerCase().includes(projectFilter.trim().toLowerCase()))
    : recentProjects;

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = projectFor(selectedCwd);

  // Session organization (pins/folders) is scoped per project key: switching
  // workspaces reloads that workspace's set instead of sharing one global one.
  // Bulk selection and any open folder menu belong to the previous workspace's
  // rows, so reset both alongside.
  useLayoutEffect(() => {
    // Legacy global-key data migrates into whichever project the user opens
    // first after this update, exactly once.
    const projectKey = selectedProject?.key;
    migrateLegacySessionOrganization(projectKey);
    const local = loadSessionOrganization(projectKey);
    // Snapshot before this request starts. Mutations made while GET is in
    // flight set dirty too, but are already represented by the replay queue
    // and must not also make the post-mutation cache become the baseline.
    const hadDirtyLocalBeforeSync = hasDirtySessionOrganization(projectKey);
    replaceSessionOrg(local);
    setFolderMenuFor(null);
    setBulkSelected(new Set());
    setBulkMode(false);
    // Folder-row and older-group UI state must not leak into another project
    // whose folders/groups can share the same ids.
    setExpandedOlderGroups(new Set());
    pendingSessionOrgMutationsRef.current = [];
    pendingExternalSessionOrgRef.current = null;

    if (!projectKey) {
      sessionOrgLoadingKeyRef.current = null;
      return;
    }
    // Block mirror PUTs until the server baseline arrives. Any user action in
    // this window is queued by updateSessionOrg and replayed below.
    beginSessionOrganizationSync(projectKey);
    sessionOrgLoadingKeyRef.current = projectKey;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const finishServerSync = async () => {
      const serverEntry = await fetchServerSessionOrganization(projectKey);
      if (cancelled || sessionOrgLoadingKeyRef.current !== projectKey) return;
      if (!serverEntry) {
        // Do not blindly PUT after a failed GET: the unseen server record may
        // be newer. Keep collecting local mutations and retry after recovery.
        retryTimer = setTimeout(() => { void finishServerSync(); }, 2_500);
        return;
      }
      // Existing server records (including deliberately empty ones) are
      // authoritative unless a previous local upload is still dirty.
      let resolved = serverEntry.exists && !hadDirtyLocalBeforeSync
        ? serverEntry.org
        : local;
      if (pendingExternalSessionOrgRef.current) {
        resolved = pendingExternalSessionOrgRef.current;
      }
      for (const mutate of pendingSessionOrgMutationsRef.current) {
        resolved = mutate(resolved);
      }
      pendingSessionOrgMutationsRef.current = [];
      pendingExternalSessionOrgRef.current = null;
      sessionOrgLoadingKeyRef.current = null;
      markSessionOrganizationSynced(projectKey);
      persistSessionOrganization(resolved, projectKey);
      replaceSessionOrg(resolved);
    };
    void finishServerSync();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (sessionOrgLoadingKeyRef.current === projectKey) {
        sessionOrgLoadingKeyRef.current = null;
        pendingSessionOrgMutationsRef.current = [];
        pendingExternalSessionOrgRef.current = null;
      }
    };
  }, [replaceSessionOrg, selectedProject?.key]);

  // Same-window draft promotion does not emit a native storage event. Adopt
  // the promoted real session id immediately so it appears in its folder as
  // soon as the first prompt creates the persisted session.
  useEffect(() => {
    const projectKey = selectedProject?.key;
    if (!projectKey) return;
    const onOrganizationChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ projectKey?: string; org?: unknown; highlightFolderId?: string | null }>).detail;
      if (detail?.projectKey !== projectKey) return;
      const incoming = normalizeSessionOrganization(detail.org);
      if (!incoming) return;
      // An initial server GET may still be in flight; hold the promoted org
      // so the sync completion replays it instead of overwriting with the
      // stale baseline (same rule as cross-tab storage events below).
      if (sessionOrgLoadingKeyRef.current === projectKey) {
        pendingExternalSessionOrgRef.current = incoming;
      }
      replaceSessionOrg(incoming);
      // Auto-classification landed a session in this folder — flash the row.
      if (detail.highlightFolderId) {
        const folderId = detail.highlightFolderId;
        setHighlightedFolders((prev) => new Set(prev).add(folderId));
        window.setTimeout(() => {
          setHighlightedFolders((prev) => {
            if (!prev.has(folderId)) return prev;
            const next = new Set(prev);
            next.delete(folderId);
            return next;
          });
        }, FOLDER_HIGHLIGHT_MS);
      }
    };
    window.addEventListener(SESSION_ORGANIZATION_CHANGED_EVENT, onOrganizationChanged);
    return () => window.removeEventListener(SESSION_ORGANIZATION_CHANGED_EVENT, onOrganizationChanged);
  }, [replaceSessionOrg, selectedProject?.key]);

  // Storage events fire only in other documents. Adopting them keeps two open
  // pi-web tabs from overwriting one another with stale in-memory state.
  useEffect(() => {
    const projectKey = selectedProject?.key;
    if (!projectKey) return;
    const storageKey = sessionOrgStorageKey(projectKey);
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      if (event.newValue === null) {
        if (sessionOrgLoadingKeyRef.current === projectKey) {
          pendingExternalSessionOrgRef.current = EMPTY_SESSION_ORGANIZATION;
        }
        replaceSessionOrg(EMPTY_SESSION_ORGANIZATION);
        return;
      }
      try {
        const incoming = normalizeSessionOrganization(JSON.parse(event.newValue));
        if (incoming) {
          if (sessionOrgLoadingKeyRef.current === projectKey) {
            pendingExternalSessionOrgRef.current = incoming;
          }
          replaceSessionOrg(incoming);
        }
      } catch {
        // Ignore malformed writes from extensions/old app versions.
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [replaceSessionOrg, selectedProject?.key]);

  const updateSessionOrg = useCallback((mutate: (org: SessionOrganization) => SessionOrganization) => {
    const projectKey = selectedProject?.key;
    if (projectKey && sessionOrgLoadingKeyRef.current === projectKey) {
      pendingSessionOrgMutationsRef.current.push(mutate);
    }
    const next = mutate(sessionOrgRef.current);
    persistSessionOrganization(next, projectKey);
    replaceSessionOrg(next);
  }, [replaceSessionOrg, selectedProject?.key]);

  const handleNewSessionInFolder = useCallback((folderId: string) => {
    if (!selectedCwd || !selectedProject?.key) return;
    const temporarySessionId = createTemporarySessionId();
    const draftKey = `new:${temporarySessionId}:${selectedCwd}`;
    // Register and persist before AppShell switches the active composer; that
    // state transition may synchronously re-render/unmount this sidebar path.
    registerSessionFolderDraft(draftKey, selectedProject.key, folderId, temporarySessionId);
    onNewSession?.(temporarySessionId, selectedCwd);
  }, [onNewSession, selectedCwd, selectedProject?.key]);

  const handleNewSession = useCallback(() => {
    if (!selectedCwd) return;
    const temporarySessionId = createTemporarySessionId();
    // Rule-based auto-classification (D): register the intent before AppShell
    // switches composers; the first folder whose cwd rule matches resolves at
    // promotion. No rule match leaves the session ungrouped.
    if (selectedProject?.key) {
      registerAutoSessionFolderDraft(
        `new:${temporarySessionId}:${selectedCwd}`,
        selectedProject.key,
        selectedCwd,
        temporarySessionId,
      );
    }
    // Pi is spawned lazily when the user sends the first message.
    onNewSession?.(temporarySessionId, selectedCwd);
  }, [selectedCwd, selectedProject?.key, onNewSession]);

  const togglePinned = useCallback((sessionId: string) => {
    updateSessionOrg((org) => ({
      ...org,
      pinned: org.pinned.includes(sessionId)
        ? org.pinned.filter((id) => id !== sessionId)
        : [sessionId, ...org.pinned],
    }));
  }, [updateSessionOrg]);

  const createFolder = useCallback((name: string, parentId?: string | null): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const folder: SessionFolder = {
      id: createFolderId(),
      name: trimmed,
      ...(parentId ? { parentId } : {}),
    };
    updateSessionOrg((org) => ({ ...org, folders: [...org.folders, folder] }));
    return folder.id;
  }, [updateSessionOrg]);

  const moveFolderTo = useCallback((folderId: string, targetParentId: string | null) => {
    updateSessionOrg((org) => {
      if (targetParentId && wouldCreateFolderCycle(org.folders, folderId, targetParentId)) return org;
      return {
        ...org,
        folders: org.folders.map((f) => (f.id === folderId ? { ...f, parentId: targetParentId } : f)),
      };
    });
  }, [updateSessionOrg]);

  const setFolderRule = useCallback((folderId: string, pattern: string) => {
    const trimmed = pattern.trim();
    updateSessionOrg((org) => ({
      ...org,
      folders: org.folders.map((f) => {
        if (f.id !== folderId) return f;
        if (!trimmed) {
          const next: SessionFolder = { id: f.id, name: f.name };
          if (f.parentId) next.parentId = f.parentId;
          return next;
        }
        return { ...f, autoPattern: trimmed };
      }),
    }));
  }, [updateSessionOrg]);

  const renameFolder = useCallback((folderId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateSessionOrg((org) => ({
      ...org,
      folders: org.folders.map((f) => (f.id === folderId ? { ...f, name: trimmed } : f)),
    }));
  }, [updateSessionOrg]);

  const deleteFolder = useCallback((folderId: string) => {
    // Sessions assigned to this folder fall back to the ungrouped list; its
    // subfolders are promoted to the deleted folder's own parent. Nothing is
    // deleted and no session files are touched.
    updateSessionOrg((org) => ({
      ...org,
      folders: removeFolderPromotingChildren(org.folders, folderId),
      assignments: Object.fromEntries(
        Object.entries(org.assignments).filter(([, fid]) => fid !== folderId),
      ),
      collapsedFolders: org.collapsedFolders.filter((id) => id !== folderId),
    }));
  }, [updateSessionOrg]);

  const moveSessionToFolder = useCallback((sessionId: string, folderId: string | null) => {
    updateSessionOrg((org) => {
      const assignments = { ...org.assignments };
      if (folderId === null) assignments[sessionId] = SESSION_ORG_UNGROUPED;
      else assignments[sessionId] = folderId;
      return { ...org, assignments };
    });
  }, [updateSessionOrg]);

  const toggleFolderCollapsed = useCallback((folderId: string) => {
    updateSessionOrg((org) => ({
      ...org,
      collapsedFolders: org.collapsedFolders.includes(folderId)
        ? org.collapsedFolders.filter((id) => id !== folderId)
        : [...org.collapsedFolders, folderId],
    }));
  }, [updateSessionOrg]);

  const hideDeletedSession = useCallback((sessionId: string) => {
    deletedSessionTombstonesRef.current.add(sessionId);
    // Remove from every rendered view in the same commit before organization
    // cleanup can make the still-present row appear under Ungrouped.
    setAllSessions((sessions) => sessions.filter((session) => session.id !== sessionId));
    setUnreadSessionIds((ids) => {
      if (!ids.has(sessionId)) return ids;
      const next = new Set(ids);
      next.delete(sessionId);
      return next;
    });
    setFolderMenuFor((id) => (id === sessionId ? null : id));
  }, []);

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  const filteredSessions = selectedProject
    ? sessionsForProject(allSessions, selectedProject.key)
    : allSessions;
  // Free-text search across name + first message (multi-token AND).
  const searchedSessions = useMemo(
    () => filteredSessions.filter((s) => sessionMatchesQuery(s, sessionQuery)),
    [filteredSessions, sessionQuery],
  );
  const hasSearchQuery = sessionQuery.trim().length > 0;

  const bulkDelete = useCallback(async () => {
    if (bulkDeleting) return;
    // Only sessions visible under the CURRENT search/filter can be deleted.
    // Otherwise a stale selection from an earlier search would silently
    // delete rows the user can no longer see. Running sessions are
    // protected: never delete one mid-run.
    const visibleIds = new Set(searchedSessions.map((s) => s.id));
    const targets = [...bulkSelected]
      .filter((id) => visibleIds.has(id))
      .filter((id) => !runningSessionIds.has(id));
    if (targets.length === 0) return;
    // Delete ancestors before descendants so each parent's effective
    // organization can be handed down through the chain before the child is
    // removed in turn.
    const sessionById = new Map(allSessions.map((session) => [session.id, session]));
    const targetIds = new Set(targets);
    const targetDepth = (id: string) => {
      let depth = 0;
      let parentId = sessionById.get(id)?.parentSessionId;
      const visited = new Set<string>();
      while (parentId && targetIds.has(parentId) && !visited.has(parentId)) {
        visited.add(parentId);
        depth += 1;
        parentId = sessionById.get(parentId)?.parentSessionId;
      }
      return depth;
    };
    targets.sort((a, b) => targetDepth(a) - targetDepth(b));
    setBulkDeleting(true);
    try {
      for (const id of targets) {
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
          if (!response.ok) continue;
          hideDeletedSession(id);
          onSessionDeleted?.(id);
          // Preserve organization for surviving/reparented children while
          // removing the deleted session's own references.
          updateSessionOrg((org) => removeSessionOrganizationReferences(org, id, allSessions));
        } catch {
          // continue with the rest
        }
      }
      loadSessions();
    } finally {
      setBulkDeleting(false);
      exitBulkMode();
    }
  }, [allSessions, searchedSessions, bulkDeleting, bulkSelected, runningSessionIds, hideDeletedSession, onSessionDeleted, loadSessions, exitBulkMode, updateSessionOrg]);

  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.isGit
        ? {
             label: t("sidebar.openRepoRoot"),
             title: t("sidebar.openRepoRootTitle"),
          }
        : {
             label: t("sidebar.gitRepoRootOnly"),
             title: t("sidebar.gitRepoRootOnlyTitle"),
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
        }
      : null);

  // Subagent sessions never render as their own sidebar rows; their state
  // aggregates into the main session row (tree rows do this in
  // SessionTreeItem). This family map also backs the search filter below so
  // subagent-only matches surface their main session instead.
  const sessionFamilies = useMemo(() => listSessionFamilies(filteredSessions), [filteredSessions]);

  // While searching or bulk-selecting, folders/pins are intentionally ignored
  // and results are flat. In browsing mode, group the COMPLETE parent/child
  // tree instead of filtering individual rows first: an unassigned subagent
  // inherits its parent's folder/pinned group and stays nested beneath it.
  const flatList = hasSearchQuery || bulkMode;
  // Subagent rows never render (their state aggregates into the main row), so
  // exclude them from every tree/group input before grouping.
  const rowSessions = useMemo(
    () => searchedSessions.filter((s) => s.relation?.kind !== "subagent"),
    [searchedSessions],
  );
  // In flat mode a subagent hit must surface its MAIN session row, not a
  // hidden subagent row (upstream families semantics).
  const flatSources = flatList
    ? sessionFamilies.map((family) => {
        const familySessions = [family.root, ...family.subagents];
        const hit = familySessions.some((s) => searchedSessions.some((x) => x.id === s.id));
        if (!hit) return null;
        return family.latestModified === family.root.modified
          ? family.root
          : { ...family.root, modified: family.latestModified };
      }).filter((s): s is SessionInfo => s !== null)
    : [];
  const sessionTree = flatList
    ? flatSources.map((s) => ({ session: s, children: [] as SessionTreeNode[] }))
    : buildSessionTree(rowSessions);
  // Rows always read the REAL pin state — flattening search results must not
  // fake them into looking unpinned (the pin action would then unpin).
  const pinnedIds = useMemo(
    () => new Set(flatList
      ? sessionOrg.pinned
      : sessionOrg.pinned.filter((id) => rowSessions.some((s) => s.id === id))),
    [flatList, sessionOrg.pinned, rowSessions],
  );
  const groupedTrees = useMemo(() => {
    if (flatList) {
      // Rendering stays flat, but rows still show their REAL pin/folder
      // state: an empty map would make pinned/foldered rows look ungrouped
      // and invert their organization actions (pin → unpin).
      const real = groupSessionTrees(
        rowSessions,
        new Set(sessionOrg.pinned),
        sessionOrg.assignments,
        new Set(sessionOrg.folders.map((folder) => folder.id)),
      );
      return {
        pinned: [],
        folders: new Map<string, SessionTreeNode[]>(),
        ungrouped: sessionTree,
        effectiveFolderBySessionId: real.effectiveFolderBySessionId,
      };
    }
    return groupSessionTrees(
      rowSessions,
      pinnedIds,
      sessionOrg.assignments,
      new Set(sessionOrg.folders.map((folder) => folder.id)),
    );
  }, [flatList, sessionTree, rowSessions, pinnedIds, sessionOrg.pinned, sessionOrg.assignments, sessionOrg.folders]);
  const pinnedTree = groupedTrees.pinned;
  const folderTrees = groupedTrees.folders;
  const effectiveFolderBySessionId = groupedTrees.effectiveFolderBySessionId;
  const ungroupedTree = groupedTrees.ungrouped;
  const focusedImportantIds = useMemo(() => new Set([
    ...runningSessionIds,
    ...unreadSessionIds,
    ...pinnedIds,
    ...(selectedSessionId ? [selectedSessionId] : []),
  ]), [runningSessionIds, unreadSessionIds, pinnedIds, selectedSessionId]);
  const currentWorkRoots = useMemo(() => [
    ...pinnedTree,
    ...sessionOrg.folders.flatMap((folder) => folderTrees.get(folder.id) ?? []),
    ...ungroupedTree,
  ], [pinnedTree, sessionOrg.folders, folderTrees, ungroupedTree]);
  const currentWorkSections = useMemo(
    () => buildCurrentWorkSections(currentWorkRoots, focusedImportantIds),
    [currentWorkRoots, focusedImportantIds],
  );
  const olderSplit = useCallback(
    (trees: SessionTreeNode[]) => splitOlderSessionTrees(trees),
    [],
  );
  const effectiveSessionView = hasSearchQuery || bulkMode ? "all" : sessionView;
  const ungroupedAgeSplit = useMemo(
    () => flatList ? { recent: ungroupedTree, older: [] } : splitOlderSessionTrees(ungroupedTree),
    [flatList, ungroupedTree],
  );

  const handleDeletedSessionOrganization = (id: string) => {
    hideDeletedSession(id);
    onSessionDeleted?.(id);
    // Every rendering path (pinned, folder, ungrouped tree) uses this cleanup.
    // Keeping it centralized prevents invisible stale assignments after a
    // child/root session is deleted from a nested tree.
    updateSessionOrg((org) => removeSessionOrganizationReferences(org, id, filteredSessions));
    loadSessions();
  };

  const renderOlderTrees = (groupId: string, trees: SessionTreeNode[], depth: number) => {
    if (trees.length === 0) return null;
    const expanded = expandedOlderGroups.has(groupId);
    return (
      <div>
        <button
          onClick={() => toggleOlderGroup(groupId)}
          aria-expanded={expanded}
          style={{
            width: "100%", height: 28, padding: `0 12px 0 ${12 + depth * 14}px`,
            display: "flex", alignItems: "center", gap: 6, border: "none",
            background: "transparent", color: "var(--text-dim)", cursor: "pointer", fontSize: 11,
          }}
        >
          <span style={{ transform: expanded ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}>⌄</span>
          {t("sidebar.olderSessions", { count: countSessionTreeNodes(trees) })}
        </button>
        {expanded && trees.map((node) => renderSessionTree(node, depth))}
      </div>
    );
  };

  const renderSessionTree = (node: SessionTreeNode, depth: number) => (
    <SessionTreeItem
      key={node.session.id}
      node={node}
      selectedSessionId={selectedSessionId}
      runningSessionIds={runningSessionIds}
      unreadSessionIds={unreadSessionIds}
      onSelectSession={handleSelectSessionFromList}
      onRenamed={loadSessions}
      onSessionDeleted={handleDeletedSessionOrganization}
      depth={depth}
      pinnedIds={pinnedIds}
      onTogglePinned={togglePinned}
      folders={sessionOrg.folders}
      assignments={sessionOrg.assignments}
      effectiveFolderBySessionId={effectiveFolderBySessionId}
      onMoveToFolder={moveSessionToFolder}
      onCreateFolder={createFolder}
      bulkMode={bulkMode}
      bulkSelected={bulkSelected}
      onBulkToggle={toggleBulkSelected}
      folderMenuFor={folderMenuFor}
      onFolderMenuFor={setFolderMenuFor}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <PiWebTitle />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={handleNewSession}
              disabled={!selectedCwd}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: selectedCwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: selectedCwd ? "pointer" : "not-allowed",
                height: 32,
                paddingLeft: 10,
                paddingRight: 12,
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
             title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
              onMouseEnter={(e) => {
                if (!selectedCwd) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = selectedCwd ? "var(--text-muted)" : "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              {t("sidebar.new")}
            </button>
            <button
              onClick={() => loadSessions(false, true)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: sessionRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${sessionRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: sessionRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer",
                width: 32, height: 32,
                borderRadius: 7,
                padding: 0,
                flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
              onMouseEnter={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                if (sessionRefreshDone) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
               title={t("sidebar.refresh")}
            >
              {sessionRefreshDone ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* CWD picker */}
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject?.root ?? selectedCwd ?? ""}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            {selectedCwd ? (
              <PathLabel
                text={displayCwd(selectedProject?.root ?? selectedCwd, homeDir)}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                 {initialSessionId && !restoredRef.current ? "" : t("sidebar.selectProject")}
              </span>
            )}
            {hasOtherWorkspaceActivity && (
              <span
                title={t("sidebar.newActivity")}
                aria-label={t("sidebar.newActivity")}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flexShrink: 0,
                  marginLeft: 6,
                  background: "var(--accent)",
                }}
              />
            )}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
              {showProjectFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setProjectFilter("");
                        setDropdownOpen(false);
                      }
                    }}
                     placeholder={t("sidebar.filterProjects")}
                    autoFocus
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}
              <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
                {visibleProjects.map((project) => (
                  <button
                    key={project.key}
                    onClick={() => {
                      setSelectedCwd(project.root);
                      setProjectFilter("");
                      setCustomPathOpen(false);
                      setCustomPathError(null);
                      setDropdownOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: project.key === selectedProject?.key ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={project.root}
                  >
                    {project.key === selectedProject?.key && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                      </svg>
                    )}
                    {project.key !== selectedProject?.key && <span style={{ width: 10, flexShrink: 0 }} />}
                    <PathLabel text={displayCwd(project.root, homeDir)} style={{ flex: 1 }} />
                    {showProjectActivity(projectActivity.get(project.key), t)}
                  </button>
                ))}
                {visibleProjects.length === 0 && projectFilter.trim() && (
                   <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                   <span>{t("sidebar.useDefaultDirectory")}</span>
                </button>
              )}

              {/* Custom path directory picker */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCustomPathClick();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>{t("sidebar.customPath")}</span>
              </button>
          </AnimatedDropdown>
        </div>

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {showWorktreeSwitcher && (() => {
          if (!worktreeState) return null;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((w) =>
                (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 6 }}>
              <button
                onClick={() => setWtDropdownOpen((v) => !v)}
                 title={currentWorktree ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path }) : t("sidebar.switchWorktree")}
                style={{
                  width: "100%",
                  height: 29,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--text-muted)",
                  textAlign: "left",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWorktree && !currentWorktree.isMain ? "var(--accent)" : "var(--text-dim)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }}
                />
                {currentWorktree?.isMain && (
                   <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  )}
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktreePath;
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("sidebar.forceRemoveCheckout")}
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.force")}
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
                              style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.cancel")}
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={wt.path}
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 10px",
                              background: "var(--bg)",
                              border: "none",
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                            {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                          </button>
                          {!wt.isMain && (
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
                               title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 34, height: 28, padding: 0, marginRight: 4,
                                background: "none", border: "none",
                                color: "var(--text-dim)", cursor: "pointer",
                                borderRadius: 5, flexShrink: 0,
                                transition: "color 0.12s, background 0.12s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={t("sidebar.createWorktreeTitle")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                       <span>{t("sidebar.newWorktree")}</span>
                    </button>
                  ) : (
                    <div style={{ padding: "6px 8px" }}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        onChange={(e) => {
                          setWtNewBranch(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewBranch("");
                            setWtError(null);
                          }
                        }}
                         placeholder={t("sidebar.branchName")}
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "#fff",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                           {t("sidebar.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-hover)",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: "default",
              opacity: 0.82,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}
      </div>

      {/* Focused time view vs complete folder view. Search/bulk temporarily
          show all matching sessions without overwriting the saved preference. */}
      <div style={{ display: "flex", gap: 3, margin: "6px 10px 0", padding: 2, borderRadius: 7, background: "var(--bg-hover)", flexShrink: 0 }}>
        {(["current", "all"] as const).map((view) => {
          const active = sessionView === view;
          return (
            <button
              key={view}
              onClick={() => setSessionView(view)}
              aria-pressed={active}
              style={{
                flex: 1, height: 25, padding: "0 8px", border: "none", borderRadius: 5,
                background: active ? "var(--bg-panel)" : "transparent",
                color: active ? "var(--text)" : "var(--text-dim)",
                boxShadow: active ? "0 1px 2px rgba(0,0,0,0.12)" : "none",
                fontSize: 11, fontWeight: active ? 600 : 500, cursor: "pointer",
              }}
            >
              {view === "current" ? t("sidebar.currentWork") : t("sidebar.allSessions")}
            </button>
          );
        })}
      </div>

      {/* Session search + bulk toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px 4px", flexShrink: 0 }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={sessionQuery}
            onChange={(e) => setSessionQuery(e.target.value)}
            placeholder={t("sidebar.searchSessions")}
            aria-label={t("sidebar.searchSessions")}
            style={{
              width: "100%",
              height: 28,
              padding: "0 8px 0 26px",
              fontSize: 12,
              fontFamily: "inherit",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 7,
              outline: "none",
              color: "var(--text)",
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
          />
        </div>
        <ToolbarIconButton
          onClick={() => (bulkMode ? exitBulkMode() : (setBulkSelected(new Set()), setBulkMode(true)))}
          title={bulkMode ? t("sidebar.bulkExit") : t("sidebar.bulkSelect")}
          skipHover={bulkMode}
          color={bulkMode ? "var(--accent)" : "var(--text-dim)"}
          ariaPressed={bulkMode}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
        </ToolbarIconButton>
      </div>

      {/* Bulk action bar */}
      {bulkMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 10px 6px", flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.bulkSelectedCount", { count: bulkSelected.size })}
          </span>
          <div style={{ display: "flex", gap: 5, marginLeft: "auto", flexShrink: 0 }}>
            <button
              onClick={() => {
                const selectable = searchedSessions.filter((s) => !runningSessionIds.has(s.id)).map((s) => s.id);
                // Compare membership, not sizes: a stale selection from a
                // different search can coincidentally have the same count.
                const allSelected = selectable.length > 0
                  && selectable.every((id) => bulkSelected.has(id));
                setBulkSelected(allSelected ? new Set() : new Set(selectable));
              }}
              style={{
                height: 26, padding: "0 10px", fontSize: 11,
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.bulkSelectAll")}
            </button>
            <button
              onClick={() => void bulkDelete()}
              disabled={bulkSelected.size === 0 || bulkDeleting}
              style={{
                height: 26, padding: "0 10px", fontSize: 11, fontWeight: 600,
                background: bulkSelected.size === 0 ? "var(--bg-hover)" : "#ef4444",
                border: "none",
                borderRadius: 6, color: bulkSelected.size === 0 ? "var(--text-dim)" : "#fff",
                cursor: bulkSelected.size === 0 ? "default" : "pointer",
                whiteSpace: "nowrap", opacity: bulkDeleting ? 0.6 : 1,
              }}
            >
              {bulkDeleting ? t("sidebar.bulkDeleting") : t("sidebar.bulkDelete", { count: bulkSelected.size })}
            </button>
          </div>
        </div>
      )}

      {/* Session list */}
      <div style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}>
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {error && (
          <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
            {error}
          </div>
        )}
        {!loading && !error && searchedSessions.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {hasSearchQuery ? t("sidebar.noSearchResults") : t("sidebar.noSessions")}
          </div>
        )}

        {/* Focused view: complete trees grouped once by importance/time. */}
        {!loading && !error && effectiveSessionView === "current" && currentWorkSections.map((section) => {
          const labels: Record<SessionSidebarTimeSection, string> = {
            active: t("sidebar.activeSessions"),
            today: t("sidebar.today"),
            yesterday: t("sidebar.yesterday"),
            week: t("sidebar.last7Days"),
            month: t("sidebar.last30Days"),
          };
          return (
            <div key={section.id}>
              <SidebarGroupLabel label={labels[section.id]} />
              {section.trees.map((node) => renderSessionTree(node, 0))}
            </div>
          );
        })}

        {!loading && !error && effectiveSessionView === "current" && currentWorkSections.length === 0 && searchedSessions.length > 0 && (
          <div style={{ padding: "18px 14px", textAlign: "center", color: "var(--text-dim)", fontSize: 11 }}>
            <div>{t("sidebar.noCurrentWork")}</div>
            <button
              onClick={() => setSessionView("all")}
              style={{ marginTop: 8, height: 26, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer", fontSize: 11 }}
            >
              {t("sidebar.viewAllSessions")}
            </button>
          </div>
        )}

        {/* Pinned group */}
        {!loading && !error && effectiveSessionView === "all" && pinnedTree.length > 0 && (
          <>
            <SidebarGroupLabel label={t("sidebar.pinned")} />
            {pinnedTree.map((node) => renderSessionTree(node, 0))}
          </>
        )}

        {/* Folder groups: nested subfolder tree, newest-first within each */}
        {!loading && !error && effectiveSessionView === "all" && !flatList && (() => {
          const renderFolderNode = (node: FolderNode, depth: number): ReactNode => {
            const folder = node.folder;
            const trees = folderTrees.get(folder.id) ?? [];
            const { recent, older } = olderSplit(trees);
            const subtreeIds = folderSubtreeIds(sessionOrg.folders, folder.id);
            // Aggregated count includes every descendant folder's sessions.
            let itemCount = 0;
            for (const id of subtreeIds) {
              itemCount += countSessionTreeNodes(folderTrees.get(id) ?? []);
            }
            if (itemCount === 0 && hasSearchQuery) return null;
            const collapsed = sessionOrg.collapsedFolders.includes(folder.id);
            return (
              <div key={`${selectedProject?.key ?? ""}:${folder.id}`}>
                <FolderRow
                  folder={folder}
                  depth={depth}
                  count={itemCount}
                  collapsed={collapsed}
                  highlight={highlightedFolders.has(folder.id)}
                  allFolders={sessionOrg.folders}
                  onToggle={() => toggleFolderCollapsed(folder.id)}
                  onRename={(name) => renameFolder(folder.id, name)}
                  onDelete={() => deleteFolder(folder.id)}
                  onNewSession={() => handleNewSessionInFolder(folder.id)}
                  onCreateSubfolder={(name) => createFolder(name, folder.id)}
                  onSetRule={(pattern) => setFolderRule(folder.id, pattern)}
                  onMoveTo={(parentId) => moveFolderTo(folder.id, parentId)}
                />
                {!collapsed && recent.map((n) => renderSessionTree(n, depth + 1))}
                {!collapsed && renderOlderTrees(`folder:${folder.id}`, older, depth + 1)}
                {!collapsed && node.children.map((child) => renderFolderNode(child, depth + 1))}
              </div>
            );
          };
          return buildFolderTree(sessionOrg.folders).map((root) => renderFolderNode(root, 0));
        })()}

        {/* Ungrouped sessions */}
        {!loading && !error && effectiveSessionView === "all" && (ungroupedTree.length > 0 || (flatList && sessionTree.length > 0)) && (
          sessionOrg.folders.length > 0 && !flatList ? (
            <>
              <SidebarGroupLabel label={t("sidebar.ungrouped")} />
              {ungroupedAgeSplit.recent.map((node) => (
                <SessionTreeItem
                  key={node.session.id}
                  node={node}
                  selectedSessionId={selectedSessionId}
                  runningSessionIds={runningSessionIds}
                  unreadSessionIds={unreadSessionIds}
                  onSelectSession={handleSelectSessionFromList}
                  onRenamed={loadSessions}
                  onSessionDeleted={handleDeletedSessionOrganization}
                  depth={0}
                  pinnedIds={pinnedIds}
                  onTogglePinned={togglePinned}
                  folders={sessionOrg.folders}
                  assignments={sessionOrg.assignments}
                  effectiveFolderBySessionId={effectiveFolderBySessionId}
                  onMoveToFolder={moveSessionToFolder}
                  onCreateFolder={createFolder}
                  bulkMode={bulkMode}
                  bulkSelected={bulkSelected}
                  onBulkToggle={toggleBulkSelected}
                  folderMenuFor={folderMenuFor}
                  onFolderMenuFor={setFolderMenuFor}
                />
              ))}
              {renderOlderTrees("ungrouped", ungroupedAgeSplit.older, 0)}
            </>
          ) : (
            // No folders exist: render the ungrouped tree, which already
            // excludes pinned sessions (rendered in the pinned group above)
            // and folder-assigned sessions.
            <>
              {ungroupedAgeSplit.recent.map((node) => (
              <SessionTreeItem
                key={node.session.id}
                node={node}
                selectedSessionId={selectedSessionId}
                runningSessionIds={runningSessionIds}
                unreadSessionIds={unreadSessionIds}
                onSelectSession={handleSelectSessionFromList}
                onRenamed={loadSessions}
                onSessionDeleted={handleDeletedSessionOrganization}
                depth={0}
                pinnedIds={pinnedIds}
                onTogglePinned={togglePinned}
                folders={sessionOrg.folders}
                assignments={sessionOrg.assignments}
                effectiveFolderBySessionId={effectiveFolderBySessionId}
                onMoveToFolder={moveSessionToFolder}
                onCreateFolder={createFolder}
                bulkMode={bulkMode}
                bulkSelected={bulkSelected}
                onBulkToggle={toggleBulkSelected}
                folderMenuFor={folderMenuFor}
                onFolderMenuFor={setFolderMenuFor}
              />
              ))}
              {renderOlderTrees("ungrouped", ungroupedAgeSplit.older, 0)}
            </>
          )
        )}
      </div>

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((open) => {
                const next = !open;
                saveExplorerOpen(next);
                return next;
              })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              {t("files.explorer")}
            </button>
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                ariaPressed={!changesCollapsed}
                color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
                background={changesCollapsed ? "none" : "var(--bg-selected)"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M3 12h6" />
                  <path d="M15 12h6" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => {
                  setFileSearchOpen((open) => !open);
                }}
                title={t("sidebar.searchFiles")}
                ariaPressed={fileSearchOpen}
                color={fileSearchOpen ? "var(--accent)" : "var(--text-dim)"}
                background={fileSearchOpen ? "var(--bg-selected)" : "none"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title={t("sidebar.refreshExplorer")}
              skipHover={explorerRefreshDone}
              color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
              background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
              marginRight={6}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </ToolbarIconButton>
          </div>
          {explorerOpen && (
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionTreeItem({
  node,
  selectedSessionId,
  runningSessionIds,
  unreadSessionIds,
  onSelectSession,
  onRenamed,
  onSessionDeleted,
  depth,
  pinnedIds,
  onTogglePinned,
  folders,
  assignments,
  effectiveFolderBySessionId,
  onMoveToFolder,
  onCreateFolder,
  bulkMode,
  bulkSelected,
  onBulkToggle,
  folderMenuFor,
  onFolderMenuFor,
}: {
  node: SessionTreeNode;
  selectedSessionId: string | null;
  runningSessionIds: Set<string>;
  unreadSessionIds: Set<string>;
  onSelectSession: (s: SessionInfo) => void;
  onRenamed?: () => void;
  onSessionDeleted?: (id: string) => void;
  depth: number;
  pinnedIds: Set<string>;
  onTogglePinned: (id: string) => void;
  folders: SessionFolder[];
  assignments: Record<string, string>;
  effectiveFolderBySessionId: ReadonlyMap<string, string | null>;
  onMoveToFolder: (sessionId: string, folderId: string | null) => void;
  onCreateFolder: (name: string) => string | null;
  bulkMode: boolean;
  bulkSelected: Set<string>;
  onBulkToggle: (id: string) => void;
  folderMenuFor: string | null;
  onFolderMenuFor: (id: string | null) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;
  // Aggregate descendant state onto this row, mirroring upstream's subagent
  // family aggregation: a running/selected subagent surfaces through its
  // ancestor row even while the subtree is collapsed.
  const subtreeIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (n: SessionTreeNode) => {
      ids.push(n.session.id);
      n.children.forEach(walk);
    };
    walk(node);
    return ids;
  }, [node]);
  const subtreeRunning = subtreeIds.some((id) => runningSessionIds.has(id));
  const subtreeUnread = subtreeIds.some((id) => unreadSessionIds.has(id));
  const subtreeSelected = subtreeIds.some((id) => id === selectedSessionId);

  return (
    <div>
      <div style={{ position: "relative" }}>
        {/* Indent line for child sessions */}
        {depth > 0 && (
          <div style={{
            position: "absolute",
            left: depth * 12 + 6,
            top: 0, bottom: 0,
            width: 1,
            background: "var(--border)",
            pointerEvents: "none",
          }} />
        )}
        <SessionItem
          session={node.session}
          isSelected={subtreeSelected}
          isRunning={subtreeRunning}
          isUnread={subtreeUnread}
          onClick={() => onSelectSession(node.session)}
          onRenamed={onRenamed}
          onDeleted={(id) => onSessionDeleted?.(id)}
          depth={depth}
          hasChildren={hasChildren}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          isPinned={pinnedIds.has(node.session.id)}
          onTogglePinned={() => onTogglePinned(node.session.id)}
          folders={folders}
          currentFolderId={effectiveFolderBySessionId.get(node.session.id) ?? null}
          onMoveToFolder={(folderId) => onMoveToFolder(node.session.id, folderId)}
          onCreateFolder={onCreateFolder}
          bulkMode={bulkMode}
          bulkChecked={bulkSelected.has(node.session.id)}
          onBulkToggle={() => onBulkToggle(node.session.id)}
          folderMenuFor={folderMenuFor}
          onFolderMenuFor={onFolderMenuFor}
        />
      </div>
      {hasChildren && !collapsed && (
        <div>
          {node.children.map((child) => (
            <SessionTreeItem
              key={child.session.id}
              node={child}
              selectedSessionId={selectedSessionId}
              runningSessionIds={runningSessionIds}
              unreadSessionIds={unreadSessionIds}
              onSelectSession={onSelectSession}
              onRenamed={onRenamed}
              onSessionDeleted={onSessionDeleted}
              depth={depth + 1}
              pinnedIds={pinnedIds}
              onTogglePinned={onTogglePinned}
              folders={folders}
              assignments={assignments}
              effectiveFolderBySessionId={effectiveFolderBySessionId}
              onMoveToFolder={onMoveToFolder}
              onCreateFolder={onCreateFolder}
              bulkMode={bulkMode}
              bulkSelected={bulkSelected}
              onBulkToggle={onBulkToggle}
              folderMenuFor={folderMenuFor}
              onFolderMenuFor={onFolderMenuFor}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" opacity="0.32">
          <animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.32;0;0.32" dur="1.6s" repeatCount="indefinite" />
        </circle>
      </svg>
    </span>
  );
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SidebarGroupLabel({ label }: { label: string }) {
  return (
    <div style={{
      padding: "10px 14px 4px",
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.06em",
      textTransform: "uppercase",
      color: "var(--text-dim)",
      userSelect: "none",
    }}>
      {label}
    </div>
  );
}

function MoveTargetButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ height: 22, padding: "0 8px", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
    >
      {label}
    </button>
  );
}

function FolderRow({
  folder,
  count,
  collapsed,
  highlight = false,
  depth = 0,
  allFolders = [],
  onToggle,
  onRename,
  onDelete,
  onNewSession,
  onCreateSubfolder,
  onSetRule,
  onMoveTo,
}: {
  folder: SessionFolder;
  count: number;
  collapsed: boolean;
  /** True for a short window after an auto-classified session landed here. */
  highlight?: boolean;
  depth?: number;
  allFolders?: SessionFolder[];
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onNewSession: () => void;
  onCreateSubfolder?: (name: string) => void;
  onSetRule?: (pattern: string) => void;
  onMoveTo?: (parentId: string | null) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(folder.name);
  const [renameDirty, setRenameDirty] = useState(false);
  const [subfolderOpen, setSubfolderOpen] = useState(false);
  const [subfolderValue, setSubfolderValue] = useState("");
  const [ruleOpen, setRuleOpen] = useState(false);
  const [ruleValue, setRuleValue] = useState(folder.autoPattern ?? "");
  const [ruleDirty, setRuleDirty] = useState(false);
  const [movingOpen, setMovingOpen] = useState(false);
  const renameCommittedRef = useRef(false);
  // While an editor is open but untouched, follow external updates (another
  // tab renamed the folder). Once the user typed, their edit wins.
  useEffect(() => {
    if (renaming && !renameDirty) setRenameValue(folder.name);
  }, [folder.name, renaming, renameDirty]);
  useEffect(() => {
    if (ruleOpen && !ruleDirty) setRuleValue(folder.autoPattern ?? "");
  }, [folder.autoPattern, ruleOpen, ruleDirty]);
  const finishRename = (commit: boolean) => {
    if (renameCommittedRef.current) return;
    renameCommittedRef.current = true;
    if (commit && renameValue.trim()) onRename(renameValue);
    setRenaming(false);
    setRenameDirty(false);
  };

  const moveCandidates = movingOpen
    ? allFolders.filter((candidate) => {
      if (candidate.id === folder.id) return false;
      const blocked = folderDescendantIds(allFolders, folder.id);
      if (blocked.has(candidate.id)) return false;
      // The current parent is already selected; hide only that no-op target.
      return candidate.id !== (folder.parentId ?? null);
    })
    : [];

  if (subfolderOpen || ruleOpen) {
    const commit = () => {
      if (subfolderOpen) {
        if (subfolderValue.trim()) onCreateSubfolder?.(subfolderValue);
        setSubfolderOpen(false);
        setSubfolderValue("");
      } else {
        onSetRule?.(ruleValue);
        setRuleOpen(false);
        setRuleDirty(false);
      }
    };
    return (
      <div style={{ padding: "4px 10px", paddingLeft: 10 + depth * 14 }}>
        <input
          autoFocus
          value={subfolderOpen ? subfolderValue : ruleValue}
          onChange={(e) => (subfolderOpen ? setSubfolderValue(e.target.value) : (setRuleDirty(true), setRuleValue(e.target.value)))}
          placeholder={ruleOpen ? t("sidebar.folderRulePlaceholder") : undefined}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setSubfolderOpen(false); setRuleOpen(false); setRuleDirty(false); }
          }}
          onBlur={() => commit()}
          style={{
            width: "100%", height: 28, padding: "0 8px", fontSize: 12,
            background: "var(--bg)", border: "1px solid var(--accent)",
            borderRadius: 6, outline: "none", color: "var(--text)",
          }}
        />
      </div>
    );
  }

  if (movingOpen) {
    return (
      <div style={{ padding: "4px 10px", paddingLeft: 10 + depth * 14 }}>
        <div style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>{t("sidebar.moveFolder")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {(folder.parentId ?? null) !== null && (
            <MoveTargetButton label={t("sidebar.moveToTopLevel")} onClick={() => { onMoveTo?.(null); setMovingOpen(false); }} />
          )}
          {moveCandidates.map((candidate) => (
            <MoveTargetButton
              key={candidate.id}
              label={candidate.name}
              onClick={() => { onMoveTo?.(candidate.id); setMovingOpen(false); }}
            />
          ))}
          <button
            onClick={() => setMovingOpen(false)}
            style={{ height: 22, padding: "0 8px", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer" }}
          >
            {t("sidebar.cancel")}
          </button>
        </div>
      </div>
    );
  }

  if (renaming) {
    return (
      <div style={{ padding: "4px 10px" }}>
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => { setRenameDirty(true); setRenameValue(e.target.value); }}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && renameValue.trim()) finishRename(true);
            if (e.key === "Escape") finishRename(false);
          }}
          onBlur={() => finishRename(true)}
          style={{
            width: "100%", height: 28, padding: "0 8px", fontSize: 12,
            background: "var(--bg)", border: "1px solid var(--accent)",
            borderRadius: 6, outline: "none", color: "var(--text)",
          }}
        />
      </div>
    );
  }

  if (confirmDelete) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px" }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t("sidebar.deleteFolderConfirm", { name: folder.name.slice(0, 16) })}
        </span>
        <button
          onClick={() => { onDelete(); setConfirmDelete(false); }}
          style={{ height: 24, padding: "0 9px", fontSize: 11, fontWeight: 600, background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", cursor: "pointer", whiteSpace: "nowrap" }}
        >
          {t("sidebar.delete")}
        </button>
        <button
          onClick={() => setConfirmDelete(false)}
          style={{ height: 24, padding: "0 9px", fontSize: 11, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", cursor: "pointer", whiteSpace: "nowrap" }}
        >
          {t("sidebar.cancel")}
        </button>
      </div>
    );
  }

  return (
    <div
      onClick={onToggle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={highlight ? "pi-folder-flash" : undefined}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: `6px 12px 6px ${12 + depth * 14}px`,
        marginTop: 6,
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        userSelect: "none",
      }}
    >
      {depth === 0 && <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ transform: collapsed ? "rotate(-90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}>
        <polyline points="2 3.5 5 6.5 8 3.5" />
      </svg>}
      {depth > 0 && <span style={{ width: 10, flexShrink: 0 }} />}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: depth > 0 ? 0.75 : 1 }}>
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {folder.name}
      </span>
      {folder.autoPattern && (
        <span
          title={t("sidebar.folderRule") + ": " + folder.autoPattern}
          style={{ fontSize: 9, padding: "1px 4px", borderRadius: 4, background: "var(--bg-hover)", color: "var(--accent)", fontFamily: "var(--font-mono)", flexShrink: 0 }}
        >
          zap
        </span>
      )}
      <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontFamily: "var(--font-mono)" }}>{count}</span>
      <div
        style={{ display: "flex", gap: 3, flexShrink: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
          <button
            onClick={onNewSession}
            title={t("sidebar.newSessionInFolder")}
            aria-label={t("sidebar.newSessionInFolder")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          {hovered && onCreateSubfolder && <button
            onClick={() => { setSubfolderValue(""); setSubfolderOpen(true); }}
            title={t("sidebar.newSubfolder")}
            aria-label={t("sidebar.newSubfolder")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>}
          {hovered && onSetRule && <button
            onClick={() => { setRuleValue(folder.autoPattern ?? ""); setRuleOpen(true); }}
            title={folder.autoPattern ? `${t("sidebar.folderRule")}: ${folder.autoPattern}` : t("sidebar.folderRule")}
            aria-label={t("sidebar.folderRule")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, background: "none", border: "none", color: folder.autoPattern ? "var(--accent)" : "var(--text-dim)", cursor: "pointer" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </button>}
          {hovered && onMoveTo && allFolders.length > 1 && <button
            onClick={() => setMovingOpen(true)}
            title={t("sidebar.moveFolder")}
            aria-label={t("sidebar.moveFolder")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" /><polyline points="12 5 19 12 12 19" />
            </svg>
          </button>}
          {hovered && <button
            onClick={() => { renameCommittedRef.current = false; setRenameValue(folder.name); setRenaming(true); }}
            title={t("sidebar.renameFolder")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
            </svg>
          </button>}
          {hovered && <button
            onClick={() => setConfirmDelete(true)}
            title={t("sidebar.deleteFolder")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
            </svg>
          </button>}
        </div>
    </div>
  );
}

function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  onDeleted,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
  isPinned = false,
  onTogglePinned,
  folders = [],
  currentFolderId = null,
  onMoveToFolder,
  onCreateFolder,
  bulkMode = false,
  bulkChecked = false,
  onBulkToggle,
  folderMenuFor = null,
  onFolderMenuFor,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  onDeleted?: (id: string) => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isPinned?: boolean;
  onTogglePinned?: () => void;
  folders?: SessionFolder[];
  currentFolderId?: string | null;
  onMoveToFolder?: (folderId: string | null) => void;
  onCreateFolder?: (name: string) => string | null;
  bulkMode?: boolean;
  bulkChecked?: boolean;
  onBulkToggle?: () => void;
  folderMenuFor?: string | null;
  onFolderMenuFor?: (id: string | null) => void;
}) {
  const { locale, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [folderMenuCreating, setFolderMenuCreating] = useState(false);
  const [folderMenuNewName, setFolderMenuNewName] = useState("");
  const folderMenuPosRef = useRef<{ top: number; bottom: number; left: number }>({ top: 0, bottom: 0, left: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const folderMenuOpen = folderMenuFor === session.id;

  // Close the folder dropdown on any outside click / Escape while it is open.
  const folderMenuRef = useRef<HTMLDivElement | null>(null);
  const folderMenuRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!folderMenuOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (folderMenuRef.current && !folderMenuRef.current.contains(e.target as Node)) {
        onFolderMenuFor?.(null);
      }
    };
    const closeFolderMenuOnKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFolderMenuFor?.(null);
    };
    // The dropdown is fixed at coordinates captured when it opened; scrolling
    // a container that contains the trigger row would detach it from its
    // anchor, so close then. The chat pane's streaming auto-follow scrolls a
    // container outside this row and must NOT close the menu.
    const rowEl = folderMenuRowRef.current;
    const closeFolderMenuOnScroll = (e: Event) => {
      const scrolled = e.target as Node | null;
      if (rowEl && scrolled instanceof Node && !rowEl.contains(scrolled)) return;
      onFolderMenuFor?.(null);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", closeFolderMenuOnKey, true);
    window.addEventListener("scroll", closeFolderMenuOnScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", closeFolderMenuOnKey, true);
      window.removeEventListener("scroll", closeFolderMenuOnScroll, true);
    };
  }, [folderMenuOpen, onFolderMenuFor]);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  // A stored first message may be an SDK-expanded <skill> block; collapse it
  // back to the compact /skill:name args command the user typed before using
  // it as the auto-name fallback, mirroring MessageView's rendering.
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (session.transient) return;
    setRenameValue(session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12));
    setRenaming(true);
  }, [session.name, session.transient, displayFirstMessage, session.id]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed displayFirstMessage, so an untouched rename of
    // a skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (response.ok) onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) {
        setDeleting(false);
        return;
      }
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [onRenamed, session.cwd, session.id, session.name, session.path]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  const ITEM_HEIGHT = 54;

  return (
    <div
      ref={folderMenuRowRef}
      onClick={confirmDelete || renaming ? undefined : onClick}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: ITEM_HEIGHT,
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: confirmDelete
          ? "2px solid #ef4444"
          : isSelected ? "2px solid var(--accent)"
          : isPinned ? "2px solid color-mix(in srgb, var(--accent) 45%, transparent)"
          : "2px solid transparent",
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 30, padding: "0 11px",
                background: "#ef4444", border: "none",
                borderRadius: 6, color: "#fff",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 30, padding: "0 11px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 6, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Bulk-mode checkbox */}
          {bulkMode && (
            <label
              onClick={(e) => e.stopPropagation()}
              style={{ display: "flex", alignItems: "center", flexShrink: 0, cursor: isRunning ? "not-allowed" : "pointer", opacity: isRunning ? 0.4 : 1 }}
              title={isRunning ? t("sidebar.bulkRunningProtected") : undefined}
            >
              <input
                type="checkbox"
                checked={bulkChecked}
                disabled={Boolean(isRunning)}
                onChange={() => onBulkToggle?.()}
                style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
              />
            </label>
          )}
          {/* Pinned marker — always visible, not just on hover */}
          {isPinned && !bulkMode && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="var(--accent)" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-label={t("sidebar.pinned")}>
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14l-1.5-5.5a7 7 0 1 0-11 0L5 17z" />
            </svg>
          )}
          {/* Child-session glyph: robot for subagent relations, fork for
              forked sessions. Subagent rows are normally hidden behind their
              main row, but any surfaced descendant keeps its relation glyph. */}
          {depth > 0 && !bulkMode && session.relation?.kind === "subagent" && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="5" y="7" width="14" height="11" rx="2" />
              <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          )}
          {depth > 0 && !bulkMode && session.relation?.kind !== "subagent" && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                color: "var(--text)",
              }}
              title={title}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
            </div>
            <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
              {isRunning ? (
                <RunningSessionIndicator />
              ) : isUnread ? (
                <UnreadSessionIndicator />
              ) : (
                <span title={session.modified}>{formatRelativeTime(session.modified, locale)}</span>
              )}
              <span>{t("sidebar.messagesCount", { count: session.messageCount })}</span>
              {session.isWorktree && session.branch && (
                <span
                  title={`Worktree: ${session.cwd}`}
                  style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.branch}</span>
                </span>
              )}
            </div>
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={t(collapsed ? "sidebar.expandSubagents" : "sidebar.collapseSubagents")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          {/* Action buttons — shown on hover, or while the folder menu is open
              (the menu lives inside this container). */}
          {(hovered || folderMenuOpen) && !session.transient && !bulkMode && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0, position: "relative" }}>
              <button
                onClick={(e) => { e.stopPropagation(); onTogglePinned?.(); }}
                title={isPinned ? t("sidebar.unpin") : t("sidebar.pin")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: isPinned ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="17" x2="12" y2="22" />
                  <path d="M5 17h14l-1.5-5.5a7 7 0 1 0-11 0L5 17z" />
                </svg>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onFolderMenuFor?.(folderMenuOpen ? null : session.id);
                  setFolderMenuCreating(false);
                  setFolderMenuNewName("");
                  // Capture the button's viewport position while the row (and
                  // its hover-gated buttons) still exist — the fixed-position
                  // dropdown survives the row losing :hover.
                  const rect = e.currentTarget.getBoundingClientRect();
                  // Dropdown anchors below the button's left edge; the render
                  // clamps it fully inside the viewport. Flips above the row
                  // when there is not enough space below.
                  folderMenuPosRef.current = {
                    top: rect.bottom + 6,
                    bottom: window.innerHeight - rect.top + 6,
                    left: rect.left,
                  };
                }}
                title={t("sidebar.moveToFolder")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: currentFolderId ? "var(--accent)" : "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </button>
              {/* Folder dropdown — portaled to document.body so no ancestor
                  (the row's overflow:hidden, list scroll, or any transformed
                  wrapper that would create a containing block for fixed
                  positioning) can clip it. Fixed at the button's captured
                  viewport position; flips above when space below is short. */}
              {folderMenuOpen && (() => {
                const estHeight = 46 + folders.length * 30 + (folders.length > 0 ? 9 : 0);
                const flipUp = folderMenuPosRef.current.top + estHeight > window.innerHeight - 12;
                // Clamp fully inside the viewport: the sidebar sits at the
                // window's left edge, so a right-anchored 190px menu would
                // render off-screen to the left.
                const left = Math.max(8, Math.min(folderMenuPosRef.current.left, window.innerWidth - 198));
                const pos = flipUp
                  ? { bottom: folderMenuPosRef.current.bottom, transformOrigin: "bottom left" }
                  : { top: folderMenuPosRef.current.top, transformOrigin: "top left" };
                return createPortal(
                <div
                  ref={folderMenuRef}
                  className="folder-menu-pop"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "fixed",
                    ...pos,
                    left,
                    zIndex: 1000,
                    minWidth: 190,
                    background: "var(--bg-panel)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    boxShadow: "0 6px 20px rgba(0,0,0,0.14)",
                    padding: 5,
                  }}
                >
                  {folders.length === 0 && !folderMenuCreating && (
                    <div style={{ padding: "6px 9px", color: "var(--text-dim)", fontSize: 11 }}>
                      {t("sidebar.noFoldersYet")}
                    </div>
                  )}
                  {folders.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        onMoveToFolder?.(currentFolderId === f.id ? null : f.id);
                        onFolderMenuFor?.(null);
                      }}
                      style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
                        width: "100%", padding: "6px 9px",
                        background: currentFolderId === f.id ? "var(--bg-selected)" : "none",
                        border: "none", borderRadius: 5,
                        color: currentFolderId === f.id ? "var(--accent)" : "var(--text)",
                        fontSize: 12, cursor: "pointer", textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => { if (currentFolderId !== f.id) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (currentFolderId !== f.id) e.currentTarget.style.background = "none"; }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
                      {currentFolderId === f.id ? (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      )}
                    </button>
                  ))}
                  {folders.length > 0 && <div style={{ height: 1, background: "var(--border)", margin: "5px 7px" }} />}
                  {folderMenuCreating ? (
                    <div style={{ display: "flex", gap: 4, padding: "3px 4px 1px" }}>
                      <input
                        autoFocus
                        value={folderMenuNewName}
                        onChange={(e) => setFolderMenuNewName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && folderMenuNewName.trim()) {
                            const folderId = onCreateFolder?.(folderMenuNewName);
                            if (folderId) onMoveToFolder?.(folderId);
                            setFolderMenuNewName("");
                            onFolderMenuFor?.(null);
                          }
                          if (e.key === "Escape") { setFolderMenuCreating(false); setFolderMenuNewName(""); }
                        }}
                        placeholder={t("sidebar.folderName")}
                        style={{
                          flex: 1, minWidth: 0, height: 26, padding: "0 7px", fontSize: 11,
                          background: "var(--bg)", border: "1px solid var(--accent)",
                          borderRadius: 5, outline: "none", color: "var(--text)",
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      onClick={() => setFolderMenuCreating(true)}
                      style={{
                        display: "flex", alignItems: "center", gap: 6,
                        width: "100%", padding: "6px 9px",
                        background: "none", border: "none", borderRadius: 5,
                        color: "var(--text-muted)", fontSize: 12, cursor: "pointer", textAlign: "left",
                        transition: "background 0.1s",
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "none"; }}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                      {t("sidebar.newFolder")}
                    </button>
                  )}
                </div>,
                document.body
                );
              })()}
              <button
                onClick={startRename}
                title={t("sidebar.rename")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                  e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={handleDeleteClick}
                title={t("sidebar.deleteWithShiftClick")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "var(--bg-hover)", border: "1px solid var(--border)",
                  borderRadius: 7, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s, border-color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.08)";
                  e.currentTarget.style.color = "#ef4444";
                  e.currentTarget.style.borderColor = "rgba(239,68,68,0.35)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text-muted)";
                  e.currentTarget.style.borderColor = "var(--border)";
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
