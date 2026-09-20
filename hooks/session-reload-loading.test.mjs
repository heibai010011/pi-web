import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile("useAgentSession.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
let loader;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "loadSession") loader = node;
  ts.forEachChild(node, visit);
}
visit(source);
const code = ts.transpileModule(`(${loader.initializer.arguments[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;

for (const outcome of ["success", "missing", "failure"]) {
  test(`stale ${outcome} reload cannot release loading before the newer snapshot`, async () => {
    const requests = [];
    const loading = [], errors = [];
    const context = {
      URLSearchParams, console,
      sessionIdRef: { current: "session" }, reloadSeqRef: { current: 0 },
      fetch: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
      setLoading: value => loading.push(value),
      setError: value => errors.push(value),
    };
    const load = new Script(code).runInNewContext(context);
    const stale = load("session", true);
    const current = load("session", true);
    if (outcome === "failure") requests[0].reject(new Error("obsolete network error"));
    else requests[0].resolve({ status: outcome === "missing" ? 404 : 200, ok: true });
    await stale;
    assert.deepEqual(loading, [true, true]);
    assert.deepEqual(errors, []);
    requests[1].reject(new Error("current network error"));
    await current;
    assert.deepEqual(loading, [true, true, false]);
    assert.deepEqual(errors, ["Error: current network error"]);
  });
}
