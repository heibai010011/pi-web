import { SESSION_ORG_UNGROUPED, type SessionOrganization } from "./session-org-shape";
import type { SessionInfo } from "./types";

export interface GroupedSessionTreeNode {
  session: SessionInfo;
  children: GroupedSessionTreeNode[];
}

export interface GroupedSessionTrees {
  pinned: GroupedSessionTreeNode[];
  folders: Map<string, GroupedSessionTreeNode[]>;
  ungrouped: GroupedSessionTreeNode[];
  /** Effective folder after parent inheritance; null for pinned/ungrouped. */
  effectiveFolderBySessionId: Map<string, string | null>;
}

type GroupKey = "pinned" | "ungrouped" | `folder:${string}`;

/**
 * Group sessions without destroying their parent/child shape.
 *
 * An explicit pin/folder assignment starts a new group branch. Descendants
 * without an explicit placement inherit that group, so a subagent remains
 * nested below its parent when the parent is moved into a folder or pinned.
 * A descendant explicitly moved elsewhere becomes a root in that target group.
 */
export function groupSessionTrees(
  sessions: SessionInfo[],
  pinnedIds: ReadonlySet<string>,
  assignments: Readonly<Record<string, string>>,
  folderIds: ReadonlySet<string>,
): GroupedSessionTrees {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const groupById = new Map<string, GroupKey>();

  const resolveGroup = (sessionId: string, visiting = new Set<string>()): GroupKey => {
    const cached = groupById.get(sessionId);
    if (cached) return cached;
    if (visiting.has(sessionId)) return "ungrouped";
    visiting.add(sessionId);

    const session = byId.get(sessionId);
    let group: GroupKey = "ungrouped";
    if (pinnedIds.has(sessionId)) {
      group = "pinned";
    } else {
      const assignedFolder = assignments[sessionId];
      if (assignedFolder === SESSION_ORG_UNGROUPED) {
        group = "ungrouped";
      } else if (assignedFolder && folderIds.has(assignedFolder)) {
        group = `folder:${assignedFolder}`;
      } else if (session?.parentSessionId && byId.has(session.parentSessionId)) {
        group = resolveGroup(session.parentSessionId, visiting);
      }
    }
    visiting.delete(sessionId);
    groupById.set(sessionId, group);
    return group;
  };

  for (const session of sessions) resolveGroup(session.id);

  const nodes = new Map<string, GroupedSessionTreeNode>();
  for (const session of sessions) nodes.set(session.id, { session, children: [] });

  const result: GroupedSessionTrees = {
    pinned: [],
    folders: new Map([...folderIds].map((id) => [id, []])),
    ungrouped: [],
    effectiveFolderBySessionId: new Map(
      [...groupById].map(([sessionId, group]) => [
        sessionId,
        group.startsWith("folder:") ? group.slice("folder:".length) : null,
      ]),
    ),
  };
  const rootsFor = (group: GroupKey): GroupedSessionTreeNode[] => {
    if (group === "pinned") return result.pinned;
    if (group === "ungrouped") return result.ungrouped;
    return result.folders.get(group.slice("folder:".length)) ?? result.ungrouped;
  };

  const hasExplicitPlacement = (sessionId: string): boolean => {
    if (pinnedIds.has(sessionId)) return true;
    const folderId = assignments[sessionId];
    return folderId === SESSION_ORG_UNGROUPED || Boolean(folderId && folderIds.has(folderId));
  };
  const wouldCreateCycle = (sessionId: string, parentId: string): boolean => {
    let current: string | undefined = parentId;
    const visited = new Set<string>();
    while (current && !visited.has(current)) {
      if (current === sessionId) return true;
      visited.add(current);
      current = byId.get(current)?.parentSessionId;
    }
    return false;
  };

  for (const session of sessions) {
    const node = nodes.get(session.id)!;
    const group = groupById.get(session.id)!;
    const parentId = session.parentSessionId;
    if (
      parentId
      && nodes.has(parentId)
      && groupById.get(parentId) === group
      && !hasExplicitPlacement(session.id)
      && !wouldCreateCycle(session.id, parentId)
    ) {
      nodes.get(parentId)!.children.push(node);
    } else {
      rootsFor(group).push(node);
    }
  }

  const sort = (items: GroupedSessionTreeNode[]) => {
    items.sort((a, b) => b.session.modified.localeCompare(a.session.modified));
    for (const item of items) sort(item.children);
  };
  sort(result.pinned);
  sort(result.ungrouped);
  for (const trees of result.folders.values()) sort(trees);
  return result;
}

/**
 * Purge a deleted session while preserving the visible organization of its
 * surviving direct children. The session DELETE route reparents those children
 * to the deleted session's parent, so without this handoff they can suddenly
 * fall out of the folder/pinned group they were displayed in.
 */
export function removeSessionOrganizationReferences(
  org: SessionOrganization,
  deletedSessionId: string,
  sessions: SessionInfo[],
): SessionOrganization {
  const assignments = { ...org.assignments };
  const directPlacement = assignments[deletedSessionId];
  // Resolve folder inheritance without pin precedence: a pinned session can
  // still carry a folder assignment that its children must retain after the
  // pinned parent is deleted.
  const effectiveFolder = groupSessionTrees(
    sessions,
    new Set(),
    org.assignments,
    new Set(org.folders.map((folder) => folder.id)),
  ).effectiveFolderBySessionId.get(deletedSessionId) ?? null;
  const inheritedFolder = directPlacement === SESSION_ORG_UNGROUPED
    ? SESSION_ORG_UNGROUPED
    : effectiveFolder;
  const wasPinned = org.pinned.includes(deletedSessionId);
  const directChildren = sessions.filter((session) => session.parentSessionId === deletedSessionId);
  for (const child of directChildren) {
    if (assignments[child.id] === undefined && inheritedFolder !== null) {
      assignments[child.id] = inheritedFolder;
    }
  }
  delete assignments[deletedSessionId];

  const pinned = org.pinned.filter((id) => id !== deletedSessionId);
  if (wasPinned) {
    for (const child of directChildren.toReversed()) {
      if (!pinned.includes(child.id)) pinned.unshift(child.id);
    }
  }
  return { ...org, pinned, assignments };
}

export function countSessionTreeNodes(nodes: GroupedSessionTreeNode[]): number {
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count += 1;
    stack.push(...node.children);
  }
  return count;
}
