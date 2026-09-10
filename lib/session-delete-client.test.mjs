import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { readDeletedSessionIds } = await jiti.import("./session-delete-client.ts");
const { removeDeletedSessionOrganizationReferences } = await jiti.import("./session-tree-groups.ts");

test("UI consumes all cascade IDs, including partial-error responses", async () => {
  assert.deepEqual(await readDeletedSessionIds(Response.json({ ok: true, deletedIds: ["p", "c", "c"] }), "p"), ["p", "c"]);
  assert.deepEqual(await readDeletedSessionIds(Response.json({ error: "rollback", deletedIds: ["c"] }, { status: 500 }), "p"), ["c"]);
  assert.deepEqual(await readDeletedSessionIds(Response.json({ ok: true }), "p"), ["p"]);
  assert.deepEqual(await readDeletedSessionIds(new Response("bad", { status: 500 }), "p"), []);
});

test("cascade organization cleanup removes every deleted ID and preserves fork family placement", () => {
  const sessions = [
    { id: "p" }, { id: "c", parentSessionId: "p", relation: { kind: "subagent", parentSessionId: "p" } },
    { id: "n", parentSessionId: "c", relation: { kind: "subagent", parentSessionId: "c" } },
    { id: "fork", parentSessionId: "n", relation: { kind: "fork" } },
    { id: "fork-child", parentSessionId: "fork", relation: { kind: "subagent", parentSessionId: "fork" } },
  ].map((s) => ({ created: "", modified: "", path: s.id, cwd: "x", firstMessage: "", messageCount: 1, ...s }));
  const org = { version: 1, folders: [{ id: "folder", name: "Folder", createdAt: 1 }], assignments: { p: "folder", c: "folder", n: "folder", "fork-child": "folder" }, pinned: ["p", "c", "n"] };
  const next = removeDeletedSessionOrganizationReferences(org, ["p", "c", "n"], sessions);
  assert.equal(next.assignments.fork, "folder");
  assert.equal(next.assignments["fork-child"], "folder");
  for (const id of ["p", "c", "n"]) { assert.equal(next.assignments[id], undefined); assert.equal(next.pinned.includes(id), false); }
  assert.ok(next.pinned.includes("fork"));
});
