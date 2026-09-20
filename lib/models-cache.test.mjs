import assert from "node:assert/strict";
import test from "node:test";

import {
  invalidateModelsCache,
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
} from "./models-cache.ts";

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    defaultThinkingLevel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
  };
}

test("caches model data independently for each cwd", async () => {
  invalidateModelsCache();
  let firstLoads = 0;
  let secondLoads = 0;

  const first = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("first");
  });
  await loadModelsWithCache("/second", async () => {
    secondLoads += 1;
    return modelsData("second");
  });
  const firstAgain = await loadModelsWithCache("/first", async () => {
    firstLoads += 1;
    return modelsData("replacement");
  });

  assert.deepEqual(firstAgain, first);
  assert.equal(firstLoads, 1);
  assert.equal(secondLoads, 1);
});

test("shares one loader between concurrent requests for the same cwd", async () => {
  invalidateModelsCache();
  let loads = 0;
  let finishLoad;
  const loader = () => {
    loads += 1;
    return new Promise((resolve) => { finishLoad = resolve; });
  };

  const first = loadModelsWithCache("/shared", loader);
  const second = loadModelsWithCache("/shared", loader);
  await Promise.resolve();

  assert.equal(loads, 1);
  finishLoad(modelsData("shared"));
  assert.deepEqual(await second, await first);
});

test("cache expiry refreshes exactly at the deadline and deduplicates requests", async (t) => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  t.after(() => { Date.now = originalNow; invalidateModelsCache(); });
  invalidateModelsCache();
  let loads = 0;
  const loader = async () => modelsData(String(++loads));
  const initial = await loadModelsWithCache("/expiry", loader);
  now = 60_999;
  assert.deepEqual(await loadModelsWithCache("/expiry", loader), initial);
  assert.equal(loads, 1);
  now = 61_000;
  const first = loadModelsWithCache("/expiry", loader);
  const second = loadModelsWithCache("/expiry", loader);
  assert.equal(first, second);
  assert.deepEqual(await first, modelsData("2"));
  assert.equal(loads, 2);
});

test("does not cache a stale load that finishes after invalidation", async () => {
  invalidateModelsCache();
  let finishOldLoad;
  const oldLoad = loadModelsWithCache("/stale", () => new Promise((resolve) => { finishOldLoad = resolve; }));
  await Promise.resolve();

  invalidateModelsCache();
  let freshLoads = 0;
  const fresh = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("fresh");
  });
  finishOldLoad(modelsData("stale"));
  await oldLoad;

  const cached = await loadModelsWithCache("/stale", async () => {
    freshLoads += 1;
    return modelsData("unexpected");
  });
  assert.deepEqual(cached, fresh);
  assert.equal(freshLoads, 1);
});

test("model cache evicts oldest projects at capacity and reloads them", async () => {
  invalidateModelsCache();
  for (let index = 0; index < 33; index++) {
    await loadModelsWithCache(`/capacity/${index}`, async () => modelsData(String(index)));
  }
  assert.equal(globalThis.__piModelsCacheState.entries.size, 32);
  assert.equal(globalThis.__piModelsCacheState.entries.has("/capacity/0"), false);
  let loads = 0;
  const retained = await loadModelsWithCache("/capacity/32", async () => {
    loads++;
    return modelsData("unexpected");
  });
  assert.deepEqual(retained, modelsData("32"));
  const reloaded = await loadModelsWithCache("/capacity/0", async () => {
    loads++;
    return modelsData("reloaded");
  });
  assert.deepEqual(reloaded, modelsData("reloaded"));
  assert.equal(loads, 1);
  assert.equal(globalThis.__piModelsCacheState.entries.size, 32);
});

test("stale rejected load cannot remove a newer in-flight model refresh", async () => {
  invalidateModelsCache();
  let rejectOld, resolveNew;
  const old = loadModelsWithCache("/refresh", () => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const rejected = assert.rejects(old, /old failure/);
  await Promise.resolve();
  invalidateModelsCache();
  const fresh = loadModelsWithCache("/refresh", () => new Promise(resolve => { resolveNew = resolve; }));
  await Promise.resolve();
  rejectOld(new Error("old failure"));
  await rejected;
  let duplicateLoads = 0;
  const shared = loadModelsWithCache("/refresh", async () => {
    duplicateLoads++;
    return modelsData("unexpected");
  });
  assert.equal(shared, fresh);
  resolveNew(modelsData("fresh"));
  assert.deepEqual(await shared, modelsData("fresh"));
  assert.equal(duplicateLoads, 0);
});

test("retries after a model load fails", async () => {
  invalidateModelsCache();
  await assert.rejects(
    loadModelsWithCache("/failed", async () => { throw new Error("load failed"); }),
    /load failed/,
  );

  let retries = 0;
  const fresh = await loadModelsWithCache("/failed", async () => {
    retries += 1;
    return modelsData("fresh");
  });
  assert.deepEqual(fresh, modelsData("fresh"));
  assert.equal(retries, 1);
});

test("adds runtime errors without discarding available models", () => {
  const data = modelsData("builtin");
  const result = withModelRuntimeError(data, "Invalid models.json schema");

  assert.deepEqual(result, {
    ...data,
    modelError: "Invalid models.json schema",
  });
});

test("uses a safe error for unexpected model load failures", () => {
  const data = {
    ...modelsData("builtin"),
    modelError: "Failed to load /Users/example/.pi/agent/models.json with token secret",
  };
  const result = withSafeModelLoadFailure(data);

  assert.deepEqual(result, {
    ...data,
    modelError: "Model list is temporarily unavailable. Check your configuration and try again.",
  });
});
