import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

// jiti resolves extensionless relative imports inside the subject module.
const jiti = createJiti(import.meta.url);
async function loadSubject() {
  return jiti.import("./session-folders.ts");
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

test("storage key is scoped per project workspace", async () => {
  const { sessionOrgStorageKey, SESSION_ORG_STORAGE_KEY } = await loadSubject();

  assert.equal(sessionOrgStorageKey(null), SESSION_ORG_STORAGE_KEY);
  assert.equal(sessionOrgStorageKey(undefined), SESSION_ORG_STORAGE_KEY);
  assert.equal(sessionOrgStorageKey("proj-a"), `${SESSION_ORG_STORAGE_KEY}:proj-a`);
  assert.notEqual(sessionOrgStorageKey("proj-a"), sessionOrgStorageKey("proj-b"));
});

test("load and persist are keyed by project", async () => {
  // The storage layer is browser-only; stub a localStorage before importing
  // so the round-trip can be exercised under node. The server mirror is a
  // fetch() best-effort — stub fetch so no real request leaves the test.
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
  };
  const mirrored = [];
  globalThis.fetch = async (url, init) => {
    mirrored.push({ url, body: init?.body });
    return { ok: true, json: async () => ({}) };
  };
  try {
    const { loadSessionOrganization, markSessionOrganizationSynced, persistSessionOrganization } = await loadSubject();

    const saved = { pinned: ["s1"], folders: [{ id: "f1", name: "Work" }], assignments: { s1: "f1" }, collapsedFolders: [] };
    // A project mirrors only after its first server merge completed.
    markSessionOrganizationSynced("proj-a");
    markSessionOrganizationSynced("proj-b");
    persistSessionOrganization(saved, "proj-a");
    persistSessionOrganization({ ...saved, folders: [{ id: "f2", name: "Other" }] }, "proj-b");

    assert.deepEqual(loadSessionOrganization("proj-a"), saved);
    const b = loadSessionOrganization("proj-b");
    assert.equal(b.folders[0]?.name, "Other");
    // a different workspace starts empty
    assert.deepEqual(loadSessionOrganization("proj-c").folders, []);
    // every persist mirrors to the server-side store endpoint
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(mirrored.length, 2);
    assert.ok(mirrored.every((m) => m.url.includes("/api/session-org")));
    const firstPayload = JSON.parse(mirrored[0].body);
    assert.equal(firstPayload.projectKey, "proj-a");
    assert.deepEqual(firstPayload.org.folders, [{ id: "f1", name: "Work" }]);
    // unscoped (null project) persists do not mirror
    persistSessionOrganization(saved, null);
    assert.equal(mirrored.length, 2);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});

test("rapid mirror writes are serialized and only latest success clears dirty", async () => {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
  };
  const calls = [];
  const releases = [];
  globalThis.fetch = (url, init) => new Promise((resolve) => {
    calls.push({ url, payload: JSON.parse(init.body) });
    releases.push(() => resolve({ ok: true }));
  });
  try {
    const {
      markSessionOrganizationSynced,
      persistSessionOrganization,
      sessionOrgDirtyKey,
    } = await loadSubject();
    markSessionOrganizationSynced("rapid-project");
    const base = { pinned: [], folders: [], assignments: {}, collapsedFolders: [] };
    persistSessionOrganization({ ...base, pinned: ["old"] }, "rapid-project");
    persistSessionOrganization({ ...base, pinned: ["new"] }, "rapid-project");

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1, "second PUT waits for the first");
    assert.equal(calls[0].payload.org.pinned[0], "old");
    releases[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].payload.org.pinned[0], "new");
    assert.ok(store.get(sessionOrgDirtyKey("rapid-project")), "older success cannot clear dirty");
    releases[1]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.has(sessionOrgDirtyKey("rapid-project")), false);
  } finally {
    delete globalThis.window;
    delete globalThis.fetch;
  }
});
