import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
function request(body, headers = {}) {
  return new Request("http://localhost/api/models-config/test", {
    method: "POST", headers: { Host: "localhost", "Content-Type": "application/json", ...headers }, body,
  });
}
test("model test rejects malformed and non-object JSON with client errors", async () => {
  for (const body of ["null", "{", "[]", "true", "42", '"model"']) {
    const response = await POST(request(body));
    assert.equal(response.status, 400, body);
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.match(result.error, /JSON/);
  }
});
test("model test keeps request security checks ahead of body parsing", async () => {
  assert.equal((await POST(request("{", { Origin: "http://untrusted.example" }))).status, 403);
  assert.equal((await POST(request("{", { "Content-Type": "text/plain" }))).status, 415);
});
