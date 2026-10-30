import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLegacySessionOrgPath,
  migrateLegacySessionOrg,
  parseLegacySessionOrgDocument,
  resetLegacySessionOrgMigrationForTests,
} = await jiti.import("./session-org-migration.ts");
const {
  getSessionUiStatePath,
  readSessionUiState,
  resetSessionUiStateCacheForTests,
  updateSessionUiState,
} = await jiti.import("./session-ui-state.ts");

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-legacy-folders-"));
  const agentDir = join(root, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  resetSessionUiStateCacheForTests();
  resetLegacySessionOrgMigrationForTests();
  t.after(() => {
    resetSessionUiStateCacheForTests();
    resetLegacySessionOrgMigrationForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const oldPath = getLegacySessionOrgPath(agentDir);
  const statePath = getSessionUiStatePath(agentDir);
  return {
    agentDir,
    oldPath,
    statePath,
    writeOld: (value) => fs.writeFileSync(oldPath, typeof value === "string" ? value : JSON.stringify(value)),
    readState: () => readSessionUiState(statePath),
    importedFiles: () => fs.readdirSync(agentDir).filter((name) => name.startsWith("session-org.json.imported-")),
  };
}

test("an upgrade imports folders, nesting, rules, assignments and pins, then retires the old file", async (t) => {
  const { agentDir, oldPath, writeOld, readState, importedFiles } = fixture(t);
  writeOld({
    version: 1,
    projects: {
      "/work/alpha": {
        pinned: ["s1"],
        folders: [
          { id: "f1", name: " One " },
          { id: "f2", name: "Two", parentId: "f1", autoPattern: " src " },
        ],
        assignments: { s2: "f1", s3: "f2", s4: "__pi-web-ungrouped__" },
        collapsedFolders: ["f1"],
      },
      "/work/beta": {
        folders: [{ id: "f3", name: "Other" }],
        assignments: { s5: "f3" },
      },
    },
  });

  const result = await migrateLegacySessionOrg(agentDir);
  assert.equal(result.imported, true);
  assert.equal(result.folders, 3);
  assert.equal(result.assignments, 4);
  assert.equal(result.pins, 1);

  const state = readState();
  assert.deepEqual((state.folders ?? []).map((folder) => [folder.id, folder.name, folder.projectKey, folder.parentId ?? null, folder.autoPattern ?? null]), [
    ["f1", "One", "/work/alpha", null, null],
    ["f2", "Two", "/work/alpha", "f1", "src"],
    ["f3", "Other", "/work/beta", null, null],
  ]);
  assert.deepEqual(state.folderAssignments, { s2: "f1", s3: "f2", s4: "__pi-web-ungrouped__", s5: "f3" });
  assert.equal(typeof state.sessions.s1?.pinnedAt, "number");
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(importedFiles().length, 1);
});

test("a second start reads nothing twice and keeps the revision", async (t) => {
  const { agentDir, writeOld, readState } = fixture(t);
  writeOld({ version: 1, projects: { "/work/a": { folders: [{ id: "f1", name: "One" }] } } });
  await migrateLegacySessionOrg(agentDir);
  const first = readState();
  const again = await migrateLegacySessionOrg(agentDir);
  assert.equal(again.imported, false);
  assert.deepEqual(again.folders, 0);
  assert.equal(readState().revision, first.revision);
  assert.equal((readState().folders ?? []).length, 1);
});

test("existing folders, assignments and pins win over the old file", async (t) => {
  const { agentDir, statePath, writeOld, readState } = fixture(t);
  await updateSessionUiState({ action: "create-folder", id: "f1", name: "Keep me", projectKey: "/work/a", parentId: null }, statePath);
  await updateSessionUiState({ action: "move-session", sessionId: "s2", folderId: "f1" }, statePath);
  await updateSessionUiState({ action: "set", ids: ["s3"], pinned: true }, statePath);
  const before = readState();
  const pinnedAt = before.sessions.s3.pinnedAt;

  writeOld({
    version: 1,
    projects: {
      "/work/a": {
        pinned: ["s3", "s9"],
        folders: [{ id: "f1", name: "Old name" }, { id: "f2", name: "New" }],
        assignments: { s2: "f2", s9: "f2" },
      },
    },
  });
  const result = await migrateLegacySessionOrg(agentDir);
  assert.equal(result.folders, 1);
  assert.equal(result.assignments, 1);
  assert.equal(result.pins, 1);

  const state = readState();
  assert.deepEqual((state.folders ?? []).map((folder) => [folder.id, folder.name]), [["f1", "Keep me"], ["f2", "New"]]);
  assert.deepEqual(state.folderAssignments, { s2: "f1", s9: "f2" });
  assert.equal(state.sessions.s3.pinnedAt, pinnedAt);
  assert.equal(typeof state.sessions.s9?.pinnedAt, "number");
});

test("a missing parent becomes a top-level folder and empty projects are ignored", async (t) => {
  const { agentDir, oldPath, writeOld, readState } = fixture(t);
  writeOld({
    version: 1,
    projects: {
      "/work/a": { folders: [{ id: "f1", name: "Child", parentId: "gone" }], assignments: { s1: "gone" } },
      "/work/b": { folders: [], assignments: {}, pinned: [] },
    },
  });
  const result = await migrateLegacySessionOrg(agentDir);
  assert.equal(result.folders, 1);
  assert.equal(result.assignments, 0);
  const state = readState();
  assert.equal(state.folders?.[0].parentId, undefined);
  assert.equal(fs.existsSync(oldPath), false);
});

test("an empty or broken old file changes nothing and is left for inspection", async (t) => {
  for (const content of [JSON.stringify({ version: 1, projects: {} }), "{ not json", JSON.stringify({ nope: true })]) {
    const { agentDir, oldPath, writeOld, readState } = fixture(t);
    writeOld(content);
    const before = readState();
    const result = await migrateLegacySessionOrg(agentDir);
    assert.equal(result.imported, false);
    assert.equal(readState().revision, before.revision);
    assert.equal(fs.existsSync(oldPath), true);
  }
});

test("the parser keeps the first project that claims a folder id and drops dangling assignments", () => {
  const projects = parseLegacySessionOrgDocument({
    version: 1,
    projects: {
      "/a": { folders: [{ id: "f1", name: "First" }], assignments: { s1: "f1", s2: "missing" } },
      "/b": { folders: [{ id: "f1", name: "Second" }], assignments: { s3: "f1" } },
    },
  });
  assert.deepEqual(projects, [
    { projectKey: "/a", folders: [{ id: "f1", name: "First" }], assignments: { s1: "f1" }, pinned: [] },
  ]);
});
