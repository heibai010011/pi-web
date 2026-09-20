import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  isBuiltInSubagentsEnabled,
  readSubagentSettings,
  writeBuiltInSubagentsEnabled,
} = await createJiti(import.meta.url).import("./subagent-settings.ts");

test("settings save replaces the target without rewriting its hard-link alias", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  const alias = join(root, "original.json");
  const original = '{"builtInEnabled":false,"custom":1}';
  await writeFile(settingsPath, original);
  await link(settingsPath, alias);
  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  assert.equal(isBuiltInSubagentsEnabled(alias), false);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { builtInEnabled: true, custom: 1, version: 1 });
  assert.equal(await readFile(alias, "utf8"), original);
  await writeFile(alias, '{"builtInEnabled":false,"external":true}');
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { builtInEnabled: true, custom: 1, version: 1 });
  assert.deepEqual((await readdir(root)).sort(), ["original.json", "settings.json"]);
  await rm(alias);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  writeBuiltInSubagentsEnabled(false, settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { builtInEnabled: false, custom: 1, version: 1 });
  assert.deepEqual(await readdir(root), ["settings.json"]);
});

test("settings writer rejects nonboolean inputs before filesystem mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "missing", "settings.json");
  const unsafeInput = { toJSON() { throw new Error("serialization hook must not run"); } };
  assert.throws(() => writeBuiltInSubagentsEnabled(unsafeInput, settingsPath), /must be a boolean/);
  assert.deepEqual(await readdir(root), []);
  for (const value of [undefined, null, "true", 1, [], {}, 1n, Symbol("fixture"), () => true]) {
    assert.throws(() => writeBuiltInSubagentsEnabled(value, settingsPath), /must be a boolean/);
    assert.deepEqual(await readdir(root), []);
  }
  writeBuiltInSubagentsEnabled(true, settingsPath);
  const before = await readFile(settingsPath, "utf8");
  for (const value of [undefined, null, "false", 0, [], {}, 0n, Symbol("fixture"), () => false]) {
    assert.throws(() => writeBuiltInSubagentsEnabled(value, settingsPath), /must be a boolean/);
    assert.equal(await readFile(settingsPath, "utf8"), before);
  }
  writeBuiltInSubagentsEnabled(false, settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  await writeFile(settingsPath, "broken fixture");
  assert.throws(() => writeBuiltInSubagentsEnabled("true", settingsPath), /must be a boolean/);
  assert.equal(await readFile(settingsPath, "utf8"), "broken fixture");
});

test("settings updates preserve special own keys as ordinary JSON data", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  const original = JSON.parse('{"__proto__":{"fixture":true,"builtInEnabled":true},"constructor":{"custom":1},"toString":"metadata"}');
  await writeFile(settingsPath, JSON.stringify(original));
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false });
  writeBuiltInSubagentsEnabled(true, settingsPath);
  const stored = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(stored, { ...original, version: 1, builtInEnabled: true });
  assert.equal(Object.hasOwn(stored, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(stored), Object.prototype);
  assert.equal(stored.fixture, undefined);
  writeBuiltInSubagentsEnabled(false, settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { ...original, version: 1, builtInEnabled: false });
});

test("subagent settings default the built-in extension to disabled", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(writeBuiltInSubagentsEnabled(false, settingsPath), { builtInEnabled: false });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, builtInEnabled: false });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
});

test("a file occupying the settings parent is preserved on save failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "agents");
  const settingsPath = join(parent, "settings.json");
  await writeFile(parent, "keep parent file");
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  for (const enabled of [false, true]) {
    assert.throws(() => writeBuiltInSubagentsEnabled(enabled, settingsPath));
    assert.equal(await readFile(parent, "utf8"), "keep parent file");
    assert.deepEqual(await readdir(root), ["agents"]);
  }
  await rm(parent);
  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, builtInEnabled: true });
  assert.deepEqual(await readdir(parent), ["settings.json"]);
});

test("independent settings paths never share enabled state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first.json");
  const second = join(root, "second.json");
  writeBuiltInSubagentsEnabled(true, first);
  writeBuiltInSubagentsEnabled(false, second);
  const unchanged = await readFile(second, "utf8");
  assert.equal(isBuiltInSubagentsEnabled(first), true);
  assert.equal(isBuiltInSubagentsEnabled(second), false);
  writeBuiltInSubagentsEnabled(false, first);
  assert.equal(isBuiltInSubagentsEnabled(first), false);
  assert.equal(await readFile(second, "utf8"), unchanged);
  writeBuiltInSubagentsEnabled(true, second);
  assert.equal(isBuiltInSubagentsEnabled(first), false);
  assert.equal(isBuiltInSubagentsEnabled(second), true);
  const secondBefore = await readFile(second, "utf8");
  await writeFile(first, "{");
  assert.equal(isBuiltInSubagentsEnabled(first), false);
  assert.equal(isBuiltInSubagentsEnabled(second), true);
  assert.equal(await readFile(second, "utf8"), secondBefore);
});

