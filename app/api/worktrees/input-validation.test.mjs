import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { DELETE } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test("valid force values never bypass the worktree authorization boundary", async (t) => {
  const original = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set(), expiresAt: Date.now() + 60000 };
  t.after(() => { globalThis.__piAllowedRootsCache = original; });
  for (const force of [undefined, false, true]) {
    const response = await DELETE(new Request("http://localhost/api/worktrees", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/fixture-not-authorized", path: "/fixture-never-remove", force }),
    }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Access denied" });
  }
});

test("worktree deletion rejects non-boolean force before authorization or removal", async () => {
  for (const force of ["false", "true", 0, 1, null, {}, []]) {
    const response = await DELETE(new Request("http://localhost/api/worktrees", {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: "/fixture-not-authorized", path: "/fixture-never-remove", force }),
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /force.*boolean/);
  }
});
