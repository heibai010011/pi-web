import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  DEFAULT_IMAGE_GEN_PREFERENCES,
  getImageGenPreferences,
  setImageGenPreferences,
} = await jiti.import("./image-gen-preferences.ts");

function memoryStorage(initial = new Map()) {
  return {
    getItem: (key) => (initial.has(key) ? initial.get(key) : null),
    setItem: (key, value) => { initial.set(key, value); },
    dump: () => initial,
  };
}

test("defaults are returned without storage", () => {
  assert.deepEqual(getImageGenPreferences(null), DEFAULT_IMAGE_GEN_PREFERENCES);
  assert.deepEqual(getImageGenPreferences(memoryStorage()), DEFAULT_IMAGE_GEN_PREFERENCES);
});

test("preferences round-trip through storage", () => {
  const storage = memoryStorage();
  setImageGenPreferences({
    model: { provider: "openrouter", modelId: "flux" },
    aspectRatio: "16:9",
    count: 4,
    seed: 42,
  }, storage);
  assert.deepEqual(getImageGenPreferences(storage), {
    model: { provider: "openrouter", modelId: "flux" },
    aspectRatio: "16:9",
    count: 4,
    seed: 42,
  });
});

test("corrupt or invalid values fall back field by field", () => {
  const storage = memoryStorage(new Map([["pi-web:image-gen-preferences", JSON.stringify({
    model: { provider: 1, modelId: "flux" },
    aspectRatio: "bogus",
    count: 3,
    seed: "NaN",
  })]]));
  assert.deepEqual(getImageGenPreferences(storage), {
    model: null,
    aspectRatio: DEFAULT_IMAGE_GEN_PREFERENCES.aspectRatio,
    count: DEFAULT_IMAGE_GEN_PREFERENCES.count,
    seed: null,
  });

  const broken = memoryStorage(new Map([["pi-web:image-gen-preferences", "{{{"]]));
  assert.deepEqual(getImageGenPreferences(broken), DEFAULT_IMAGE_GEN_PREFERENCES);
});

test("set is best-effort when storage throws", () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
  };
  assert.doesNotThrow(() => setImageGenPreferences(DEFAULT_IMAGE_GEN_PREFERENCES, storage));
});
