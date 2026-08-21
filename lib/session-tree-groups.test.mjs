import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { countSessionTreeNodes, groupSessionTrees, removeSessionOrganizationReferences } = await jiti.import("./session-tree-groups.ts");

const session = (id, parentSessionId, modified = "2026-01-01T00:00:00.000Z") => ({
  id,
  path: `${id}.jsonl`,
  cwd: "/repo",
  created: modified,
  modified,
  messageCount: 1,
  firstMessage: id,
  ...(parentSessionId ? { parentSessionId } : {}),
});

test("children inherit a parent's folder and remain nested", () => {
  const grouped = groupSessionTrees(
    [session("parent"), session("child", "parent"), session("grandchild", "child")],
    new Set(),
    { parent: "work" },
    new Set(["work"]),
  );
  const roots = grouped.folders.get("work");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].session.id, "parent");
  assert.equal(roots[0].children[0].session.id, "child");
  assert.equal(roots[0].children[0].children[0].session.id, "grandchild");
  assert.equal(countSessionTreeNodes(roots), 3);
  assert.equal(grouped.ungrouped.length, 0);
});

test("explicit child placement starts a root in its own group", () => {
  const grouped = groupSessionTrees(
    [session("parent"), session("child", "parent")],
    new Set(),
    { parent: "work", child: "review" },
    new Set(["work", "review"]),
  );
  assert.equal(grouped.folders.get("work")[0].children.length, 0);
  assert.equal(grouped.folders.get("review")[0].session.id, "child");
});

test("pinned parent retains unpinned children while explicitly pinned child becomes a root", () => {
  const inherited = groupSessionTrees(
    [session("parent"), session("child", "parent")],
    new Set(["parent"]),
    {},
    new Set(),
  );
  assert.equal(inherited.pinned[0].children[0].session.id, "child");

  const explicit = groupSessionTrees(
    [session("parent"), session("child", "parent")],
    new Set(["parent", "child"]),
    {},
    new Set(),
  );
  assert.deepEqual(explicit.pinned.map((node) => node.session.id).sort(), ["child", "parent"]);
});

test("explicit ungrouped placement removes a child from inherited folder", () => {
  const grouped = groupSessionTrees(
    [session("parent"), session("child", "parent")],
    new Set(),
    { parent: "work", child: "__pi-web-ungrouped__" },
    new Set(["work"]),
  );
  assert.equal(grouped.folders.get("work")[0].children.length, 0);
  assert.equal(grouped.ungrouped[0].session.id, "child");
});

test("deleting a grouped parent hands organization to surviving children", () => {
  const sessions = [session("grand"), session("parent", "grand"), session("child", "parent")];
  const org = {
    pinned: ["parent"],
    folders: [{ id: "work", name: "Work" }],
    assignments: { parent: "work" },
    collapsedFolders: [],
  };
  const next = removeSessionOrganizationReferences(org, "parent", sessions);
  assert.equal(next.assignments.parent, undefined);
  assert.equal(next.assignments.child, "work");
  assert.deepEqual(next.pinned, ["child"]);
});

test("explicit child organization survives parent deletion", () => {
  const sessions = [session("parent"), session("child", "parent")];
  const org = {
    pinned: [],
    folders: [{ id: "work", name: "Work" }, { id: "review", name: "Review" }],
    assignments: { parent: "work", child: "review" },
    collapsedFolders: [],
  };
  const next = removeSessionOrganizationReferences(org, "parent", sessions);
  assert.equal(next.assignments.child, "review");
});

test("dangling assignments and parent cycles safely fall back to ungrouped", () => {
  const grouped = groupSessionTrees(
    [session("a", "b"), session("b", "a"), session("orphan", "missing")],
    new Set(),
    { orphan: "deleted-folder" },
    new Set(),
  );
  assert.equal(countSessionTreeNodes(grouped.ungrouped), 3);
});
