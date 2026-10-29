import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  FOLDER_UNGROUPED,
  MAX_SESSION_FOLDERS,
  applySessionUiStateRequest,
  emptySessionUiState,
  folderDescendantIds,
  folderWouldCycle,
  normalizeSessionUiState,
  parseSessionUiStateRequest,
} = await jiti.import("./session-ui-state-shared.ts");

function state() {
  return emptySessionUiState();
}

function apply(current, request) {
  return applySessionUiStateRequest(current, request, 1000);
}

function parse(request) {
  return parseSessionUiStateRequest(request);
}

function folder(id, extra = {}) {
  return { id, name: id.toUpperCase(), projectKey: "/w", ...extra };
}

test("create-folder files a folder under its project, at the top or under a parent", () => {
  const created = apply(state(), { action: "create-folder", id: "f1", name: " Bugs ", projectKey: "/w", parentId: null });
  assert.equal(created.changed, true);
  assert.deepEqual(created.state.folders, [{ id: "f1", name: "Bugs", projectKey: "/w" }]);
  const child = apply(created.state, { action: "create-folder", id: "f2", name: "Sub", projectKey: "/w", parentId: "f1" });
  assert.deepEqual(child.state.folders?.[1], { id: "f2", name: "Sub", projectKey: "/w", parentId: "f1" });
  // An unknown parent reads as top level; a duplicate id changes nothing.
  const dangling = apply(state(), { action: "create-folder", id: "f3", name: "Top", projectKey: "/w", parentId: "nope" });
  assert.deepEqual(dangling.state.folders, [{ id: "f3", name: "Top", projectKey: "/w" }]);
  assert.equal(apply(dangling.state, { action: "create-folder", id: "f3", name: "Again", projectKey: "/w", parentId: null }).changed, false);
});

test("rename, rule and move change only the named folder, and cycles are refused", () => {
  const seeded = apply(apply(state(), {
    action: "create-folder", id: "f1", name: "One", projectKey: "/w", parentId: null,
  }).state, {
    action: "create-folder", id: "f2", name: "Two", projectKey: "/w", parentId: "f1",
  }).state;

  const renamed = apply(seeded, { action: "rename-folder", id: "f1", name: " First " });
  assert.equal(renamed.state.folders?.[0].name, "First");
  const ruled = apply(renamed.state, { action: "set-folder-rule", id: "f2", autoPattern: " work/alpha " });
  assert.equal(ruled.state.folders?.[1].autoPattern, "work/alpha");
  const cleared = apply(ruled.state, { action: "set-folder-rule", id: "f2", autoPattern: "" });
  assert.equal(cleared.state.folders?.[1].autoPattern, undefined);

  // f1 cannot go under its own child.
  const cycled = apply(cleared.state, { action: "move-folder", id: "f1", parentId: "f2" });
  assert.equal(cycled.changed, false);
  assert.equal(cycled.state.folders?.[0].parentId, undefined);
  const moved = apply(cleared.state, { action: "move-folder", id: "f2", parentId: null });
  assert.equal(moved.state.folders?.[1].parentId, undefined);
});

test("delete-folder promotes its children and unfiles its sessions, deleting nothing else", () => {
  const parent = apply(state(), { action: "create-folder", id: "ai", name: "AI", projectKey: "/w", parentId: null }).state;
  const middle = apply(parent, { action: "create-folder", id: "mid", name: "Mid", projectKey: "/w", parentId: "ai" }).state;
  const leaf = apply(middle, { action: "create-folder", id: "child", name: "Child", projectKey: "/w", parentId: "mid" }).state;
  const filed = apply(apply(leaf, { action: "move-session", sessionId: "s1", folderId: "mid" }).state, {
    action: "move-session", sessionId: "s2", folderId: "child",
  }).state;

  const deleted = apply(filed, { action: "delete-folder", id: "mid" });
  assert.deepEqual(deleted.state.folders, [
    { id: "ai", name: "AI", projectKey: "/w" },
    { id: "child", name: "Child", projectKey: "/w", parentId: "ai" },
  ]);
  assert.deepEqual(deleted.state.folderAssignments, { s2: "child" });
  // Deleting the top one promotes its child to the top level.
  const topDeleted = apply(deleted.state, { action: "delete-folder", id: "ai" });
  assert.equal(topDeleted.state.folders?.[0].parentId, undefined);
  // The last folder going removes the fields; assignments of its sessions go too.
  const lastDeleted = apply(topDeleted.state, { action: "delete-folder", id: "child" });
  assert.equal(lastDeleted.state.folders, undefined);
  assert.equal(lastDeleted.state.folderAssignments, undefined);
});

