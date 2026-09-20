import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, Script } from "node:vm";
import ts from "typescript";

// Exercise the production callback, not a copied implementation, with deferred
// POSTs. No server/session fixtures or browser navigation are involved.
const source = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const nodes = [];
function visit(node) { nodes.push(node); ts.forEachChild(node, visit); }
visit(source);
const declaration = nodes.find(node => ts.isVariableDeclaration(node) && node.name.getText(source) === "handleFork");
assert.ok(declaration);
const script = new Script(ts.transpileModule(`(${declaration.initializer.arguments[0].getText(source)})`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext },
}).outputText);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup() {
  const commands = [], navigations = [], writes = [], errors = [], notices = [];
  const ui = { spinner: null };
  const context = createContext({
    console: { error: (...args) => errors.push(args) },
    sendAgentCommand: (sid, command) => {
      const pending = deferred();
      commands.push({ sid, ...command, ...pending });
      return pending.promise;
    },
    onSessionForked: sid => navigations.push(sid),
    setForkingEntryId: value => { writes.push(value); ui.spinner = value; },
    addNotice: notice => notices.push(notice),
  });
  for (const [name, current] of Object.entries({
    bashRunningRef: false, imageGeneratingRef: false, sessionIdRef: "source",
    sessionHookMountedRef: true, forkRequestRef: null,
  })) context[name] = { current };
  return { context, commands, navigations, writes, errors, notices, ui, fork: script.runInContext(context) };
}

for (const outcome of ["success", "cancel", "error", "empty"]) {
  test(`${outcome} releases the current spinner and admission for retry`, async () => {
    const s = setup();
    const pending = s.fork("entry-A");
    assert.equal(s.ui.spinner, "entry-A");
    assert.equal(s.commands.length, 1);
    assert.equal(s.commands[0].sid, "source");
    assert.equal(s.commands[0].type, "fork");
    assert.equal(s.commands[0].entryId, "entry-A");
    if (outcome === "error") s.commands[0].reject(new Error("fork failed"));
    else s.commands[0].resolve(outcome === "empty" ? undefined : { cancelled: outcome === "cancel", newSessionId: "fork-A" });
    await pending;
    assert.deepEqual(s.navigations, outcome === "success" ? ["fork-A"] : []);
    assert.equal(s.ui.spinner, null);
    assert.equal(s.context.forkRequestRef.current, null);
    assert.equal(s.errors.length, outcome === "error" ? 1 : 0);
    const retry = s.fork("entry-B");
    assert.equal(s.commands.length, 2);
    s.commands[1].resolve({ newSessionId: "fork-B" });
    await retry;
    assert.equal(s.navigations.at(-1), "fork-B");
    assert.equal(s.context.forkRequestRef.current, null);
  });
}

test("simultaneous rows reject the second POST before a React render", async () => {
  const s = setup();
  const first = s.fork("A"), second = s.fork("B");
  await second;
  assert.equal(s.commands.length, 1);
  assert.equal(s.ui.spinner, "A");
  assert.deepEqual(s.writes, ["A"]);
  s.commands[0].resolve({ newSessionId: "fork-A" });
  await first;
  assert.deepEqual(s.navigations, ["fork-A"]);
  assert.deepEqual(s.writes, ["A", null]);
});

for (const invalidation of ["switch", "unmount"]) {
  for (const outcome of ["success", "error"]) {
    test(`${invalidation}: stale ${outcome} cannot navigate or write UI, but releases admission`, async () => {
      const s = setup();
      const pending = s.fork("A");
      if (invalidation === "switch") s.context.sessionIdRef.current = "other";
      else s.context.sessionHookMountedRef.current = false; // Old sid intentionally retained.
      s.ui.spinner = "new-page-state";
      await s.fork("B");
      assert.equal(s.commands.length, 1, "leaving must not release a pending mutation guard");
      if (outcome === "error") s.commands[0].reject(new Error("stale failure"));
      else s.commands[0].resolve({ newSessionId: "fork-A" });
      await pending;
      assert.deepEqual(s.navigations, []);
      assert.deepEqual(s.writes, ["A"]);
      assert.equal(s.ui.spinner, "new-page-state");
      assert.deepEqual(s.errors, []);
      assert.deepEqual(s.notices, []);
      assert.equal(s.context.forkRequestRef.current, null);
      const retry = s.fork("C");
      if (invalidation === "switch") {
        assert.equal(s.commands.length, 2);
        assert.equal(s.commands[1].sid, "other");
        s.commands[1].resolve({ cancelled: true });
      } else assert.equal(s.commands.length, 1);
      await retry;
    });
  }
}

test("old unmounted hook completion cannot clear a newly mounted hook spinner", async () => {
  const old = setup(), current = setup();
  const a = old.fork("A");
  old.context.sessionHookMountedRef.current = false;
  const b = current.fork("B");
  const owner = current.context.forkRequestRef.current;
  old.commands[0].resolve({ newSessionId: "fork-A" });
  await a;
  assert.equal(current.ui.spinner, "B");
  assert.equal(current.context.forkRequestRef.current, owner);
  assert.deepEqual(old.navigations, []);
  assert.deepEqual(old.writes, ["A"]);
  current.commands[0].resolve({ newSessionId: "fork-B" });
  await b;
  assert.deepEqual(current.navigations, ["fork-B"]);
  assert.equal(current.ui.spinner, null);
});

test("request identity fences both navigation and finally from replacement ownership", async () => {
  const s = setup();
  const pending = s.fork("A");
  // Defensive ownership test: real admission never replaces an in-flight owner.
  const newerOwner = { sid: "source" };
  s.context.forkRequestRef.current = newerOwner;
  s.ui.spinner = "B";
  s.commands[0].resolve({ newSessionId: "fork-A" });
  await pending;
  assert.deepEqual(s.navigations, []);
  assert.deepEqual(s.writes, ["A"]);
  assert.equal(s.ui.spinner, "B");
  assert.equal(s.context.forkRequestRef.current, newerOwner);
});

for (const [ref, value] of [["sessionIdRef", null], ["sessionHookMountedRef", false], ["bashRunningRef", true], ["imageGeneratingRef", true]]) {
  test(`${ref} rejects admission without UI writes`, async () => {
    const s = setup();
    s.context[ref].current = value;
    await s.fork("A");
    assert.equal(s.commands.length, 0);
    assert.deepEqual(s.writes, []);
    assert.equal(s.context.forkRequestRef.current, null);
  });
}