test("mutating returned settings does not alter persisted or subsequent state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  const saved = writeBuiltInSubagentsEnabled(true, settingsPath);
  const before = await readFile(settingsPath, "utf8");
  saved.builtInEnabled = false;
  const loaded = readSubagentSettings(settingsPath);
  assert.equal(loaded.builtInEnabled, true);
  loaded.builtInEnabled = false;
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  assert.equal(await readFile(settingsPath, "utf8"), before);
});

test("subagent settings persist both states and preserve unrelated fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agents", "settings.json");

  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: true });
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  const first = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(first, { version: 1, builtInEnabled: true });

  const futureSetting = { profiles: [{ name: "中文", enabled: false }], extra: { value: null, count: 3 } };
  await writeFile(settingsPath, JSON.stringify({ ...first, futureSetting }));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  const second = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(second, { version: 1, builtInEnabled: false, futureSetting });
  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, builtInEnabled: true, futureSetting });
  const stable = await readFile(settingsPath, "utf8");
  for (let i = 0; i < 3; i++) {
    writeBuiltInSubagentsEnabled(true, settingsPath);
    assert.equal(await readFile(settingsPath, "utf8"), stable);
    assert.deepEqual(await readdir(join(root, "agents")), ["settings.json"]);
  }
  const external = { version: 1, builtInEnabled: true, externalRevision: 2 };
  await writeFile(settingsPath, JSON.stringify(external));
  writeBuiltInSubagentsEnabled(false, settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { ...external, builtInEnabled: false });
});

test("only literal true enables subagents and nonobject settings stay untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  for (const value of [false, null, 0, 1, "true", [], {}, true]) {
    await writeFile(settingsPath, JSON.stringify({ builtInEnabled: value, metadata: { preserved: true } }));
    assert.equal(isBuiltInSubagentsEnabled(settingsPath), value === true);
    assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: value === true });
    for (const enabled of [false, true]) {
      await writeFile(settingsPath, JSON.stringify({ builtInEnabled: value, metadata: { preserved: true } }));
      writeBuiltInSubagentsEnabled(enabled, settingsPath);
      assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: enabled });
      assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { builtInEnabled: enabled, version: 1, metadata: { preserved: true } });
    }
  }
  for (const value of [null, [], true, 42, "enabled"]) {
    const original = JSON.stringify(value);
    await writeFile(settingsPath, original);
    assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
    assert.throws(() => readSubagentSettings(settingsPath), /expected an object/);
    for (const enabled of [false, true]) {
      assert.throws(() => writeBuiltInSubagentsEnabled(enabled, settingsPath), /expected an object/);
      assert.equal(await readFile(settingsPath, "utf8"), original);
    }
  }
});

test("removing enabled settings immediately disables and allows explicit recreation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  await rm(settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.deepEqual(readSubagentSettings(settingsPath), { builtInEnabled: false });
  await assert.rejects(readFile(settingsPath), { code: "ENOENT" });
  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, builtInEnabled: true });
});

test("a directory at the settings path fails closed without modifying its contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await mkdir(settingsPath);
  const sentinel = join(settingsPath, "keep.txt");
  await writeFile(sentinel, "unchanged");
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
  assert.throws(() => readSubagentSettings(settingsPath));
  assert.throws(() => writeBuiltInSubagentsEnabled(true, settingsPath));
  assert.equal(await readFile(sentinel, "utf8"), "unchanged");
  assert.deepEqual(await readdir(root), ["settings.json"]);
  await rm(settingsPath, { recursive: true });
  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { version: 1, builtInEnabled: true });
  assert.deepEqual(await readdir(root), ["settings.json"]);
});

test("damaged settings fail closed and are not overwritten", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  writeBuiltInSubagentsEnabled(true, settingsPath);
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  for (const damaged of ["{", "", " \t\r\n", '{"builtInEnabled":true} trailing', '{"builtInEnabled":true}{}']) {
    await writeFile(settingsPath, damaged);
    assert.equal(isBuiltInSubagentsEnabled(settingsPath), false);
    assert.throws(() => readSubagentSettings(settingsPath));
    for (const enabled of [false, true]) {
      assert.throws(() => writeBuiltInSubagentsEnabled(enabled, settingsPath));
      assert.equal(await readFile(settingsPath, "utf8"), damaged);
    }
  }
  await writeFile(settingsPath, ' \t\r\n{"builtInEnabled":true,"repaired":true}\r\n\t ');
  assert.equal(isBuiltInSubagentsEnabled(settingsPath), true);
  writeBuiltInSubagentsEnabled(false, settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { builtInEnabled: false, repaired: true, version: 1 });
});
