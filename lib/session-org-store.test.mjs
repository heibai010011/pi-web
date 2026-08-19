import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readSessionOrgProject, writeSessionOrgProject, migrateSessionOrgLegacyEntry } = await jiti.import("./session-org-store.ts");

function tempStorePath() {
  return join(mkdtempSync(join(tmpdir(), "session-org-")), "session-org.json");
}

const ORG_A = {
  pinned: ["s1"],
  folders: [{ id: "f1", name: "工作" }],
  assignments: { s1: "f1" },
  collapsedFolders: [],
};

test("writes and reads back per-project organization", () => {
  const path = tempStorePath();
  try {
    writeSessionOrgProject("proj-a", ORG_A, path);
    assert.deepEqual(readSessionOrgProject("proj-a", path), ORG_A);
    // other projects untouched
    assert.deepEqual(readSessionOrgProject("proj-b", path), { pinned: [], folders: [], assignments: {}, collapsedFolders: [] });
    // overwrite works
    const next = { ...ORG_A, pinned: ["s2"] };
    writeSessionOrgProject("proj-a", next, path);
    assert.deepEqual(readSessionOrgProject("proj-a", path), next);
    // the second write preserved proj-b isolation
    writeSessionOrgProject("proj-b", ORG_A, path);
    assert.deepEqual(readSessionOrgProject("proj-a", path), next);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("corrupt or missing store files degrade to empty instead of throwing", () => {
  const path = tempStorePath();
  try {
    // missing file
    assert.deepEqual(readSessionOrgProject("proj-a", path).folders, []);
    // corrupt file
    writeFileSync(path, "{ not json", "utf8");
    assert.deepEqual(readSessionOrgProject("proj-a", path).folders, []);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});

test("legacy entry migrates once and never overwrites existing data", () => {
  const path = tempStorePath();
  try {
    migrateSessionOrgLegacyEntry("proj-a", ORG_A, path);
    assert.deepEqual(readSessionOrgProject("proj-a", path), ORG_A);
    // a second, different legacy payload must not clobber the migrated one
    const different = { pinned: [], folders: [{ id: "x", name: "别的" }], assignments: {}, collapsedFolders: [] };
    migrateSessionOrgLegacyEntry("proj-a", different, path);
    assert.deepEqual(readSessionOrgProject("proj-a", path), ORG_A);
    // invalid legacy payloads are ignored entirely
    migrateSessionOrgLegacyEntry("proj-b", { pinned: "junk" }, path);
    assert.deepEqual(readSessionOrgProject("proj-b", path).folders, []);
    // file exists and is valid JSON with the version envelope
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw.version, 1);
    assert.ok(raw.projects["proj-a"]);
  } finally {
    rmSync(join(path, ".."), { recursive: true, force: true });
  }
});