test("move-session files a family, keeps Ungrouped explicit, and refuses unknown folders", () => {
  const seeded = apply(state(), { action: "create-folder", id: "f1", name: "One", projectKey: "/w", parentId: null }).state;
  const filed = apply(seeded, { action: "move-session", sessionId: "s1", folderId: "f1" });
  assert.deepEqual(filed.state.folderAssignments, { s1: "f1" });
  const ungrouped = apply(filed.state, { action: "move-session", sessionId: "s1", folderId: null });
  assert.deepEqual(ungrouped.state.folderAssignments, { s1: FOLDER_UNGROUPED });
  const refused = apply(ungrouped.state, { action: "move-session", sessionId: "s2", folderId: "missing" });
  assert.equal(refused.changed, false);
  assert.deepEqual(refused.state.folderAssignments, { s1: FOLDER_UNGROUPED });
  const unchanged = apply(ungrouped.state, { action: "move-session", sessionId: "s1", folderId: null });
  assert.equal(unchanged.changed, false);
});

test("normalize keeps valid folders, drops malformed ones and dangling assignments, and tolerates dangling parents", () => {
  const normalized = normalizeSessionUiState({
    version: 1,
    revision: 3,
    sessions: {},
    projects: {},
    folders: [
      { id: "f1", name: "One", projectKey: "/w", parentId: "gone" },
      { id: "f1", name: "Dup", projectKey: "/w" },
      { id: "f2", name: " ", projectKey: "/w" },
      { id: "f3", name: "Three", projectKey: "/w", parentId: "f3" },
      { id: "f4", name: "Four", projectKey: "/w", autoPattern: "  alpha " },
      { id: "bad id", name: "Bad", projectKey: "/w" },
      { id: "f5", name: "No project" },
    ],
    folderAssignments: { s1: "f1", s2: "gone", s3: FOLDER_UNGROUPED, s4: 7 },
  });
  assert.deepEqual(normalized.folders, [
    { id: "f1", name: "One", projectKey: "/w", parentId: "gone" },
    { id: "f3", name: "Three", projectKey: "/w" },
    { id: "f4", name: "Four", projectKey: "/w", autoPattern: "alpha" },
  ]);
  assert.deepEqual(normalized.folderAssignments, { s1: "f1", s3: FOLDER_UNGROUPED });
});

test("normalize caps the folder list and parse refuses malformed requests", () => {
  const many = Array.from({ length: MAX_SESSION_FOLDERS + 3 }, (_, index) => ({ id: `f${index}`, name: `F${index}`, projectKey: "/w" }));
  const normalized = normalizeSessionUiState({ version: 1, revision: 0, sessions: {}, projects: {}, folders: many });
  assert.equal(normalized.folders.length, MAX_SESSION_FOLDERS);

  for (const request of [
    { action: "create-folder", id: "f1", name: "", projectKey: "/w" },
    { action: "create-folder", id: "f1", name: "ok", projectKey: "" },
    { action: "create-folder", id: "f1", name: "ok", projectKey: "/w", parentId: "not an id" },
    { action: "rename-folder", id: "f1", name: "two\nlines" },
    { action: "move-folder", id: "f1", parentId: "f1" },
    { action: "set-folder-rule", id: "f1", autoPattern: "x".repeat(201) },
    { action: "delete-folder", id: "../escape" },
    { action: "move-session", sessionId: "s1", folderId: "not an id" },
  ]) {
    assert.equal(parse(request).ok, false, JSON.stringify(request));
  }
  const ok = parse({ action: "create-folder", id: "f1", name: " Bugs ", projectKey: "/w" });
  assert.deepEqual(ok.request, { action: "create-folder", id: "f1", name: "Bugs", projectKey: "/w", parentId: null });
});

test("folder helpers find descendants and cycles without looping", () => {
  const folders = [
    { id: "a", name: "A", projectKey: "/w" },
    { id: "b", name: "B", projectKey: "/w", parentId: "a" },
    { id: "c", name: "C", projectKey: "/w", parentId: "b" },
  ];
  assert.deepEqual([...folderDescendantIds(folders, "a")].sort(), ["b", "c"]);
  assert.deepEqual([...folderDescendantIds(folders, "b")], ["c"]);
  assert.equal(folderWouldCycle(folders, "a", "c"), true);
  assert.equal(folderWouldCycle(folders, "c", "c"), true);
  assert.equal(folderWouldCycle(folders, "c", "a"), false);
  assert.equal(folderWouldCycle(folders, "a", null), false);
});
