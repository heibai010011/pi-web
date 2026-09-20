import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;

test("default cwd grants only the created directory before returning it", async () => {
  const calls = [];
  const exports = {};
  const dependencies = {
    "next/server": { NextResponse: { json: body => ({ body, status: 200 }) } },
    fs: { mkdirSync: (dir, options) => {
      assert.equal(options.recursive, true);
      calls.push(["mkdir", dir]);
    } },
    os: { homedir: () => "/fixture-home" },
    path: { join: (...parts) => parts.join("/") },
    "@/lib/file-access": { allowFileRoot: dir => calls.push(["allow", dir]) },
  };
  let now = "2026-01-02T12:00:00.000Z";
  class FixedDate extends Date {
    constructor() { super(now); }
  }
  vm.runInNewContext(compiled, { exports, Date: FixedDate, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  const response = await exports.POST();
  assert.equal(response.status, 200);
  assert.equal(response.body.cwd, "/fixture-home/pi-cwd-20260102");
  assert.deepEqual(calls, [["mkdir", response.body.cwd], ["allow", response.body.cwd]]);
  const repeated = await exports.POST();
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.cwd, response.body.cwd);
  assert.deepEqual(calls.slice(2), [["mkdir", response.body.cwd], ["allow", response.body.cwd]]);
  now = "2026-01-03T00:00:00.000Z";
  const nextDay = await exports.POST();
  assert.equal(nextDay.status, 200);
  assert.equal(nextDay.body.cwd, "/fixture-home/pi-cwd-20260103");
  assert.deepEqual(calls.slice(4), [["mkdir", nextDay.body.cwd], ["allow", nextDay.body.cwd]]);
});

test("default cwd never reports success when authorization fails", async () => {
  const exports = {};
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    fs: { mkdirSync: () => {} },
    os: { homedir: () => "/fixture-home" },
    path: { join: (...parts) => parts.join("/") },
    "@/lib/file-access": { allowFileRoot: () => { throw new Error("fixture authorization failed"); } },
  };
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  const response = await exports.POST();
  assert.equal(response.status, 500);
  assert.match(response.body.error, /fixture authorization failed/);
  assert.equal(response.body.cwd, undefined);
});

test("default cwd creation failure never grants file access", async () => {
  const granted = [];
  let failCreation = true;
  const exports = {};
  const dependencies = {
    "next/server": { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } },
    fs: { mkdirSync: () => { if (failCreation) throw new Error("fixture mkdir denied"); } },
    os: { homedir: () => "/fixture-home" },
    path: { join: (...parts) => parts.join("/") },
    "@/lib/file-access": { allowFileRoot: value => granted.push(value) },
  };
  vm.runInNewContext(compiled, { exports, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  } });
  const response = await exports.POST();
  assert.equal(response.status, 500);
  assert.match(response.body.error, /fixture mkdir denied/);
  assert.deepEqual(granted, []);
  failCreation = false;
  const recovered = await exports.POST();
  assert.equal(recovered.status, 200);
  assert.deepEqual(granted, [recovered.body.cwd]);
});
