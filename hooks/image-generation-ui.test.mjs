import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";
const text = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("hook.ts", text, ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(n) { nodes.push(n); ts.forEachChild(n, visit); }
visit(source);
const declaration = nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(source) === "handleAgentEvent");
const eventScript = new Script(ts.transpileModule(`(${declaration.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
function setup(pending = false) {
  const busy = [], loads = [], closes = [];
  const context = { imageRunIdRef: { current: 0 }, imageRequestPendingRef: { current: pending }, imageGeneratingRef: { current: false }, sessionIdRef: { current: "session" }, cancelEventStreamGrace() {}, setIsGeneratingImage: value => busy.push(value), loadSession: sid => loads.push(sid), scheduleEventStreamClose: sid => closes.push(sid) };
  return { context, busy, loads, closes, event: eventScript.runInNewContext(context) };
}
test("restored image run settles on SSE without entering text streaming", () => {
  const s = setup();
  s.event({ type: "image_generation_start" });
  assert.equal(s.context.imageGeneratingRef.current, true);
  s.event({ type: "image_generation_end" });
  assert.deepEqual(s.busy, [true, false]);
  assert.deepEqual(s.loads, ["session"]);
  assert.deepEqual(s.closes, ["session"]);
  assert.equal(s.context.imageRunIdRef.current, 1);
});
test("terminal SSE cannot unlock an outstanding local image POST", () => {
  const s = setup(true);
  s.event({ type: "image_generation_start" });
  s.event({ type: "image_generation_end" });
  assert.equal(s.context.imageGeneratingRef.current, true);
  assert.deepEqual(s.busy, [true]);
  assert.deepEqual(s.loads, ["session"]);
  assert.deepEqual(s.closes, []);
});
test("aborted local generation restores the composer without promoting an empty session", async () => {
  const handler = nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(source) === "handleImageGenerate");
  const script = new Script(ts.transpileModule(`(${handler.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
  const restored = [], promoted = [];
  const context = {
    sessionHookMountedRef: { current: true }, imageSubmissionIdRef: { current: 0 }, session: { id: "sid" },
    branchNavigationRef: { current: null }, branchNavigationFailedRef: { current: false },
    agentRunningRef: { current: false }, bashRunningRef: { current: false }, imageGeneratingRef: { current: false },
    cancelPendingImageRef: { current: null }, imageRequestPendingRef: { current: false }, imageRunIdRef: { current: 0 }, imageModelRef: { current: { provider: "p", modelId: "m" } }, sessionIdRef: { current: "sid" },
    cancelEventStreamGrace() {}, setIsGeneratingImage() {}, ensureEventsConnected: async () => {},
    sendAgentCommand: async () => ({ ok: false, stopReason: "aborted" }),
    restoreSubmission: (...args) => restored.push(args), composerDraftKey: "draft", scheduleEventStreamClose() {},
    promoteNewSession: (...args) => promoted.push(args),
  };
  await script.runInNewContext(context)("draw", [], {});
  assert.equal(restored[0][0], "draw");
  assert.equal(promoted.length, 0);
  assert.equal(context.imageGeneratingRef.current, false);
});

test("image state participates in composer busy and refresh restoration", async () => {
  const windowSource = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(windowSource, /const sessionBusy = agentRunning \|\| bashRunning \|\| isGeneratingImage/);
  assert.match(text, /if \(agentState.state\?\.isGeneratingImage\)/);
});

function callback(name, context) {
  const node = nodes.find(n => ts.isVariableDeclaration(n) && n.name.getText(source) === name);
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
// Real callbacks, including shared session creation, run against deferred fixture
// I/O only. Stop must release the composer without waiting for either boundary.
function startupSetup({ existing = false } = {}) {
  const startup = deferred(), startupEntered = deferred(), events = deferred(), eventsEntered = deferred();
  const commands = [], restored = [], stored = [], notices = [], promoted = [], loads = [], scheduled = [];
  const ui = { busy: false, closes: 0 };
  const context = createContext({
    console: { error() {} }, isNew: !existing, newSessionCwd: "/fixture", newSessionDraftKey: "draft",
    session: existing ? { id: "existing" } : null, composerDraftKey: "draft", modelList: [], toolPreset: "default",
    fetch: async () => { startupEntered.resolve(); return startup.promise; },
    getToolNamesForPreset: () => [], claimSessionFolderDraft() {}, promoteSessionFolderDraft() {},
    setNewSessionModel() {}, setPendingModel() {}, setNewSessionDefaultModel() {}, setThinkingLevel() {},
    cancelEventStreamGrace() {}, closeEvents: () => { ui.closes++; },
    ensureEventsConnected: async () => { eventsEntered.resolve(); await events.promise; },
    sendAgentCommand: async (sid, command) => { commands.push({ sid, ...command }); return { ok: true }; },
    restoreDraftSubmission: (...args) => stored.push(args),
    restoreSubmission: (...args) => restored.push(args), promoteNewSession: (...args) => promoted.push(args),
    addNotice: notice => notices.push(notice), loadSession: async sid => { loads.push(sid); },
    scheduleEventStreamClose: sid => scheduled.push(sid), setIsGeneratingImage: value => { ui.busy = value; },
  });
  for (const [name, current] of Object.entries({
    sessionHookMountedRef: true, imageSubmissionIdRef: 0,
    branchNavigationRef: null, branchNavigationFailedRef: false,
    agentRunningRef: false, bashRunningRef: false, imageGeneratingRef: false, imageRequestPendingRef: false,
    imageRunIdRef: 0, imageModelRef: { provider: "fixture", modelId: "image" },
    sessionIdRef: existing ? "existing" : null, ensuringNewSessionRef: null,
    newSessionModelOverrideRef: null, thinkingLevelOverrideRef: null,
    cancelPendingPromptRef: null, cancelPendingBashRef: null, cancelPendingImageRef: null,
  })) context[name] = { current };
  context.ensureNewSession = callback("ensureNewSession", context);
  return {
    context, ui, commands, restored, stored, notices, promoted, loads, scheduled, startup, startupEntered, events, eventsEntered,
    generate: callback("handleImageGenerate", context), stop: callback("handleAbort", context),
    event: callback("handleAgentEvent", context),
    resolveStartup() { startup.resolve({ ok: true, json: async () => ({ sessionId: "created" }) }); },
  };
}
for (const existing of [false, true]) {
  for (const exit of ["switch", "unmount"]) {
    for (const rejects of [false, true]) {
      test(`stale ${existing ? "existing" : "fresh"} image SSE ${exit} ${rejects ? "reject" : "resolve"} never dispatches`, async () => {
        const s = startupSetup({ existing });
        const pending = s.generate("draw", fixtureImages, {});
        if (!existing) { await s.startupEntered.promise; s.resolveStartup(); }
        await s.eventsEntered.promise;
        if (exit === "switch") s.context.sessionIdRef.current = "other";
        else s.context.sessionHookMountedRef.current = false;
        const snapshot = { ...s.ui };
        if (rejects) s.events.reject(new Error("closed")); else s.events.resolve();
        await pending;
        assert.equal(s.commands.length, 0);
        assert.deepEqual(s.stored, existing ? [["draft", "draw", fixtureImages]] : []);
        assert.deepEqual(s.restored, []);
        assert.deepEqual(s.ui, snapshot);
        assert.deepEqual([s.notices, s.promoted, s.loads, s.scheduled], [[], [], [], []]);
      });
    }
  }
}
for (const rejects of [false, true]) {
  test(`abandoned fresh startup ${rejects ? "reject" : "resolve"} leaves cleanup intact`, async () => {
    const s = startupSetup();
    const pending = s.generate("draw", fixtureImages, {});
    await s.startupEntered.promise;
    s.context.sessionHookMountedRef.current = false;
    s.events.resolve();
    if (rejects) s.startup.reject(new Error("closed")); else s.resolveStartup();
    await pending;
    assert.deepEqual([s.commands, s.restored, s.stored, s.notices, s.promoted, s.loads, s.scheduled], [[], [], [], [], [], [], []]);
  });
}
for (const ownership of ["switch", "unmount", "newer-run"]) {
for (const result of ["success", "aborted", "rejected"]) {
  test(`stale dispatched ${result} after ${ownership} cannot touch newer image ownership`, async () => {
    const s = startupSetup({ existing: true });
    const response = deferred(), entered = deferred();
    s.context.sendAgentCommand = async () => { entered.resolve(); return response.promise; };
    const pending = s.generate("draw", fixtureImages, {});
    s.events.resolve();
    await entered.promise;
    if (ownership === "switch") s.context.sessionIdRef.current = "other";
    if (ownership === "unmount") s.context.sessionHookMountedRef.current = false;
    if (ownership === "newer-run") s.context.imageSubmissionIdRef.current += 1;
    const newerCancel = () => {};
    s.context.cancelPendingImageRef.current = newerCancel;
    if (result === "rejected") response.reject(new Error("lost response"));
    else response.resolve(result === "aborted" ? { stopReason: "aborted" } : { ok: true });
    await pending;
    assert.equal(s.context.imageGeneratingRef.current, true);
    assert.equal(s.context.imageRequestPendingRef.current, true);
    assert.equal(s.context.cancelPendingImageRef.current, newerCancel);
    assert.deepEqual([s.restored, s.stored, s.notices, s.promoted, s.loads, s.scheduled], [[], [], [], [], [], []]);
  });
}
}
test("active resolved image errors retain existing reload and retry semantics", async () => {
  const s = startupSetup({ existing: true });
  s.context.sendAgentCommand = async () => ({ ok: false, errorMessage: "provider error" });
  const pending = s.generate("draw", [], {});
  s.events.resolve();
  await pending;
  assert.equal(s.notices[0].message, "provider error");
  assert.deepEqual(s.restored, []);
  assert.deepEqual(s.loads, ["existing"]);
  assert.equal(s.promoted.length, 1);
  assert.equal(s.ui.busy, false);
});
test("switch during image reload cannot promote the wrong session", async () => {
  const s = startupSetup({ existing: true });
  const reload = deferred(), entered = deferred();
  s.context.loadSession = async () => { entered.resolve(); await reload.promise; };
  const pending = s.generate("draw", [], {});
  s.events.resolve();
  await entered.promise;
  s.context.sessionIdRef.current = "other";
  reload.resolve();
  await pending;
  assert.deepEqual(s.promoted, []);
  assert.deepEqual(s.scheduled, []);
});
const fixtureImages = [{ mimeType: "image/png", data: "fixture", name: "reference.png" }];
function assertCancelled(s) {
  assert.equal(s.ui.busy, false);
  assert.equal(s.context.imageGeneratingRef.current, false);
  assert.equal(s.context.imageRequestPendingRef.current, false);
  assert.equal(s.context.cancelPendingImageRef.current, null);
  assert.deepEqual(s.restored, [["  draw fixture  ", fixtureImages, "draft"]]);
  assert.equal(s.notices.length, 0);
  assert.equal(s.commands.length, 0);
  assert.equal(s.promoted.length, 0);
  assert.equal(s.loads.length, 0);
  assert.equal(s.scheduled.length, 0);
  assert.equal(s.ui.closes, 1);
}
for (const sidAvailable of [false, true]) {
  test(`image Stop during creation restores once with session ID ${sidAvailable ? "available" : "absent"}`, async () => {
    const s = startupSetup();
    const pending = s.generate("  draw fixture  ", fixtureImages, {});
    await s.startupEntered.promise;
    const ticket = s.context.imageRunIdRef.current;
    if (sidAvailable) s.context.sessionIdRef.current = "created";
    const cancel = s.context.cancelPendingImageRef.current;
    await s.stop();
    cancel(); // A retained local callback cannot restore twice.
    assert.equal(s.context.imageRunIdRef.current, ticket + 1);
    assertCancelled(s);
    s.resolveStartup();
    await pending;
    assertCancelled(s);
  });
}
for (const existing of [false, true]) {
  test(`image Stop during ${existing ? "existing" : "new"}-session SSE readiness prevents dispatch`, async () => {
    const s = startupSetup({ existing });
    const pending = s.generate("  draw fixture  ", fixtureImages, {});
    if (!existing) { await s.startupEntered.promise; s.resolveStartup(); }
    await s.eventsEntered.promise;
    await s.stop();
    assertCancelled(s);
    s.events.resolve();
    await pending;
    assertCancelled(s);
  });
}
for (const boundary of ["creation", "events"]) {
  for (const rejects of [false, true]) {
    test(`cancelled image ${boundary} late ${rejects ? "rejection" : "completion"} cannot clear newer image startup`, async () => {
      const s = startupSetup({ existing: boundary === "events" });
      const old = s.generate("  draw fixture  ", fixtureImages, {});
      await (boundary === "creation" ? s.startupEntered : s.eventsEntered).promise;
      await s.stop();
      s.context.sessionIdRef.current = "other";
      const newerEvents = deferred(), newerEntered = deferred();
      s.context.ensureEventsConnected = async () => { newerEntered.resolve(); await newerEvents.promise; };
      const newer = s.generate("new", [], {});
      await newerEntered.promise;
      const cancelNew = s.context.cancelPendingImageRef.current;
      if (rejects) (boundary === "creation" ? s.startup : s.events).reject(new Error("closed"));
      else if (boundary === "creation") s.resolveStartup();
      else s.events.resolve();
      await old;
      assert.equal(s.ui.busy, true);
      assert.equal(s.context.imageGeneratingRef.current, true);
      assert.equal(s.context.imageRequestPendingRef.current, true);
      assert.equal(s.context.cancelPendingImageRef.current, cancelNew);
      assert.deepEqual(s.restored, [["  draw fixture  ", fixtureImages, "draft"]]);
      assert.equal(s.notices.length, 0);
      assert.equal(s.scheduled.length, 0);
      assert.equal(s.commands.length, 0);
      assert.equal(s.ui.closes, 1);
      // Shared creation writes its returned ID; keep the newer fixture's
      // selected session consistent before releasing its own SSE boundary.
      s.context.sessionIdRef.current = "other";
      newerEvents.resolve();
      await newer;
      assert.deepEqual(s.commands.map(c => [c.type, c.prompt]), [["image_generate", "new"]]);
    });
  }
}
test("stopped and newer images share pending creation without stale cleanup", async () => {
  const s = startupSetup();
  const old = s.generate("  draw fixture  ", fixtureImages, {});
  await s.startupEntered.promise;
  await s.stop();
  const newer = s.generate("new", [], {});
  s.resolveStartup();
  await s.eventsEntered.promise;
  await old;
  assert.equal(s.ui.busy, true);
  assert.equal(s.context.imageRequestPendingRef.current, true);
  assert.equal(s.scheduled.length, 0);
  s.events.resolve();
  await newer;
  assert.deepEqual(s.commands.map(c => [c.type, c.prompt]), [["image_generate", "new"]]);
  assert.deepEqual(s.restored, [["  draw fixture  ", fixtureImages, "draft"]]);
});
for (const aborted of [false, true]) {
  test(`image Stop after dispatch preserves server abort and ${aborted ? "restoration" : "successful settlement"} across start SSE`, async () => {
    const s = startupSetup({ existing: true });
    const command = deferred(), dispatched = deferred();
    s.context.sendAgentCommand = async (sid, cmd) => {
      s.commands.push({ sid, ...cmd });
      if (cmd.type === "image_generate") { dispatched.resolve(); return command.promise; }
    };
    const pending = s.generate("  draw fixture  ", fixtureImages, { count: 2, aspectRatio: "1:1", seed: 0 });
    s.events.resolve();
    await dispatched.promise;
    assert.equal(s.context.cancelPendingImageRef.current, null);
    const ticket = s.context.imageRunIdRef.current;
    s.event({ type: "image_generation_start" });
    assert.equal(s.context.imageRunIdRef.current, ticket + 1);
    await s.stop();
    assert.deepEqual(s.commands.map(c => c.type), ["image_generate", "abort"]);
    assert.equal(s.commands[0].prompt, "draw fixture");
    assert.equal(s.commands[0].count, 2);
    assert.equal(s.commands[0].aspectRatio, "1:1");
    assert.equal(s.commands[0].seed, 0);
    assert.equal(s.commands[0].images[0].data, "fixture");
    assert.equal(s.ui.busy, true);
    assert.equal(s.context.imageRequestPendingRef.current, true);
    assert.equal(s.restored.length, 0);
    command.resolve(aborted ? { ok: false, stopReason: "aborted" } : { ok: true });
    await pending;
    assert.equal(s.ui.busy, false);
    assert.equal(s.context.imageRequestPendingRef.current, false);
    assert.equal(s.restored.length, aborted ? 1 : 0);
    assert.equal(s.promoted.length, aborted ? 0 : 1);
    assert.equal(s.loads.length, aborted ? 0 : 1);
    assert.deepEqual(s.scheduled, ["existing"]);
  });
}

