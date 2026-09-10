import { readFileSync, readdirSync, existsSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { sessionPathKey } from "./session-path";
import { SUBAGENT_META_TYPE } from "./subagents";
import type { SessionInfo } from "./types";
import { readSessionHeader, readSessionRelationEntries } from "./session-reader";

export interface SessionDeletionPlan {
  deletedIds: string[];
  deletedPaths: Map<string, string>;
  rewrites: PreparedChildRewrite[];
}

/** Build from the global disk list plus *all* runtime snapshots (including empty sessions).
 * Only subagent ownership edges cascade. A normal fork is a boundary: it and
 * its own subagents survive. Read relation metadata beyond the list scanner's
 * bounded prefix, and use header lineage to distinguish inherited fork metadata.
 */
export type DeletionSessionInfo = SessionInfo & { runtimeContent?: string };

export function planSessionDeletion(sessions: DeletionSessionInfo[], rootId: string, rootPath: string): SessionDeletionPlan {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const paths = new Set<string>();
  if (rootPath) paths.add(rootPath);
  // Global scanned relations already cover cross-cwd children. Only supplement
  // the requested custom directory; never read all historical JSONL bodies.
  for (const directory of rootPath ? [dirname(rootPath)] : []) {
    try {
      for (const name of readdirSync(directory)) {
        if (name.endsWith(".jsonl")) paths.add(join(directory, name));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  type Node = { id: string; path: string; original?: string; header?: Record<string, unknown>; parentPath?: string; parentId?: string; subagent: boolean; metadataParent?: string };
  const nodes = new Map<string, Node>();
  for (const session of sessions) nodes.set(session.id, {
    id: session.id, path: session.path, parentId: session.parentSessionId,
    subagent: session.relation?.kind === "subagent",
    ...(session.relation?.kind === "subagent" ? { metadataParent: session.relation.parentSessionId } : {}),
  });
  for (const session of sessions) {
    if (session.runtimeContent && session.path) paths.add(session.path);
  }
  for (const path of paths) {
    const runtime = sessions.find((session) => session.path && sessionPathKey(session.path) === sessionPathKey(path))?.runtimeContent;
    let header: Record<string, unknown>;
    let entries: Array<{ type?: string; customType?: string; data?: unknown }>;
    try {
      header = readSessionHeader(path) as unknown as Record<string, unknown>;
      entries = readSessionRelationEntries(path);
    } catch (error) {
      if (runtime) {
        const lines = runtime.trimEnd().split("\n").map((line) => JSON.parse(line));
        header = lines[0]; entries = lines.slice(1);
      } else {
        if (path === rootPath && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        continue;
      }
    }
    if (header?.type !== "session" || typeof header.id !== "string") continue;
    const metadata = entries.find((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE)?.data as
      { parentSessionId?: string; parentSessionPath?: string } | undefined;
    const known = nodes.get(header.id);
    const parentPath = typeof header.parentSession === "string" ? header.parentSession : undefined;
    const inheritedForkMetadata = parentPath && metadata?.parentSessionPath
      && sessionPathKey(parentPath) !== sessionPathKey(metadata.parentSessionPath);
    nodes.set(header.id, {
      id: header.id, path, original: runtime, header, parentPath,
      parentId: byId.get(header.id)?.parentSessionId,
      subagent: !inheritedForkMetadata && Boolean(metadata?.parentSessionId || known?.subagent),
      metadataParent: metadata?.parentSessionId ?? known?.metadataParent,
    });
  }
  if (!nodes.has(rootId)) nodes.set(rootId, { id: rootId, path: rootPath, subagent: false });
  const pathIds = new Map([...nodes.values()].filter((n) => n.path).map((n) => [sessionPathKey(n.path), n.id]));
  // A cached/custom root can have an ancestor outside the scanner's directories.
  for (const node of nodes.values()) {
    if (!node.parentPath || pathIds.has(sessionPathKey(node.parentPath))) continue;
    try {
      const header = readSessionHeader(node.parentPath);
      if (!header?.id) continue;
      pathIds.set(sessionPathKey(node.parentPath), header.id);
      if (!nodes.has(header.id)) nodes.set(header.id, {
        id: header.id, path: node.parentPath, parentPath: header.parentSession, subagent: false,
      });
    } catch { /* Missing ancestor: surviving forks become roots. */ }
  }
  for (const node of nodes.values()) {
    node.parentId = (node.parentPath ? pathIds.get(sessionPathKey(node.parentPath)) : undefined)
      ?? (node.subagent ? node.metadataParent : node.parentId);
  }
  const validated = new Set<string>();
  const validateCandidate = (node: Node) => {
    if (validated.has(node.id)) return;
    validated.add(node.id);
    try { node.original = readFileSync(node.path, "utf8"); } catch (error) {
      if (!node.original && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      node.original ??= byId.get(node.id)?.runtimeContent;
      if (!node.original) return;
    }
    const lines = node.original.split("\n");
    node.header = JSON.parse(lines[0]);
    if (node.header?.id !== node.id) throw new Error(`Session identity changed: ${node.id}`);
    node.parentPath = typeof node.header.parentSession === "string" ? node.header.parentSession : undefined;
    node.subagent = false;
    for (const line of lines.slice(1)) {
      if (!line.includes(SUBAGENT_META_TYPE)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_META_TYPE) continue;
      const meta = entry.data;
      if (meta?.version !== 1 || typeof meta.parentSessionId !== "string") continue;
      node.metadataParent = meta.parentSessionId;
      node.subagent = !node.parentPath || typeof meta.parentSessionPath !== "string"
        || sessionPathKey(node.parentPath) === sessionPathKey(meta.parentSessionPath);
      break;
    }
    node.parentId = (node.parentPath ? pathIds.get(sessionPathKey(node.parentPath)) : undefined)
      ?? (node.subagent ? node.metadataParent : node.parentId);
  };
  const deleted = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes.values()) {
      if (deleted.has(node.id) || !node.parentId || !deleted.has(node.parentId)) continue;
      validateCandidate(node);
      if (node.subagent && node.parentId && deleted.has(node.parentId)) {
        deleted.add(node.id);
        changed = true;
      }
    }
  }
  const rewrites: PreparedChildRewrite[] = [];
  for (const node of nodes.values()) {
    if (deleted.has(node.id) || !node.parentId || !deleted.has(node.parentId)) continue;
    const oldParent = node.parentId;
    let parentId: string | undefined = oldParent;
    const visited = new Set<string>();
    while (parentId && deleted.has(parentId)) {
      if (visited.has(parentId)) throw new Error("Cyclic session ancestry");
      visited.add(parentId);
      parentId = nodes.get(parentId)?.parentId;
    }
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (node.original === undefined) node.original = readFileSync(node.path, "utf8");
    if (!node.header) node.header = JSON.parse(node.original.split("\n", 1)[0]);
    const header = { ...node.header };
    if (parent?.path) header.parentSession = parent.path;
    else delete header.parentSession;
    const newline = node.original.indexOf("\n");
    let updated = JSON.stringify(header) + (newline < 0 ? "" : node.original.slice(newline));
    // A fork can contain copied subagent entries. Preserve resource/history
    // data, but remove the copied ownership IDs instead of assigning this fork
    // to the new ancestor as though it were that ancestor's subagent.
    if (!node.subagent && node.metadataParent) {
      updated = updateSubagentMetaParent(updated, node.metadataParent, undefined, undefined) ?? updated;
    } else {
      updated = updateSubagentMetaParent(updated, oldParent, parent?.id, parent?.path) ?? updated;
    }
    rewrites.push({ id: node.id, path: node.path, original: node.original, updated });
  }
  return { deletedIds: [...deleted], deletedPaths: new Map([...deleted].map((id) => [id, nodes.get(id)?.path ?? ""])), rewrites };
}

/** All filesystem steps are synchronous after runtimes have drained. On ordinary
 * I/O failure restore every changed file; report rollback failures explicitly.
 * This is request-atomic, not a crash-recovery journal.
 */
export function applySessionDeletion(plan: SessionDeletionPlan, io = {
  write: writePrivateFileAtomicSync,
  unlink: unlinkSync,
  read: (path: string) => readFileSync(path, "utf8"),
}): { deletedIds: string[]; rollbackFailedIds: string[]; error?: string } {
  const backups = new Map<string, { path: string; content: string }>();
  const changed: string[] = [];
  try {
    for (const [id, path] of plan.deletedPaths) {
      if (!path) continue;
      try { backups.set(id, { path, content: io.read(path) }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const rewrite of plan.rewrites) {
      backups.set(rewrite.id, { path: rewrite.path, content: rewrite.original });
      changed.push(rewrite.id);
      io.write(rewrite.path, rewrite.updated);
    }
    for (const [id, path] of plan.deletedPaths) {
      if (!path) continue;
      try { io.unlink(path); changed.push(id); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { deletedIds: plan.deletedIds, rollbackFailedIds: [] };
  } catch (error) {
    const rollbackFailedIds: string[] = [];
    for (const id of changed.toReversed()) {
      const backup = backups.get(id);
      if (!backup) continue;
      try { io.write(backup.path, backup.content); } catch { rollbackFailedIds.push(id); }
    }
    return {
      deletedIds: plan.deletedIds.filter((id) => rollbackFailedIds.includes(id)),
      rollbackFailedIds,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface ReparentResult {
  reparentedIds: string[];
  failedIds: string[];
  /** Restore every successfully rewritten child; returns ids that failed rollback. */
  rollback: () => string[];
}

export interface PreparedChildRewrite {
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
