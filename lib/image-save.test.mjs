import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  extensionForMime,
  resolveImageSaveTarget,
  sanitizeImageFileName,
  validateSavedImageSize,
} = await jiti.import("./image-save.ts");

test("extensionForMime maps supported image types", () => {
  assert.equal(extensionForMime("image/png"), "png");
  assert.equal(extensionForMime("IMAGE/JPEG"), "jpg");
  assert.equal(extensionForMime("application/pdf"), undefined);
});

test("image MIME lookup rejects inherited object properties", () => {
  for (const mime of ["constructor", "__proto__", "toString"]) {
    assert.equal(extensionForMime(mime), undefined);
    assert.throws(() => resolveImageSaveTarget(process.cwd(), mime, "image"), /Unsupported/);
  }
});

test("sanitizeImageFileName avoids Windows device names", () => {
  for (const stem of ["CON", "prn", "AUX", "nul", "COM1", "com9", "LPT1", "lpt9"]) {
    assert.equal(sanitizeImageFileName(`${stem}.png`, "image/png"), `image-${stem}.png`);
  }
  assert.equal(sanitizeImageFileName("COM10.png", "image/png"), "COM10.png");
});

test("sanitizeImageFileName strips path segments and unsafe characters", () => {
  assert.equal(sanitizeImageFileName("..\\evil/../name.png", "image/png"), "name.png");
  assert.equal(sanitizeImageFileName("../../../etc/passwd", "image/png"), "passwd.png");
  assert.equal(sanitizeImageFileName("我的 壁纸!.png", "image/png"), "我的-壁纸.png");
  assert.equal(sanitizeImageFileName(undefined, "image/png"), undefined);
  assert.equal(sanitizeImageFileName("...", "image/png"), undefined);
});

test("image filenames reserve UTF-8 byte space for collision suffixes", () => {
  for (const stem of ["图".repeat(110), "a图".repeat(100), "a".repeat(200)]) {
    const name = sanitizeImageFileName(`${stem}.webp`, "image/webp");
    assert.ok(Buffer.byteLength(name, "utf8") + 37 <= 255);
    assert.ok(!name.includes("\uFFFD"));
    assert.equal(sanitizeImageFileName(name, "image/webp"), name);
  }
});

test("sanitizeImageFileName forces the extension to match the mime type", () => {
  assert.equal(sanitizeImageFileName("photo.txt", "image/png"), "photo.png");
  assert.equal(sanitizeImageFileName("photo.png", "image/png"), "photo.png");
});

test("resolveImageSaveTarget stays inside the generated-images directory", () => {
  const cwd = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
  const target = resolveImageSaveTarget(cwd, "image/png", "cat.png");
  assert.ok(target.filePath.includes("generated-images"));
  assert.equal(target.fileName, "cat.png");
  assert.ok(target.filePath.endsWith("cat.png"));

  const fallback = resolveImageSaveTarget(cwd, "image/png", undefined);
  assert.match(fallback.fileName, /^image-\d{8,14}\.png$/);

  // Path traversal via the file name cannot escape the directory.
  const traversal = resolveImageSaveTarget(cwd, "image/png", "..\\..\\system32\\evil.png");
  assert.ok(traversal.filePath.startsWith(target.directory));
  assert.ok(!traversal.filePath.replace(target.directory, "").includes(".."));

  assert.throws(() => resolveImageSaveTarget(cwd, "application/zip", "a.zip"), /Unsupported/);
});

test("validateSavedImageSize rejects empty and oversized payloads", () => {
  validateSavedImageSize(1);
  assert.throws(() => validateSavedImageSize(0), /empty/);
  assert.throws(() => validateSavedImageSize(21 * 1024 * 1024), /20MB/);
});
