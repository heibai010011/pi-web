import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Execute the real hook callbacks with deterministic deferred I/O, following
// model-loading.test.mjs. No source-regex assertions, servers, or live sessions.
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
test("Stop rejection is visible and does not pretend the run settled", async () => {
  const s = setup({ existing: true });
  s.context.agentRunningRef.current = true;
  s.context.sendAgentCommand = async () => { throw new Error("Reload session to support cancellation"); };
  await s.stop();
  assert.equal(s.context.agentRunningRef.current, true);
  assert.equal(s.notices.length, 1);
  assert.match(s.notices[0].message, /Reload session/);
});

function setup({ existing = false } = {}) {
  const startup = deferred(), startupEntered = deferred(), events = deferred(), eventsEntered = deferred();
  const commands = [], restored = [], notices = [], promoted = [];
  const ui = { messages: [], running: false, phase: null, streaming: false, closes: 0 };
  const context = createContext({
    console: { error() {} }, crypto: webcrypto,
    isNew: !existing, newSessionCwd: existing ? null : "/fixture", newSessionModel: null,
    session: existing ? { id: "existing" } : null, composerDraftKey: "draft",
    newSessionDraftKey: "draft", modelList: [], toolPreset: "default",
    fetch: async () => { startupEntered.resolve(); return startup.promise; },
    getToolNamesForPreset: () => [], claimSessionFolderDraft() {}, promoteSessionFolderDraft() {},
    setNewSessionModel() {}, setPendingModel() {}, setNewSessionDefaultModel() {}, setThinkingLevel() {},
    cancelEventStreamGrace() {},
    ensureEventsConnected: async () => { eventsEntered.resolve(); await events.promise; },
    closeEvents: () => { ui.closes++; },
    sendAgentCommand: async (sid, command) => { commands.push({ sid, ...command }); },
    restoreSubmission: (...args) => restored.push(args),
    restoreDraftSubmission: (key, text, images) => restored.push([text, images, key]),
    promoteNewSession: (...args) => promoted.push(args),
    addNotice: notice => notices.push(notice),
    isPromptRejectedError: () => false,
    waitForPromptSettlement() {}, reconcileAgentState() {},
    userMessageKey: message => JSON.stringify(message),
    setMessages: update => { ui.messages = update(ui.messages); },
    loadSession: async () => {},
    setPendingBash: value => { ui.pendingBash = value; },
    setBashRunning: value => { ui.bashRunning = value; },
    setAgentRunning: value => { ui.running = value; },
    setAgentPhase: value => { ui.phase = value; },
    setPromptAnchorActive: value => { ui.anchor = value; },
    dispatch: action => { ui.streaming = action.type === "start"; },
  });
  const refs = {
    branchNavigationRef: null, branchNavigationFailedRef: false, sessionHookMountedRef: true,
    agentRunningRef: false, bashRunningRef: false, imageGeneratingRef: false,
    sessionIdRef: existing ? "existing" : null, promptRunIdRef: 0,
    cancelPendingPromptRef: null, cancelPendingBashRef: null, cancelPendingImageRef: null, bashRecoveryIdRef: 0, bashSubmissionIdRef: 0, rpcPromptPendingRef: false,
    promptAdmissionPendingRunRef: null, promptRequestRef: null, sdkAgentActiveRef: false,
    optimisticUserMessageKeyRef: null, optimisticUserMessageRef: null,
    pendingScrollToUserRef: false, chatAnchorModeRef: "prompt-anchor", userScrolledUpRef: false,
    ensuringNewSessionRef: null, newSessionModelOverrideRef: null, thinkingLevelOverrideRef: null,
  };
  for (const [name, current] of Object.entries(refs)) context[name] = { current };
  context.ensureNewSession = callback("ensureNewSession", context);
  context.executeBashRef = { current: callback("executeBash", context) };
  return {
    context, ui, commands, restored, notices, promoted, startup, startupEntered, events, eventsEntered,
    send: callback("handleSend", context), stop: callback("handleAbort", context),
    resolveStartup() { startup.resolve({ ok: true, json: async () => ({ sessionId: "created" }) }); },
  };
}
// Use the actual draft store (including its merge rules) and restore callback.
const attachmentSource = await readFile(new URL("../lib/image-attachments.ts", import.meta.url), "utf8");
const draftSource = await readFile(new URL("../lib/draft-store.ts", import.meta.url), "utf8");
function loadModule(text, require = () => { throw new Error("Unexpected import"); }) {
  const exports = {};
  new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText)
    .runInContext(createContext({ exports, require }));
  return exports;
}
function wireDrafts(s) {
  const store = loadModule(draftSource, () => loadModule(attachmentSource));
  let inputWrites = 0, storeWrites = 0;
  Object.assign(s.context, {
    newSessionPromotedRef: { current: false },
    resolveComposerDraftKey: key => key,
    opts: { chatInputRef: { current: { restoreSubmission() { inputWrites++; } } } },
    restoreDraftSubmission: (...args) => { storeWrites++; return store.restoreDraftSubmission(...args); },
  });
  s.context.restoreSubmission = callback("restoreSubmission", s.context);
  return { store, counts: () => ({ inputWrites, storeWrites }) };
}
const originalImages = [{ data: "YQ==", mimeType: "image/png" }];
const newerImages = [{ data: "Yg==", mimeType: "image/jpeg" }];
function abandonExisting(s, drafts) {
  // Keyed ChatWindow unmount: A's refs remain A's, but no mounted UI is owned.
  s.context.sessionHookMountedRef.current = false;
  drafts.store.setDraft("draft", { value: "newer A", images: newerImages });
  drafts.store.setDraft("B", { value: "B untouched", images: newerImages });
  return JSON.stringify(s.ui);
}
function assertRecoveredExisting(s, drafts, uiBefore, restored = true) {
  assert.equal(JSON.stringify(s.ui), uiBefore, "stale callback cannot mutate UI");
  assert.equal(s.notices.length, 0);
  assert.equal(JSON.stringify(drafts.store.getDraft("draft")), JSON.stringify({
    value: restored ? " original A \n\nnewer A" : "newer A",
    images: restored ? [...originalImages, ...newerImages] : newerImages,
  }));
  assert.equal(JSON.stringify(drafts.store.getDraft("B")), JSON.stringify({ value: "B untouched", images: newerImages }));
  assert.deepEqual(drafts.counts(), { inputWrites: 0, storeWrites: restored ? 1 : 0 });
}
for (const rejects of [false, true]) {
  test(`unmounted existing session restores unsent text/images after SSE ${rejects ? "failure" : "readiness"}`, async () => {
    const s = setup({ existing: true }), drafts = wireDrafts(s);
    const pending = s.send(" original A ", originalImages);
    await s.eventsEntered.promise;
    const before = abandonExisting(s, drafts);
    if (rejects) s.events.reject(new Error("SSE closed"));
    else s.events.resolve();
    await pending;
    assertRecoveredExisting(s, drafts, before);
    assert.equal(s.commands.length, 0);
  });
}
for (const explicit of [true, false]) {
  test(`unmounted existing session ${explicit ? "restores explicitly rejected POST" : "does not restore ambiguous POST failure"}`, async () => {
    const s = setup({ existing: true }), drafts = wireDrafts(s);
    const post = deferred(), entered = deferred();
    s.context.sendAgentCommand = async (sid, command) => { s.commands.push({ sid, ...command }); entered.resolve(); await post.promise; };
    s.context.isPromptRejectedError = () => explicit;
    s.events.resolve();
    const pending = s.send(" original A ", originalImages);
    await entered.promise;
    const before = abandonExisting(s, drafts);
    post.reject(new Error(explicit ? "prompt rejected" : "response lost"));
    await pending;
    assertRecoveredExisting(s, drafts, before, explicit);
    assert.equal(s.commands.length, 1);
  });
}

