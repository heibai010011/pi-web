import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./[provider]/route.ts");

function submit(body, provider = "test") {
  return POST(new Request("http://localhost/api/auth/login/test", {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  }), { params: Promise.resolve({ provider }) });
}

test("manual login rejects invalid input without consuming pending callbacks", async (t) => {
  const original = globalThis.__piLoginCallbacks;
  t.after(() => { globalThis.__piLoginCallbacks = original; });
  const token = "test-123-random";
  let calls = 0;
  const callback = { resolve() { calls++; }, reject() {} };
  globalThis.__piLoginCallbacks = new Map([[token, callback]]);
  for (const body of ["null", "{", "[]", "42", JSON.stringify({ token, code: 123 }),
    JSON.stringify({ token, code: {} }), JSON.stringify({ token: 123, code: "code" }),
    JSON.stringify({ token, code: "   " })]) {
    const response = await submit(body);
    assert.equal(response.status, 400, body);
    assert.equal(typeof (await response.json()).error, "string");
    assert.equal(calls, 0);
    assert.equal(globalThis.__piLoginCallbacks.get(token), callback);
  }
});

test("valid manual code resolves only the matching pending login once", async (t) => {
  const original = globalThis.__piLoginCallbacks;
  t.after(() => { globalThis.__piLoginCallbacks = original; });
  const token = "test-123-random";
  const codes = [];
  globalThis.__piLoginCallbacks = new Map([[token, { resolve(code) { codes.push(code); }, reject() {} }]]);
  const body = JSON.stringify({ token, code: "valid-code" });
  assert.equal((await submit(body, "other")).status, 400);
  assert.deepEqual(codes, []);
  assert.equal((await submit(body)).status, 200);
  assert.deepEqual(codes, ["valid-code"]);
  assert.equal((await submit(body)).status, 404);
});
