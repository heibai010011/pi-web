import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
function callback(name, context) {
  const node = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  assert.ok(node, name);
  return new Script(ts.transpileModule(`(${node.initializer.arguments[0].getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText).runInContext(context);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const commands = [], reads = [], notices = [], restored = [];
  const ui = { branchNavigationBlocked: false };
  const context = createContext({
    console: { error() {} }, URLSearchParams,
    sendAgentCommand: async (sid, cmd) => {
      const d = deferred(); commands.push({ sid, ...cmd, ...d });
      const result = await d.promise;
      if (!result?.cancelled) ui.backendLeaf = cmd.targetId;
      return result;
    },
    fetch: async url => { const d = deferred(); reads.push({ url, ...d }); return d.promise; },
    setActiveLeafId: value => { ui.leaf = value; },
    setBranchNavigationBlocked: value => { ui.branchNavigationBlocked = value; },
    setHistoryCursor() {}, setHasEarlierMessages() {}, setData() {},
    setMessages: value => { ui.messages = value; }, setEntryIds() {},
    addNotice: value => notices.push(value), restoreSubmission: (...args) => restored.push(args), composerDraftKey: "draft",
  });
  for (const [name, current] of Object.entries({
    agentRunningRef: false, bashRunningRef: false, imageGeneratingRef: false,
    sessionIdRef: "session", sessionHookMountedRef: true, branchSelectionSeqRef: 0,
    branchNavigationRef: null, branchMutationRef: null, branchNavigationFailedRef: false, reloadSeqRef: 0,
    historyCursorRef: null, hasEarlierMessagesRef: false, entryIdsRef: [],
  })) context[name] = { current };
  context.loadContext = callback("loadContext", context);
  context.handleLeafChange = callback("handleLeafChange", context);
  return { context, commands, reads, notices, restored, ui,
    select: context.handleLeafChange, navigate: callback("handleNavigate", context), send: callback("handleSend", context),
    resolveRead(index, leaf, pagination = {}) { reads[index].resolve({ ok: true, json: async () => ({ context: { messages: [leaf], entryIds: [leaf], oldestEntryId: null, hasMore: false, ...pagination } }) }); },
  };
}
// Flush the bounded promise continuations in the callbacks; no timers or live I/O.
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }

test("B POST and context finish while obsolete A context remains pending", async () => {
  const s = setup();
  const a = s.select("A"); await flush();
  assert.deepEqual(s.commands.map(c => c.targetId), ["A"]);
  s.commands[0].resolve(); await flush();
  assert.equal(s.reads.length, 1);
  const b = s.select("B"); await flush();
  assert.deepEqual(s.commands.map(c => c.targetId), ["A", "B"]);
  s.commands[1].resolve(); await flush();
  assert.equal(s.reads.length, 2);
  await s.send("not yet"); assert.equal(s.restored.length, 1);
  s.resolveRead(1, "B"); await b;
  assert.equal(s.ui.leaf, "B"); assert.deepEqual(s.ui.messages, ["B"]);
  assert.equal(s.ui.backendLeaf, "B");
  assert.equal(s.context.branchNavigationRef.current, null);
  assert.equal(s.context.branchNavigationFailedRef.current, false);
  s.resolveRead(0, "A"); await a;
  assert.equal(s.ui.leaf, "B"); assert.deepEqual(s.ui.messages, ["B"]);
  assert.equal(s.ui.backendLeaf, "B");
  assert.equal(s.context.branchNavigationRef.current, null);
  assert.equal(s.context.branchNavigationFailedRef.current, false);
});

test("pagination during branch reload is skipped without invalidating context or cursor", async () => {
  const s = setup();
  s.context.historyCursorRef.current = "old-cursor";
  s.context.hasEarlierMessagesRef.current = true;
  const selection = s.select("A"); await flush();
  s.commands[0].resolve(); await flush();
  const seq = s.context.reloadSeqRef.current;
  await s.context.loadContext("session", "A", "old-cursor");
  assert.equal(s.reads.length, 1);
  assert.equal(s.context.reloadSeqRef.current, seq);
  assert.equal(s.context.historyCursorRef.current, "old-cursor");
  assert.equal(s.context.hasEarlierMessagesRef.current, true);
  s.resolveRead(0, "A"); await selection;
  assert.deepEqual(s.ui.messages, ["A"]);
  assert.equal(s.context.branchNavigationRef.current, null);
  assert.equal(s.context.branchNavigationFailedRef.current, false);
  const page = s.context.loadContext("session", "A", "new-cursor"); await flush();
  assert.equal(s.reads.length, 2);
  s.resolveRead(1, "older"); await page;
});

test("B mutation waits for pending A POST but not its context", async () => {
  const s = setup();
  const a = s.select("A"); await flush();
  const b = s.select("B"); await flush();
  assert.equal(s.commands.length, 1);
  s.commands[0].resolve(); await a; await flush();
  assert.deepEqual(s.commands.map(c => c.targetId), ["A", "B"]);
  assert.equal(s.reads.length, 0);
  s.commands[1].resolve(); await flush(); s.resolveRead(0, "B"); await b;
  assert.equal(s.ui.backendLeaf, "B");
});

test("rapid selections coalesce stale unsent mutations and both entry points share ordering", async () => {
  const s = setup();
  const a = s.navigate("A"), b = s.select("B"); await flush();
  assert.deepEqual(s.commands.map(c => c.targetId), ["B"]);
  s.commands[0].resolve(); await flush(); s.resolveRead(0, "B"); await Promise.all([a, b]);
  assert.deepEqual(s.ui.messages, ["B"]);
});

for (const invalidate of ["switch", "unmount"]) test(`${invalidate} discards pending selections and stale context`, async () => {
  const s = setup(); const a = s.select("A"); await flush();
  const b = s.select("B");
  if (invalidate === "switch") s.context.sessionIdRef.current = "other";
  else s.context.sessionHookMountedRef.current = false;
  s.commands[0].resolve(); await Promise.all([a, b]);
  assert.deepEqual(s.commands.map(c => c.targetId), ["A"]);
  assert.equal(s.reads.length, 0);
});

test("null preserves read-current semantics and waits for previous mutation", async () => {
  const s = setup(); const a = s.select("A"); await flush();
  const latest = s.select(null); await flush(); assert.equal(s.reads.length, 0);
  s.commands[0].resolve(); await a; await flush();
  assert.equal(s.commands.length, 1); assert.equal(s.reads.length, 1);
  assert.equal(new URL(s.reads[0].url, "http://fixture").searchParams.has("leafId"), false);
  s.resolveRead(0, "A"); await latest; assert.equal(s.ui.leaf, null);
});

test("send restores draft during pending navigation and after failure; successful reselection recovers", async () => {
  const s = setup(); const a = s.navigate("A"); await flush();
  const images = [{ id: "fixture", name: "photo.png", data: "fixture-only" }];
  await s.send("draft", images); assert.equal(s.restored.length, 1);
  assert.equal(s.restored[0][0], "draft");
  assert.equal(s.restored[0][1], images);
  assert.equal(s.restored[0][2], "draft");
  assert.equal(s.commands.length, 1);
  s.commands[0].reject(new Error("navigation failed")); await a;
  assert.equal(s.context.branchNavigationFailedRef.current, true);
  await s.send("retry draft"); assert.equal(s.restored.length, 2);
  const retry = s.select("A"); await flush(); s.commands[1].resolve(); await flush();
  s.resolveRead(0, "A"); await retry;
  assert.equal(s.context.branchNavigationFailedRef.current, false);
  assert.equal(s.context.branchNavigationRef.current, null);
});

test("cancelled backend navigation fails closed instead of displaying an unselected branch", async () => {
  const s = setup(); const pending = s.select("A"); await flush();
  s.commands[0].resolve({ cancelled: true }); await pending;
  assert.equal(s.reads.length, 0);
  assert.equal(s.context.branchNavigationFailedRef.current, true);
  await s.send("draft"); assert.equal(s.restored.length, 1);
});

test("failed context load keeps sends blocked even after backend navigation succeeds", async () => {
  const s = setup(); const pending = s.select("A"); await flush();
  s.commands[0].resolve(); await flush();
  s.reads[0].resolve({ ok: false, status: 500 }); await pending;
  assert.equal(s.context.branchNavigationFailedRef.current, true);
  await s.send("draft"); assert.equal(s.restored.length, 1);
});

test("failure of an obsolete selection does not poison a newer queued selection", async () => {
  const s = setup();
  const a = s.select("A"); await flush();
  const b = s.select("B");
  s.commands[0].reject(new Error("obsolete failure"));
  await a; await flush();
  assert.equal(s.notices.length, 0);
  assert.deepEqual(s.commands.map(c => c.targetId), ["A", "B"]);
  s.commands[1].resolve(); await flush();
  s.resolveRead(0, "B"); await b;
  assert.deepEqual(s.ui.messages, ["B"]);
  assert.equal(s.context.branchNavigationFailedRef.current, false);
  assert.equal(s.context.branchNavigationRef.current, null);
});

// Execute the production observer effect and its actual dependency array. The fake
// observer reports an already-visible sentinel once per observe(), never polls.
const chatSource = ts.createSourceFile("ChatWindow.tsx", await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let observerEffect;
function findObserver(node) {
  if (ts.isCallExpression(node) && node.expression.getText(chatSource) === "useEffect"
    && node.arguments[0]?.getText(chatSource).includes("new IntersectionObserver(")) observerEffect = node;
  ts.forEachChild(node, findObserver);
}
findObserver(chatSource);
assert.ok(observerEffect);
function paginationObserver(s) {
  const observers = [];
  Object.assign(s.context, {
    sentinelRef: { current: {} },
    scrollContainerRef: { current: { scrollHeight: 1000, scrollTop: 0 } },
    loadingOlderRef: { current: false }, prevScrollDistanceRef: { current: null },
    captureScrollDistance: (height, top) => height - top,
    session: { id: "session" }, historyCursor: "shared-cursor", hasEarlierMessages: true,
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
      observe() { this.callback([{ isIntersecting: true }]); }
      disconnect() { this.disconnected = true; }
    },
  });
  const compile = node => new Script(ts.transpileModule(`(${node.getText(chatSource)})`, {
    compilerOptions: { target: ts.ScriptTarget.ESNext },
  }).outputText);
  const effect = compile(observerEffect.arguments[0]).runInContext(s.context);
  const dependencies = compile(observerEffect.arguments[1]);
  let previous, cleanup;
  return {
    observers,
    render() {
      s.context.activeLeafId = s.ui.leaf ?? null;
      s.context.branchNavigationBlocked = s.ui.branchNavigationBlocked;
      const next = dependencies.runInContext(s.context);
      if (previous && next.every((value, index) => Object.is(value, previous[index]))) return;
      cleanup?.();
      previous = next;
      cleanup = effect();
    },
  };
}

test("visible sentinel re-arms after branch success with the same cursor and leaf", async () => {
  const s = setup();
  s.ui.leaf = "A";
  const observer = paginationObserver(s);
  // Observe without history first, then keep cursor/hasMore unchanged throughout
  // the selection. Only the branch lifecycle state can trigger the final retry.
  s.context.loadingOlderRef.current = true;
  observer.render();
  s.context.loadingOlderRef.current = false;
  const pending = s.select("A");
  observer.render();
  assert.equal(observer.observers[0].disconnected, true);
  assert.equal(observer.observers.length, 1);
  await flush(); s.commands[0].resolve(); await flush();
  observer.render();
  assert.equal(s.reads.length, 1);
  assert.equal(s.ui.branchNavigationBlocked, true);
  s.resolveRead(0, "A", { oldestEntryId: "shared-cursor", hasMore: true });
  await pending;
  observer.render(); await flush();
  assert.equal(s.ui.branchNavigationBlocked, false);
  assert.equal(observer.observers.length, 2);
  assert.equal(s.reads.length, 2);
  const url = new URL(s.reads[1].url, "http://fixture");
  assert.equal(url.searchParams.get("before"), "shared-cursor");
  assert.equal(url.searchParams.get("leafId"), "A");
  s.resolveRead(1, "older"); await flush();
  assert.equal(s.context.loadingOlderRef.current, false);
});

test("obsolete pending page neither blocks branch rearm nor unlocks its newer page", async () => {
  const s = setup(); const observer = paginationObserver(s);
  observer.render(); await flush();
  assert.equal(s.reads.length, 1);
  assert.equal(s.context.loadingOlderRef.current, true);
  const selection = s.select("B"); observer.render(); await flush();
  assert.equal(s.context.loadingOlderRef.current, false);
  s.commands[0].resolve(); await flush();
  s.resolveRead(1, "B", { oldestEntryId: "shared-cursor", hasMore: true });
  await selection; observer.render(); await flush();
  assert.equal(s.reads.length, 3);
  assert.equal(s.context.loadingOlderRef.current, true);
  assert.match(s.reads[2].url, /leafId=B/);
  s.resolveRead(0, "obsolete"); await flush();
  assert.equal(s.context.loadingOlderRef.current, true, "old finally cannot clear new page ownership");
  assert.deepEqual(s.ui.messages, ["B"]);
  s.resolveRead(2, "older-B"); await flush();
  assert.equal(s.context.loadingOlderRef.current, false);
  observer.observers[0].callback([{ isIntersecting: true }]); await flush();
  assert.equal(s.reads.length, 3, "disconnected observer cannot start another page");
});

for (const failure of ["mutation", "context"]) test(`failed ${failure} stays gated until successful reselection`, async () => {
  const s = setup(); const observer = paginationObserver(s);
  const pending = s.select("A"); observer.render(); await flush();
  if (failure === "mutation") s.commands[0].reject(new Error("failed"));
  else {
    s.commands[0].resolve(); await flush();
    s.reads[0].resolve({ ok: false, status: 500 });
  }
  await pending; observer.render();
  assert.equal(s.ui.branchNavigationBlocked, true);
  assert.equal(observer.observers.length, 0);
  const seq = s.context.reloadSeqRef.current;
  await s.context.loadContext("session", "A", "shared-cursor");
  assert.equal(s.context.reloadSeqRef.current, seq);
  const retry = s.select("A"); observer.render(); await flush();
  s.commands[1].resolve(); await flush();
  s.resolveRead(s.reads.length - 1, "A", { oldestEntryId: "shared-cursor", hasMore: true });
  await retry; observer.render(); await flush();
  assert.equal(observer.observers.length, 1);
  assert.equal(s.ui.branchNavigationBlocked, false);
  assert.match(s.reads.at(-1).url, /before=shared-cursor/);
  s.resolveRead(s.reads.length - 1, "older"); await flush();
});

test("obsolete completion cannot release the latest selection's pagination gate", async () => {
  const s = setup();
  const a = s.select("A"); await flush(); s.commands[0].resolve(); await flush();
  const b = s.select("B"); await flush();
  s.resolveRead(0, "A"); await a;
  assert.equal(s.ui.branchNavigationBlocked, true);
  s.commands[1].resolve(); await flush(); s.resolveRead(1, "B"); await b;
  assert.equal(s.ui.branchNavigationBlocked, false);
});

test("active prompt refuses new branch mutations", async () => {
  const s = setup(); s.context.agentRunningRef.current = true;
  await s.select("A"); await s.navigate("B");
  assert.equal(s.commands.length, 0); assert.equal(s.ui.leaf, undefined);
});
