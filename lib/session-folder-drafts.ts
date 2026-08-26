import {
  loadSessionOrganization,
  persistSessionOrganization,
  type SessionOrganization,
} from "./session-folders";

export const SESSION_ORGANIZATION_CHANGED_EVENT = "pi-web:session-organization-changed";

/** Draft marker: resolve the target folder from folder cwd rules at promotion. */
export const SESSION_FOLDER_AUTO = "__pi-web-folder-auto__";

interface PendingFolderDraft {
  projectKey: string;
  /** Real folder id, or SESSION_FOLDER_AUTO for rule-based assignment. */
  folderId: string;
  temporarySessionId: string;
  /** The cwd the composer was opened with; drives rule resolution. */
  cwd: string;
  /**
   * True once a real server session is being created for this draft. Such an
   * intent outlives composer navigation — the session file is about to exist,
   * so discarding the intent would strand the session in the wrong group.
   */
  claimed?: boolean;
}

declare global {
  var __piPendingSessionFolderDrafts: Map<string, PendingFolderDraft> | undefined;
}

// A draft has no server session yet, so its folder intent is page-lifetime
// state, not durable user data. globalThis survives Next hot reload; a real
// page refresh naturally cancels the unsubmitted composer and its intent.
const pendingDrafts = globalThis.__piPendingSessionFolderDrafts ?? new Map<string, PendingFolderDraft>();
globalThis.__piPendingSessionFolderDrafts = pendingDrafts;

function setPending(draftKey: string, projectKey: string, folderId: string, temporarySessionId: string, cwd: string): void {
  pendingDrafts.set(draftKey, { projectKey, folderId, temporarySessionId, cwd });
}

/** Explicit intent: the user picked (or just created) this exact folder. */
export function registerSessionFolderDraft(
  draftKey: string,
  projectKey: string,
  folderId: string,
  temporarySessionId: string,
): void {
  setPending(draftKey, projectKey, folderId, temporarySessionId, "");
}

/**
 * Rule-based intent: at promotion time the first folder whose autoPattern
 * matches the composer cwd wins. No match leaves the session ungrouped.
 */
export function registerAutoSessionFolderDraft(
  draftKey: string,
  projectKey: string,
  cwd: string,
  temporarySessionId: string,
): void {
  setPending(draftKey, projectKey, SESSION_FOLDER_AUTO, temporarySessionId, cwd);
}

export function discardSessionFolderDraft(draftKey: string | null | undefined): void {
  if (!draftKey) return;
  const record = pendingDrafts.get(draftKey);
  if (!record) return;
  // A claimed draft maps to a real session being created right now; its
  // folder intent must survive navigation and be resolved at promotion.
  if (record.claimed) return;
  pendingDrafts.delete(draftKey);

  // No organization mutation is needed: a draft has no persisted session row
  // and its folder intent lives only in the pending record above.
}

/** Mark a draft as backed by a real server session being created now. */
export function claimSessionFolderDraft(draftKey: string | null | undefined): void {
  if (!draftKey) return;
  const record = pendingDrafts.get(draftKey);
  if (record) record.claimed = true;
}

function resolveTargetFolderId(org: SessionOrganization, record: PendingFolderDraft): string | null {
  if (record.folderId !== SESSION_FOLDER_AUTO) return record.folderId;
  const needle = record.cwd.toLowerCase();
  const matched = org.folders.find(
    (folder) => typeof folder.autoPattern === "string"
      && folder.autoPattern.length > 0
      && needle.includes(folder.autoPattern.toLowerCase()),
  );
  return matched?.id ?? null;
}

/**
 * Promote a folder assignment from the client-only draft id to pi's real
 * session id. Returns the updated organization for immediate same-window UI
 * convergence; null means no folder intent applied to this draft.
 */
export function promoteSessionFolderDraft(
  draftKey: string,
  realSessionId: string,
): { projectKey: string; org: SessionOrganization } | null {
  const record = pendingDrafts.get(draftKey);
  if (!record) return null;
  pendingDrafts.delete(draftKey);

  const org = loadSessionOrganization(record.projectKey);
  const targetFolderId = resolveTargetFolderId(org, record);
  if (!targetFolderId) return null;

  const assignments = { ...org.assignments };
  delete assignments[record.temporarySessionId];
  // If the folder was deleted while the draft was open, do not create a
  // dangling assignment to it.
  if (org.folders.some((folder) => folder.id === targetFolderId)) {
    assignments[realSessionId] = targetFolderId;
  }
  const next = { ...org, assignments };
  persistSessionOrganization(next, record.projectKey);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSION_ORGANIZATION_CHANGED_EVENT, {
      detail: { projectKey: record.projectKey, org: next },
    }));
  }
  return { projectKey: record.projectKey, org: next };
}
