/**
 * Browser-side session organization: pinned sessions and custom folders.
 *
 * localStorage is the instant client cache (zero-latency UI); every change is
 * also mirrored asynchronously to the server-side store
 * (`~/.pi/agent/session-org.json`, keyed per project) so organization survives
 * clearing browser data or switching browsers. On load, both sources merge:
 * whichever has data wins when the other is empty.
 *
 * Everything is metadata only — sessions keep living in
 * ~/.pi/agent/sessions and deleting a folder never touches session files.
 */

import { EMPTY_SESSION_ORGANIZATION, normalizeSessionOrganization, type SessionOrganization } from "./session-org-shape";

export { EMPTY_SESSION_ORGANIZATION, normalizeSessionOrganization };
export type { SessionFolder, SessionOrganization } from "./session-org-shape";

export const SESSION_ORG_STORAGE_KEY = "pi-web:session-organization";
export const SESSION_ORG_SYNCED_FLAG = "syncedToServer";

/**
 * Storage is scoped per project key so folders/pins created under one
 * workspace do not leak into another. The project key comes from the
 * session list's project grouping (same identity as the sidebar filter).
 */
export function sessionOrgStorageKey(projectKey: string | null | undefined): string {
  return projectKey ? `${SESSION_ORG_STORAGE_KEY}:${projectKey}` : SESSION_ORG_STORAGE_KEY;
}

/**
 * One-time migration: organization data used to live in one global key. When
 * per-project storage is empty but the legacy global key has data, move it in
 * (for the project that currently owns the sessions it references) and drop
 * the global key so it migrates exactly once.
 */
export function migrateLegacySessionOrganization(projectKey: string | null | undefined): void {
  if (typeof window === "undefined") return;
  try {
    const legacy = window.localStorage.getItem(SESSION_ORG_STORAGE_KEY);
    if (!legacy) return;
    const targetKey = sessionOrgStorageKey(projectKey);
    if (targetKey === SESSION_ORG_STORAGE_KEY) return; // no project scope: key already correct
    if (!window.localStorage.getItem(targetKey)) {
      window.localStorage.setItem(targetKey, legacy);
    }
    window.localStorage.removeItem(SESSION_ORG_STORAGE_KEY);
  } catch {
    // best-effort migration
  }
}

export function loadSessionOrganization(projectKey: string | null | undefined): SessionOrganization {
  if (typeof window === "undefined") return EMPTY_SESSION_ORGANIZATION;
  try {
    const raw = window.localStorage.getItem(sessionOrgStorageKey(projectKey));
    if (!raw) return EMPTY_SESSION_ORGANIZATION;
    return normalizeSessionOrganization(JSON.parse(raw)) ?? EMPTY_SESSION_ORGANIZATION;
  } catch {
    return EMPTY_SESSION_ORGANIZATION;
  }
}

export function sessionOrgDirtyKey(projectKey: string): string {
  return `pi-web:session-organization-dirty:${projectKey}`;
}

export function hasDirtySessionOrganization(projectKey: string | null | undefined): boolean {
  if (typeof window === "undefined" || !projectKey) return false;
  try {
    return Boolean(window.localStorage.getItem(sessionOrgDirtyKey(projectKey)));
  } catch {
    return false;
  }
}

function markSessionOrganizationDirty(projectKey: string): string | null {
  try {
    const token = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem(sessionOrgDirtyKey(projectKey), token);
    return token;
  } catch {
    // localStorage persistence itself is best-effort.
    return null;
  }
}

/**
 * First-contact gate for this page lifecycle. It deliberately is NOT stored
 * in localStorage: every full page load must consult the server again so a
 * change made from another browser is visible. Before first contact, edits
 * remain in localStorage and join the initial merge instead of prematurely
 * replacing the server record.
 */
const syncedProjects = new Set<string>();

export function beginSessionOrganizationSync(projectKey: string): void {
  syncedProjects.delete(projectKey);
}

export function hasSyncedSessionOrganization(projectKey: string | null | undefined): boolean {
  return Boolean(projectKey && syncedProjects.has(projectKey));
}

