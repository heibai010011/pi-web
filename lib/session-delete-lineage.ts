import { readFileSync } from "node:fs";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { sessionPathKey } from "./session-path";
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
 * Reparent every persisted direct child before deleting its parent session.
 * Children may live in different encoded-cwd directories (subagents,
 * worktrees, custom cwd), so callers must pass the global session list rather
 * than scanning only the deleted file's sibling directory.
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
  writeAtomic: (path: string, content: string) => void = writePrivateFileAtomicSync,
): ReparentResult {
  const deletedPathKey = sessionPathKey(deletedSessionPath);
  const prepared: PreparedChildRewrite[] = [];
  const failedIds: string[] = [];

  for (const child of sessions) {
    if (child.parentSessionId !== deletedSessionId || !child.path) continue;
    try {
      const original = readFileSync(child.path, "utf8");
      const newline = original.indexOf("\n");
      const headerText = newline === -1 ? original : original.slice(0, newline);
      const rest = newline === -1 ? "" : original.slice(newline);
      const header = JSON.parse(headerText) as { type?: string; parentSession?: string };
      if (
        header.type !== "session"
        || !header.parentSession
        || sessionPathKey(header.parentSession) !== deletedPathKey
      ) {
        failedIds.push(child.id);
        continue;
      }
      if (newParentSessionPath) header.parentSession = newParentSessionPath;
      else delete header.parentSession;
      prepared.push({
        id: child.id,
        path: child.path,
        original,
        updated: `${JSON.stringify(header)}${rest}`,
      });
    } catch {
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
