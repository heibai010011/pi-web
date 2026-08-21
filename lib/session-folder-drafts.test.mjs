import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const store = new Map();
const events = [];
globalThis.window = {
  localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  },
  dispatchEvent: (event) => { events.push(event); return true; },
};
globalThis.CustomEvent = class CustomEvent extends Event {
  constructor(type, init) { super(type); this.detail = init?.detail; }
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

delete globalThis.__piPendingSessionFolderDrafts;
const jiti = createJiti(import.meta.url);
const {
  discardSessionFolderDraft,
  promoteSessionFolderDraft,
  registerSessionFolderDraft,
  SESSION_ORGANIZATION_CHANGED_EVENT,
} = await jiti.import("./session-folder-drafts.ts");
const {
  loadSessionOrganization,
  markSessionOrganizationSynced,
  persistSessionOrganization,
} = await jiti.import("./session-folders.ts");

const empty = { pinned: [], folders: [{ id: "work", name: "Work" }], assignments: {}, collapsedFolders: [] };

function reset() {
  store.clear();
  events.length = 0;
}

test("promotes a folder draft assignment to the real persisted session id", () => {
  reset();
  markSessionOrganizationSynced("project-a");
  persistSessionOrganization(empty, "project-a");
  registerSessionFolderDraft("new:temp:/repo", "project-a", "work", "temp");

  const promoted = promoteSessionFolderDraft("new:temp:/repo", "real-session");
  assert.equal(promoted?.projectKey, "project-a");
  assert.equal(promoted?.org.assignments.temp, undefined);
  assert.equal(promoted?.org.assignments["real-session"], "work");
  assert.deepEqual(loadSessionOrganization("project-a").assignments, { "real-session": "work" });
  assert.equal(events.at(-1)?.type, SESSION_ORGANIZATION_CHANGED_EVENT);
});

test("discarding an unsent draft removes its pending intent without touching organization", () => {
  reset();
  markSessionOrganizationSynced("project-b");
  persistSessionOrganization(empty, "project-b");
  registerSessionFolderDraft("new:temp:/repo", "project-b", "work", "temp");

  discardSessionFolderDraft("new:temp:/repo");
  assert.deepEqual(loadSessionOrganization("project-b").assignments, {});
  assert.equal(promoteSessionFolderDraft("new:temp:/repo", "real"), null);
});

test("promotion never creates an assignment to a folder deleted meanwhile", () => {
  reset();
  markSessionOrganizationSynced("project-c");
  persistSessionOrganization(empty, "project-c");
  registerSessionFolderDraft("new:temp:/repo", "project-c", "work", "temp");
  persistSessionOrganization({ ...empty, folders: [], assignments: {} }, "project-c");

  const promoted = promoteSessionFolderDraft("new:temp:/repo", "real");
  assert.deepEqual(promoted?.org.assignments, {});
});

test.after(() => {
  delete globalThis.window;
  delete globalThis.CustomEvent;
  delete globalThis.fetch;
});
