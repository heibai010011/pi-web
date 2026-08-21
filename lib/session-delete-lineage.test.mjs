import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { reparentDirectChildSessions } = await jiti.import("./session-delete-lineage.ts");

const info = (id, path, parentSessionId) => ({
  id, path, parentSessionId, cwd: "C:/repo", created: "", modified: "", messageCount: 0, firstMessage: "",
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delete-lineage-"));
  const parentDir = join(root, "parent-cwd");
  const childDir = join(root, "different-child-cwd");
  mkdirSync(parentDir); mkdirSync(childDir);
  const grandPath = join(parentDir, "grand.jsonl");
  const parentPath = join(parentDir, "parent.jsonl");
  const childPath = join(childDir, "child.jsonl");
  writeFileSync(grandPath, JSON.stringify({ type: "session", id: "grand", cwd: "C:/repo" }) + "\n");
  writeFileSync(parentPath, JSON.stringify({ type: "session", id: "parent", cwd: "C:/repo", parentSession: grandPath }) + "\n");
  writeFileSync(childPath, JSON.stringify({ type: "session", id: "child", cwd: "D:/worktree", parentSession: parentPath }) + "\nchild-content\n");
  return { root, grandPath, parentPath, childPath };
}

const header = (path) => JSON.parse(readFileSync(path, "utf8").split("\n")[0]);

test("reparents a direct child stored in a different session directory", () => {
  const f = fixture();
  try {
    const result = reparentDirectChildSessions(
      [info("parent", f.parentPath, "grand"), info("child", f.childPath, "parent")],
      "parent",
      f.parentPath,
      f.grandPath,
    );
    assert.deepEqual(
      { reparentedIds: result.reparentedIds, failedIds: result.failedIds },
      { reparentedIds: ["child"], failedIds: [] },
    );
    assert.equal(header(f.childPath).parentSession, f.grandPath);
    assert.match(readFileSync(f.childPath, "utf8"), /child-content/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("deleting a root parent removes parentSession from direct children", () => {
  const f = fixture();
  try {
    const result = reparentDirectChildSessions(
      [info("child", f.childPath, "parent")],
      "parent",
      f.parentPath,
      undefined,
    );
    assert.equal(result.failedIds.length, 0);
    assert.equal("parentSession" in header(f.childPath), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("successful reparenting exposes rollback for a later parent unlink failure", () => {
  const f = fixture();
  const before = readFileSync(f.childPath, "utf8");
  try {
    const result = reparentDirectChildSessions(
      [info("child", f.childPath, "parent")],
      "parent",
      f.parentPath,
      f.grandPath,
    );
    assert.equal(header(f.childPath).parentSession, f.grandPath);
    assert.deepEqual(result.rollback(), []);
    assert.equal(readFileSync(f.childPath, "utf8"), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a failed later write rolls earlier child files back", () => {
  const f = fixture();
  const secondPath = join(f.root, "second-child.jsonl");
  writeFileSync(secondPath, JSON.stringify({ type: "session", id: "child-2", cwd: "E:/other", parentSession: f.parentPath }) + "\n");
  const before = readFileSync(f.childPath, "utf8");
  let writes = 0;
  const writeAtomic = (path, content) => {
    writes += 1;
    if (writes === 2) throw new Error("simulated failure");
    writeFileSync(path, content, "utf8");
  };
  try {
    const result = reparentDirectChildSessions(
      [info("child", f.childPath, "parent"), info("child-2", secondPath, "parent")],
      "parent",
      f.parentPath,
      f.grandPath,
      writeAtomic,
    );
    assert.deepEqual(result.failedIds, ["child-2"]);
    assert.equal(readFileSync(f.childPath, "utf8"), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
