import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
test("models config rejects malformed JSON and nonobjects without writes", async () => {
  const exports = {};
  const writes = [];
  let writeAttempts = 0;
  let failWrite = false;
  let writeFailure = new Error("fixture storage failure");
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } };
    if (name === "@/lib/models-config-store") return { writeModelsConfig: body => {
      writeAttempts++;
      if (failWrite) throw writeFailure;
      writes.push(body);
    } };
    throw new Error(`Unexpected import ${name}`);
  } });
  for (const body of ["{", "null", "[]", '"text"', "1", "true"]) {
    const response = await exports.PUT(new Request("http://localhost/api/models-config", { method: "PUT", body }));
    assert.equal(response.status, 400);
    assert.match(response.body.error, /JSON/);
  }
  assert.equal(writes.length, 0);
  assert.equal(writeAttempts, 0);
  for (const config of [{}, { providers: {}, custom: "preserved" }]) {
    const response = await exports.PUT(new Request("http://localhost/api/models-config", { method: "PUT", body: JSON.stringify(config) }));
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.deepEqual(writes.at(-1), config);
  }
  failWrite = true;
  for (const body of ["{", "null", "[]"]) {
    const invalid = await exports.PUT(new Request("http://localhost/api/models-config", { method: "PUT", body }));
    assert.equal(invalid.status, 400);
    assert.equal(writes.length, 2);
    assert.equal(writeAttempts, 2);
  }
  const failed = await exports.PUT(new Request("http://localhost/api/models-config", { method: "PUT", body: "{}" }));
  assert.equal(failed.status, 500);
  assert.equal(typeof failed.body.error, "string");
  assert.doesNotMatch(failed.body.error, /fixture storage failure/);
  assert.equal(failed.body.success, undefined);
  assert.equal(writes.length, 2);
  const unprintableFailure = { toString() { throw new Error("must not stringify storage errors"); } };
  for (const failure of ["fixture secret", { detail: "fixture secret" }, null, undefined, unprintableFailure]) {
    writeFailure = failure;
    const response = await exports.PUT(new Request("http://localhost/api/models-config", { method: "PUT", body: "{}" }));
    assert.equal(response.status, 500);
    assert.equal(response.body.error, failed.body.error);
    assert.equal(response.body.success, undefined);
    assert.equal(writes.length, 2);
  }
  failWrite = false;
  const recoveredConfig = { providers: {}, recovered: true };
  const recovered = await exports.PUT(new Request("http://localhost/api/models-config", {
    method: "PUT", body: JSON.stringify(recoveredConfig),
  }));
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.success, true);
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.at(-1), recoveredConfig);
});
