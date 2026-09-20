import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const { PUT } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test("session organization preserves 500 for real storage failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-org-failure-"));
  const blockedDirectory = join(root, "not-a-directory");
  await writeFile(blockedDirectory, "sentinel");
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = blockedDirectory;
  t.after(async () => {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(root, { recursive: true, force: true });
  });
  const response = await PUT(new Request("http://localhost/api/session-org", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectKey: "fixture", org: { pinned: [], folders: [], assignments: {}, collapsedFolders: [] } }),
  }));
  assert.equal(response.status, 500);
  assert.equal(typeof (await response.json()).error, "string");
  assert.equal(await readFile(blockedDirectory, "utf8"), "sentinel");
});

test("session organization rejects invalid JSON shapes without storage writes", async () => {
  for (const body of ["{", "null", "[]", "false", "42", '"project"']) {
    const response = await PUT(new Request("http://localhost/api/session-org", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body,
    }));
    assert.equal(response.status, 400, body);
    assert.match((await response.json()).error, /JSON/);
  }
});
