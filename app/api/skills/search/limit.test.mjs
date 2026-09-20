import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import ts from "typescript";
const source = ts.createSourceFile("route.ts", await readFile(new URL("./route.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === "parseLimit");
const parseLimit = new Script(ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText).runInNewContext({ DEFAULT_LIMIT: 50, MIN_LIMIT: 1, MAX_LIMIT: 50 });
test("search limit uses default for nonnumeric types without coercing objects", () => {
  for (const value of [{ toString: null }, {}, [], [2], null, undefined, false, true, "", " ", "invalid"]) {
    assert.equal(parseLimit(value), 50);
  }
});
test("search limit preserves numeric conversion floor and bounds", () => {
  for (const [input, expected] of [[2, 2], [" 3 ", 3], [3.9, 3], [0, 1], [-5, 1], [500, 50], [NaN, 50], [Infinity, 50]]) {
    assert.equal(parseLimit(input), expected);
  }
});
