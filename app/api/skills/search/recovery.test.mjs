import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import ts from "typescript";
const source = ts.createSourceFile("route.ts", await readFile(new URL("./route.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declarations = ["parseLimit", "parseSearchOutput", "POST"].map(name => source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(source).replace(/^export /, ""));
const script = new Script(ts.transpileModule(`${declarations.join("\n")}\nPOST;`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
test("search reports failure when neither upstream nor CLI yields results", async () => {
  let calls = 0;
  const post = script.runInNewContext({
    DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50, ANSI_RE: /\x1B\[[0-9;]*m/g,
    process: { env: {} }, NextResponse: { json: (body, options) => Response.json(body, options) },
    searchSkillsApi: async () => { throw new Error("upstream unavailable"); },
    runNpx: async () => { calls++; throw Object.assign(new Error("CLI unavailable"), { stdout: "not a result", stderr: "diagnostic" }); },
  });
  const response = await post(new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture" }),
  }));
  assert.equal(response.status, 500);
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), { error: "CLI unavailable" });
});

for (const rejects of [false, true]) {
test(`CLI ${rejects ? "recovery" : "success"} separates stdout and stderr at a line boundary`, async () => {
  const post = script.runInNewContext({
    DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50, ANSI_RE: /\x1B\[[0-9;]*m/g,
    process: { env: {} }, NextResponse: { json: (body, options) => Response.json(body, options) },
    searchSkillsApi: async () => { throw new Error("upstream unavailable"); },
    runNpx: async () => {
      const output = { stdout: "diagnostic without newline", stderr: "owner/repo@found  1 install" };
      if (rejects) throw output;
      return output;
    },
  });
  const response = await post(new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results.map(r => r.package), ["owner/repo@found"]);
});

}

test("CLI error recovery honors the requested result limit", async () => {
  let calls = 0;
  const post = script.runInNewContext({
    DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50, ANSI_RE: /\x1B\[[0-9;]*m/g,
    process: { env: {} }, NextResponse: { json: (body, options) => Response.json(body, options) },
    searchSkillsApi: async () => { throw new Error("upstream unavailable"); },
    runNpx: async () => { calls++; throw { stdout: "owner/repo@one  1 install\nowner/repo@two  2 installs\n", stderr: "" }; },
  });
  const response = await post(new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture", limit: 1 }),
  }));
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual((await response.json()).results.map(r => r.package), ["owner/repo@one"]);
});
