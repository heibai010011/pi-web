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
  /** Parent folder id for nesting. Absent/null = top level. Pure metadata:
   *  legacy stores without this field keep working unchanged. */
  parentId?: string | null;
  /** Case-insensitive cwd substring rule; new sessions matching it are
   *  auto-assigned to this folder. Empty/absent disables the rule. */
  autoPattern?: string;
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
    ? raw.folders
        .map((folder): SessionFolder | null => {
          if (!folder || typeof folder !== "object") return null;
          if (typeof (folder as SessionFolder).id !== "string"
            || typeof (folder as SessionFolder).name !== "string") return null;
          const parentId = (folder as SessionFolder).parentId;
          const rawAuto = (folder as SessionFolder).autoPattern;
          const autoPattern = typeof rawAuto === "string" && rawAuto.trim()
            ? { autoPattern: rawAuto.trim() }
            : {};
          // Tolerate legacy stores (no parentId) and sanitize broken values.
          if (typeof parentId === "string" && parentId && parentId !== (folder as SessionFolder).id) {
            return { id: (folder as SessionFolder).id, name: (folder as SessionFolder).name, parentId, ...autoPattern };
          }
          return { id: (folder as SessionFolder).id, name: (folder as SessionFolder).name, ...autoPattern };        })
        .filter((f): f is SessionFolder => f !== null)
        // Duplicate folder ids corrupt every id-keyed structure downstream
        // (tree maps, counts, menus). Keep the first occurrence only —
        // deterministic for legacy stores and API payloads alike.
        .filter((f, index, list) => list.findIndex((other) => other.id === f.id) === index)
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
