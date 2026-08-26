import type { GroupedSessionTreeNode } from "./session-tree-groups";

export type SessionSidebarTimeSection = "active" | "today" | "yesterday" | "week" | "month";

export interface SessionSidebarSection {
  id: SessionSidebarTimeSection;
  trees: GroupedSessionTreeNode[];
}

function analyzeTree(
  root: GroupedSessionTreeNode,
  importantIds?: ReadonlySet<string>,
): { latest: number; important: boolean } {
  let latest = 0;
  let important = false;
  const stack = [root];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node.session.id)) continue;
    visited.add(node.session.id);
    const modified = Date.parse(node.session.modified);
    if (Number.isFinite(modified)) latest = Math.max(latest, modified);
    if (importantIds?.has(node.session.id)) important = true;
    stack.push(...node.children);
  }
  return { latest, important };
}

export function sessionTreeLatestModified(node: GroupedSessionTreeNode): number {
  return analyzeTree(node).latest;
}

function localDayStart(value: Date, daysAgo = 0): number {
  const day = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  day.setDate(day.getDate() - daysAgo);
  return day.getTime();
}

/** Build the focused view. Each complete tree appears in exactly one section. */
export function buildCurrentWorkSections(
  roots: GroupedSessionTreeNode[],
  importantIds: ReadonlySet<string>,
  now = new Date(),
): SessionSidebarSection[] {
  const buckets = new Map<SessionSidebarTimeSection, GroupedSessionTreeNode[]>([
    ["active", []], ["today", []], ["yesterday", []], ["week", []], ["month", []],
  ]);
  const today = localDayStart(now);
  const yesterday = localDayStart(now, 1);
  const week = localDayStart(now, 7);
  const month = localDayStart(now, 30);

  for (const tree of roots) {
    const facts = analyzeTree(tree, importantIds);
    if (facts.important) {
      buckets.get("active")!.push(tree);
      continue;
    }
    const modified = facts.latest;
    const section = modified >= today ? "today"
      : modified >= yesterday ? "yesterday"
      : modified >= week ? "week"
      : modified >= month ? "month"
      : null;
    if (section) buckets.get(section)!.push(tree);
  }
  return [...buckets.entries()]
    .filter(([, trees]) => trees.length > 0)
    .map(([id, trees]) => ({ id, trees }));
}

/** Split roots for the complete view; trees idle beyond 7 local days fold
 *  into a collapsed "older" group per folder/ungrouped section. */
export function splitOlderSessionTrees(
  roots: GroupedSessionTreeNode[],
  now = new Date(),
  days = 7,
): { recent: GroupedSessionTreeNode[]; older: GroupedSessionTreeNode[] } {
  const cutoff = localDayStart(now, days);
  const recent: GroupedSessionTreeNode[] = [];
  const older: GroupedSessionTreeNode[] = [];
  for (const tree of roots) {
    (sessionTreeLatestModified(tree) >= cutoff ? recent : older).push(tree);
  }
  return { recent, older };
}
