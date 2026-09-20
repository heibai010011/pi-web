import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import ts from "typescript";
const source = ts.createSourceFile("route.ts", await readFile(new URL("./route.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declarations = source.statements.filter(ts.isFunctionDeclaration).map(n => n.getText(source).replace(/^export /, ""));
const script = new Script(ts.transpileModule(`${declarations.join("\n")}\nPOST;`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
test("successful empty upstream search does not invoke CLI fallback", async () => {
  let calls = 0;
  const post = script.runInNewContext({
    AbortSignal, DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50, SEARCH_API_BASE: "https://fixture.invalid", ANSI_RE: /\x1B\[[0-9;]*m/g,
    process: { env: {} }, NextResponse: { json: (body, options) => Response.json(body, options) },
    fetch: async () => Response.json({ skills: [] }),
    runNpx: async () => { calls++; throw new Error("Unexpected CLI fallback"); },
  });
  const response = await post(new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(calls, 0);
  assert.deepEqual(await response.json(), { results: [] });
});

test("upstream search receives a bounded timeout signal and falls back on timeout", async () => {
  let timeout, fetchSignal, cliCalls = 0;
  const signal = AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  const post = script.runInNewContext({
    DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50, SEARCH_API_BASE: "https://fixture.invalid", ANSI_RE: /\x1B\[[0-9;]*m/g,
    AbortSignal: { timeout: ms => { timeout = ms; return signal; } },
    process: { env: {} }, NextResponse: { json: (body, options) => Response.json(body, options) },
    fetch: async (_url, options) => { fetchSignal = options.signal; throw signal.reason; },
    runNpx: async () => { cliCalls++; return { stdout: "", stderr: "" }; },
  });
  const response = await post(new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture" }),
  }));
  assert.equal(timeout, 20000);
  assert.equal(fetchSignal, signal);
  assert.equal(cliCalls, 1);
  assert.equal(response.status, 200);
});

test("HTTP errors and invalid JSON invoke CLI fallback rather than losing search results", async () => {
  for (const responseFactory of [() => new Response("unavailable", { status: 503 }), () => new Response("{", { status: 200 })]) {
    let calls = 0;
    const post = script.runInNewContext({
      AbortSignal, DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50, SEARCH_API_BASE: "https://fixture.invalid", ANSI_RE: /\x1B\[[0-9;]*m/g,
      process: { env: {} }, NextResponse: { json: (body, options) => Response.json(body, options) },
      fetch: async () => responseFactory(),
      runNpx: async () => { calls++; return { stdout: "owner/repo@recovered  1 install", stderr: "" }; },
    });
    const response = await post(new Request("http://localhost/api/skills/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture" }),
    }));
    assert.equal(calls, 1);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).results.map(r => r.package), ["owner/repo@recovered"]);
  }
});

test("invalid upstream response shape falls back to CLI with trimmed query and limit", async () => {
  for (const payload of [null, {}, { skills: {} }, { skills: "invalid" }]) {
    const calls = [];
    const post = script.runInNewContext({
      AbortSignal,
    DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50, SEARCH_API_BASE: "https://fixture.invalid", ANSI_RE: /\x1B\[[0-9;]*m/g,
      process: { env: {} }, NextResponse: { json: (body, options) => Response.json(body, options) },
      fetch: async () => Response.json(payload),
      runNpx: async (args) => { calls.push(Array.from(args)); return { stdout: "owner/repo@one  1 install\nowner/repo@two  2 installs", stderr: "" }; },
    });
    const response = await post(new Request("http://localhost/api/skills/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: " fixture ", limit: 1 }),
    }));
    assert.deepEqual(calls, [["skills", "find", "fixture"]]);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).results.map(r => r.package), ["owner/repo@one"]);
  }
});

test("bad upstream entries do not discard valid skills or invoke CLI fallback", async () => {
  let calls = 0;
  const post = script.runInNewContext({
    AbortSignal,
    DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50, SEARCH_API_BASE: "https://fixture.invalid", ANSI_RE: /\x1B\[[0-9;]*m/g,
    process: { env: {} }, NextResponse: { json: (body, options) => Response.json(body, options) },
    fetch: async () => Response.json({ skills: [null, 42, {}, { name: 42, source: "owner/repo" },
      { name: "valid", source: "owner/repo", installs: 5 },
      { name: "other", source: "owner/repo", installs: { value: 99 } },
    ] }),
    runNpx: async () => { calls++; throw new Error("Unexpected CLI fallback"); },
  });
  const response = await post(new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture" }),
  }));
  assert.equal(calls, 0);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results.map(r => [r.package, r.installs]), [["owner/repo@valid", "5 installs"], ["owner/repo@other", ""]]);
});
