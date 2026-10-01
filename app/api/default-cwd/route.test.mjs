import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

function loadRoute({ defaultCwdPath, mkdirSync }) {
  const exports = {};
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    fs: { mkdirSync },
    "@/lib/default-cwd": { defaultCwdPath },
  };
  vm.runInNewContext(compiled, { exports, require: name => {
    // Creation must not grant a broad root itself: selection and authorization
    // now go through /api/cwd/validate, just like a user-selected directory.
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  return exports;
}

test("default cwd creates only the helper's dated directory and leaves authorization to validation", async () => {
  const calls = [];
  let dir = "/fixture-home/pi-cwd/20260102";
  const { POST } = loadRoute({
    defaultCwdPath: () => dir,
    mkdirSync: (path, options) => {
      assert.equal(options.recursive, true);
      calls.push(path);
    },
  });
  for (const expected of [dir, dir, "/fixture-home/pi-cwd/20260103"]) {
    dir = expected;
    const response = await POST();
    assert.equal(response.status, 200);
    assert.equal(response.body.cwd, expected);
  }
  assert.deepEqual(calls, ["/fixture-home/pi-cwd/20260102", "/fixture-home/pi-cwd/20260102", "/fixture-home/pi-cwd/20260103"]);
});

test("default cwd never reports success when path resolution fails", async () => {
  let created = false;
  const { POST } = loadRoute({
    defaultCwdPath: () => { throw new Error("fixture path failed"); },
    mkdirSync: () => { created = true; },
  });
  const response = await POST();
  assert.equal(response.status, 500);
  assert.match(response.body.error, /fixture path failed/);
  assert.equal(response.body.cwd, undefined);
  assert.equal(created, false);
});

test("default cwd creation failure returns no selectable cwd and can recover", async () => {
  let failCreation = true;
  const { POST } = loadRoute({
    defaultCwdPath: () => "/fixture-home/pi-cwd/20260102",
    mkdirSync: () => { if (failCreation) throw new Error("fixture mkdir denied"); },
  });
  const response = await POST();
  assert.equal(response.status, 500);
  assert.match(response.body.error, /fixture mkdir denied/);
  assert.equal(response.body.cwd, undefined);
  failCreation = false;
  const recovered = await POST();
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.cwd, "/fixture-home/pi-cwd/20260102");
});
