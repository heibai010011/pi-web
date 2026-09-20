import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test("skill search rejects malformed bodies and non-string queries", async () => {
  for (const body of ["{", "null", "[]", "42", ...[42, true, {}, [], null, " "].map(query => JSON.stringify({ query }))]) {
    const response = await POST(new Request("http://localhost/api/skills/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }));
    assert.equal(response.status, 400, body);
  }
});
