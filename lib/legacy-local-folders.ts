/**
 * Browser side of the 0.12 folder migration: the old sidebar also kept its
 * organizations in localStorage (`pi-web:session-organization:<projectKey>`),
 * which the server cannot read. After the new state has loaded, this imports
 * the non-empty records and removes the keys; a record that is already in the
 * state (the server file was imported first) adds nothing and is removed too.
 * Data only in this browser therefore survives an upgrade, and a record with
 * no folders/assignments/pins is just cleaned up.
 *
 * Client-only: reads `window.localStorage` and writes through the sidebar's
 * own `apply`, so the same rules, optimistic order and rollback apply.
 */

import {
  parseLegacySessionOrgValue,
  type LegacySessionProject,
} from "./session-org-legacy";
import {
  FOLDER_UNGROUPED,
  type SessionUiState,
  type SessionUiStateRequest,
} from "./session-ui-state-shared";

export const LEGACY_SESSION_ORG_STORAGE_PREFIX = "pi-web:session-organization";

export interface LegacyLocalProject {
  /** The localStorage key, removed once its data is in the new state. */
  key: string;
  projectKey: string;
  project: LegacySessionProject;
}

interface StorageLike {
  length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

function browserStorage(storage?: StorageLike | null): StorageLike | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Every per-project legacy record, including the empty ones that are only
 * worth removing. A global key (no project suffix) cannot be placed in a
 * project and is left alone: the old client itself moved it to a project key
 * on its first load.
 */
export function readLegacyLocalSessionOrg(
  storage: StorageLike | null = browserStorage(),
): { entries: LegacyLocalProject[]; keys: string[] } {
  const entries: LegacyLocalProject[] = [];
  const keys: string[] = [];
  if (!storage) return { entries, keys };
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key || !key.startsWith(`${LEGACY_SESSION_ORG_STORAGE_PREFIX}:`)) continue;
    const projectKey = key.slice(LEGACY_SESSION_ORG_STORAGE_PREFIX.length + 1);
    if (!projectKey) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(storage.getItem(key) ?? "null");
    } catch {
      continue;
    }
    const project = parseLegacySessionOrgValue(parsed, projectKey);
    keys.push(key);
    if (project) entries.push({ key, projectKey, project });
  }
  return { entries, keys };
}

export function removeLegacyLocalSessionOrg(keys: readonly string[], storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Privacy mode; the next load tries again.
    }
  }
}

/**
 * Import the browser's legacy records into `state` through `apply`. True when
 * every write was accepted (the legacy keys are then gone); false leaves them
 * for the next load, so a refused or failed write is retried rather than lost.
 */
export async function importLegacyLocalSessionOrg(
  state: SessionUiState,
  apply: (request: SessionUiStateRequest) => Promise<boolean>,
  storage: StorageLike | null = browserStorage(),
): Promise<boolean> {
  const { entries, keys } = readLegacyLocalSessionOrg(storage);
  if (keys.length === 0) return true;

  const folderIds = new Set((state.folders ?? []).map((folder) => folder.id));
  const assignments = new Set(Object.keys(state.folderAssignments ?? {}));
  const sessionIds = new Set(Object.keys(state.sessions));
  let ok = true;

  const write = async (request: SessionUiStateRequest): Promise<void> => {
    if (!ok) return;
    ok = await apply(request);
  };

  for (const entry of entries) {
    const { project } = entry;
    const created: string[] = [];
    for (const folder of project.folders) {
      if (folderIds.has(folder.id)) continue;
      await write({
        action: "create-folder",
        id: folder.id,
        name: folder.name,
        projectKey: entry.projectKey,
        parentId: null,
      });
      folderIds.add(folder.id);
      created.push(folder.id);
    }
    for (const folder of project.folders) {
      if (!created.includes(folder.id)) continue;
      if (folder.parentId && folderIds.has(folder.parentId)) {
        await write({ action: "move-folder", id: folder.id, parentId: folder.parentId });
      }
      if (folder.autoPattern) {
        await write({ action: "set-folder-rule", id: folder.id, autoPattern: folder.autoPattern });
      }
    }
    for (const [sessionId, folderId] of Object.entries(project.assignments)) {
      if (assignments.has(sessionId)) continue;
      if (folderId !== FOLDER_UNGROUPED && !folderIds.has(folderId)) continue;
      await write({
        action: "move-session",
        sessionId,
        folderId: folderId === FOLDER_UNGROUPED ? null : folderId,
      });
      assignments.add(sessionId);
    }
  }

  // Pins once, across every record; a family the new state knows (pinned or
  // archived there) keeps its state.
  const base = Date.now();
  const pinEntries = entries
    .flatMap((entry) => entry.project.pinned)
    .filter((id, index, all) => all.indexOf(id) === index && !sessionIds.has(id))
    .slice(0, 500)
    .map((id, index) => ({ id, pinnedAt: base - index, archivedAt: null }));
  if (pinEntries.length > 0) await write({ action: "restore", entries: pinEntries });

  if (!ok) return false;
  removeLegacyLocalSessionOrg(keys, storage);
  return true;
}
