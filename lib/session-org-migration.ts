/**
 * One-time import of the session folders the sidebar used before pi-web 0.12
 * (`<agentDir>/session-org.json`, written by the old `app/api/session-org`
 * route). The new sidebar keeps folders in `pi-web-session-state.json`
 * (`lib/session-ui-state.ts`), so an upgrade would otherwise show a user's
 * folders gone. Migration runs on the machine that holds the old file, before
 * its first `GET /api/sessions/ui-state`, and is idempotent: folder ids that
 * already exist are left alone, and the old file is renamed once the import
 * has run. It never reads another machine's data: the file lives beside pi's
 * own sessions in this profile's agent directory.
 *
 * The old browser cache (`pi-web:session-organization:*` in localStorage) is
 * imported by the client after this state has loaded (`lib/legacy-local-folders.ts`),
 * because only the browser can read it.
 */

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readRegularFileText } from "./regular-file";
import {
  parseLegacySessionOrgDocument,
  type LegacySessionFolder,
  type LegacySessionProject,
} from "./session-org-legacy";
import {
  getSessionUiStatePath,
  readSessionUiState,
  updateSessionUiState,
} from "./session-ui-state";
import { FOLDER_UNGROUPED } from "./session-ui-state-shared";

export { parseLegacySessionOrgDocument } from "./session-org-legacy";
export type { LegacySessionFolder, LegacySessionProject } from "./session-org-legacy";

const MAX_LEGACY_BYTES = 2 * 1024 * 1024;
const MAX_PINNED_ENTRIES = 500;

export interface LegacySessionOrgMigrationResult {
  /** True when at least one folder, assignment or pin was written. */
  imported: boolean;
  folders: number;
  assignments: number;
  pins: number;
}

export function getLegacySessionOrgPath(agentDir = getAgentDir()): string {
  return join(agentDir, "session-org.json");
}

function importedPath(path: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${path}.imported-${stamp}`;
}

/** Where the one run per agent dir is kept, so two GETs do not write twice at once. */
const RUNS_KEY: symbol = Symbol.for("pi-web:legacy-session-org-migrations");

function runs(): Map<string, Promise<LegacySessionOrgMigrationResult>> {
  const holder = globalThis as typeof globalThis & { [RUNS_KEY]?: Map<string, Promise<LegacySessionOrgMigrationResult>> };
  holder[RUNS_KEY] ??= new Map();
  return holder[RUNS_KEY]!;
}

async function runMigration(agentDir: string): Promise<LegacySessionOrgMigrationResult> {
  const result: LegacySessionOrgMigrationResult = { imported: false, folders: 0, assignments: 0, pins: 0 };
  const oldPath = getLegacySessionOrgPath(agentDir);
  if (!existsSync(oldPath)) return result;
  const text = readRegularFileText(oldPath, MAX_LEGACY_BYTES);
  if (text === undefined) return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A corrupt old file is not worth failing the sidebar for; leave it alone.
    return result;
  }
  const projects: LegacySessionProject[] = parseLegacySessionOrgDocument(parsed);
  if (projects.length === 0) return result;

  const statePath = getSessionUiStatePath(agentDir);
  const state = readSessionUiState(statePath);
  const folderIds = new Set((state.folders ?? []).map((folder) => folder.id));
  const assignments = { ...(state.folderAssignments ?? {}) };
  const sessionIds = new Set(Object.keys(state.sessions));

  const created: LegacySessionFolder[] = [];
  for (const project of projects) {
    for (const folder of project.folders) {
      if (folderIds.has(folder.id)) continue;
      // Parents are linked below, once every folder exists; creating with a
      // dangling id would read it as top level and never move it later.
      await updateSessionUiState({
        action: "create-folder",
        id: folder.id,
        name: folder.name,
        projectKey: project.projectKey,
        parentId: null,
      }, statePath);
      folderIds.add(folder.id);
      result.folders++;
      created.push(folder);
    }
  }
  for (const folder of created) {
    if (folder.parentId && folderIds.has(folder.parentId)) {
      await updateSessionUiState({ action: "move-folder", id: folder.id, parentId: folder.parentId }, statePath);
    }
    if (folder.autoPattern) {
      await updateSessionUiState({ action: "set-folder-rule", id: folder.id, autoPattern: folder.autoPattern }, statePath);
    }
  }
  for (const project of projects) {
    for (const [sessionId, folderId] of Object.entries(project.assignments)) {
      if (Object.hasOwn(assignments, sessionId)) continue;
      if (folderId !== FOLDER_UNGROUPED && !folderIds.has(folderId)) continue;
      await updateSessionUiState({ action: "move-session", sessionId, folderId: folderId === FOLDER_UNGROUPED ? null : folderId }, statePath);
      assignments[sessionId] = folderId;
      result.assignments++;
    }
  }

  // Old pins: only families the new state does not know yet, so a pin or an
  // archive made here is never overwritten. The file's order is kept (the
  // first id is the newest pin, as the old sidebar showed it).
  const base = Date.now();
  const pinEntries = projects
    .flatMap((project) => project.pinned)
    .filter((id, index, all) => all.indexOf(id) === index && !sessionIds.has(id))
    .slice(0, MAX_PINNED_ENTRIES)
    .map((id, index) => ({ id, pinnedAt: base - index, archivedAt: null }));
  if (pinEntries.length > 0) {
    await updateSessionUiState({ action: "restore", entries: pinEntries }, statePath);
    result.pins = pinEntries.length;
  }

  result.imported = result.folders > 0 || result.assignments > 0 || result.pins > 0;
  // Rename even when every entry was already there: the old file has been
  // considered, and a second copy would only be read again. A failed rename
  // leaves it for the next start; the import itself is idempotent.
  try {
    renameSync(oldPath, importedPath(oldPath));
  } catch {
    // Another process may hold it; importing again changes nothing.
  }
  return result;
}

/**
 * Import `<agentDir>/session-org.json` into the sidebar's state. One run per
 * agent dir at a time; a refused write leaves the old file for the next GET,
 * and every step is idempotent.
 */
export function migrateLegacySessionOrg(agentDir = getAgentDir()): Promise<LegacySessionOrgMigrationResult> {
  const active = runs();
  const running = active.get(agentDir);
  if (running) return running;
  const promise = runMigration(agentDir).finally(() => {
    active.delete(agentDir);
  });
  active.set(agentDir, promise);
  return promise;
}

/** Tests: forget in-flight runs (the state cache has its own reset). */
export function resetLegacySessionOrgMigrationForTests(): void {
  runs().clear();
}
