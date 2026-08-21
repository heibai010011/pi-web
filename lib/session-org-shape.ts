/**
 * Shared shape for session organization (pins, folders, assignments).
 * Imported by both the browser cache layer (session-folders.ts) and the
 * server-side store (session-org-store.ts) — keep it dependency-free.
 */

/** Explicitly keep a child session outside its parent's inherited folder. */
export const SESSION_ORG_UNGROUPED = "__pi-web-ungrouped__";

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
