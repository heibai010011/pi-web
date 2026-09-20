import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { POST } = await jiti.import("./route.ts");

function request(body) {
  return new Request("http://localhost/api/images/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("image save route preserves valid PNG bytes and avoids filename collisions", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-save-success-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
  allowFileRoot(cwd);
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWHsAAAAASUVORK5CYII=";
  const saved = [];
  for (let index = 0; index < 2; index++) {
    const response = await POST(request(JSON.stringify({ cwd, data, mimeType: "image/png", fileName: "我的图片.txt" })));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.path, join(cwd, "generated-images", body.fileName));
    assert.match(body.fileName, /^我的图片(?:-[\da-f-]+)?\.png$/);
    assert.deepEqual(await readFile(body.path), Buffer.from(data, "base64"));
    saved.push(body.path);
  }
  assert.notEqual(saved[0], saved[1]);
  assert.equal((await readdir(join(cwd, "generated-images"))).length, 2);
});

test("image save denies a valid request outside the allowed roots", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-save-denied-"));
  const original = globalThis.__piAllowedRootsCache;
  t.after(async () => {
    globalThis.__piAllowedRootsCache = original;
    await rm(cwd, { recursive: true, force: true });
  });
  // Isolate authorization from the developer's real session roots.
  globalThis.__piAllowedRootsCache = { roots: new Set(), expiresAt: Date.now() + 60_000 };
  const response = await POST(request(JSON.stringify({ cwd, data: "AA==", mimeType: "image/png" })));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Access denied" });
  assert.deepEqual(await readdir(cwd), []);
});

test("image save rejects oversized decoded data before creating files", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-save-size-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
  allowFileRoot(cwd);
  // Every four unpadded base64 characters decode to three bytes.
  const data = "AAAA".repeat(Math.floor((20 * 1024 * 1024) / 3) + 1);
  const response = await POST(request(JSON.stringify({ cwd, data, mimeType: "image/png" })));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /20MB/);
  assert.deepEqual(await readdir(cwd), []);
});

test("image save rejects malformed base64 without writing files", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-save-base64-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { allowFileRoot } = await jiti.import("../../../../lib/file-access.ts");
  allowFileRoot(cwd);
  for (const data of ["aGVsbG8=!!!", "a=GVsbG8", "data:image/png;base64,AA==", "===="]) {
    const response = await POST(request(JSON.stringify({ cwd, data, mimeType: "image/png" })));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /base64/i);
  }
  assert.deepEqual(await readdir(cwd), []);
});

test("image save rejects malformed JSON with a client error", async () => {
  const response = await POST(request("{"));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Invalid JSON/);
});

test("image save rejects non-object JSON without throwing", async () => {
  for (const value of [null, [], "image", 42, true]) {
    const response = await POST(request(JSON.stringify(value)));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON object/);
  }
});

test("image save validates required fields before filesystem access", async () => {
  for (const [body, field] of [
    [{}, "cwd"],
    [{ cwd: 123 }, "cwd"],
    [{ cwd: "/project" }, "data"],
    [{ cwd: "/project", data: "AA==" }, "mimeType"],
  ]) {
    const response = await POST(request(JSON.stringify(body)));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.includes(field));
  }
});
