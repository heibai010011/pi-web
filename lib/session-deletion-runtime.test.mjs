import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper, drainSessionStartsForDeletion, startRpcSession, shutdownSessionsForDeletion } = await jiti.import("./rpc-manager.ts");
const { createSubagentController, publishSubagentCompletion, settleSubagentsForDeletion } = await jiti.import("./subagent-runtime.ts");
const { blockSessionDeletion, releaseSessionDeletion, serializeSessionDeletion } = await jiti.import("./session-deletion-state.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function isolated(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-delete-runtime-"));
  const previous = [globalThis.__piSessionDeletionBlocked, globalThis.__piSessionDeleted, globalThis.__piSubagentRuns, globalThis.__piStartLocks, globalThis.__piSubagentStarts];
  globalThis.__piSessionDeletionBlocked = new Set(); globalThis.__piSessionDeleted = new Set();
  globalThis.__piSubagentRuns = new Map(); globalThis.__piStartLocks = new Map(); globalThis.__piSubagentStarts = new Map();
  t.after(() => {
    [globalThis.__piSessionDeletionBlocked, globalThis.__piSessionDeleted, globalThis.__piSubagentRuns, globalThis.__piStartLocks, globalThis.__piSubagentStarts] = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("deletion drains late prompt writes before unlink and suppresses completion notification", async (t) => {
  const dir = isolated(t), path = join(dir, "session.jsonl");
  let finish, listener, completed = 0, aborted = 0;
  const inner = {
    sessionId: "delete-runtime", sessionFile: path, isStreaming: false, isBashRunning: false,
    sessionManager: { getCwd: () => dir }, agent: { state: {} }, extensionRunner: {},
    subscribe: (fn) => { listener = fn; return () => {}; }, dispose() {}, abortBash() {},
    prompt: (_text, options) => new Promise((resolve) => {
      inner.isStreaming = true; options.preflightResult(true); listener({ type: "agent_start" });
      finish = () => { writeFileSync(path, "late SDK write"); inner.isStreaming = false; listener({ type: "agent_settled" }); resolve(); };
    }),
    abort: async () => { aborted++; /* emulate idle before outer prompt finalizer */ },
  };
  const wrapper = new AgentSessionWrapper(inner, { onAgentRunComplete: () => completed++ });
  t.after(() => wrapper.destroy()); wrapper.start();
  await wrapper.send({ type: "prompt", message: "start" });
  blockSessionDeletion([inner.sessionId]);
  let settled = false;
  const stopping = wrapper.shutdownForDeletion().then(() => { settled = true; });
  await tick(); assert.equal(aborted, 1); assert.equal(settled, false);
  await assert.rejects(wrapper.send({ type: "prompt", message: "late" }), /deleted/);
  finish(); await stopping;
  assert.equal(readFileSync(path, "utf8"), "late SDK write");
  assert.equal(completed, 0);
  unlinkSync(path); releaseSessionDeletion([inner.sessionId], [inner.sessionId]);
  await tick(); assert.equal(existsSync(path), false);
});

test("late subagent completion cannot recreate its file or reopen/notify deleted parent", async (t) => {
  const dir = isolated(t), path = join(dir, "child.jsonl");
  const run = { sessionId: "child", parentSessionId: "parent", status: "completed", completedAt: new Date().toISOString(), result: "done" };
  let updates = 0, reopened = 0, notified = 0;
  const manager = { appendCustomEntry: (_type, data) => writeFileSync(path, JSON.stringify(data)) };
  publishSubagentCompletion(manager, run, () => updates++);
  assert.equal(existsSync(path), true); unlinkSync(path);
  blockSessionDeletion(["child", "parent"]);
  let complete;
  const completion = new Promise((resolve) => { complete = () => { publishSubagentCompletion(manager, run, () => updates++); resolve(run); }; });
  globalThis.__piSubagentRuns.set("child", { run, completion, abortRequested: false });
  let drained = false;
  const drain = settleSubagentsForDeletion(new Set(["child"])).then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  complete(); await drain;
  releaseSessionDeletion(["child", "parent"], ["child", "parent"]);
  const controller = createSubagentController({ getSession: () => undefined, registerSession() {},
    resolveSessionPath: async () => path,
    reopenSession: async () => { reopened++; return { isAlive: () => true, waitUntilReady: async () => {}, inner: { sendCustomMessage: async () => notified++ } }; },
    invalidateSessionList() {},
  });
  await controller.extensionRuntime.notifyParent(run);
  assert.equal(existsSync(path), false); assert.equal(updates, 1); assert.equal(reopened, 0); assert.equal(notified, 0);
  await assert.rejects(startRpcSession("parent", path, undefined), /deleted/);
});

test("notification checks the deletion fence again after awaited path resolution", async (t) => {
  isolated(t); let resolvePath, reopened = 0;
  const controller = createSubagentController({ getSession: () => undefined, registerSession() {},
    resolveSessionPath: () => new Promise((resolve) => { resolvePath = resolve; }),
    reopenSession: async () => { reopened++; throw new Error("must not reopen"); }, invalidateSessionList() {},
  });
  const notifying = controller.extensionRuntime.notifyParent({ sessionId: "c", parentSessionId: "p" });
  await tick();
  blockSessionDeletion(["p"]); resolvePath("unused");
  await tick(); releaseSessionDeletion(["p"], ["p"]); await notifying;
  assert.equal(reopened, 0);
});

test("surviving fork subagent persists its result and defers notification until reparenting ends", async (t) => {
  const dir = isolated(t), path = join(dir, "surviving-child.jsonl");
  const run = { sessionId: "surviving-child", parentSessionId: "fork", status: "completed", completedAt: new Date().toISOString() };
  blockSessionDeletion(["fork"]);
  publishSubagentCompletion({ appendCustomEntry: (_type, data) => writeFileSync(path, JSON.stringify(data)) }, run);
  assert.equal(existsSync(path), true);
  let sent = 0;
  const controller = createSubagentController({ getSession: () => ({ isAlive: () => true, waitUntilReady: async () => {}, inner: { sendCustomMessage: async () => sent++ } }), registerSession() {}, resolveSessionPath: async () => null, reopenSession: async () => { throw new Error("unused"); }, invalidateSessionList() {} });
  const notifying = controller.extensionRuntime.notifyParent(run);
  await tick(); assert.equal(sent, 0);
  releaseSessionDeletion(["fork"]);
  await notifying; assert.equal(sent, 1);
});

test("notification reopens a surviving fork when the entire deletion fence passes during readiness", async (t) => {
  isolated(t);
  let finishReady, alive = true, sent = 0, reopened = 0;
  const old = { isAlive: () => alive, waitUntilReady: () => new Promise((resolve) => { finishReady = resolve; }), inner: { sendCustomMessage: async () => assert.fail("dead parent") } };
  const fresh = { isAlive: () => true, waitUntilReady: async () => {}, inner: { sendCustomMessage: async () => sent++ } };
  const controller = createSubagentController({ getSession: () => alive ? old : undefined, registerSession() {}, resolveSessionPath: async () => "fixture", reopenSession: async () => { reopened++; return fresh; }, invalidateSessionList() {} });
  const notifying = controller.extensionRuntime.notifyParent({ sessionId: "child", parentSessionId: "fork" });
  await tick(); blockSessionDeletion(["fork"]); alive = false; releaseSessionDeletion(["fork"]); finishReady();
  await notifying; assert.equal(reopened, 1); assert.equal(sent, 1);
});

test("legacy HMR runtimes fail closed while busy and use graceful shutdown once idle",  async (t) => {
  isolated(t);
  const previous = globalThis.__piSessions;
  t.after(() => { globalThis.__piSessions = previous; });
  let busy = true, stopped = 0;
  globalThis.__piSessions = new Map([["old", { isRunning: () => busy, shutdown: async () => stopped++ }], ["new", { shutdownForDeletion: async () => stopped++ }]]);
  await assert.rejects(shutdownSessionsForDeletion(new Set(["new", "old"])), (error) => error.status === 409 && /reload/.test(error.message));
  assert.equal(stopped, 0);
  busy = false;
  await shutdownSessionsForDeletion(new Set(["old", "new"]));
  assert.equal(stopped, 2);
});

test("failed result persistence cannot poison future deletion draining",  async (t) => {
  isolated(t);
  const completion = Promise.reject(new Error("append failed"));
  completion.catch(() => {});
  globalThis.__piSubagentRuns.set("failed-child", { run: {}, completion, abortRequested: false });
  await settleSubagentsForDeletion(new Set(["failed-child"]));
  await settleSubagentsForDeletion(new Set(["failed-child"]));
});

test("deletion waits for RPC and subagent constructions; queue survives a failed request",  async (t) => {
  isolated(t); let rpcDone, childDone;
  globalThis.__piStartLocks.set("p", new Promise((resolve) => { rpcDone = resolve; }));
  globalThis.__piSubagentStarts.set(new Promise((resolve) => { childDone = resolve; }), "p");
  let drained = false;
  const draining = drainSessionStartsForDeletion(new Set(["p"])).then(() => { drained = true; });
  await tick(); assert.equal(drained, false); rpcDone(); await tick(); assert.equal(drained, false);
  childDone(); await draining; assert.equal(drained, true);
  const first = serializeSessionDeletion(async () => { throw new Error("fixture failure"); });
  const second = serializeSessionDeletion(async () => "second succeeds");
  await assert.rejects(first, /fixture failure/); assert.equal(await second, "second succeeds");
});
