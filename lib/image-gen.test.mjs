import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  applyImageGenerationParams,
  ImageGenerationValidationError,
  imageCredentialsFromModelRegistry,
  isImageProviderConfigured,
  mergeAssistantImages,
  normalizeImageGenerationRequest,
  summarizeImageGeneration,
  runImageGeneration,
  zeroImageUsage,
} = await jiti.import("./image-gen.ts");

function imageResult(overrides = {}) {
  return {
    api: "openrouter-images",
    provider: "openrouter",
    model: "black-forest-labs/flux.2-klein",
    output: [],
    stopReason: "stop",
    timestamp: 1_000,
    ...overrides,
  };
}

test("applyImageGenerationParams injects image_config and seed", () => {
  const request = normalizeImageGenerationRequest({
    prompt: "a cat",
    model: { provider: "openrouter", modelId: "flux" },
    aspectRatio: "16:9",
    count: 1,
    seed: 42,
  });
  const payload = applyImageGenerationParams({ model: "flux", messages: [] }, request);
  assert.deepEqual(payload.image_config, { aspect_ratio: "16:9" });
  assert.equal(payload.seed, 42);
  // Untouched payload fields survive.
  assert.deepEqual(payload.messages, []);
});

test("applyImageGenerationParams leaves payloads without params unchanged", () => {
  const request = normalizeImageGenerationRequest({
    prompt: "a cat",
    model: { provider: "openrouter", modelId: "flux" },
  });
  const payload = { model: "flux" };
  assert.deepEqual(applyImageGenerationParams(payload, request), { model: "flux" });
});

test("normalizeImageGenerationRequest validates and clamps", () => {
  const request = normalizeImageGenerationRequest({
    prompt: "  a cat  ",
    model: { provider: "openrouter", modelId: "flux" },
    count: 99,
    seed: 7.6,
    aspectRatio: "bogus",
    referenceImages: [
      { data: "aaa", mimeType: "image/png" },
      "not an image",
      { data: "bbb", mimeType: "image/jpeg" },
    ],
  });
  assert.equal(request.prompt, "a cat");
  assert.equal(request.count, 4);
  assert.equal(request.seed, 7);
  assert.equal(request.aspectRatio, undefined);
  assert.deepEqual(request.referenceImages, [
    { data: "aaa", mimeType: "image/png" },
    { data: "bbb", mimeType: "image/jpeg" },
  ]);

  assert.throws(() => normalizeImageGenerationRequest({ prompt: "  ", model: { provider: "a", modelId: "b" } }), /prompt/);
  assert.throws(() => normalizeImageGenerationRequest({ prompt: "x", model: { provider: "a" } }), /model/);
});

test("reference limits reject raw counts before filtering or provider calls", async () => {
  for (const count of [5, 10]) {
    for (const extra of [{ data: "extra", mimeType: "image/png" }, null]) {
      const referenceImages = Array.from({ length: count }, (_, index) => index < 4
        ? { data: String(index), mimeType: "image/png" } : extra);
      const request = { prompt: "cat", model: { provider: "p", modelId: "m" }, referenceImages };
      const expected = { name: "ImageGenerationValidationError", status: 400 };
      assert.throws(() => normalizeImageGenerationRequest(request), expected);
      let calls = 0;
      await assert.rejects(runImageGeneration({
        getModel() { calls++; return { provider: "p", id: "m" }; },
        async generateImages() { calls++; return imageResult(); },
      }, request), ImageGenerationValidationError);
      assert.equal(calls, 0);
    }
  }
});

test("four reference images reach the provider intact and in order", async () => {
  const referenceImages = Array.from({ length: 4 }, (_, index) => ({ data: `ref-${index}`, mimeType: "image/png" }));
  const request = normalizeImageGenerationRequest({ prompt: "cat", model: { provider: "p", modelId: "m" }, referenceImages });
  assert.deepEqual(request.referenceImages, referenceImages);
  let calls = 0;
  await runImageGeneration({
    getModel: () => ({ provider: "p", id: "m" }),
    async generateImages(_model, context) {
      calls++;
      assert.deepEqual(context.input, [{ type: "text", text: "cat" }, ...referenceImages.map(image => ({ type: "image", ...image }))]);
      return imageResult({ output: [{ type: "image", data: "result", mimeType: "image/png" }] });
    },
  }, request);
  assert.equal(calls, 1);
});

