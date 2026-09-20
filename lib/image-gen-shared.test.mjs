import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { isImageGenerationToolDetails } = await createJiti(import.meta.url).import("./image-gen-shared.ts");
const valid = {
  kind: "pi-web-image-generation", model: { provider: "p", modelId: "m" },
  prompt: "cat", count: 2, durationMs: 1200, requestedBy: "composer",
};

test("image generation metadata accepts complete valid records", () => {
  assert.equal(isImageGenerationToolDetails(valid), true);
  assert.equal(isImageGenerationToolDetails({ ...valid, durationMs: 0, seed: 0, aspectRatio: "3:4", requestedBy: "tool" }), true);
});

test("image generation metadata rejects missing required fields", () => {
  for (const key of Object.keys(valid)) {
    const record = { ...valid };
    delete record[key];
    assert.equal(isImageGenerationToolDetails(record), false, key);
  }
});

test("image generation metadata rejects malformed values before rendering", () => {
  for (const overrides of [
    { durationMs: "1200" }, { durationMs: NaN }, { durationMs: Infinity }, { durationMs: -1 },
    { count: 0 }, { count: 1.5 }, { count: Infinity },
    { prompt: {} }, { requestedBy: "unknown" },
    { model: null }, { model: { provider: 1, modelId: "m" } },
    { aspectRatio: 42 }, { seed: NaN }, { seed: "1" }, { seed: 1.5 },
  ]) assert.equal(isImageGenerationToolDetails({ ...valid, ...overrides }), false, JSON.stringify(overrides));
  for (const value of [null, [], "data", 1]) assert.equal(isImageGenerationToolDetails(value), false);
});
