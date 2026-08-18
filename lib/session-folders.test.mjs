import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./session-folders.ts");
}

test("normalizes valid and invalid stored organization", async () => {
  const { normalizeSessionOrganization } = await loadSubject();

  const valid = {
    pinned: ["a", "b"],
    folders: [{ id: "f1", name: "Work" }],
    assignments: { a: "f1" },
    collapsedFolders: ["f1"],
  };
  assert.deepEqual(normalizeSessionOrganization(valid), valid);

  assert.equal(normalizeSessionOrganization(null), null);
  assert.equal(normalizeSessionOrganization("junk"), null);
  assert.equal(normalizeSessionOrganization({ pinned: "nope" }), null);
  // malformed entries are silently filtered (dirty-data cleanup), not fatal
  assert.deepEqual(
    normalizeSessionOrganization({ ...valid, folders: ["x", { id: "f2", name: "Ok" }] }),
    { ...valid, folders: [{ id: "f2", name: "Ok" }] },
  );
  assert.deepEqual(
    normalizeSessionOrganization({ ...valid, assignments: { a: 3, b: "f1" } }),
    { ...valid, assignments: { b: "f1" } },
  );
});

test("sessionMatchesQuery matches name and first message across tokens", async () => {
  const { sessionMatchesQuery } = await loadSubject();

  const session = { name: "Fix login bug", firstMessage: "the auth flow breaks on refresh" };

  assert.equal(sessionMatchesQuery(session, ""), true);
  assert.equal(sessionMatchesQuery(session, "   "), true);
  assert.equal(sessionMatchesQuery(session, "login"), true);
  assert.equal(sessionMatchesQuery(session, "LOGIN"), true);
  assert.equal(sessionMatchesQuery(session, "auth refresh"), true);
  // every token must match somewhere
  assert.equal(sessionMatchesQuery(session, "login missing"), false);
  assert.equal(sessionMatchesQuery(session, "zzz"), false);
  // name and message are both searched
  assert.equal(sessionMatchesQuery({ name: null, firstMessage: "find me" }, "find"), true);
});
