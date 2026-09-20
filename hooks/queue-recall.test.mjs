import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Exercise actual hook callbacks with deferred RPC and the real draft merge/store.
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
const attachmentSource = await readFile(new URL("../lib/image-attachments.ts", import.meta.url), "utf8");
const draftSource = await readFile(new URL("../lib/draft-store.ts", import.meta.url), "utf8");
function loadModule(text, require = () => { throw new Error("Unexpected import"); }) {
  const exports = {};
  new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText)
    .runInContext(createContext({ exports, require }));
  return exports;
}
const images = [{ data: "YQ==", mimeType: "image/png" }];
const plain = value => JSON.parse(JSON.stringify(value));
function setup({ draftKey = "A" } = {}) {
  const store = loadModule(draftSource, () => loadModule(attachmentSource));
  const commands = [], notices = [], inputWrites = [], storeWrites = [], queueUpdates = [];
  const input = {
    key: draftKey,
    draft: { value: "current A", images },
    restoreSubmission(text, restoredImages, target) {
      inputWrites.push({ text, target });
      if (target !== this.key) { store.restoreDraftSubmission(target, text, restoredImages); return; }
      this.draft = store.mergeRestoredSubmissionDraft(text, restoredImages, this.draft.value, this.draft.images);
      store.setDraft(this.key, this.draft);
    },
  };
  store.setDraft(draftKey, input.draft);
  store.setDraft("B", { value: "B untouched", images });
  const context = createContext({
    console: { error() {} }, composerDraftKey: draftKey, newSessionDraftKey: "new",
    sessionIdRef: { current: "A" }, sessionHookMountedRef: { current: true },
    builtinCommandLifetimeRef: { current: 1 }, newSessionPromotedRef: { current: false },
    draftKeyAliasesRef: { current: new Map() }, opts: { chatInputRef: { current: input } },
    sendAgentCommand: (sid, command) => new Promise((resolve, reject) => { commands.push({ sid, command, resolve, reject }); }),
    restoreDraftSubmission: (...args) => { storeWrites.push(args); return store.restoreDraftSubmission(...args); },
    setQueuedMessages: value => queueUpdates.push(plain(value)), addNotice: value => notices.push(value),
  });
  context.resolveComposerDraftKey = callback("resolveComposerDraftKey", context);
  context.restoreSubmission = callback("restoreSubmission", context);
  return { context, store, commands, notices, inputWrites, storeWrites, queueUpdates, input,
    recall: callback("handleRecallQueue", context) };
}
const recalled = { steering: ["steer 1", "steer 2"], followUp: ["follow up"] };
const restoredText = "steer 1\n\nsteer 2\n\nfollow up\n\ncurrent A";
function assertDraft(s, key, value) { assert.deepEqual(plain(s.store.getDraft(key)), { value, images }); }

test("same-session recall restores ordered queue before current text and preserves images", async () => {
  const s = setup();
  const pending = s.recall();
  assert.equal(s.commands.length, 1);
  assert.equal(s.commands[0].sid, "A");
  assert.deepEqual(plain(s.commands[0].command), { type: "clear_queue" });
  s.commands[0].resolve(recalled); await pending;
  assertDraft(s, "A", restoredText);
  assert.equal(s.input.draft.value, restoredText);
  assert.equal(s.inputWrites.length, 1);
  assert.equal(s.inputWrites[0].target, "A");
  assert.deepEqual(s.queueUpdates, [{ steering: [], followUp: [] }]);
  assert.equal(s.notices.length, 0);
});