test("Stop then unmount cannot restore the same existing payload twice", async () => {
  const s = setup({ existing: true }), drafts = wireDrafts(s);
  // No input instance: execute the real restore callback's stored-draft fallback.
  s.context.opts.chatInputRef.current = null;
  const pending = s.send(" original A ", originalImages);
  await s.eventsEntered.promise;
  drafts.store.setDraft("draft", { value: "newer A", images: newerImages });
  drafts.store.setDraft("B", { value: "B untouched", images: newerImages });
  await s.stop();
  s.context.sessionHookMountedRef.current = false;
  const before = JSON.stringify(s.ui);
  s.events.reject(new Error("closed after Stop")); await pending;
  assertRecoveredExisting(s, drafts, before);
  assert.equal(s.commands.length, 0);
});

test("abandoned fresh-session SSE startup keeps intentional draft cleanup", async () => {
  const s = setup(), drafts = wireDrafts(s);
  const pending = s.send("abandoned", originalImages);
  await s.startupEntered.promise; s.resolveStartup();
  await s.eventsEntered.promise;
  s.context.sessionHookMountedRef.current = false;
  s.events.resolve(); await pending;
  assert.equal(drafts.store.getDraft("draft"), null);
  assert.deepEqual(drafts.counts(), { inputWrites: 0, storeWrites: 0 });
  assert.equal(s.commands.length, 0);
});

