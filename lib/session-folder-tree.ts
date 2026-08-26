import type { SessionFolder } from "./session-org-shape";

/**
 * Pure helpers for nested folders. Nesting is organization metadata only —
 * sessions are still assigned to a single folder id, so legacy stores without
 * parentId keep working unchanged and no session files are ever touched.
 */

export interface FolderNode {
  folder: SessionFolder;
  children: FolderNode[];
}

export function folderChildren(folders: readonly SessionFolder[], parentId: string | null | undefined): SessionFolder[] {
  return folders.filter((folder) => (folder.parentId ?? null) === (parentId ?? null));
}

/** Build a tree ignoring dangling parents and cycles defensively. */
export function buildFolderTree(folders: readonly SessionFolder[]): FolderNode[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const nodes = new Map<string, FolderNode>();
  for (const folder of folders) nodes.set(folder.id, { folder, children: [] });

  // A folder is a root when it has no parent, the parent is missing, or the
  // parent chain loops back into itself (cycle broken at the first repeat).
  const isRoot = (folder: SessionFolder): boolean => {
    const parentId = folder.parentId;
    if (!parentId || !byId.has(parentId)) return true;
    const seen = new Set<string>([folder.id]);
    let current: SessionFolder | undefined = byId.get(parentId);
    while (current) {
      if (seen.has(current.id)) return true; // cycle: every member becomes a root
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };

  const roots: FolderNode[] = [];
  for (const folder of folders) {
    if (!isRoot(folder)) continue;
    const node = nodes.get(folder.id)!;
    if (folder.parentId) {
      // Dangling or cycle-broken parent: normalize to top level in output.
      node.folder = { ...folder, parentId: null };
    }
    roots.push(node);
  }
  // Attach non-root folders under their (validated, cycle-free) parents.
  for (const folder of folders) {
    if (isRoot(folder)) continue;
    const parentNode = nodes.get(folder.parentId!)!;
    parentNode.children.push(nodes.get(folder.id)!);
  }
  return roots;
}

/** True when moving `folderId` under `targetParentId` would create a cycle.
 *  Also returns true when the target's own ancestor chain is already cyclic
 *  (corrupt metadata) — attaching anything into a loop is always rejected
 *  instead of looping forever. */
export function wouldCreateFolderCycle(
  folders: readonly SessionFolder[],
  folderId: string,
  targetParentId: string,
): boolean {
  if (folderId === targetParentId) return true;
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const visited = new Set<string>();
  let current: SessionFolder | undefined = byId.get(targetParentId);
  while (current) {
    if (current.id === folderId) return true;
    if (visited.has(current.id)) return true; // pre-existing cycle in metadata
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

/** All descendant folder ids of `folderId` (excluding itself). */
export function folderDescendantIds(folders: readonly SessionFolder[], folderId: string): Set<string> {
  const descendants = new Set<string>();
  let frontier = [folderId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const folder of folders) {
      if (frontier.includes(folder.parentId ?? "") && !descendants.has(folder.id) && folder.id !== folderId) {
        descendants.add(folder.id);
        next.push(folder.id);
      }
    }
    frontier = next;
  }
  return descendants;
}

/** `folderId` plus every descendant — used for aggregated counts. */
export function folderSubtreeIds(folders: readonly SessionFolder[], folderId: string): Set<string> {
  const subtree = folderDescendantIds(folders, folderId);
  subtree.add(folderId);
  return subtree;
}

/**
 * Deleting a folder promotes its subfolders to the deleted folder's own
 * parent. If the deleted folder sat in (or led into) corrupt metadata, the
 * promotion target is validated so no child ever ends up pointing at itself,
 * at the deleted id, or into a loop — those fall back to the top level.
 */
export function removeFolderPromotingChildren(
  folders: readonly SessionFolder[],
  folderId: string,
): SessionFolder[] {
  const deleted = folders.find((folder) => folder.id === folderId);
  const grandparent = deleted?.parentId ?? null;
  const remaining = folders.filter((folder) => folder.id !== folderId);
  const grandparentExists = grandparent !== null
    && remaining.some((folder) => folder.id === grandparent);
  return remaining.map((folder) => {
    if (folder.parentId !== folderId) return folder;
    if (!grandparentExists || grandparent === folder.id
      || wouldCreateFolderCycle(remaining, folder.id, grandparent)) {
      return { ...folder, parentId: null };
    }
    return { ...folder, parentId: grandparent };
  });
}
