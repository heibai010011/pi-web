import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

test("exclusive temporary file collision never deletes the existing file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-atomic-collision-"));
  try {
    const destination = path.join(root, "models.json");
    const collision = path.join(root, ".pi-atomic-fixed.tmp");
    fs.writeFileSync(destination, "original");
    fs.writeFileSync(collision, "other writer");
    const source = fs.readFileSync(new URL("./atomic-file.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const exports = {};
    let failRename = false;
    let failWrite = false;
    let failCleanup = false;
    let recreateTemp = false;
    const renameError = Object.assign(new Error("fixture rename collision"), { code: "EEXIST", syscall: "rename", path: collision });
    const writeError = Object.assign(new Error("fixture disk full"), { code: "ENOSPC", syscall: "write", path: collision });
    vm.runInNewContext(compiled, { exports, require: name => {
      if (name === "crypto") return { randomUUID: () => "fixed" };
      if (name === "fs") return { ...fs, writeFileSync: (file, contents, options) => {
        assert.equal(options.flag, "wx");
        assert.equal(options.mode, 0o600);
        assert.equal(options.flush, true);
        assert.equal(options.encoding, "utf8");
        assert.equal(path.dirname(file), path.dirname(destination));
        assert.notEqual(file, destination);
        fs.writeFileSync(file, failWrite ? "partial" : contents, options);
        if (failWrite) throw writeError;
      }, unlinkSync: file => {
        if (failCleanup) throw Object.assign(new Error("fixture cleanup denied"), { code: "EACCES" });
        return fs.unlinkSync(file);
      }, renameSync: (...args) => {
        assert.equal(args[0], collision);
        assert.equal(args[1], destination);
        if (failRename) {
          assert.ok(["new", "first rename"].includes(fs.readFileSync(args[0], "utf8")));
          if (fs.existsSync(destination)) assert.equal(fs.readFileSync(destination, "utf8"), "original");
          throw renameError;
        }
        fs.renameSync(...args);
        if (recreateTemp) fs.writeFileSync(args[0], "next writer", { flag: "wx" });
      } };
      if (name === "path") return path;
      throw new Error(`Unexpected import ${name}`);
    } });
    assert.throws(() => exports.writePrivateFileAtomicSync(destination, "new"), { code: "EEXIST" });
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    assert.equal(fs.readFileSync(collision, "utf8"), "other writer");
    fs.unlinkSync(collision);
    fs.mkdirSync(collision);
    const sentinel = path.join(collision, "keep.txt");
    fs.writeFileSync(sentinel, "directory owner");
    assert.throws(() => exports.writePrivateFileAtomicSync(destination, "new"));
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    assert.equal(fs.readFileSync(sentinel, "utf8"), "directory owner");
    fs.rmSync(collision, { recursive: true });
    fs.linkSync(destination, collision);
    assert.throws(() => exports.writePrivateFileAtomicSync(destination, "must not overwrite"), { code: "EEXIST" });
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    assert.equal(fs.readFileSync(collision, "utf8"), "original");
    fs.unlinkSync(collision);
    failRename = true;
    assert.throws(() => exports.writePrivateFileAtomicSync(destination, "new"), error => error === renameError);
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(root), ["models.json"]);
    failRename = false;
    failWrite = true;
    assert.throws(() => exports.writePrivateFileAtomicSync(destination, "new"), error => error === writeError);
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    assert.deepEqual(fs.readdirSync(root), ["models.json"]);
    failCleanup = true;
    assert.throws(() => exports.writePrivateFileAtomicSync(destination, "new"), error => error === writeError);
    assert.equal(fs.readFileSync(destination, "utf8"), "original");
    assert.equal(fs.readFileSync(collision, "utf8"), "partial");
    failCleanup = false;
    fs.unlinkSync(collision);
    fs.unlinkSync(destination);
    assert.throws(() => exports.writePrivateFileAtomicSync(destination, "first creation"), error => error === writeError);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(root), []);
    failWrite = false;
    failRename = true;
    assert.throws(() => exports.writePrivateFileAtomicSync(destination, "first rename"), error => error === renameError);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(root), []);
    failRename = false;
    exports.writePrivateFileAtomicSync(destination, "recovered");
    assert.equal(fs.readFileSync(destination, "utf8"), "recovered");
    recreateTemp = true;
    failCleanup = true;
    assert.doesNotThrow(() => exports.writePrivateFileAtomicSync(destination, "committed"));
    assert.equal(fs.readFileSync(destination, "utf8"), "committed");
    assert.equal(fs.readFileSync(collision, "utf8"), "next writer");
    fs.unlinkSync(collision);
    assert.deepEqual(fs.readdirSync(root), ["models.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