function assertStopped(s, message, images) {
  assert.equal(s.ui.running, false);
  assert.equal(s.ui.streaming, false);
  assert.equal(s.ui.phase, null);
  assert.equal(s.ui.anchor, false);
  assert.equal(s.ui.messages.length, 0);
  assert.equal(s.context.rpcPromptPendingRef.current, false);
  assert.equal(s.context.optimisticUserMessageRef.current, null);
  assert.deepEqual(s.restored, [[message, images, "draft"]]);
  assert.equal(s.notices.length, 0);
}

test("Stop during new-session creation restores text/images immediately and never submits late", async () => {
  const s = setup();
  const images = [{ mimeType: "image/png", data: "fixture" }];
  const pending = s.send("draft text", images);
  await s.startupEntered.promise;
  assert.equal(s.ui.running, true);
  await s.stop();
  assertStopped(s, "draft text", images);
  s.resolveStartup();
  await pending;
  assertStopped(s, "draft text", images);
  assert.equal(s.context.sessionIdRef.current, "created");
  assert.equal(s.commands.length, 0);
  assert.equal(s.promoted.length, 0);
});

test("Stop before startup's first microtask prevents even session creation", async () => {
  const s = setup();
  const pending = s.send("draft");
  await s.stop();
  await pending;
  assertStopped(s, "draft", undefined);
  assert.equal(s.context.ensuringNewSessionRef.current, null);
  assert.equal(s.commands.length, 0);
});

for (const existing of [false, true]) {
  test(`Stop during ${existing ? "existing" : "new"}-session SSE readiness prevents prompt dispatch`, async () => {
    const s = setup({ existing });
    const pending = s.send("draft");
    if (!existing) { await s.startupEntered.promise; s.resolveStartup(); }
    await s.eventsEntered.promise;
    await s.stop();
    assertStopped(s, "draft", undefined);
    s.events.resolve();
    await pending;
    assert.equal(s.commands.length, 0);
    assert.equal(s.promoted.length, 0);
  });
}

test("a stopped startup cannot submit or abort a newer run sharing its creation", async () => {
  const s = setup();
  const old = s.send("old");
  await s.startupEntered.promise;
  await s.stop();
  const newer = s.send("new");
  s.resolveStartup();
  await s.eventsEntered.promise;
  s.events.resolve();
  await Promise.all([old, newer]);
  assert.deepEqual(s.commands.map(c => [c.type, c.message]), [["prompt", "new"]]);
  assert.equal(s.ui.running, true);
  assert.equal(s.ui.messages.length, 1);
  assert.equal(s.ui.messages[0].content, "new");
  assert.deepEqual(s.restored, [["old", undefined, "draft"]]);
  assert.equal(s.ui.closes, 1);
});

test("late cancelled SSE rejection cannot clear a newer run or restore twice", async () => {
  const s = setup({ existing: true });
  const old = s.send("old");
  await s.eventsEntered.promise;
  await s.stop();
  s.context.ensureEventsConnected = async () => {};
  await s.send("new");
  s.events.reject(new Error("closed"));
  await old;
  assert.equal(s.ui.running, true);
  assert.equal(s.context.rpcPromptPendingRef.current, true);
  assert.equal(s.ui.messages[0].content, "new");
  assert.deepEqual(s.restored, [["old", undefined, "draft"]]);
  assert.equal(s.notices.length, 0);
  assert.deepEqual(s.commands.map(c => c.type), ["prompt"]);
});

test("Stop during model setup prevents SSE and prompt submission", async () => {
  const s = setup();
  s.context.sessionIdRef.current = "created";
  s.context.newSessionModel = { provider: "fixture", modelId: "fixture" };
  const model = deferred(), entered = deferred();
  s.context.sendAgentCommand = async (_sid, command) => {
    s.commands.push(command);
    entered.resolve();
    await model.promise;
  };
  const pending = s.send("draft");
  await entered.promise;
  await s.stop();
  model.resolve();
  await pending;
  assertStopped(s, "draft", undefined);
  assert.deepEqual(s.commands.map(c => c.type), ["set_model"]);
});

