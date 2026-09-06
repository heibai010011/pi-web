import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const store = new Map();
const events = [];
const originalWindow = globalThis.window;
const originalCustomEvent = globalThis.CustomEvent;
const originalFetch = globalThis.fetch;
globalThis.window = {
  localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  },
  dispatchEvent: (event) => { events.push(event); return true; },
};
globalThis.CustomEvent = class CustomEvent extends Event {
  // Pass init through: this file keeps the stub installed for its whole run,
  // and under `--test-isolation=none` other test files' EventTarget tests
  // execute in between — they need cancelable/preventDefault to work.
  constructor(type, init) { super(type, init); this.detail = init?.detail; }
};
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) });

delete globalThis.__piPendingSessionFolderDrafts;
const jiti = createJiti(import.meta.url);
const {
  claimSessionFolderDraft,
  discardSessionFolderDraft,
  promoteSessionFolderDraft,
  registerAutoSessionFolderDraft,
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

test("auto rule resolves the first folder whose pattern matches the cwd", () => {
  reset();
  markSessionOrganizationSynced("project-d");
  persistSessionOrganization({
    pinned: [],
    folders: [
      { id: "web", name: "Web", autoPattern: "pi-web" },
      { id: "api", name: "API", autoPattern: "server" },
    ],
    assignments: {},
    collapsedFolders: [],
  }, "project-d");
  registerAutoSessionFolderDraft("new:t1:D:\\code\\pi-web", "project-d", "D:\\code\\pi-web", "t1");
  const promoted = promoteSessionFolderDraft("new:t1:D:\\code\\pi-web", "real-1");
  assert.equal(promoted?.org.assignments["real-1"], "web");
});

test("auto rule is case-insensitive and skips non-matching cwds", () => {
  reset();
  markSessionOrganizationSynced("project-e");
  persistSessionOrganization({
    pinned: [],
    folders: [{ id: "web", name: "Web", autoPattern: "PI-WEB" }],
    assignments: {},
    collapsedFolders: [],
  }, "project-e");
  registerAutoSessionFolderDraft("new:t2:D:\\other", "project-e", "D:\\other", "t2");
  assert.equal(promoteSessionFolderDraft("new:t2:D:\\other", "real-2"), null);
  registerAutoSessionFolderDraft("new:t3:D:\\Code\\Pi-Web\\x", "project-e", "D:\\Code\\Pi-Web\\x", "t3");
  assert.equal(promoteSessionFolderDraft("new:t3:D:\\Code\\Pi-Web\\x", "real-3")?.org.assignments["real-3"], "web");
});

test("a claimed draft survives navigation and still promotes", () => {
  reset();
  markSessionOrganizationSynced("project-f");
  persistSessionOrganization(empty, "project-f");
  registerSessionFolderDraft("new:t4:/repo", "project-f", "work", "t4");
  claimSessionFolderDraft("new:t4:/repo");

  // Navigation attempts to discard the in-flight composer — must be ignored.
  discardSessionFolderDraft("new:t4:/repo");
  const promoted = promoteSessionFolderDraft("new:t4:/repo", "real-4");
  assert.equal(promoted?.org.assignments["real-4"], "work");
});

test.after(() => {
  // Restore instead of delete: under `--test-isolation=none` this file shares
  // a realm with every other test file, and deleting leaves the globals
  // undefined (Node exposes them as bindings, not deletable properties).
  // The CustomEvent stub in particular lacks cancelable/preventDefault
  // support and broke unrelated EventTarget tests while installed.
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalCustomEvent === undefined) delete globalThis.CustomEvent;
  else globalThis.CustomEvent = originalCustomEvent;
  if (originalFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = originalFetch;
  delete globalThis.__piPendingSessionFolderDrafts;
});
