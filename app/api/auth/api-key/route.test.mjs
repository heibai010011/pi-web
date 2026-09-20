import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./[provider]/route.ts");

function submit(body) {
  return POST(new Request("http://localhost/api/auth/api-key/test", {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  }), { params: Promise.resolve({ provider: "test" }) });
}

test("API key route rejects invalid JSON and non-object bodies with 400", async () => {
  for (const body of ["null", "{", "[]", "42", "true", '"key"']) {
    const response = await submit(body);
    assert.equal(response.status, 400, body);
    assert.match((await response.json()).error, /JSON/);
  }
});

test("API key route rejects invalid key values before authentication", async () => {
  for (const apiKey of [undefined, null, "", "  ", 123, {}, []]) {
    const response = await submit(JSON.stringify({ apiKey }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "apiKey is required" });
  }
});