test("late cancelled creation failure leaves a newer independent run untouched", async () => {
  const s = setup();
  const old = s.send("old");
  await s.startupEntered.promise;
  await s.stop();
  // Another action has supplied a usable session while the old request lingers.
  s.context.sessionIdRef.current = "other";
  s.events.resolve();
  await s.send("new");
  s.startup.reject(new Error("startup failed"));
  await old;
  assert.equal(s.ui.running, true);
  assert.equal(s.context.rpcPromptPendingRef.current, true);
  assert.equal(s.ui.messages[0].content, "new");
  assert.deepEqual(s.restored, [["old", undefined, "draft"]]);
  assert.equal(s.notices.length, 0);
  assert.deepEqual(s.commands.map(c => c.type), ["prompt"]);
});

for (const prefix of ["!", "!!"]) {
  for (const sidAvailable of [false, true]) {
    test(`Stop restores ${prefix} draft during bash startup with session ID ${sidAvailable ? "available" : "absent"}`, async () => {
      const s = setup();
      const pending = s.send(`${prefix}echo fixture`);
      await s.startupEntered.promise;
      assert.equal(s.ui.bashRunning, true);
      // Creation can publish its ID before executeBash's await resumes.
      if (sidAvailable) s.context.sessionIdRef.current = "created";
      await s.stop();
      assert.equal(s.ui.bashRunning, false);
      assert.equal(s.context.bashRunningRef.current, false);
      assert.equal(s.ui.pendingBash, null);
      assert.equal(s.context.cancelPendingBashRef.current, null);
      assert.deepEqual(s.restored, [[`${prefix}echo fixture`, undefined, "draft"]]);
      assert.equal(s.commands.length, 0);
      s.resolveStartup();
      await pending;
      assert.equal(s.commands.length, 0);
      assert.equal(s.promoted.length, 0);
      assert.equal(s.notices.length, 0);
      assert.equal(s.restored.length, 1);
      assert.equal(s.ui.bashRunning, false);
    });
  }
}

for (const rejects of [false, true]) {
  test(`cancelled bash startup's late ${rejects ? "rejection" : "completion"} cannot clear newer bash`, async () => {
    const s = setup();
    const old = s.send("!old");
    await s.startupEntered.promise;
    await s.stop();
    const command = deferred(), dispatched = deferred();
    s.context.sessionIdRef.current = "other";
    s.context.sendAgentCommand = async (_sid, cmd) => {
      s.commands.push(cmd);
      dispatched.resolve();
      await command.promise;
    };
    const newer = s.send("!!new");
    await dispatched.promise;
    if (rejects) s.startup.reject(new Error("startup failed"));
    else s.resolveStartup();
    await old;
    assert.equal(s.ui.bashRunning, true);
    assert.equal(s.context.bashRunningRef.current, true);
    assert.equal(s.ui.pendingBash.command, "new");
    assert.equal(s.ui.pendingBash.excludeFromContext, true);
    assert.deepEqual(s.restored, [["!old", undefined, "draft"]]);
    assert.equal(s.notices.length, 0);
    assert.deepEqual(s.commands.map(c => c.type), ["bash"]);
    // The artificial concurrent creation overwrites this ref; reselect the
    // newer command's session before asserting its owned terminal cleanup.
    s.context.sessionIdRef.current = "other";
    command.resolve();
    await newer;
    assert.equal(s.ui.bashRunning, false);
  });
}

test("stopped bash and newer bash can share pending creation without stale cleanup", async () => {
  const s = setup();
  const old = s.send("!old");
  await s.startupEntered.promise;
  await s.stop();
  const command = deferred(), dispatched = deferred();
  s.context.sendAgentCommand = async (_sid, cmd) => {
    s.commands.push(cmd);
    dispatched.resolve();
    await command.promise;
  };
  const newer = s.send("!!new");
  s.resolveStartup();
  await dispatched.promise;
  await old;
  assert.equal(s.ui.bashRunning, true);
  assert.equal(s.ui.pendingBash.command, "new");
  assert.deepEqual(s.commands.map(c => [c.type, c.command]), [["bash", "new"]]);
  assert.deepEqual(s.restored, [["!old", undefined, "draft"]]);
  command.resolve();
  await newer;
});

