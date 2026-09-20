import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { writePrivateFileAtomicSync } = await import("./atomic-file.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-atomic-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomic replacement supports long valid destination basenames", (t) => {
  const root = createTempRoot(t);
  const names = ["a".repeat(250) + ".json", "中".repeat(83) + ".json"];
  for (const name of names) {
    const destination = path.toNamespacedPath(path.join(root, name));
    writePrivateFileAtomicSync(destination, "original");
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    writePrivateFileAtomicSync(destination, "replacement");
    assert.equal(fs.readFileSync(destination, "utf8"), "replacement");
  }
  assert.deepEqual(fs.readdirSync(root).sort(), names.sort());
});

for (const [label, name, error] of [
  ["overlong", "a".repeat(256), undefined],
  ["NUL-containing", "invalid\u0000.json", { code: "ERR_INVALID_ARG_VALUE" }],
  ["NUL-containing parent", path.join("invalid\u0000", "config.json"), { code: "ERR_INVALID_ARG_VALUE" }],
]) {
  test(`atomic write rejects ${label} destinations without collateral changes`, (t) => {
    const root = createTempRoot(t);
    const sentinel = path.join(root, "keep.txt");
    fs.writeFileSync(sentinel, "unchanged");
    const destination = path.toNamespacedPath(path.join(root, name));
    assert.throws(() => writePrivateFileAtomicSync(destination, "must fail"), error);
    assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
    assert.deepEqual(fs.readdirSync(root), ["keep.txt"]);
    const validDestination = path.join(root, "recovered.json");
    writePrivateFileAtomicSync(validDestination, "recovered");
    assert.equal(fs.readFileSync(validDestination, "utf8"), "recovered");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
    assert.deepEqual(fs.readdirSync(root).sort(), ["keep.txt", "recovered.json"]);
  });
}

test("atomic replacement preserves unrelated temporary-looking sibling files", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  const siblings = [".models.json-user.tmp", ".pi-atomic-user.tmp"];
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  for (const name of siblings) fs.writeFileSync(path.join(root, name), bytes);
  writePrivateFileAtomicSync(destination, "first");
  writePrivateFileAtomicSync(destination, "second");
  for (const name of siblings) assert.deepEqual(fs.readFileSync(path.join(root, name)), bytes);
  assert.equal(fs.readFileSync(destination, "utf8"), "second");
  assert.deepEqual(fs.readdirSync(root).sort(), [...siblings, "models.json"].sort());
});

test("atomically replaces a file with restrictive permissions", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.writeFileSync(destination, "old", { mode: 0o644 });

  writePrivateFileAtomicSync(destination, "new");

  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test("atomic writes support Windows namespaced destination paths", { skip: process.platform !== "win32" }, (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "config.json");
  for (const contents of ["initial", "updated"]) {
    writePrivateFileAtomicSync(path.toNamespacedPath(destination), contents);
    assert.equal(fs.readFileSync(destination, "utf8"), contents);
    assert.deepEqual(fs.readdirSync(root), ["config.json"]);
  }
  fs.unlinkSync(destination);
  fs.mkdirSync(destination);
  const sentinel = path.join(destination, "keep.txt");
  fs.writeFileSync(sentinel, "unchanged");
  assert.throws(() => writePrivateFileAtomicSync(path.toNamespacedPath(destination), "must fail"));
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged");
  assert.deepEqual(fs.readdirSync(root), ["config.json"]);
});

test("atomic replacements preserve UTF-8 bytes and never retain old suffixes", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "配置.json");
  fs.writeFileSync(destination, "old suffix ".repeat(100));
  for (const content of ["中文 🚀\r\n", "x", "", "restored"]) {
    writePrivateFileAtomicSync(destination, content);
    assert.deepEqual(fs.readFileSync(destination), Buffer.from(content, "utf8"));
    assert.deepEqual(fs.readdirSync(root), ["配置.json"]);
  }
});

test("atomic writes handle special characters in parent and destination names", (t) => {
  const root = createTempRoot(t);
  const parent = path.join(root, "目录 # 100%");
  fs.mkdirSync(parent);
  const destination = path.join(parent, "配置 #%.json");
  for (const contents of ["initial", "replacement"]) {
    writePrivateFileAtomicSync(destination, contents);
    assert.equal(fs.readFileSync(destination, "utf8"), contents);
    assert.deepEqual(fs.readdirSync(parent), ["配置 #%.json"]);
  }
});

test("atomic writes through a linked parent replace the real destination cleanly", (t) => {
  const root = createTempRoot(t);
  const real = path.join(root, "real");
  const alias = path.join(root, "alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  const destination = path.join(alias, "config.json");
  fs.writeFileSync(path.join(real, "config.json"), "original");
  writePrivateFileAtomicSync(destination, "replacement");
  assert.equal(fs.readFileSync(path.join(real, "config.json"), "utf8"), "replacement");
  assert.equal(fs.readFileSync(destination, "utf8"), "replacement");
  assert.deepEqual(fs.readdirSync(real), ["config.json"]);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  fs.rmSync(real, { recursive: true });
  assert.throws(() => writePrivateFileAtomicSync(destination, "must fail"));
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.equal(fs.existsSync(real), false);
  assert.deepEqual(fs.readdirSync(root), ["alias"]);
  fs.mkdirSync(real);
  writePrivateFileAtomicSync(destination, "restored target");
  assert.equal(fs.readFileSync(path.join(real, "config.json"), "utf8"), "restored target");
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(real), ["config.json"]);
});

test("missing parent fails without side effects and succeeds after caller creates it", (t) => {
  const root = createTempRoot(t);
  const parent = path.join(root, "missing");
  const destination = path.join(parent, "config.json");
  assert.throws(() => writePrivateFileAtomicSync(destination, "first"), { code: "ENOENT" });
  assert.deepEqual(fs.readdirSync(root), []);
  fs.mkdirSync(parent);
  writePrivateFileAtomicSync(destination, "recovered");
  assert.equal(fs.readFileSync(destination, "utf8"), "recovered");
  assert.deepEqual(fs.readdirSync(parent), ["config.json"]);
});

test("keeps the destination and removes the temporary file when replacement fails", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.mkdirSync(destination);
  const sentinel = path.join(destination, "keep.txt");
  fs.writeFileSync(sentinel, "preserve contents");

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"));
  assert.equal(fs.statSync(destination).isDirectory(), true);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "preserve contents");
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
  fs.rmSync(destination, { recursive: true });
  writePrivateFileAtomicSync(destination, "recovered");
  assert.equal(fs.readFileSync(destination, "utf8"), "recovered");
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
});
