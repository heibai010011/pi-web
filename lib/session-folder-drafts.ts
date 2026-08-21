import {
  loadSessionOrganization,
  persistSessionOrganization,
  type SessionOrganization,
} from "./session-folders";

export const SESSION_ORGANIZATION_CHANGED_EVENT = "pi-web:session-organization-changed";

interface PendingFolderDraft {
  projectKey: string;
  folderId: string;
  temporarySessionId: string;
}

declare global {
  var __piPendingSessionFolderDrafts: Map<string, PendingFolderDraft> | undefined;
}

// A draft has no server session yet, so its folder intent is page-lifetime
// state, not durable user data. globalThis survives Next hot reload; a real
// page refresh naturally cancels the unsubmitted composer and its intent.
const pendingDrafts = globalThis.__piPendingSessionFolderDrafts ?? new Map<string, PendingFolderDraft>();
globalThis.__piPendingSessionFolderDrafts = pendingDrafts;

export function discardSessionFolderDraft(draftKey: string | null | undefined): void {
  if (!draftKey) return;
  if (!pendingDrafts.has(draftKey)) return;
  pendingDrafts.delete(draftKey);

  // No organization mutation is needed: a draft has no persisted session row
  // and its folder intent lives only in the pending record above.
}

export function registerSessionFolderDraft(
  draftKey: string,
  projectKey: string,
  folderId: string,
  temporarySessionId: string,
): void {
  pendingDrafts.set(draftKey, { projectKey, folderId, temporarySessionId });
}

/**
 * Promote a folder assignment from the client-only draft id to pi's real
 * session id. Returns the updated organization for immediate same-window UI
 * convergence; null means this draft was not started from a folder.
 */
export function promoteSessionFolderDraft(
  draftKey: string,
  realSessionId: string,
): { projectKey: string; org: SessionOrganization } | null {
  const record = pendingDrafts.get(draftKey);
  if (!record) return null;
  pendingDrafts.delete(draftKey);

  const org = loadSessionOrganization(record.projectKey);
  const assignments = { ...org.assignments };
  delete assignments[record.temporarySessionId];
  // If the folder was deleted while the draft was open, do not create a
  // dangling assignment to it.
  if (org.folders.some((folder) => folder.id === record.folderId)) {
    assignments[realSessionId] = record.folderId;
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