test("Stop after bash dispatch retains server abort and waits for command settlement", async () => {
  const s = setup({ existing: true });
  const command = deferred(), dispatched = deferred();
  s.context.sendAgentCommand = async (_sid, cmd) => {
    s.commands.push(cmd);
    if (cmd.type === "bash") { dispatched.resolve(); await command.promise; }
  };
  const pending = s.send("!!echo fixture");
  await dispatched.promise;
  await s.stop();
  assert.deepEqual(s.commands.map(c => c.type), ["bash", "abort_bash"]);
  assert.equal(s.commands[0].excludeFromContext, true);
  assert.ok(s.commands.every(c => !("promptRequestId" in c)));
  assert.equal(s.restored.length, 0);
  assert.equal(s.ui.bashRunning, true);
  command.resolve();
  await pending;
  assert.equal(s.ui.bashRunning, false);
  assert.equal(s.ui.pendingBash, null);
  assert.equal(s.promoted.length, 1);
});

for (const prefix of ["!", "!!"]) {
  for (const stale of ["unmount", "session switch"]) {
    test(`${prefix} fresh startup ${stale} never dispatches or revives abandoned draft`, async () => {
      const s = setup(), drafts = wireDrafts(s);
      if (stale === "session switch") {
        const ensure = s.context.ensureNewSession;
        s.context.ensureNewSession = async () => {
          const sid = await ensure();
          s.context.sessionIdRef.current = "other";
          return sid;
        };
      }
      const pending = s.send(`${prefix}marker`);
      await s.startupEntered.promise;
      if (stale === "unmount") {
        s.context.sessionHookMountedRef.current = false;
        s.context.bashRecoveryIdRef.current++;
      } else {
        s.context.sessionIdRef.current = "other";
      }
      const before = JSON.stringify(s.ui);
      s.resolveStartup();
      await pending;
      assert.equal(s.commands.length, 0);
      assert.equal(s.promoted.length, 0);
      assert.equal(JSON.stringify(s.ui), before);
      assert.deepEqual(drafts.counts(), { inputWrites: 0, storeWrites: 0 });
    });
  }
  for (const stage of ["POST", "reload"]) {
    for (const stale of ["unmount", "session switch", "newer bash"]) {
      test(`${prefix} late ${stage} cannot mutate UI or promote after ${stale}`, async () => {
        const s = setup({ existing: true });
        const gate = deferred(), entered = deferred();
        let loads = 0;
        s.context.sendAgentCommand = async (sid, command) => {
          s.commands.push({ sid, ...command });
          if (stage === "POST") { entered.resolve(); await gate.promise; }
        };
        s.context.loadSession = async () => {
          loads++;
          if (stage === "reload") { entered.resolve(); await gate.promise; }
        };
        const pending = s.send(`${prefix}old`);
        await entered.promise;
        let newer, newerGate;
        if (stale === "unmount") {
          s.context.sessionHookMountedRef.current = false;
          s.context.bashRecoveryIdRef.current++;
        } else if (stale === "session switch") s.context.sessionIdRef.current = "other";
        else {
          // Recovery observed idle before the old blocking HTTP reply arrived.
          s.context.bashRunningRef.current = false;
          newerGate = deferred();
          s.context.sendAgentCommand = async () => newerGate.promise;
          newer = s.send("!!newer");
        }
        const before = JSON.stringify(s.ui);
        gate.resolve(); await pending;
        assert.equal(JSON.stringify(s.ui), before);
        assert.equal(loads, stage === "POST" ? 0 : 1);
        assert.equal(s.promoted.length, 0);
        assert.equal(s.restored.length, 0);
        assert.equal(s.notices.length, 0);
        if (newer) { newerGate.resolve(); await newer; }
      });
    }
  }
  test(`${prefix} active normal bash tolerates recovery ticket changes`, async () => {
    const s = setup({ existing: true });
    s.context.sendAgentCommand = async (sid, command) => {
      s.commands.push({ sid, ...command });
      s.context.bashRecoveryIdRef.current++;
    };
    await s.send(`${prefix}marker`);
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0].excludeFromContext, prefix === "!!");
    assert.equal(s.promoted.length, 1);
    assert.equal(s.ui.bashRunning, false);
    assert.equal(s.ui.pendingBash, null);
  });
  test(`${prefix} stale existing callback restores undispatched draft to store only once`, async () => {
    const s = setup({ existing: true }), drafts = wireDrafts(s);
    s.context.sessionHookMountedRef.current = false;
    drafts.store.setDraft("draft", { value: "newer", images: newerImages });
    await s.send(`${prefix}marker`);
    assert.equal(s.commands.length, 0);
    assert.equal(drafts.store.getDraft("draft").value, `${prefix}marker\n\nnewer`);
    assert.deepEqual(drafts.counts(), { inputWrites: 0, storeWrites: 1 });
  });
  test(`${prefix} Stop then unmount restores startup draft only once`, async () => {
    const s = setup(), drafts = wireDrafts(s);
    s.context.opts.chatInputRef.current = null;
    const pending = s.send(`${prefix}marker`);
    await s.startupEntered.promise;
    await s.stop();
    s.context.sessionHookMountedRef.current = false;
    const before = JSON.stringify(s.ui);
    s.resolveStartup(); await pending;
    assert.equal(JSON.stringify(s.ui), before);
    assert.equal(drafts.store.getDraft("draft").value, `${prefix}marker`);
    assert.deepEqual(drafts.counts(), { inputWrites: 0, storeWrites: 1 });
    assert.equal(s.commands.length, 0);
  });
  test(`${prefix} ambiguous stale POST failure never restores duplicate work`, async () => {
    const s = setup({ existing: true }), drafts = wireDrafts(s);
    const post = deferred();
    s.context.sendAgentCommand = async () => post.promise;
    const pending = s.send(`${prefix}marker`);
    s.context.sessionHookMountedRef.current = false;
    const before = JSON.stringify(s.ui);
    post.reject(new Error("response lost")); await pending;
    assert.equal(JSON.stringify(s.ui), before);
    assert.deepEqual(drafts.counts(), { inputWrites: 0, storeWrites: 0 });
    assert.equal(s.notices.length, 0);
  });
}

