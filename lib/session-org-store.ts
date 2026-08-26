import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {
  EMPTY_SESSION_ORGANIZATION,
  normalizeSessionOrganization,
  type SessionOrganization,
} from "./session-org-shape";

/**
 * Server-side persistence for session organization (pins, folders,
 * assignments). The browser keeps localStorage as an instant cache and mirrors
 * every change here, so organization survives clearing browser data or
 * switching browsers/machines on the same user profile.
 *
 * Shape: { version: 1, projects: Record<projectKey, SessionOrganization> }
 */

const STORAGE_VERSION = 1;

interface SessionOrgStore {
  version: number;
  projects: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getSessionOrgStorePath(): string {
  return join(getAgentDir(), "session-org.json");
}

function readStore(storePath: string): SessionOrgStore {
  if (!existsSync(storePath)) return { version: STORAGE_VERSION, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.projects)) {
      return { version: STORAGE_VERSION, projects: {} };
    }
    // Null-prototype copy: a project key like "__proto__" must not leak
    // through Object.prototype or silently disappear on write.
    const projects = Object.assign(Object.create(null) as Record<string, unknown>, parsed.projects);
    return { version: STORAGE_VERSION, projects };
  } catch {
    // Corrupt file: start over rather than blocking the UI.
    return { version: STORAGE_VERSION, projects: {} };
  }
}

function writeStore(store: SessionOrgStore, storePath: string): void {
  const dir = dirname(storePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writePrivateFileAtomicSync(storePath, JSON.stringify(store, null, 2));
}

export interface SessionOrgProjectEntry {
  exists: boolean;
  org: SessionOrganization;
}

/**
 * Load one project's organization and distinguish a missing project from an
 * intentionally empty one. That distinction prevents an old browser cache
 * from resurrecting folders the user deleted elsewhere.
 */
export function readSessionOrgProjectEntry(
  projectKey: string | null | undefined,
  storePath = getSessionOrgStorePath(),
): SessionOrgProjectEntry {
  if (!projectKey) return { exists: false, org: EMPTY_SESSION_ORGANIZATION };
  const store = readStore(storePath);
  const has = Object.prototype.hasOwnProperty.call(store.projects, projectKey);
  // A present-but-malformed record is NOT authoritative empty data: treating
  // it as an existing empty org would clobber the client's valid folders.
  // Report it as missing so the local cache wins and no empty write-back
  // destroys data.
  if (!has) return { exists: false, org: EMPTY_SESSION_ORGANIZATION };
  const normalized = normalizeSessionOrganization(store.projects[projectKey]);
  return normalized
    ? { exists: true, org: normalized }
    : { exists: false, org: EMPTY_SESSION_ORGANIZATION };
}

/** Load one project's organization (server-side). */
export function readSessionOrgProject(
  projectKey: string | null | undefined,
  storePath = getSessionOrgStorePath(),
): SessionOrganization {
  return readSessionOrgProjectEntry(projectKey, storePath).org;
}

/** Persist one project's organization (server-side). */
export function writeSessionOrgProject(
  projectKey: string,
  org: SessionOrganization,
  storePath = getSessionOrgStorePath(),
): void {
  const store = readStore(storePath);
  store.projects[projectKey] = org;
  writeStore(store, storePath);
}

/** Move a legacy single-project record into the per-project map. */
export function migrateSessionOrgLegacyEntry(
  projectKey: string,
  legacy: unknown,
  storePath = getSessionOrgStorePath(),
): void {
  if (!projectKey) return;
  const normalized = normalizeSessionOrganization(legacy);
  if (!normalized) return;
  const store = readStore(storePath);
  if (store.projects[projectKey]) return;
  store.projects[projectKey] = normalized;
  writeStore(store, storePath);
}
