import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, linkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  normalizeModelsConfigCosts,
  readModelsConfig,
  writeModelsConfig,
} = await jiti.import("./models-config-store.ts");
const { invalidateModelsCache, loadModelsWithCache } = await jiti.import("./models-cache.ts");
const { buildSessionContext, getSessionEntries } = await jiti.import("./session-reader.ts");

function createTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-models-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomic config replacement leaves hard-linked original content untouched", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  const alias = join(root, "original.json");
  const original = '{"providers":{},"custom":"original"}';
  writeFileSync(file, original);
  linkSync(file, alias);
  const replacement = { providers: {}, custom: "new" };
  writeModelsConfig(replacement, file);
  assert.deepEqual(readModelsConfig(file), replacement);
  assert.equal(readFileSync(alias, "utf8"), original);
  assert.deepEqual(readdirSync(root).sort(), ["models.json", "original.json"]);
});

test("saving a normalized configuration twice produces identical bytes", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  const config = { providers: { fixture: { models: [
    { id: " " }, { id: "stable", cost: { input: 0.125 }, custom: ["preserved"] },
  ] } } };
  writeModelsConfig(config, file);
  const first = readFileSync(file);
  writeModelsConfig(readModelsConfig(file), file);
  assert.deepEqual(readFileSync(file), first);
  const replacement = { providers: {}, custom: "replacement" };
  writeModelsConfig(replacement, file);
  assert.deepEqual(readModelsConfig(file), replacement);
  assert.deepEqual(readdirSync(root), ["models.json"]);
});

test("blank-row cleanup preserves opaque nonblank model identifiers", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  const ids = ["models/acme", "acme", " vendor/model ", "模型/版本", "acme"];
  const config = { providers: { fixture: { models: [
    { id: " \t\n" }, ...ids.map(id => ({ id })),
  ] } } };
  const before = structuredClone(config);
  writeModelsConfig(config, file);
  assert.deepEqual(readModelsConfig(file).providers.fixture.models.map(model => model.id), ids);
  assert.deepEqual(config, before);
});

test("removing all blank model rows preserves the provider configuration", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  const provider = {
    baseUrl: "https://fixture.invalid/v1", apiKey: "FIXTURE_API_KEY",
    custom: { enabled: true }, models: [{ id: "" }, { id: " \t" }],
  };
  const untouched = { baseUrl: "https://other.invalid", modelOverrides: { inherited: { cost: { input: 3 } } } };
  writeModelsConfig({ providers: { fixture: provider, untouched } }, file);
  assert.deepEqual(readModelsConfig(file), {
    providers: { fixture: { ...provider, models: [] }, untouched },
  });
  assert.equal(provider.models.length, 2);
});

test("special provider names survive config normalization and persistence", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  const config = JSON.parse('{"providers":{"__proto__":{"models":[{"id":"special","cost":{"input":1}}]},"constructor":{"models":[]},"toString":{"models":[]}}}');
  writeModelsConfig(config, file);
  const saved = readModelsConfig(file);
  assert.deepEqual(Object.keys(saved.providers).sort(), ["__proto__", "constructor", "toString"].sort());
  assert.equal(Object.hasOwn(saved.providers, "__proto__"), true);
  assert.deepEqual(saved.providers.__proto__.models[0].cost, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(Object.getPrototypeOf(saved.providers), Object.prototype);
  assert.deepEqual(saved.providers.constructor.models, []);
  assert.deepEqual(saved.providers.toString.models, []);
});

test("cost normalization preserves a literal proto metadata key safely", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  const config = JSON.parse('{"providers":{"fixture":{"models":[{"id":"fixture","cost":{"input":1,"__proto__":{"unit":"tokens"}}}]}}}');
  writeModelsConfig(config, file);
  const cost = readModelsConfig(file).providers.fixture.models[0].cost;
  assert.equal(Object.hasOwn(cost, "__proto__"), true);
  assert.deepEqual(cost.__proto__, { unit: "tokens" });
  assert.equal(Object.getPrototypeOf(cost), Object.prototype);
  assert.equal(cost.unit, undefined);
  assert.equal(cost.cacheWrite, 0);
});