test("idle reconciliation during SSE startup cannot settle or unlock the pending prompt", async () => {
  const s = setup({ existing: true });
  const pending = s.send("original");
  await s.eventsEntered.promise;
  let fetches = 0, settlements = 0;
  s.context.fetch = async () => { fetches++; return { ok: true, json: async () => ({ running: true, state: { isStreaming: false, isPromptRunning: false } }) }; };
  s.context.finishPromptWithoutStream = async () => { settlements++; s.context.agentRunningRef.current = false; };
  await callback("reconcileAgentState", s.context)("existing");
  assert.equal(fetches, 0);
  assert.equal(settlements, 0);
  assert.equal(s.ui.running, true);
  assert.equal(s.context.rpcPromptPendingRef.current, true);
  await s.send("second");
  assert.deepEqual(s.restored, [["second", undefined, "draft"]]);
  s.events.resolve(); await pending;
  assert.deepEqual(s.commands.map(c => c.message), ["original"]);
});

test("reconciliation snapshot crossing into startup is ignored on response", async () => {
  const s = setup({ existing: true });
  const response = deferred();
  s.context.agentRunningRef.current = true;
  s.context.fetch = async () => response.promise;
  let settlements = 0;
  s.context.finishPromptWithoutStream = async () => { settlements++; };
  const reconcile = callback("reconcileAgentState", s.context)("existing");
  s.context.cancelPendingPromptRef.current = () => {};
  response.resolve({ ok: true, json: async () => ({ running: false }) });
  await reconcile;
  assert.equal(settlements, 0);
});

test("session switch during SSE startup prevents stale prompt dispatch", async () => {
  const s = setup({ existing: true }); const pending = s.send("old session");
  await s.eventsEntered.promise;
  s.context.sessionIdRef.current = "other";
  s.events.resolve(); await pending;
  assert.equal(s.commands.length, 0);
});

function wireReconciliation(s) {
  Object.assign(s.context, {
    syncLiveModel() {}, setIsCompacting() {}, setQueuedMessages() {}, setActiveToolResults() {}, setAutoCompactionEnabled() {},
    normalizeQueuedMessages: value => value ?? [], setRetryInfo() {},
    scheduleEventStreamClose() {}, onAgentEnd() {},
    notifiedPromptRunIdRef: { current: null },
  });
  for (const name of ["settleUiStage", "notifyPromptStage", "finishPromptWithoutStream", "reconcileAgentState"]) {
    s.context[name] = callback(name, s.context);
  }
  s.snapshot = state => { s.context.fetch = async () => ({ ok: true, json: async () => state }); };
  s.reconcile = () => s.context.reconcileAgentState("existing");
}

async function dispatchedPrompt() {
  const s = setup({ existing: true });
  wireReconciliation(s);
  const post = deferred(), dispatched = deferred();
  s.context.sendAgentCommand = async (_sid, cmd) => {
    s.commands.push(cmd);
    if (cmd.type === "prompt") { dispatched.resolve(); await post.promise; }
  };
  s.events.resolve();
  const pending = s.send("original");
  await dispatched.promise;
  return Object.assign(s, { post, pending });
}
const idleSnapshot = { running: true, state: { isStreaming: false, isPromptRunning: false } };

