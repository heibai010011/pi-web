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
    return { version: STORAGE_VERSION, projects: parsed.projects };
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

/** Load one project's organization (server-side). */
export function readSessionOrgProject(
  projectKey: string | null | undefined,
  storePath = getSessionOrgStorePath(),
): SessionOrganization {
  if (!projectKey) return EMPTY_SESSION_ORGANIZATION;
  const store = readStore(storePath);
  return normalizeSessionOrganization(store.projects[projectKey]) ?? EMPTY_SESSION_ORGANIZATION;
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