test("nonobject config files fall back to an empty provider map", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  assert.deepEqual(readModelsConfig(file), { providers: {} });
  assert.throws(() => statSync(file), { code: "ENOENT" });
  for (const damaged of ["", "{", '{"providers":']) {
    writeFileSync(file, damaged);
    assert.deepEqual(readModelsConfig(file), { providers: {} });
    assert.equal(readFileSync(file, "utf8"), damaged);
  }
  for (const value of [null, [], "broken", 42, true]) {
    writeFileSync(file, JSON.stringify(value));
    assert.deepEqual(readModelsConfig(file), { providers: {} });
    assert.equal(readFileSync(file, "utf8"), JSON.stringify(value));
  }
  const valid = { providers: {}, custom: { nested: [1, "preserved"] } };
  writeFileSync(file, JSON.stringify(valid));
  assert.deepEqual(readModelsConfig(file), valid);
  const mutableRead = readModelsConfig(file);
  mutableRead.custom.nested.push("local edit");
  assert.deepEqual(readModelsConfig(file), valid);
  assert.equal(readFileSync(file, "utf8"), JSON.stringify(valid));
  writeFileSync(file, "{");
  assert.deepEqual(readModelsConfig(file), { providers: {} });
  const replacement = { providers: { replacement: { models: [] } } };
  writeFileSync(file, JSON.stringify(replacement));
  assert.deepEqual(readModelsConfig(file), replacement);
});

test("serialization failure does not create missing config directories", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "missing", "nested", "models.json");
  assert.throws(() => writeModelsConfig({ providers: {}, unsupported: 1n }, file), /BigInt/i);
  assert.deepEqual(readdirSync(root), []);
  assert.throws(() => writeModelsConfig({ providers: {}, callback: () => {} }, file));
  assert.deepEqual(readdirSync(root), []);
  const valid = { providers: { fixture: { models: [{ id: "first-save" }] } } };
  writeModelsConfig(valid, file);
  assert.deepEqual(readModelsConfig(file), valid);
  assert.deepEqual(readdirSync(join(root, "missing", "nested")), ["models.json"]);
});

test("serialization failure preserves an existing configuration", async (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  const original = '{\n  "providers": {}, "custom": "keep formatting"\n}\n';
  writeFileSync(file, original);
  let loads = 0;
  invalidateModelsCache();
  t.after(() => invalidateModelsCache());
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  assert.throws(() => writeModelsConfig({ providers: {}, unsupported: 1n }, file), /BigInt/i);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(readdirSync(root), ["models.json"]);
  const circular = { providers: {} };
  circular.self = circular;
  assert.throws(() => writeModelsConfig(circular, file), /circular/i);
  assert.equal(readFileSync(file, "utf8"), original);
  assert.throws(() => writeModelsConfig({ providers: {}, callback: () => {} }, file));
  assert.equal(readFileSync(file, "utf8"), original);
  assert.deepEqual(readdirSync(root), ["models.json"]);
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  assert.equal(loads, 1);
  const recovered = { providers: {}, custom: "recovered" };
  writeModelsConfig(recovered, file);
  assert.deepEqual(readModelsConfig(file), recovered);
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  assert.equal(loads, 2);
});

test("config path occupied by a directory falls back without touching its contents", (t) => {
  const root = createTempRoot(t);
  const config = join(root, "models.json");
  mkdirSync(config);
  const sentinel = join(config, "keep.txt");
  writeFileSync(sentinel, "preserve directory");
  assert.deepEqual(readModelsConfig(config), { providers: {} });
  assert.throws(() => writeModelsConfig({ providers: {} }, config));
  assert.deepEqual(readdirSync(root), ["models.json"]);
  assert.equal(statSync(config).isDirectory(), true);
  assert.equal(readFileSync(sentinel, "utf8"), "preserve directory");
});

test("config write rejects a parent path occupied by a file without modifying it", (t) => {
  const root = createTempRoot(t);
  const parent = join(root, "agent");
  writeFileSync(parent, "must remain a file");
  assert.throws(() => writeModelsConfig({ providers: {} }, join(parent, "models.json")));
  assert.equal(readFileSync(parent, "utf8"), "must remain a file");
  assert.deepEqual(readdirSync(root), ["agent"]);
  rmSync(parent);
  const recovered = { providers: { fixture: { models: [{ id: "recovered" }] } } };
  const configPath = join(parent, "models.json");
  writeModelsConfig(recovered, configPath);
  assert.deepEqual(readModelsConfig(configPath), recovered);
  assert.deepEqual(readdirSync(parent), ["models.json"]);
});

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    defaultThinkingLevel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
    thinkingLevelPins: {},
  };
}

test("saving models.json atomically invalidates the model-list cache", async (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [{ id: "acme-2" }],
      },
    },
  };
  let loads = 0;

  invalidateModelsCache();
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  writeModelsConfig(config, modelsPath);
  const reloaded = await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));

  assert.equal(loads, 2);
  assert.equal(reloaded.modelList[0].id, "load-2");
  assert.deepEqual(readModelsConfig(modelsPath), config);
  assert.deepEqual(readdirSync(join(root, "agent")), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(modelsPath).mode & 0o777, 0o600);
  }
});