for (const stale of ["switch", "unmount", "away-and-back"]) {
  for (const ref of ["null", "B"]) {
    test(`${stale} recall persists A with ${ref} input without touching live UI`, async () => {
      const s = setup(), pending = s.recall();
      if (stale === "switch") s.context.sessionIdRef.current = "B";
      if (stale === "unmount") s.context.sessionHookMountedRef.current = false;
      if (stale === "away-and-back") s.context.builtinCommandLifetimeRef.current += 2;
      s.context.opts.chatInputRef.current = ref === "null" ? null : { restoreSubmission() { assert.fail("B live input touched"); }, prependText() { assert.fail("B text touched"); } };
      s.commands[0].resolve(recalled); await pending;
      assertDraft(s, "A", restoredText);
      assertDraft(s, "B", "B untouched");
      assert.equal(s.storeWrites.length, 1);
      assert.equal(s.inputWrites.length, 0);
      assert.deepEqual(s.queueUpdates, []);
      assert.equal(s.notices.length, 0);
    });
  }
}

test("unmounted provisional draft recall follows new-to-real alias despite fresh-prompt cleanup", async () => {
  const s = setup({ draftKey: "new" }), pending = s.recall();
  s.store.rekeyDraft("new", "A");
  s.context.draftKeyAliasesRef.current.set("new", "A");
  s.context.sessionHookMountedRef.current = false;
  s.context.opts.chatInputRef.current = null;
  s.commands[0].resolve(recalled); await pending;
  assert.equal(s.store.getDraft("new"), null);
  assertDraft(s, "A", restoredText);
  assert.equal(s.storeWrites.length, 1);
  assert.deepEqual(s.queueUpdates, []);
});

test("current recall without an input persists in draft store", async () => {
  const s = setup(), pending = s.recall();
  s.context.opts.chatInputRef.current = null;
  s.commands[0].resolve(recalled); await pending;
  assertDraft(s, "A", restoredText);
  assert.equal(s.storeWrites.length, 1);
  assert.equal(s.queueUpdates.length, 1);
});

for (const stale of [false, "switch", "unmount"]) {
  test(`${stale || "current"} recall error does not restore or retry destructive RPC`, async () => {
    const s = setup(), pending = s.recall();
    if (stale === "switch") s.context.sessionIdRef.current = "B";
    if (stale === "unmount") s.context.sessionHookMountedRef.current = false;
    s.commands[0].reject(new Error("response lost after clear")); await pending;
    assertDraft(s, "A", "current A");
    assertDraft(s, "B", "B untouched");
    assert.equal(s.inputWrites.length + s.storeWrites.length, 0);
    assert.equal(s.notices.length, stale ? 0 : 1);
    assert.deepEqual(s.queueUpdates, []);
    assert.equal(s.commands.length, 1);
  });
}

for (const result of [undefined, {}, { steering: [], followUp: [] }]) {
  test(`empty queue ${JSON.stringify(result)} clears current queue UI without draft writes`, async () => {
    const s = setup(), pending = s.recall();
    s.commands[0].resolve(result); await pending;
    assertDraft(s, "A", "current A");
    assert.equal(s.inputWrites.length + s.storeWrites.length, 0);
    assert.deepEqual(s.queueUpdates, [{ steering: [], followUp: [] }]);
  });
}

test("concurrent destructive recalls restore each nonempty response exactly once, even out of order", async () => {
  const s = setup();
  const first = s.recall(), second = s.recall(), third = s.recall();
  assert.equal(s.commands.length, 3);
  s.context.sessionHookMountedRef.current = false;
  s.context.opts.chatInputRef.current = null;
  s.commands[1].resolve({ followUp: ["second"] }); await second;
  s.commands[2].resolve({ steering: [], followUp: [] }); await third;
  s.commands[0].resolve({ steering: ["first"] }); await first;
  assertDraft(s, "A", "first\n\nsecond\n\ncurrent A");
  assert.equal(s.storeWrites.length, 2);
  assert.equal(s.commands.length, 3);
  assert.deepEqual(s.queueUpdates, []);
});

test("no active session makes recall a no-op", async () => {
  const s = setup(); s.context.sessionIdRef.current = null;
  await s.recall();
  assert.equal(s.commands.length, 0);
  assert.deepEqual(s.queueUpdates, []);
});
