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

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./file-paths.ts");
}

test("encodeFilePathForApi keeps a UNC root inside the first segment", async () => {
  const { encodeFilePathForApi } = await loadSubject();
  // The catch-all route cannot carry a literal "//" prefix — URL routing
  // normalizes it away — so the root is folded into segment one as %2F%2Fhost.
  assert.equal(
    encodeFilePathForApi("\\\\192.0.2.1\\share\\dir"),
    "%2F%2F192.0.2.1/share/dir",
  );
  assert.equal(
    encodeFilePathForApi("//192.0.2.1/share/dir"),
    "%2F%2F192.0.2.1/share/dir",
  );
  assert.equal(
    encodeFilePathForApi("\\\\192.0.2.1\\share"),
    "%2F%2F192.0.2.1/share",
  );
});

test("encodeFilePathForApi encodes drive and POSIX paths per segment", async () => {
  const { encodeFilePathForApi } = await loadSubject();
  assert.equal(encodeFilePathForApi("D:\\repo\\a file.ts"), "D%3A/repo/a%20file.ts");
  assert.equal(encodeFilePathForApi("/tmp/a file.ts"), "tmp/a%20file.ts");
  assert.equal(encodeFilePathForApi("/tmp/dir/"), "tmp/dir");
});

test("getFileName and getFileDirectory handle UNC paths", async () => {
  const { getFileName, getFileDirectory } = await loadSubject();
  assert.equal(getFileName("\\\\host\\share\\dir\\file.ts"), "file.ts");
  assert.equal(getFileDirectory("\\\\host\\share\\dir\\file.ts"), "//host/share/dir");
  assert.equal(getFileDirectory("//host/share/dir"), "//host/share");
});

test("joinFilePath preserves the UNC root", async () => {
  const { joinFilePath } = await loadSubject();
  assert.equal(joinFilePath("\\\\host\\share\\dir", "child"), "//host/share/dir/child");
});

test("getRelativeFilePath strips a UNC cwd prefix", async () => {
  const { getRelativeFilePath } = await loadSubject();
  assert.equal(
    getRelativeFilePath("\\\\host\\share\\dir\\sub\\file.ts", "\\\\host\\share\\dir"),
    "sub/file.ts",
  );
});