test("failed config writes preserve the existing model cache", async (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  mkdirSync(modelsPath);
  let loads = 0;
  invalidateModelsCache();
  t.after(() => invalidateModelsCache());
  const first = await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  assert.throws(() => writeModelsConfig({ providers: {} }, modelsPath));
  const afterFailure = await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  assert.equal(loads, 1);
  assert.deepEqual(afterFailure, first);
});

test("normalized config does not share nested mutable data with the input", () => {
  const original = { providers: { fixture: { models: [{ id: "fixture", cost: { input: 1, custom: { unit: "tokens" } } }] } } };
  const result = normalizeModelsConfigCosts(original);
  result.providers.fixture.models[0].cost.custom.unit = "changed";
  result.providers.fixture.models.push({ id: "extra" });
  assert.equal(original.providers.fixture.models.length, 1);
  assert.equal(original.providers.fixture.models[0].cost.custom.unit, "tokens");
  assert.equal(original.providers.fixture.models[0].cost.output, undefined);
});

test("each individual cost field is preserved while missing fields become zero", () => {
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    for (const value of [0, 0.125]) {
      const config = { providers: { fixture: { models: [{ id: "fixture", cost: { [key]: value } }] } } };
      const result = normalizeModelsConfigCosts(config);
      assert.deepEqual(result.providers.fixture.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, [key]: value });
    }
  }
});

test("invalid cost values never serialize as null or contaminate valid models", (t) => {
  const root = createTempRoot(t);
  const file = join(root, "models.json");
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    for (const invalid of [NaN, Infinity, -Infinity, "1", null, false, [], {}]) {
      const config = { providers: { fixture: { models: [
        { id: "invalid", cost: { input: 2, [key]: invalid } },
        { id: "valid", cost: { input: 1 } },
      ] } } };
      writeModelsConfig(config, file);
      assert.deepEqual(readModelsConfig(file).providers.fixture.models, [
        { id: "invalid" },
        { id: "valid", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ]);
    }
  }
});

test("models.json writes fill partial cost groups with zero and remove empty groups", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        models: [
          { id: "empty-cost", cost: {} },
          { id: "zero-cost", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: "partial-cost", cost: { input: 1, output: 2, cacheRead: 0.1, custom: { unit: "tokens" } } },
          { id: "complete-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.1 } },
        ],
        modelOverrides: {
          inherited: { cost: { input: 3 } },
        },
      },
    },
  };

  const original = structuredClone(config);
  const normalized = normalizeModelsConfigCosts(config);
  assert.deepEqual(config, original);
  assert.deepEqual(normalizeModelsConfigCosts(normalized), normalized);
  assert.deepEqual(normalized.providers.acme.models, [
    { id: "empty-cost" },
    { id: "zero-cost", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: "partial-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, custom: { unit: "tokens" } } },
    { id: "complete-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.1 } },
  ]);
  assert.deepEqual(normalized.providers.acme.modelOverrides, {
    inherited: { cost: { input: 3 } },
  });
  assert.deepEqual(config.providers.acme.models[0], { id: "empty-cost", cost: {} });

  writeModelsConfig(config, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath), normalized);
  assert.deepEqual(config, original);
});

test("saving models.json drops blank model rows without hiding other schema errors", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");

  writeModelsConfig({
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1 } },
          { id: "" },
          { id: "  " },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  }, modelsPath);

  assert.deepEqual(readModelsConfig(modelsPath), {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  });
});

test("an existing session opens after its historical model is removed from config", (t) => {
  const root = createTempRoot(t);
  const sessionPath = join(root, "session.jsonl");
  const modelsPath = join(root, "models.json");
  const records = [
    {
      type: "session",
      version: 3,
      id: "existing-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "model_change",
      id: "model-old",
      parentId: null,
      provider: "retired-provider",
      modelId: "retired-model",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "message",
      id: "user-1",
      parentId: "model-old",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "keep this conversation" },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        provider: "retired-provider",
        model: "retired-model",
        content: [{ type: "text", text: "still readable" }],
      },
    },
  ];
  writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  writeModelsConfig({
    providers: {
      "retired-provider": {
        baseUrl: "https://retired.example.test/v1",
        api: "openai-completions",
        models: [{ id: "retired-model" }],
      },
    },
  }, modelsPath);
  const beforeChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.equal(beforeChange.messages[1].content[0].text, "still readable");

  writeModelsConfig({
    providers: {
      replacement: {
        baseUrl: "https://replacement.example.test/v1",
        api: "openai-completions",
        models: [{ id: "replacement-model" }],
      },
    },
  }, modelsPath);

  const afterChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.deepEqual(afterChange.entryIds, ["user-1", "assistant-1"]);
  assert.equal(afterChange.messages[0].content, "keep this conversation");
  assert.equal(afterChange.messages[1].content[0].text, "still readable");
});