test("image model references trim surrounding whitespace and reject blank identities", () => {
  assert.deepEqual(normalizeImageGenerationRequest({
    prompt: "cat", model: { provider: " openrouter ", modelId: " vendor/flux " },
  }).model, { provider: "openrouter", modelId: "vendor/flux" });
  for (const model of [{ provider: " ", modelId: "flux" }, { provider: "openrouter", modelId: "\t" }]) {
    assert.throws(() => normalizeImageGenerationRequest({ prompt: "cat", model }), /requires a model/);
  }
});

test("generation counts stay finite and bounded at normalization and execution", async () => {
  for (const [count, expected] of [[NaN, 1], [Infinity, 1], [-Infinity, 1], [99, 4], [2.9, 2], [-1, 1]]) {
    const request = { prompt: "cat", model: { provider: "openrouter", modelId: "flux" }, count };
    assert.equal(normalizeImageGenerationRequest(request).count, expected);
    let calls = 0;
    const outcome = await runImageGeneration({
      getModel: () => ({ provider: "openrouter", id: "flux" }),
      generateImages: async () => {
        calls++;
        return imageResult({ output: [{ type: "image", data: "a", mimeType: "image/png" }] });
      },
    }, request);
    assert.equal(calls, expected);
    assert.equal(outcome.requestedCount, expected);
  }
});

test("generation preserves sibling results when a provider throws or rejects", async () => {
  for (const synchronous of [true, false]) {
    let calls = 0;
    const outcome = await runImageGeneration({
      getModel: () => ({ api: "openrouter-images", provider: "p", id: "m" }),
      generateImages() {
        if (++calls === 1) {
          if (synchronous) throw new Error("provider failed");
          return Promise.reject(new Error("provider failed"));
        }
        return Promise.resolve(imageResult({ output: [{ type: "image", data: "saved", mimeType: "image/png" }] }));
      },
    }, { prompt: "cat", model: { provider: "p", modelId: "m" }, count: 2 });
    assert.equal(calls, 2);
    assert.equal(outcome.result.stopReason, "error");
    assert.equal(outcome.result.errorMessage, "provider failed");
    assert.equal(outcome.result.output[0].data, "saved");
  }
});

test("already cancelled generations never invoke the provider", async () => {
  for (const count of [1, 4]) {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const outcome = await runImageGeneration({
      getModel: () => ({ api: "openrouter-images", provider: "p", id: "m" }),
      async generateImages() {
        calls++;
        return imageResult({ output: [{ type: "image", data: "unexpected", mimeType: "image/png" }] });
      },
    }, { prompt: "cat", model: { provider: "p", modelId: "m" }, count }, controller.signal);
    assert.equal(calls, 0);
    assert.equal(outcome.result.stopReason, "aborted");
    assert.deepEqual(outcome.result.output, []);
    assert.equal(outcome.requestedCount, count);
  }
});

test("generation converts an aborted rejected call into a cancelled result", async () => {
  const controller = new AbortController();
  const outcome = await runImageGeneration({
    getModel: () => ({ api: "openrouter-images", provider: "p", id: "m" }),
    async generateImages() {
      controller.abort();
      throw new Error("cancelled by user");
    },
  }, { prompt: "cat", model: { provider: "p", modelId: "m" } }, controller.signal);
  assert.equal(outcome.result.stopReason, "aborted");
  assert.deepEqual(outcome.result.output, []);
});

test("mergeAssistantImages combines outputs, usage, and keeps first identity", () => {
  const usage = (n) => ({
    input: n, output: n * 2, cacheRead: 0, cacheWrite: 0, totalTokens: n * 3,
    cost: { input: n, output: n, cacheRead: 0, cacheWrite: 0, total: n * 2 },
  });
  const merged = mergeAssistantImages([
    imageResult({ output: [{ type: "image", data: "a", mimeType: "image/png" }], usage: usage(1), responseId: "r1" }),
    imageResult({ output: [{ type: "image", data: "b", mimeType: "image/png" }], usage: usage(2) }),
  ]);
  assert.equal(merged.output.length, 2);
  assert.equal(merged.responseId, "r1");
  assert.equal(merged.usage.input, 3);
  assert.equal(merged.usage.totalTokens, 9);
  assert.equal(merged.usage.cost.total, 6);
  assert.equal(merged.stopReason, "stop");
});

