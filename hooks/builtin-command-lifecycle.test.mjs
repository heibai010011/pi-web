import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test as nodeTest } from "node:test";
const test = (name, callback) => nodeTest(name, { timeout: 2000 }, callback);
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Execute the actual callback AST with deferred startup/command/refresh promises.
// These tests neither copy its implementation nor touch real sessions or browsers.
const source = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const declaration = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(source) === "handleBuiltinSlashCommand");
assert.ok(declaration);
const script = new Script(ts.transpileModule(`(${declaration.initializer.arguments[0].getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext },
}).outputText);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(sid = "source") {
  const commands = [], starts = [], effects = [];
  const context = createContext({
    Error, activeLeafId: "leaf-A", isCompacting: false,
    sendAgentCommand: (sid, command) => {
      const pending = deferred();
      commands.push({ sid, ...command, ...pending });
      return pending.promise;
    },
    ensureNewSession: () => {
      const pending = deferred();
      starts.push(pending);
      return pending.promise;
    },
    navigator: { clipboard: { writeText: async text => { effects.push(["clipboard", text]); } } },
    readCompactResult: value => value,
  });
  for (const name of ["addNotice", "setIsCompacting", "setCompactError", "setCompactResult", "setSessionStatsOverride", "onSessionStatsPanelOpen", "onSessionForked", "promoteNewSession"]) {
    context[name] = (...args) => effects.push([name, ...args]);
  }
  for (const name of ["loadSession", "loadTools", "loadSlashCommands", "loadModels"]) {
    context[name] = async (...args) => { effects.push([name, ...args]); return {}; };
  }
  for (const [name, current] of Object.entries({
    sessionIdRef: sid, sessionPropIdRef: sid, sessionHookMountedRef: true,
    builtinCommandLifetimeRef: 0, agentRunningRef: false, bashRunningRef: false,
  })) context[name] = { current };
  return { context, commands, starts, effects, run: script.runInContext(context) };
}
function invalidate(s, mode) {
  if (mode === "unmount") s.context.sessionHookMountedRef.current = false;
  if (mode === "switch") s.context.sessionIdRef.current = "other";
  if (mode === "prop-switch") s.context.sessionPropIdRef.current = "other";
  if (mode === "new-lifetime") s.context.builtinCommandLifetimeRef.current++;
}
const results = {
  clone: { newSessionId: "cloned" }, compact: { summary: "short" }, reload: {},
  name: {}, session: { tokens: 42 }, copy: { text: "assistant reply" },
};
for (const input of ["hello", "/", "/unknown", "/extension arg", "/Clone", "/prompt-template"]) {
  test(`${input}: unrecognized input has no startup or mutation`, async () => {
    const s = setup(null);
    const pending = s.run(input);
    assert.equal(s.starts.length, 0);
    assert.equal((await pending).handled, false);
    assert.deepEqual(s.commands, []);
    assert.deepEqual(s.effects, []);
    assert.equal(s.context.sessionIdRef.current, null);
  });
}
for (const command of Object.keys(results)) {
  for (const mode of ["unmount", "switch", "prop-switch", "new-lifetime"]) {
    for (const outcome of ["success", "error"]) {
      test(`${command}: delayed ${outcome} after ${mode} has no further UI effects`, async () => {
        const s = setup();
        const pending = s.run(`/${command} arg`);
        assert.equal(s.commands.length, 1);
        const before = [...s.effects];
        invalidate(s, mode);
        if (outcome === "error") s.commands[0].reject(new Error("stale failure"));
        else s.commands[0].resolve(results[command]);
        assert.equal((await pending).handled, true);
        assert.deepEqual(s.effects, before, "no notice, navigation, clipboard, refresh, or compaction cleanup");
      });
    }
  }
  test(`${command}: fresh recognized command starts once and completes happily`, async () => {
    const s = setup(null);
    const pending = s.run(`/${command} arg`);
    assert.equal(s.starts.length, 1);
    s.context.sessionIdRef.current = "created"; // ensureNewSession legitimately assigns the ref.
    s.starts[0].resolve("created");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0].sid, "created");
    s.commands[0].resolve(results[command]);
    const result = await pending;
    assert.equal(result.handled, true);
    assert.equal(result.error, undefined);
    if (command === "clone") assert.ok(s.effects.some(e => e[0] === "onSessionForked" && e[1] === "cloned"));
    if (command === "copy") assert.ok(s.effects.some(e => e[0] === "clipboard" && e[1] === "assistant reply"));
    if (command === "session") assert.ok(s.effects.some(e => e[0] === "onSessionStatsPanelOpen"));
    else assert.ok(s.effects.some(e => e[0] === "addNotice" && e[1].type === "success"));
    assert.equal(s.starts.length, 1);
  });
}
for (const mode of ["unmount", "switch", "prop-switch", "new-lifetime"]) {
  for (const outcome of ["success", "error"]) {
    test(`startup ${outcome} after ${mode} never dispatches or notifies`, async () => {
      const s = setup(null);
      const pending = s.run("/clone");
      invalidate(s, mode);
      if (outcome === "error") s.starts[0].reject(new Error("stale startup"));
      else {
        if (mode !== "switch") s.context.sessionIdRef.current = "created";
        s.starts[0].resolve("created");
      }
      assert.equal((await pending).handled, true);
      assert.deepEqual(s.commands, []);
      assert.deepEqual(s.effects, []);
    });
  }
}
for (const command of ["compact", "name", "reload"]) {
  test(`${command}: session change during refresh suppresses promotion and notice`, async () => {
    const s = setup();
    const refresh = deferred();
    s.context.loadSession = () => refresh.promise;
    const pending = s.run(`/${command} arg`);
    s.commands[0].resolve(results[command]);
    await new Promise(resolve => setImmediate(resolve));
    const before = [...s.effects];
    invalidate(s, "switch");
    refresh.resolve({});
    await pending;
    assert.deepEqual(s.effects, before);
  });
}
test("clipboard settlement after unmount cannot show success or error notices", async () => {
  for (const outcome of ["success", "error"]) {
    const s = setup();
    const clipboard = deferred();
    let clipboardStarted = false;
    s.context.navigator.clipboard.writeText = () => { clipboardStarted = true; return clipboard.promise; };
    const pending = s.run("/copy");
    s.commands[0].resolve(results.copy);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(clipboardStarted, true, "clipboard await is entered before invalidation");
    invalidate(s, "unmount");
    if (outcome === "error") clipboard.reject(new Error("clipboard failed"));
    else clipboard.resolve();
    await pending;
    assert.deepEqual(s.effects, []);
  }
});
test("already-running compaction rejection does not clear its spinner", async () => {
  const s = setup();
  s.context.isCompacting = true;
  const result = await s.run("/compact");
  assert.equal(result.handled, true);
  assert.equal(s.commands.length, 0);
  assert.equal(s.effects.some(e => e[0] === "setIsCompacting"), false);
});
test("recognized command on an unmounted hook cannot start a session", async () => {
  const s = setup(null);
  invalidate(s, "unmount");
  const pending = s.run("/clone");
  assert.equal(s.starts.length, 0);
  assert.equal((await pending).handled, true);
  assert.deepEqual(s.effects, []);
});
