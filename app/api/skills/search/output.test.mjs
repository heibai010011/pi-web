import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import ts from "typescript";
const source = ts.createSourceFile("route.ts", await readFile(new URL("./route.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "parseSearchOutput");
const parse = new Script(ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText).runInNewContext({ ANSI_RE: /\x1B\[[0-9;]*m/g });
test("CLI skill search retains singular and plural installation counts", () => {
  const result = parse("owner/repo@one  1 install\n└ https://skills.sh/owner/repo/one\nowner/repo@many  2K installs\nhttps://skills.sh/owner/repo/many");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { package: "owner/repo@one", installs: "1 install", url: "https://skills.sh/owner/repo/one" },
    { package: "owner/repo@many", installs: "2K installs", url: "https://skills.sh/owner/repo/many" },
  ]);
});
