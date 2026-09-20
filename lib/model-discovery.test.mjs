import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { buildModelsListUrl, parseDiscoveredModels } = await loadSubject("./model-discovery.ts");
const { resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");

test("model discovery rejects unsupported URL protocols", () => {
  for (const url of ["file:///tmp/models", "ftp://example.com/models", "data:application/json,{}", "javascript:alert(1)"]) {
    assert.throws(() => buildModelsListUrl(url, "openai-completions"), /HTTP/i, url);
  }
  assert.equal(buildModelsListUrl("http://localhost:8080/v1", "openai-completions").protocol, "http:");
});

test("model discovery rejects URL credentials unsupported by fetch", () => {
  for (const url of ["https://user:password@example.com/v1", "https://user@example.com", "http://:password@localhost:8080"]) {
    assert.throws(() => buildModelsListUrl(url, "openai-completions"), /credentials/i);
  }
});

test("normalizes explicit models endpoints while preserving query overrides", () => {
  assert.equal(buildModelsListUrl("https://example.com/v1/models///?limit=12", "anthropic-messages").toString(), "https://example.com/v1/models?limit=12");
  assert.equal(buildModelsListUrl("https://example.com/v1beta/models/?pageSize=5", "google-generative-ai").toString(), "https://example.com/v1beta/models?pageSize=5");
});

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("preserves opaque explicit IDs instead of treating them as Google resource names", () => {
  const result = parseDiscoveredModels({ data: [{ id: "models/acme-chat" }, { id: "acme-chat" }, { model: "models/other" }] });
  assert.deepEqual(result.map(model => model.id).sort(), ["acme-chat", "models/acme-chat", "models/other"]);
});

test("mixed discovery responses skip unusable entries and deduplicate normalized IDs", () => {
  assert.deepEqual(parseDiscoveredModels({ items: [
    null, false, 42, [], {}, "   ", { id: " " }, { name: "models/" },
    { id: " model-2 ", display_name: " Model Two " }, { id: "model-2", name: "duplicate" },
    { id: " ", model: " fallback ", displayName: " Fallback " },
  ] }), [
    { id: "fallback", name: "Fallback" },
    { id: "model-2", name: "Model Two" },
  ]);
  for (const value of [null, false, 42, "models", {}]) assert.deepEqual(parseDiscoveredModels(value), []);
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("resolves environment-backed headers without an API key", async () => {
  process.env.PI_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    const auth = await resolveModelDiscoveryAuth("pi-web-header-only-test", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      headers: { "X-Discovery-Token": "$PI_WEB_DISCOVERY_TEST_TOKEN" },
    });
    assert.equal(auth.apiKey, undefined);
    assert.deepEqual(auth.headers, { "X-Discovery-Token": "resolved-token" });
  } finally {
    delete process.env.PI_WEB_DISCOVERY_TEST_TOKEN;
  }
});