export function markSessionOrganizationSynced(projectKey: string): void {
  syncedProjects.add(projectKey);
}

export function persistSessionOrganization(org: SessionOrganization, projectKey: string | null | undefined): void {
  if (typeof window === "undefined") return;
  try {
    // Drop assignments pointing at folders that no longer exist so the
    // stored shape stays clean as folders are removed.
    const folderIds = new Set(org.folders.map((f) => f.id));
    const clean: SessionOrganization = {
      pinned: org.pinned,
      folders: org.folders,
      assignments: Object.fromEntries(
        Object.entries(org.assignments).filter(([, folderId]) => folderIds.has(folderId)),
      ),
      collapsedFolders: org.collapsedFolders.filter((id) => folderIds.has(id)),
    };
    window.localStorage.setItem(sessionOrgStorageKey(projectKey), JSON.stringify(clean));
    // Dirty is set immediately, even while the first GET is still in flight.
    // If the page closes in that window, next load must keep this local edit
    // instead of replacing it with an older server record.
    const dirtyToken = projectKey ? markSessionOrganizationDirty(projectKey) : null;
    // Mirror only after first contact completed: before that, the merge path
    // owns the initial server write and a partial local record must not
    // overwrite the server's.
    if (projectKey && hasSyncedSessionOrganization(projectKey)) {
      void mirrorSessionOrganizationToServer(clean, projectKey, dirtyToken);
    }
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/**
 * Serialize full-record PUTs per project. Without this, rapid create/delete/
 * bulk operations may finish out of order and an older request can overwrite
 * the newest organization on disk.
 */
const mirrorQueues = new Map<string, Promise<void>>();
const mirrorVersions = new Map<string, number>();

/** Async best-effort mirror to the server-side store; failures keep localStorage as source. */
export async function mirrorSessionOrganizationToServer(
  org: SessionOrganization,
  projectKey: string | null | undefined,
  dirtyToken: string | null = null,
): Promise<void> {
  if (!projectKey) return;
  const version = (mirrorVersions.get(projectKey) ?? 0) + 1;
  mirrorVersions.set(projectKey, version);
  const previous = mirrorQueues.get(projectKey) ?? Promise.resolve();
  let succeeded = false;
  const current = previous.catch(() => undefined).then(async () => {
    try {
      const response = await fetch("/api/session-org", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey, org }),
      });
      succeeded = response.ok;
    } catch {
      // Server unreachable: localStorage cache and dirty flag retain the data.
    }
  });
  mirrorQueues.set(projectKey, current);
  await current;
  if (mirrorQueues.get(projectKey) === current) mirrorQueues.delete(projectKey);
  // Never let an older successful write clear the dirty marker for a newer
  // queued update that has not reached disk yet.
  if (succeeded && mirrorVersions.get(projectKey) === version && typeof window !== "undefined") {
    try {
      const dirtyKey = sessionOrgDirtyKey(projectKey);
      // Cross-tab safe: never clear a newer token written by another tab.
      if (dirtyToken && window.localStorage.getItem(dirtyKey) === dirtyToken) {
        window.localStorage.removeItem(dirtyKey);
      }
    } catch {
      // best-effort marker cleanup
    }
  }
}

/** Merge server-side data with the local cache; local wins only when the server has nothing. */
export interface ServerSessionOrganization {
  exists: boolean;
  org: SessionOrganization;
}

export async function fetchServerSessionOrganization(projectKey: string | null | undefined): Promise<ServerSessionOrganization | null> {
  if (!projectKey) return null;
  try {
    const res = await fetch(`/api/session-org?projectKey=${encodeURIComponent(projectKey)}`);
    if (!res.ok) return null;
    const data = await res.json() as { exists?: unknown; org?: unknown };
    const org = normalizeSessionOrganization(data.org);
    if (!org || typeof data.exists !== "boolean") return null;
    return { exists: data.exists, org };
  } catch {
    return null;
  }
}

export function createFolderId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** True when the session matches the free-text query (name or first message). */
export function sessionMatchesQuery(session: { name?: string | null; firstMessage?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = `${session.name ?? ""}\n${session.firstMessage ?? ""}`.toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}
