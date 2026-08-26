import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

delete globalThis.__piPendingSessionFolderDrafts;
const jiti = createJiti(import.meta.url);
const {
  buildFolderTree,
  folderDescendantIds,
  folderSubtreeIds,
  removeFolderPromotingChildren,
  wouldCreateFolderCycle,
} = await jiti.import("./session-folder-tree.ts");
const { normalizeSessionOrganization } = await jiti.import("./session-org-shape.ts");

const folder = (id, parentId) => (parentId === undefined ? { id, name: id } : { id, name: id, parentId });

test("legacy folders without parentId stay top level unchanged", () => {
  const org = normalizeSessionOrganization({
    pinned: [], folders: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    assignments: {}, collapsedFolders: [],
  });
  assert.deepEqual(org.folders.map((f) => f.parentId ?? null), [null, null]);
});

test("normalize keeps valid nesting and drops dangling or self parents", () => {
  const org = normalizeSessionOrganization({
    pinned: [],
    folders: [
      { id: "root", name: "Root" },
      { id: "child", name: "Child", parentId: "root" },
      { id: "self", name: "Self", parentId: "self" },
      { id: "missing", name: "Missing", parentId: "ghost" },
    ],
    assignments: {}, collapsedFolders: [],
  });
  const byId = Object.fromEntries(org.folders.map((f) => [f.id, f]));
  assert.equal(byId.child.parentId, "root");
  assert.equal(byId.self.parentId, undefined);
  // Dangling parentId is kept structurally but buildFolderTree promotes it.
  assert.equal(byId.missing.parentId, "ghost");
});

test("buildFolderTree nests children and promotes cycles/dangles to roots", () => {
  const roots = buildFolderTree([
    folder("a"), folder("a1", "a"), folder("a1b", "a1"),
    folder("cycleA", "cycleB"), folder("cycleB", "cycleA"),
    folder("dangle", "ghost"),
  ]);
  const byName = Object.fromEntries(roots.map((node) => [node.folder.id, node]));
  assert.deepEqual(byName.a.children.map((n) => n.folder.id), ["a1"]);
  assert.equal(byName.a.children[0].children[0].folder.id, "a1b");
  assert.equal(byName.cycleA.folder.parentId, null);
  assert.equal(byName.cycleB.folder.parentId, null);
  assert.equal(byName.dangle.folder.parentId, null);
});

test("move cycle guard and descendant computation", () => {
  const folders = [folder("p"), folder("c", "p"), folder("g", "c")];
  assert.equal(wouldCreateFolderCycle(folders, "p", "g"), true);
  assert.equal(wouldCreateFolderCycle(folders, "g", "p"), false);
  assert.deepEqual([...folderDescendantIds(folders, "p")].sort(), ["c", "g"]);
  assert.deepEqual([...folderSubtreeIds(folders, "c")].sort(), ["c", "g"]);
});

test("deleting a folder promotes subfolders to its own parent", () => {
  const folders = [folder("root"), folder("mid", "root"), folder("leaf", "mid"), folder("other")];
  const next = removeFolderPromotingChildren(folders, "mid");
  assert.deepEqual(next.map((f) => f.id).sort(), ["leaf", "other", "root"]);
  assert.equal(next.find((f) => f.id === "leaf").parentId, "root");
});