test("parallel text-only responses cannot be masked by a successful sibling", () => {
  const image = imageResult({ output: [{ type: "image", data: "a", mimeType: "image/png" }] });
  const refusal = imageResult({ output: [{ type: "text", text: "Unable to fulfill this request" }] });
  for (const results of [[image, refusal], [refusal, image], [image, imageResult()]]) {
    const result = mergeAssistantImages(results);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /no images/);
    assert.equal(result.output.filter(block => block.type === "image").length, 1);
    assert.deepEqual(result.output, results.flatMap(item => item.output));
  }
});

test("mergeAssistantImages surfaces errors and empty results", () => {
  const failed = mergeAssistantImages([
    imageResult({ stopReason: "stop", output: [{ type: "image", data: "a", mimeType: "image/png" }] }),
    imageResult({ stopReason: "error", errorMessage: "boom" }),
  ]);
  assert.equal(failed.stopReason, "error");
  assert.equal(failed.errorMessage, "boom");

  const empty = mergeAssistantImages([imageResult(), imageResult()]);
  assert.equal(empty.stopReason, "error");
  assert.match(empty.errorMessage, /no images/);
});

test("mergeAssistantImages propagates an error to stopReason even with images", () => {
  const merged = mergeAssistantImages([
    imageResult({ output: [{ type: "image", data: "a", mimeType: "image/png" }] }),
    imageResult({ stopReason: "error", errorMessage: "rate limited" }),
  ]);
  assert.equal(merged.stopReason, "error");
});

test("summarizeImageGeneration describes success and failure", () => {
  const request = normalizeImageGenerationRequest({
    prompt: "cat",
    model: { provider: "openrouter", modelId: "flux" },
    aspectRatio: "3:4",
    count: 2,
    seed: 9,
  });
  const ok = summarizeImageGeneration(request, {
    result: imageResult({ output: [{ type: "image", data: "a", mimeType: "image/png" }] }),
    requestedCount: 2,
    durationMs: 1234,
  });
  assert.match(ok, /1\/2 image/);
  assert.match(ok, /aspect 3:4/);
  assert.match(ok, /seed 9/);

  const failed = summarizeImageGeneration(request, {
    result: imageResult({ stopReason: "error", errorMessage: "no key" }),
    requestedCount: 2,
    durationMs: 50,
  });
  assert.match(failed, /^Image generation failed: no key/);
});

test("cancelled parallel generations retain cancellation and partial images", () => {
  const aborted = imageResult({ stopReason: "aborted" });
  const success = imageResult({ output: [{ type: "image", data: "a", mimeType: "image/png" }] });
  for (const results of [[aborted], [aborted, aborted], [success, aborted]]) {
    const result = mergeAssistantImages(results);
    assert.equal(result.stopReason, "aborted");
    assert.equal(result.output.length, results.includes(success) ? 1 : 0);
    assert.match(summarizeImageGeneration({ model: { provider: "p", modelId: "m" } }, {
      result, requestedCount: results.length, durationMs: 1,
    }), /^Image generation cancelled/);
  }
  assert.equal(mergeAssistantImages([aborted, imageResult({ stopReason: "error", errorMessage: "failure" })]).stopReason, "error");
});

test("zeroImageUsage returns a complete usage object", () => {
  const usage = zeroImageUsage();
  assert.equal(usage.totalTokens, 0);
  assert.deepEqual(usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("imageCredentialsFromModelRegistry resolves api keys to credential entries", async () => {
  const registry = {
    getProviderAuthStatus: (provider) => (provider === "openrouter" ? { configured: true } : undefined),
    getProviderAuth: async (provider) =>
      provider === "openrouter" ? { auth: { apiKey: "sk-test" } } : undefined,
  };
  const credentials = imageCredentialsFromModelRegistry(registry);
  assert.deepEqual(await credentials.read("openrouter"), { type: "api_key", key: "sk-test" });
  assert.equal(await credentials.read("unknown"), undefined);
  assert.equal(isImageProviderConfigured(registry, "openrouter"), true);
  assert.equal(isImageProviderConfigured(registry, "other"), false);
});

test("image credentials also handle synchronous authentication failures", async () => {
  const credentials = imageCredentialsFromModelRegistry({
    getProviderAuthStatus: () => ({ configured: true }),
    getProviderAuth: () => { throw new Error("auth backend down"); },
  });
  assert.equal(await credentials.read("openrouter"), undefined);
});

test("imageCredentialsFromModelRegistry swallows auth failures", async () => {
  const credentials = imageCredentialsFromModelRegistry({
    getProviderAuthStatus: () => ({ configured: true }),
    getProviderAuth: async () => { throw new Error("auth backend down"); },
  });
  assert.equal(await credentials.read("openrouter"), undefined);
});
