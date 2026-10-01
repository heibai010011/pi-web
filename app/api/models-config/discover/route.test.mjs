import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import ts from "typescript";
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

test("invalid explicit discovery URLs are rejected before resolving credentials", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  let authCalls = 0;
  let fetchCalls = 0;
  new Script(compiled).runInNewContext({
    exports,
    require(name) {
      if (name === "next/server") return { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } };
      if (name === "@/lib/model-discovery-auth") return { resolveModelDiscoveryAuth() { authCalls++; throw new Error("credential commands must not run"); } };
      if (name === "@/lib/model-discovery") return { buildModelsListUrl() { throw new Error("invalid URL"); } };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    fetch() { fetchCalls++; throw new Error("must not fetch"); },
  });
  const response = await exports.POST(new Request("http://localhost/api/models-config/discover", {
    method: "POST",
    body: JSON.stringify({ providerName: "fixture", provider: { baseUrl: "file:///private", apiKey: "!credential-command" } }),
  }));
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Base URL is invalid");
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
});
