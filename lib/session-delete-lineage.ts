import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { sessionPathKey } from "./session-path";
import { SUBAGENT_META_TYPE } from "./subagents";
import type { SessionInfo } from "./types";

export interface ReparentResult {
  reparentedIds: string[];
  failedIds: string[];
  /** Restore every successfully rewritten child; returns ids that failed rollback. */
  rollback: () => string[];
}

interface PreparedChildRewrite {
  id: string;
  path: string;
  original: string;
  updated: string;
}

/**
 * Rewrite a subagent metadata entry so it keeps pointing at a live parent
 * after the recorded parent session was deleted and its children reparented.
 * Returns the updated file content, or null when nothing needs changing.
 * Malformed lines are left untouched (the caller already validated the
 * header; anything else must not block the reparent).
 */
function updateSubagentMetaParent(
  content: string,
  deletedSessionId: string,
  newParentSessionId: string | undefined,
  newParentSessionPath: string | undefined,
): string | null {
  const newline = content.indexOf("\n");
  const body = newline === -1 ? "" : content.slice(newline + 1);
  let changed = false;
  const updatedBody = body
    .split("\n")
    .map((line) => {
      if (!line.includes(SUBAGENT_META_TYPE)) return line;
      try {
        const entry = JSON.parse(line) as {
          type?: string;
          customType?: string;
          data?: { parentSessionId?: unknown; parentSessionPath?: unknown };
        };
        if (
          entry.type !== "custom"
          || entry.customType !== SUBAGENT_META_TYPE
          || typeof entry.data?.parentSessionId !== "string"
          || entry.data.parentSessionId !== deletedSessionId
        ) return line;
        if (newParentSessionId && newParentSessionPath) {
          entry.data.parentSessionId = newParentSessionId;
          entry.data.parentSessionPath = newParentSessionPath;
        } else {
          // Root-level delete: no live parent remains. Clear the recorded ids
          // so family resolution cannot chase a deleted session id.
          delete entry.data.parentSessionId;
          delete entry.data.parentSessionPath;
        }
        changed = true;
        return JSON.stringify(entry);
      } catch {
        return line;
      }
    })
    .join("\n");
  if (!changed) return null;
  return content.slice(0, newline + 1) + updatedBody;
}

/**
 * Reparent every persisted direct child before deleting its parent session.
 * Children may live in different encoded-cwd directories (subagents,
 * worktrees, custom cwd), so callers must pass the global session list rather
 * than scanning only the deleted file's sibling directory.
 *
 * Both the session header and any pi-web:subagent metadata entry are
 * rewritten; a stale metadata parent id would orphan the subagent from its
 * family resolution after the reparent.
 *
 * Validation is completed for every child before the first write. Each write
 * is atomic; if a later write fails, earlier files are rolled back before the
 * caller decides whether it is safe to delete the parent.
 */
export function reparentDirectChildSessions(
  sessions: SessionInfo[],
  deletedSessionId: string,
  deletedSessionPath: string,
  newParentSessionPath: string | undefined,
  newParentSessionId: string | undefined = undefined,
  writeAtomic: (path: string, content: string) => void = writePrivateFileAtomicSync,
): ReparentResult {
  const deletedPathKey = sessionPathKey(deletedSessionPath);
  const prepared: PreparedChildRewrite[] = [];
  const failedIds: string[] = [];

  // Candidate children come from two sources: the global session list
  // (covers cross-directory subagents/worktrees) plus a same-directory scan
  // (covers files the lister cannot see, e.g. transient test dirs or a
  // cache miss). Validation happens per file, so overlap is harmless.
  const candidatePaths = new Set<string>();
  for (const child of sessions) {
    if (child.parentSessionId === deletedSessionId && child.path) {
      candidatePaths.add(child.path);
    }
  }
  try {
    const deletedDir = dirname(deletedSessionPath);
    if (existsSync(deletedDir) && statSync(deletedDir).isDirectory()) {
      for (const file of readdirSync(deletedDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const candidate = join(deletedDir, file);
        if (sessionPathKey(candidate) !== deletedPathKey) candidatePaths.add(candidate);
      }
    }
  } catch { /* unreadable directory: global list remains the source */ }

  const seenIds = new Set<string>();
  for (const childPath of candidatePaths) {
    try {
      const original = readFileSync(childPath, "utf8");
      const newline = original.indexOf("\n");
      const headerText = newline === -1 ? original : original.slice(0, newline);
      const rest = newline === -1 ? "" : original.slice(newline);
      const header = JSON.parse(headerText) as { type?: string; id?: string; parentSession?: string };
      if (header.type !== "session" || typeof header.id !== "string") continue;
      // Same-session files can be reached through both sources; rewrite once.
      if (seenIds.has(header.id)) continue;
      seenIds.add(header.id);
      if (
        !header.parentSession
        || sessionPathKey(header.parentSession) !== deletedPathKey
      ) {
        continue;
      }
      if (newParentSessionPath) header.parentSession = newParentSessionPath;
      else delete header.parentSession;
      let updated = `${JSON.stringify(header)}${rest}`;
      const metaUpdated = updateSubagentMetaParent(
        updated,
        deletedSessionId,
        newParentSessionId,
        newParentSessionPath,
      );
      if (metaUpdated !== null) updated = metaUpdated;
      prepared.push({
        id: header.id,
        path: childPath,
        original,
        updated,
      });
    } catch {
      // A malformed or unreadable candidate file is skipped. Only files the
      // global list explicitly claims as children can veto the delete.
    }
  }

  // Children the global list knows about but that were not prepared above
  // (unreadable, or their recorded lineage does not match) must block the
  // delete rather than silently strand them.
  const preparedIds = new Set(prepared.map((child) => child.id));
  for (const child of sessions) {
    if (
      child.parentSessionId === deletedSessionId
      && child.path
      && !preparedIds.has(child.id)
    ) {
      failedIds.push(child.id);
    }
  }

  // No partial updates when any known child cannot even be prepared.
  if (failedIds.length > 0) return { reparentedIds: [], failedIds, rollback: () => [] };

  const written: PreparedChildRewrite[] = [];
  for (const child of prepared) {
    try {
      writeAtomic(child.path, child.updated);
      written.push(child);
    } catch {
      const rollbackFailedIds: string[] = [];
      for (const previous of written.toReversed()) {
        try {
          writeAtomic(previous.path, previous.original);
        } catch {
          rollbackFailedIds.push(previous.id);
        }
      }
      return {
        reparentedIds: rollbackFailedIds,
        failedIds: [child.id, ...rollbackFailedIds],
        rollback: () => [],
      };
    }
  }
  return {
    reparentedIds: written.map((child) => child.id),
    failedIds: [],
    rollback: () => {
      const rollbackFailedIds: string[] = [];
      for (const child of written.toReversed()) {
        try {
          writeAtomic(child.path, child.original);
        } catch {
          rollbackFailedIds.push(child.id);
        }
      }
      return rollbackFailedIds;
    },
  };
}
