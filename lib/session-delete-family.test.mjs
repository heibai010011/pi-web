import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { planSessionDeletion, applySessionDeletion } = await createJiti(import.meta.url).import("./session-delete-lineage.ts");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-delete-family-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sessions = [];
  const paths = new Map();
  const add = (id, parentId, kind = "fork", options = {}) => {
    const cwd = join(dir, options.crossCwd ? "other" : "main");
    mkdirSync(cwd, { recursive: true });
    const path = join(cwd, `${id}.jsonl`);
    paths.set(id, path);
    const header = { type: "session", version: 3, id, cwd, timestamp: new Date().toISOString(), ...(parentId ? { parentSession: paths.get(parentId) } : {}) };
    const metadata = { type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: parentId, parentSessionPath: paths.get(parentId), profile: "test" } };
    const content = [header, ...(options.delayedMetadata ? [{ type: "session_info", name: id }] : []), ...(kind === "subagent" ? [metadata] : []), { type: "message", message: { role: "user", content: `history-${id}` } }].map(JSON.stringify).join("\n") + "\n";
    if (!options.transient) writeFileSync(path, content);
    sessions.push({ id, path, cwd, parentSessionId: parentId, created: "", modified: "", firstMessage: "", messageCount: 1,
      ...(parentId ? { relation: kind === "subagent" ? { kind, parentSessionId: parentId } : { kind } } : {}),
      ...(options.transient ? { transient: true, runtimeContent: content } : {}) });
    return path;
  };
  return { dir, sessions, paths, add };
}
const header = (path) => JSON.parse(readFileSync(path, "utf8").split("\n")[0]);

test("nested cross-cwd subagents cascade; forks and their subagents survive at nearest living ancestor", (t) => {
  const f = fixture(t);
  f.add("grand"); f.add("parent", "grand");
  f.add("child", "parent", "subagent", { crossCwd: true });
  f.add("nested", "child", "subagent", { crossCwd: true, delayedMetadata: true });
  f.add("fork", "nested", "fork", { crossCwd: true });
  f.add("fork-agent", "fork", "subagent");
  f.add("direct-fork", "parent");
  const forkBefore = readFileSync(f.paths.get("fork-agent"), "utf8");
  const plan = planSessionDeletion(f.sessions, "parent", f.paths.get("parent"));
  assert.deepEqual(new Set(plan.deletedIds), new Set(["parent", "child", "nested"]));
  assert.deepEqual(new Set(plan.rewrites.map((item) => item.id)), new Set(["fork", "direct-fork"]));
  assert.deepEqual(applySessionDeletion(plan).deletedIds, plan.deletedIds);
  for (const id of plan.deletedIds) assert.equal(existsSync(f.paths.get(id)), false);
  for (const id of ["fork", "direct-fork"]) assert.equal(header(f.paths.get(id)).parentSession, f.paths.get("grand"));
  assert.equal(readFileSync(f.paths.get("fork-agent"), "utf8"), forkBefore);
});

test("full candidate metadata overrides stale list classification and protects inherited fork metadata", (t) => {
  const f = fixture(t);
  f.add("root"); f.add("agent", "root", "subagent", { delayedMetadata: true });
  f.add("fork", "agent", "fork", { crossCwd: true });
  // Forks may copy the original subagent metadata; its owner path differs from
  // the fork header, and must not turn a fork into an owned subagent.
  writeFileSync(f.paths.get("fork"), readFileSync(f.paths.get("fork"), "utf8") + JSON.stringify({ type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "root", parentSessionPath: f.paths.get("root") } }) + "\n");
  f.sessions.find((s) => s.id === "fork").relation = { kind: "subagent", parentSessionId: "root" };
  f.sessions.find((s) => s.id === "agent").relation = { kind: "fork" };
  const plan = planSessionDeletion(f.sessions, "root", f.paths.get("root"));
  assert.deepEqual(new Set(plan.deletedIds), new Set(["root", "agent"]));
  applySessionDeletion(plan);
  assert.equal(header(f.paths.get("fork")).parentSession, undefined);
  const metadata = readFileSync(f.paths.get("fork"), "utf8").trimEnd().split("\n").map(JSON.parse).find((entry) => entry.customType === "pi-web:subagent");
  assert.equal(metadata.data.parentSessionId, undefined);
  assert.equal(metadata.data.parentSessionPath, undefined);
});

test("unpersisted subagents are included and unpersisted forks are preserved", (t) => {
  const f = fixture(t);
  f.add("root", undefined, "fork", { transient: true });
  f.add("child", "root", "subagent", { transient: true, crossCwd: true });
  f.add("fork", "child", "fork", { transient: true });
  const plan = planSessionDeletion(f.sessions, "root", f.paths.get("root"));
  assert.deepEqual(new Set(plan.deletedIds), new Set(["root", "child"]));
  assert.equal(applySessionDeletion(plan).error, undefined);
  assert.equal(header(f.paths.get("fork")).parentSession, undefined);
});

test("unlink failure restores deleted files and fork headers, retry succeeds", (t) => {
  const f = fixture(t);
  f.add("root"); f.add("child", "root", "subagent"); f.add("fork", "child");
  const before = new Map([...f.paths].map(([id, path]) => [id, readFileSync(path, "utf8")]));
  const plan = planSessionDeletion(f.sessions, "root", f.paths.get("root"));
  const failed = applySessionDeletion(plan, {
    read: (path) => readFileSync(path, "utf8"), write: (path, text) => writeFileSync(path, text),
    unlink: (path) => { if (path === f.paths.get("child")) throw new Error("disk denied"); unlinkSync(path); },
  });
  assert.match(failed.error, /disk denied/);
  assert.deepEqual(failed.deletedIds, []);
  assert.deepEqual(failed.rollbackFailedIds, []);
  for (const [id, path] of f.paths) assert.equal(readFileSync(path, "utf8"), before.get(id));
  assert.equal(applySessionDeletion(plan).error, undefined);
});

test("fork rewrite failure performs no deletes; failed rollback is explicit", (t) => {
  const f = fixture(t);
  f.add("root"); f.add("fork", "root");
  const plan = planSessionDeletion(f.sessions, "root", f.paths.get("root"));
  const result = applySessionDeletion(plan, {
    read: (path) => readFileSync(path, "utf8"), unlink: () => assert.fail("must not delete"),
    write: () => { throw new Error("write failed"); },
  });
  assert.deepEqual(result.deletedIds, []);
  assert.deepEqual(result.rollbackFailedIds, ["fork"]);
  assert.equal(existsSync(f.paths.get("root")), true);
});
