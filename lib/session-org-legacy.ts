/**
 * The shape of the session folders pi-web kept before 0.12
 * (`<agentDir>/session-org.json`, and the same JSON in the browser's
 * `pi-web:session-organization:*` localStorage keys), with the clean-up both
 * the server-side import and the browser-side one apply. Client-safe: the
 * parser is shared by `lib/session-org-migration.ts` (Node) and
 * `lib/legacy-local-folders.ts` (browser).
 */

import {
  FOLDER_UNGROUPED,
  MAX_FOLDER_NAME_LENGTH,
  MAX_FOLDER_PATTERN_LENGTH,
  MAX_SESSION_FOLDERS,
  SESSION_ID_PATTERN,
} from "./session-ui-state-shared";

const MAX_PROJECT_KEY_LENGTH = 4096;

export interface LegacySessionFolder {
  id: string;
  name: string;
  parentId?: string;
  autoPattern?: string;
}

export interface LegacySessionProject {
  projectKey: string;
  folders: LegacySessionFolder[];
  assignments: Record<string, string>;
  pinned: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function isProjectKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PROJECT_KEY_LENGTH && value !== "__proto__";
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name) return null;
  return [...name].slice(0, MAX_FOLDER_NAME_LENGTH).join("");
}

function cleanPattern(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const pattern = value.trim();
  return pattern ? [...pattern].slice(0, MAX_FOLDER_PATTERN_LENGTH).join("") : undefined;
}

function normalizeFolders(value: unknown): LegacySessionFolder[] {
  if (!Array.isArray(value)) return [];
  const folders: LegacySessionFolder[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (folders.length >= MAX_SESSION_FOLDERS) break;
    if (!isRecord(entry) || !isSessionId(entry.id) || seen.has(entry.id)) continue;
    const name = cleanName(entry.name);
    if (!name) continue;
    const folder: LegacySessionFolder = { id: entry.id, name };
    if (isSessionId(entry.parentId) && entry.parentId !== entry.id) folder.parentId = entry.parentId;
    const autoPattern = cleanPattern(entry.autoPattern);
    if (autoPattern) folder.autoPattern = autoPattern;
    folders.push(folder);
    seen.add(folder.id);
  }
  return folders;
}

function normalizeAssignments(value: unknown, folderIds: ReadonlySet<string>): Record<string, string> {
  const assignments: Record<string, string> = {};
  if (!isRecord(value)) return assignments;
  for (const [sessionId, folderId] of Object.entries(value)) {
    if (!isSessionId(sessionId) || typeof folderId !== "string") continue;
    if (folderId !== FOLDER_UNGROUPED && !folderIds.has(folderId)) continue;
    assignments[sessionId] = folderId;
  }
  return assignments;
}

function normalizePinned(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isSessionId))] : [];
}

function projectFromOrg(projectKey: string, raw: Record<string, unknown>, seenFolders: Set<string>): LegacySessionProject | null {
  const folders = normalizeFolders(raw.folders).filter((folder) => {
    // One folder id per state: keep the first project that claims it.
    if (seenFolders.has(folder.id)) return false;
    seenFolders.add(folder.id);
    return true;
  });
  const folderIds = new Set(folders.map((folder) => folder.id));
  const assignments = normalizeAssignments(raw.assignments, folderIds);
  const pinned = normalizePinned(raw.pinned);
  if (folders.length === 0 && pinned.length === 0 && Object.keys(assignments).length === 0) return null;
  return { projectKey, folders, assignments, pinned };
}

/** The old file's projects as clean plans; empty projects are dropped. */
export function parseLegacySessionOrgDocument(value: unknown): LegacySessionProject[] {
  if (!isRecord(value) || !isRecord(value.projects)) return [];
  const projects: LegacySessionProject[] = [];
  const seenFolders = new Set<string>();
  for (const [projectKey, raw] of Object.entries(value.projects)) {
    if (!isProjectKey(projectKey) || !isRecord(raw)) continue;
    const project = projectFromOrg(projectKey, raw, seenFolders);
    if (project) projects.push(project);
  }
  return projects;
}

/** One browser localStorage record, whose project comes from its key. */
export function parseLegacySessionOrgValue(value: unknown, projectKey: string): LegacySessionProject | null {
  if (!isProjectKey(projectKey) || !isRecord(value)) return null;
  return projectFromOrg(projectKey, value, new Set());
}
