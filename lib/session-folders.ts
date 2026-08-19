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
    return void mirrorSessionOrgToServer(clean, projectKey);
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Async best-effort mirror to the server-side store; failures keep localStorage as source. */
async function mirrorSessionOrgToServer(org: SessionOrganization, projectKey: string | null | undefined): Promise<void> {
  if (!projectKey) return;
  try {
    await fetch("/api/session-org", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectKey, org }),
    });
  } catch {
    // Server unreachable: localStorage cache still holds the data.
  }
}

/** Merge server-side data with the local cache; local wins only when the server has nothing. */
export async function fetchServerSessionOrganization(projectKey: string | null | undefined): Promise<SessionOrganization | null> {
  if (!projectKey) return null;
  try {
    const res = await fetch(`/api/session-org?projectKey=${encodeURIComponent(projectKey)}`);
    if (!res.ok) return null;
    const data = await res.json() as { org?: unknown };
    return normalizeSessionOrganization(data.org);
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
