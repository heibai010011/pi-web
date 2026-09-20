import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");

test("model discovery rejects invalid request bodies without upstream requests", async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected upstream request"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  for (const body of ["null", "{", "[]", "true", "42", '"provider"']) {
    const response = await POST(new Request("http://localhost/api/models-config/discover", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }));
    assert.equal(response.status, 400, body);
    assert.match((await response.json()).error, /JSON/);
  }
  for (const baseUrl of ["file:///tmp/models", "ftp://example.com", "data:application/json,{}", "javascript:alert(1)"]) {
    const response = await POST(new Request("http://localhost/api/models-config/discover", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerName: "test-provider", provider: { baseUrl } }),
    }));
    assert.equal(response.status, 400, baseUrl);
    assert.deepEqual(await response.json(), { error: "Base URL is invalid" });
  }
  assert.equal(calls, 0);
});