test("post-dispatch idle GET cannot settle pre-admission prompt or allow a second send", async () => {
  const s = await dispatchedPrompt();
  assert.equal(s.context.cancelPendingPromptRef.current, null);
  s.snapshot(idleSnapshot);
  await s.reconcile();
  assert.equal(s.ui.running, true);
  assert.equal(s.ui.streaming, true);
  assert.equal(s.context.rpcPromptPendingRef.current, true);
  assert.ok(s.context.optimisticUserMessageRef.current);
  await s.send("second");
  assert.deepEqual(s.restored, [["second", undefined, "draft"]]);
  assert.equal(s.commands.length, 1);
  s.post.resolve(); await s.pending;
  await s.reconcile();
  assert.equal(s.ui.running, false);
});

for (const admission of ["busy GET", "agent_start"]) {
  test(`${admission} permits idle recovery while long-running prompt POST remains unresolved`, async () => {
    const s = await dispatchedPrompt();
    if (admission === "busy GET") {
      s.snapshot({ running: true, state: { isStreaming: true, isPromptRunning: true } });
      await s.reconcile();
    } else callback("handleAgentEvent", s.context)({ type: "agent_start" });
    s.snapshot(idleSnapshot);
    await s.reconcile();
    assert.equal(s.ui.running, false);
    assert.equal(s.context.rpcPromptPendingRef.current, false);
    s.post.resolve(); await s.pending;
  });
}

test("lost POST response releases admission guard and retains ambiguous-response recovery", async () => {
  const s = await dispatchedPrompt();
  let recoveries = 0;
  s.context.waitForPromptSettlement = () => { recoveries++; };
  s.post.reject(new Error("response lost")); await s.pending;
  assert.equal(recoveries, 1);
  assert.equal(s.ui.running, true);
  assert.equal(s.restored.length, 0);
  s.snapshot(idleSnapshot); await s.reconcile();
  assert.equal(s.ui.running, false);
});

test("prompt_done settles immediately without waiting for the prompt POST", async () => {
  const s = await dispatchedPrompt();
  callback("handleAgentEvent", s.context)({ type: "prompt_done" });
  assert.equal(s.ui.running, false);
  assert.equal(s.context.rpcPromptPendingRef.current, false);
  s.post.resolve(); await s.pending;
});

for (const rejects of [false, true]) {
  test(`old POST ${rejects ? "rejection" : "resolution"} cannot release a newer admission guard`, async () => {
    const s = await dispatchedPrompt();
    callback("handleAgentEvent", s.context)({ type: "prompt_done" });
    const newerPost = deferred(), entered = deferred();
    s.context.sendAgentCommand = async () => { entered.resolve(); await newerPost.promise; };
    const newer = s.send("newer");
    await entered.promise;
    if (rejects) s.post.reject(new Error("old response lost"));
    else s.post.resolve();
    await s.pending;
    s.snapshot(idleSnapshot); await s.reconcile();
    assert.equal(s.ui.running, true);
    assert.equal(s.context.rpcPromptPendingRef.current, true);
    newerPost.resolve(); await newer;
    await s.reconcile();
    assert.equal(s.ui.running, false);
  });
}

test("idle GET begun before admission cannot settle after agent_start", async () => {
  const s = await dispatchedPrompt();
  const response = deferred();
  s.context.fetch = async () => response.promise;
  const polling = s.reconcile();
  callback("handleAgentEvent", s.context)({ type: "agent_start" });
  response.resolve({ ok: true, json: async () => idleSnapshot });
  await polling;
  assert.equal(s.ui.running, true);
  s.snapshot(idleSnapshot); await s.reconcile();
  assert.equal(s.ui.running, false);
  s.post.resolve(); await s.pending;
});

test("Stop immediately after prompt dispatch sends the same correlation token", async () => {
  const s = setup({ existing: true });
  const prompt = deferred(), dispatched = deferred();
  s.context.sendAgentCommand = async (_sid, command) => {
    s.commands.push(command);
    if (command.type === "prompt") { dispatched.resolve(); await prompt.promise; }
  };
  const pending = s.send("accepted");
  s.events.resolve();
  await dispatched.promise;
  await s.stop();
  assert.deepEqual(s.commands.map(c => c.type), ["prompt", "abort"]);
  assert.match(s.commands[0].promptRequestId, /^\d{13}:[0-9a-f-]{36}$/);
  assert.equal(s.commands[1].promptRequestId, s.commands[0].promptRequestId);
  assert.equal("streamingBehavior" in s.commands[0], false);
  assert.equal(s.restored.length, 0);
  prompt.resolve();
  await pending;
  assert.equal(s.context.promptRequestRef.current.token, s.commands[0].promptRequestId);
});

