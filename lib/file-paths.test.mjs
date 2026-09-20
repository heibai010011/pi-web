import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { getRelativeFilePath, getFileDirectory, encodeFilePathForApi, joinFilePath } = await jiti.import("./file-paths.ts");
const { filePathFromApiSegments } = await jiti.import("./paths.ts");

test("directory helpers tolerate repeated trailing separators", () => {
  for (const [cwd, full] of [
    ["/project///", "/project/file.ts"],
    ["C:/project///", "C:/project/file.ts"],
    ["//server/share///", "//server/share/file.ts"],
    ["///", "/file.ts"], ["C:///", "C:/file.ts"],
  ]) {
    assert.equal(getRelativeFilePath(full, cwd), "file.ts", cwd);
    assert.equal(joinFilePath(cwd, "file.ts"), full, cwd);
  }
});

test("file API encoding preserves UNC paths through decoded route segments", () => {
  for (const [input, expected] of [
    ["\\\\server\\share\\目录\\a #%.png", "//server/share/目录/a #%.png"],
    ["//server/share/file.png", "//server/share/file.png"],
    ["C:\\project\\a #%.png", "C:/project/a #%.png"],
    ["/tmp/a #%.png", "/tmp/a #%.png"],
    ["C:/", "C:/"],
  ]) {
    const encoded = encodeFilePathForApi(input);
    assert.ok(!encoded.includes("//"), "URL must not contain repeated slashes");
    const segments = encoded.split("/").map(decodeURIComponent);
    assert.equal(filePathFromApiSegments(segments), expected, input);
  }
});

test("file directory traversal preserves filesystem roots", () => {
  for (const [input, expected] of [
    ["/", "/"], ["///", "/"], ["C:/", "C:/"], ["C:\\", "C:/"],
    ["//server/share/", "//server/share"], ["//server/share", "//server/share"],
    ["//server/share/folder", "//server/share"], ["/folder/", "/"],
    ["C:/folder/file.ts", "C:/folder"], ["file.ts", ""],
  ]) {
    assert.equal(getFileDirectory(input), expected, input);
  }
});

test("relative Windows file paths ignore drive and directory casing", () => {
  assert.equal(getRelativeFilePath("c:\\PROJECT\\Src\\File.ts", "C:\\project"), "Src/File.ts");
  assert.equal(getRelativeFilePath("C:/Project/Src/File.ts", "c:/project/"), "Src/File.ts");
  assert.equal(getRelativeFilePath("\\\\SERVER\\Share\\Folder\\File.ts", "\\\\server\\share\\folder"), "File.ts");
  assert.equal(getRelativeFilePath("//SERVER/Share/Folder/File.ts", "//server/share/folder/"), "File.ts");
});

test("relative file paths preserve POSIX casing and directory boundaries", () => {
  assert.equal(getRelativeFilePath("/Project/File.ts", "/project"), "/Project/File.ts");
  assert.equal(getRelativeFilePath("/project/File.ts", "/project/"), "File.ts");
  assert.equal(getRelativeFilePath("C:/project-other/File.ts", "c:/project"), "C:/project-other/File.ts");
  assert.equal(getRelativeFilePath("/file.ts", "/"), "file.ts");
  assert.equal(getRelativeFilePath("C:/File.ts", "c:/"), "File.ts");
  assert.equal(getRelativeFilePath("relative/File.ts"), "relative/File.ts");
});
