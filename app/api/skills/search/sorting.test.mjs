import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test("search enforces limit after ranking and filtering upstream results", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ skills: [
    { name: "", installs: 99999 },
    { name: "lower", source: "owner/repo", installs: 1 },
    { name: "higher", source: "owner/repo", installs: 2 },
  ] });
  const response = await POST(new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture", limit: 1 }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results.map(r => r.package), ["owner/repo@higher"]);
});

test("search ranks by exact installation counts rather than rounded display text", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ skills: [
    { name: "lower", source: "owner/repo", installs: 1201 },
    { name: "higher", source: "owner/repo", installs: 1249 },
  ] });
  const response = await POST(new Request("http://localhost/api/skills/search", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "fixture" }),
  }));
  assert.equal(response.status, 200);
  const { results } = await response.json();
  assert.deepEqual(results.map(r => r.package), ["owner/repo@higher", "owner/repo@lower"]);
  assert.deepEqual(results.map(r => r.installs), ["1.2K installs", "1.2K installs"]);
});
