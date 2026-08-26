import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { countSessionTreeNodes, groupSessionTrees, removeSessionOrganizationReferences } = await jiti.import("./session-tree-groups.ts");

const session = (id, parentSessionId, modified = "2026-01-01T00:00:00.000Z", relation) => ({
  id,
  path: `${id}.jsonl`,
  cwd: "/repo",
  created: modified,
  modified,
  messageCount: 1,
  firstMessage: id,
  ...(parentSessionId ? { parentSessionId } : {}),
  ...(relation ? { relation } : {}),
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

test("deleting a pinned parent does not pin children with explicit placement", () => {
  const next = removeSessionOrganizationReferences(
    {
      pinned: ["parent"],
      folders: [{ id: "review", name: "Review" }],
      assignments: { child: "review" },
      collapsedFolders: [],
    },
    "parent",
    [session("parent"), session("child", "parent"), session("heir", "parent")],
  );
  // child keeps its explicit Review folder and must NOT be force-pinned.
  assert.equal(next.assignments.child, "review");
  assert.equal(next.pinned.includes("child"), false);
  // heir had no placement of its own: it inherits the pin handdown.
  assert.equal(next.pinned.includes("heir"), true);
});

test("deleting a parent purges subagent children's organization references", () => {
  // Upstream hides subagent rows inside their root's row; after that root is
  // deleted those hidden rows must not leave stale assignments or pins behind.
  const next = removeSessionOrganizationReferences(
    {
      pinned: ["sub", "parent"],
      folders: [{ id: "work", name: "Work" }],
      assignments: { parent: "work", sub: "work" },
      collapsedFolders: [],
    },
    "parent",
    [
      session("parent"),
      session("sub", "parent", "2026-01-02T00:00:00.000Z", {
        kind: "subagent",
        parentSessionId: "parent",
        profile: "p",
        description: "d",
        status: "completed",
      }),
      session("fork", "parent"),
    ],
  );
  assert.equal(next.assignments.sub, undefined);
  assert.equal(next.pinned.includes("sub"), false);
  // A fork child still renders as its own row and keeps the inheritance handoff.
  assert.equal(next.assignments.fork, "work");
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

test("deleting a parent hands its inherited folder to children", () => {
  const sessions = [session("grand"), session("parent", "grand"), session("child", "parent")];
  const org = {
    pinned: [],
    folders: [{ id: "work", name: "Work" }],
    assignments: { grand: "work" },
    collapsedFolders: [],
  };
  const next = removeSessionOrganizationReferences(org, "parent", sessions);
  assert.equal(next.assignments.child, "work");
});

test("deleting an explicitly ungrouped parent keeps children ungrouped", () => {
  const sessions = [session("grand"), session("parent", "grand"), session("child", "parent")];
  const org = {
    pinned: [],
    folders: [{ id: "work", name: "Work" }],
    assignments: { grand: "work", parent: "__pi-web-ungrouped__" },
    collapsedFolders: [],
  };
  const next = removeSessionOrganizationReferences(org, "parent", sessions);
  assert.equal(next.assignments.child, "__pi-web-ungrouped__");
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
