import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  LEGACY_SESSION_ORG_STORAGE_PREFIX,
  importLegacyLocalSessionOrg,
  readLegacyLocalSessionOrg,
} = await jiti.import("./legacy-local-folders.ts");

class MemoryStorage {
  constructor(entries = {}) {
    this.map = new Map(Object.entries(entries));
  }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.get(key) ?? null; }
  removeItem(key) { this.map.delete(key); }
}

function state({ folders = [], assignments = {}, sessions = {} } = {}) {
  return {
    version: 1,
    revision: 0,
    sessions,
    projects: {},
    ...(folders.length > 0 ? { folders } : {}),
    ...(Object.keys(assignments).length > 0 ? { folderAssignments: assignments } : {}),
  };
}

function recorder(accepted = true) {
  const requests = [];
  return {
    requests,
    apply: async (request) => {
      requests.push(request);
      return accepted;
    },
  };
}

const key = (projectKey) => `${LEGACY_SESSION_ORG_STORAGE_PREFIX}:${projectKey}`;

test("a browser's old folders, rules, assignments and pins move into the new state once", async () => {
  const storage = new MemoryStorage({
    [key("/work/alpha")]: JSON.stringify({
      pinned: ["s2"],
      folders: [{ id: "f1", name: " One " }, { id: "f2", name: "Two", parentId: "f1", autoPattern: " src " }],
      assignments: { s1: "f1", s9: "f2" },
      collapsedFolders: ["f1"],
    }),
    [key("/work/empty")]: JSON.stringify({ pinned: [], folders: [], assignments: {}, collapsedFolders: [] }),
    [LEGACY_SESSION_ORG_STORAGE_PREFIX]: JSON.stringify({ pinned: [], folders: [{ id: "g1", name: "Global" }], assignments: {} }),
  });
  const { requests, apply } = recorder();
  const imported = await importLegacyLocalSessionOrg(state(), apply, storage);
  assert.equal(imported, true);
  assert.deepEqual(requests, [
    { action: "create-folder", id: "f1", name: "One", projectKey: "/work/alpha", parentId: null },
    { action: "create-folder", id: "f2", name: "Two", projectKey: "/work/alpha", parentId: null },
    { action: "move-folder", id: "f2", parentId: "f1" },
    { action: "set-folder-rule", id: "f2", autoPattern: "src" },
    { action: "move-session", sessionId: "s1", folderId: "f1" },
    { action: "move-session", sessionId: "s9", folderId: "f2" },
    { action: "restore", entries: [{ id: "s2", pinnedAt: requests[6].entries[0].pinnedAt, archivedAt: null }] },
  ]);
  assert.equal(typeof requests[6].entries[0].pinnedAt, "number");
  // Per-project records are consumed; the global one cannot be placed and stays.
  assert.equal(storage.getItem(key("/work/alpha")), null);
  assert.equal(storage.getItem(key("/work/empty")), null);
  assert.notEqual(storage.getItem(LEGACY_SESSION_ORG_STORAGE_PREFIX), null);
});

test("an existing folder or assignment wins, and only the missing pieces are written", async () => {
  const storage = new MemoryStorage({
    [key("/work/alpha")]: JSON.stringify({
      folders: [{ id: "f1", name: "Old" }, { id: "f2", name: "New" }],
      assignments: { s1: "f2", s3: "f2" },
      pinned: [],
    }),
  });
  const { requests, apply } = recorder();
  const imported = await importLegacyLocalSessionOrg(
    state({ folders: [{ id: "f1", name: "Keep", projectKey: "/work/alpha" }], assignments: { s1: "f1" } }),
    apply,
    storage,
  );
  assert.equal(imported, true);
  assert.deepEqual(requests, [
    { action: "create-folder", id: "f2", name: "New", projectKey: "/work/alpha", parentId: null },
    { action: "move-session", sessionId: "s3", folderId: "f2" },
  ]);
  assert.equal(storage.getItem(key("/work/alpha")), null);
});

test("a refused write keeps the browser records for the next load", async () => {
  const storage = new MemoryStorage({
    [key("/work/alpha")]: JSON.stringify({ folders: [{ id: "f1", name: "One" }, { id: "f2", name: "Two" }], assignments: {} }),
  });
  const { requests, apply } = recorder(false);
  const imported = await importLegacyLocalSessionOrg(state(), apply, storage);
  assert.equal(imported, false);
  assert.equal(requests.length, 1, "nothing is written after the refusal");
  assert.notEqual(storage.getItem(key("/work/alpha")), null);
});

test("empty records are removed without a request, and a broken one is left alone", async () => {
  const storage = new MemoryStorage({
    [key("/work/a")]: JSON.stringify({ pinned: [], folders: [], assignments: {}, collapsedFolders: [] }),
    [key("/work/b")]: "{ broken",
  });
  const { requests, apply } = recorder();
  const read = readLegacyLocalSessionOrg(storage);
  assert.deepEqual(read.entries, []);
  assert.deepEqual(read.keys, [key("/work/a")]);
  assert.equal(await importLegacyLocalSessionOrg(state(), apply, storage), true);
  assert.equal(requests.length, 0);
  assert.equal(storage.getItem(key("/work/a")), null);
  assert.notEqual(storage.getItem(key("/work/b")), null);
});