for (const rejects of [false, true]) {
  test(`old HTTP ${rejects ? "rejection" : "completion"} cannot clear a distinct newer run token`, async () => {
    const s = await dispatchedPrompt();
    const oldToken = s.commands[0].promptRequestId;
    callback("handleAgentEvent", s.context)({ type: "prompt_done" });
    assert.equal(s.context.promptRequestRef.current, null);
    s.context.sendAgentCommand = async (sid, command) => { s.commands.push({ sid, ...command }); };
    await s.send("newer");
    const newToken = s.commands[1].promptRequestId;
    assert.notEqual(oldToken, newToken);
    if (rejects) s.post.reject(new Error("old response lost"));
    else s.post.resolve();
    await s.pending;
    await s.stop();
    assert.equal(s.commands[2].promptRequestId, newToken);
    s.snapshot(idleSnapshot); await s.reconcile();
    assert.equal(s.context.promptRequestRef.current, null);
  });
}

test("extension continuation retires completed prompt token while preserving running UI", async () => {
  const s = await dispatchedPrompt();
  const event = callback("handleAgentEvent", s.context);
  event({ type: "agent_start" });
  event({ type: "prompt_done" });
  await s.stop();
  assert.equal(s.commands[1].promptRequestId, undefined);
  assert.equal(s.context.agentRunningRef.current, true);
  event({ type: "agent_settled" });
  assert.equal(s.context.promptRequestRef.current, null);
  s.post.resolve(); await s.pending;
});

test("definitive pre-admission rejection clears ownership and restores the draft", async () => {
  const s = await dispatchedPrompt();
  s.context.isPromptRejectedError = () => true;
  s.context.reconcileAgentState = async () => {};
  s.post.reject(new Error("prompt rejected")); await s.pending;
  assert.equal(s.context.promptRequestRef.current, null);
  assert.deepEqual(s.restored, [["original", undefined, "draft"]]);
});

test("slow old logical settlement cannot clear newer token", async () => {
  const s = await dispatchedPrompt();
  const loaded = deferred();
  s.context.loadSession = async () => loaded.promise;
  const oldFinish = s.context.finishPromptWithoutStream("existing", s.context.promptRunIdRef.current);
  callback("handleAgentEvent", s.context)({ type: "prompt_done" });
  s.context.sendAgentCommand = async (sid, command) => { s.commands.push({ sid, ...command }); };
  await s.send("newer");
  const token = s.context.promptRequestRef.current.token;
  loaded.resolve(); await oldFinish;
  assert.equal(s.context.promptRequestRef.current.token, token);
  s.post.resolve(); await s.pending;
});

test("observed remote run retains legacy global abort", async () => {
  const s = setup({ existing: true });
  s.context.agentRunningRef.current = true;
  await s.stop();
  assert.deepEqual(s.commands, [{ sid: "existing", type: "abort" }]);
});

test("slash commands preserve command semantics without token or streamingBehavior", async () => {
  const s = setup({ existing: true });
  s.events.resolve();
  await s.send("/compact");
  await s.stop();
  assert.deepEqual(s.commands, [
    { sid: "existing", type: "prompt", message: "/compact" },
    { sid: "existing", type: "abort" },
  ]);
});

test("image generation and Stop do not send prompt correlation tokens", async () => {
  const s = setup({ existing: true });
  Object.assign(s.context, {
    imageModelRef: { current: { provider: "fixture", modelId: "fixture" } },
    imageRequestPendingRef: { current: false }, imageRunIdRef: { current: 0 },
    imageSubmissionIdRef: { current: 0 },
    setIsGeneratingImage() {}, scheduleEventStreamClose() {},
  });
  const image = deferred(), dispatched = deferred();
  s.context.sendAgentCommand = async (sid, command) => {
    s.commands.push({ sid, ...command });
    if (command.type === "image_generate") { dispatched.resolve(); await image.promise; }
  };
  s.events.resolve();
  const pending = callback("handleImageGenerate", s.context)("draw", [], {});
  await dispatched.promise;
  await s.stop();
  assert.deepEqual(s.commands.map(c => c.type), ["image_generate", "abort"]);
  assert.ok(s.commands.every(c => !("promptRequestId" in c)));
  image.resolve(); await pending;
});
