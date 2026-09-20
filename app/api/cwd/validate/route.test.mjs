import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, lstat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { projectIdentityKey } = await jiti.import("../../../../lib/project-identity.ts");

test("selecting a directory does not authorize its sibling", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-cwd-boundary-"));
  const cache = globalThis.__piAllowedRootsCache;
  const additional = globalThis.__piAdditionalAllowedRoots;
  t.after(async () => {
    globalThis.__piAllowedRootsCache = cache;
    globalThis.__piAdditionalAllowedRoots = additional;
    await rm(base, { recursive: true, force: true });
  });
  globalThis.__piAllowedRootsCache = { roots: new Set(), expiresAt: Date.now() + 60000 };
  globalThis.__piAdditionalAllowedRoots = new Set();
  const cwd = path.join(base, "selected");
  const sibling = path.join(base, "selected-extra");
  await mkdir(cwd);
  await mkdir(sibling);
  await writeFile(path.join(cwd, "file.txt"), "selected");
  await writeFile(path.join(sibling, "file.txt"), "private");
  for (const invalidCwd of [path.join(sibling, "file.txt"), path.join(base, "missing")]) {
    const invalid = await POST(new Request("http://localhost/api/cwd/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: invalidCwd }),
    }));
    assert.equal(invalid.status, 400);
    assert.equal(globalThis.__piAllowedRootsCache.roots.size, 0);
    assert.equal(globalThis.__piAdditionalAllowedRoots.size, 0);
  }
  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
  }));
  assert.equal(response.status, 200);
  const { getAllowedFileRoots, isFilePathAllowed, isExistingFilePathAllowed } = await jiti.import("../../../../lib/file-access.ts");
  const roots = await getAllowedFileRoots();
  const repeated = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
  }));
  assert.equal(repeated.status, 200);
  assert.equal(globalThis.__piAdditionalAllowedRoots.size, 1);
  assert.equal(roots.size, 1);
  for (const check of [isFilePathAllowed, isExistingFilePathAllowed]) {
    assert.equal(check(path.join(cwd, "file.txt"), roots), true);
    assert.equal(check(path.join(sibling, "file.txt"), roots), false);
  }
  const switched = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: sibling }),
  }));
  assert.equal(switched.status, 200);
  const updatedRoots = await getAllowedFileRoots();
  assert.equal(updatedRoots.size, 2);
  const failedSwitch = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: path.join(base, "still-missing") }),
  }));
  assert.equal(failedSwitch.status, 400);
  assert.equal((await getAllowedFileRoots()).size, 2);
  assert.equal(globalThis.__piAdditionalAllowedRoots.size, 2);
  const parentFile = path.join(base, "not-selected.txt");
  await writeFile(parentFile, "parent must remain private");
  for (const check of [isFilePathAllowed, isExistingFilePathAllowed]) {
    assert.equal(check(path.join(cwd, "file.txt"), updatedRoots), true);
    assert.equal(check(path.join(sibling, "file.txt"), updatedRoots), true);
    assert.equal(check(parentFile, updatedRoots), false);
  }
});

test("cwd validation expands platform home-directory shorthand", async () => {
  const inputs = process.platform === "win32" ? ["~", "~/", "~\\"] : ["~", "~/"];
  for (const cwd of inputs) {
    const response = await POST(new Request("http://localhost/api/cwd/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
    }));
    assert.equal(response.status, 200, cwd);
    assert.equal(path.resolve((await response.json()).cwd), path.resolve(os.homedir()));
  }
});

test("cwd validation resolves an explicitly relative dot path", async () => {
  const request = cwd => POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
  }));
  assert.equal(path.isAbsolute("."), false);
  const relative = await request(".");
  const absolute = await request(process.cwd());
  assert.equal(relative.status, 200);
  assert.equal(absolute.status, 200);
  const result = await relative.json();
  assert.equal(result.cwd, process.cwd());
  assert.deepEqual(result, await absolute.json());
});

test("cwd validation returns client errors for malformed request bodies", async () => {
  for (const body of ["{", "null", "[]", '"path"', "42", "true"]) {
    const response = await POST(new Request("http://localhost/api/cwd/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    }));
    assert.equal(response.status, 400, body);
    assert.match((await response.json()).error, /JSON/);
  }
});

test("cwd validation rejects missing, blank, and non-string fields", async () => {
  for (const cwd of [undefined, null, "", " \t\n", 0, true, {}, []]) {
    const response = await POST(new Request("http://localhost/api/cwd/validate", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
    }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Path is required");
  }
});

test("cwd validation handles embedded NUL paths as client errors", async () => {
  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: `${process.cwd()}\0ignored` }),
  }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /Directory does not exist/);
  assert.equal(body.success, undefined);
});

test("cwd validation rejects a regular file without altering it", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "pi-cwd-file-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = path.join(base, "fixture.txt");
  await writeFile(cwd, "preserve fixture");
  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd }),
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not a directory/);
  assert.equal(await readFile(cwd, "utf8"), "preserve fixture");
  const missing = path.join(base, "not-created");
  const missingResponse = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: missing }),
  }));
  assert.equal(missingResponse.status, 400);
  assert.match((await missingResponse.json()).error, /does not exist/);
  await assert.rejects(lstat(missing), { code: "ENOENT" });
});

test("validated cwd responses include server-resolved project identity", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-validate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    cwd,
    projectRoot: cwd,
    projectKey: projectIdentityKey(cwd),
  });
  const padded = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: ` \t${cwd}\n ` }),
  }));
  assert.equal(padded.status, 200);
  const normalized = await padded.json();
  assert.equal(normalized.cwd, cwd);
  assert.equal(normalized.projectKey, projectIdentityKey(cwd));
  const { getAllowedFileRoots, isFilePathAllowed, isExistingFilePathAllowed } = await jiti.import("../../../../lib/file-access.ts");
  const probe = path.join(cwd, "authorized.txt");
  await writeFile(probe, "authorization fixture");
  const roots = await getAllowedFileRoots();
  assert.equal(isFilePathAllowed(probe, roots), true);
  assert.equal(isExistingFilePathAllowed(probe, roots), true);
  const relative = path.relative(process.cwd(), cwd);
  const relativeResponse = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: relative }),
  }));
  assert.equal(relativeResponse.status, 200);
  const resolved = await relativeResponse.json();
  assert.equal(resolved.cwd, path.resolve(relative));
  assert.equal(resolved.projectKey, projectIdentityKey(cwd));
});
