/**
 * Browser-persisted session organization: pinned sessions and custom folders.
 *
 * Storage shape (localStorage, one key):
 * {
 *   pinned: string[],              // session ids, most recent pin first
 *   folders: { id, name }[],       // user-created folders
 *   assignments: Record<sessionId, folderId>,
 *   collapsedFolders: string[],    // folder ids the user collapsed
 * }
 *
 * Everything is client-side metadata only — sessions keep living in
 * ~/.pi/agent/sessions and deleting a folder never touches session files.
 */

export interface SessionFolder {
  id: string;
  name: string;
}

export interface SessionOrganization {
  pinned: string[];
  folders: SessionFolder[];
  assignments: Record<string, string>;
  collapsedFolders: string[];
}

export const SESSION_ORG_STORAGE_KEY = "pi-web:session-organization";

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

export const EMPTY_SESSION_ORGANIZATION: SessionOrganization = {
  pinned: [],
  folders: [],
  assignments: {},
  collapsedFolders: [],
};

export function normalizeSessionOrganization(value: unknown): SessionOrganization | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SessionOrganization> & Record<string, unknown>;
  const pinned = Array.isArray(raw.pinned)
    ? raw.pinned.filter((id): id is string => typeof id === "string")
    : null;
  const folders = Array.isArray(raw.folders)
    ? raw.folders.filter(
        (f): f is SessionFolder =>
          Boolean(f) && typeof f === "object"
          && typeof (f as SessionFolder).id === "string"
          && typeof (f as SessionFolder).name === "string",
      )
    : null;
  const assignments = raw.assignments && typeof raw.assignments === "object" && !Array.isArray(raw.assignments)
    ? Object.fromEntries(
        Object.entries(raw.assignments as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : null;
  const collapsedFolders = Array.isArray(raw.collapsedFolders)
    ? raw.collapsedFolders.filter((id): id is string => typeof id === "string")
    : null;
  if (!pinned || !folders || !assignments || !collapsedFolders) return null;
  return { pinned, folders, assignments, collapsedFolders };
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
  } catch {
    // ignore storage quota / privacy-mode errors
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
