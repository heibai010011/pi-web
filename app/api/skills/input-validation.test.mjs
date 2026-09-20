import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const { PATCH } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test("skill toggle preserves content and rejects invalid updates on an allowed file", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-skill-toggle-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { allowFileRoot } = await createJiti(import.meta.url).import("../../../lib/file-access.ts");
  allowFileRoot(cwd);
  const filePath = join(cwd, "SKILL.md");
  const original = "---\nname: fixture\ndescription: fixture skill\n---\n\nKeep this body.\n";
  await writeFile(filePath, original);
  const patch = value => PATCH(new Request("http://localhost/api/skills", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePath, disableModelInvocation: value }),
  }));
  assert.equal((await patch(true)).status, 200);
  const disabled = await readFile(filePath, "utf8");
  assert.match(disabled, /disable-model-invocation: true/);
  assert.ok(disabled.endsWith("\n\nKeep this body.\n"));
  for (const value of [undefined, null, "false", 0, {}, []]) {
    assert.equal((await patch(value)).status, 400);
    assert.equal(await readFile(filePath, "utf8"), disabled);
  }
  assert.equal((await patch(false)).status, 200);
  assert.equal(await readFile(filePath, "utf8"), original);
  for (const [content, value] of [
    ["---\n&config { name: fixture }\n---\nBody\n", true],
    ["---\nname: fixture\ndisable-model-invocation: >\n  extra\n---\nBody\n", false],
  ]) {
    await writeFile(filePath, content);
    const response = await patch(value);
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /unsupported frontmatter formatting/);
    assert.equal(await readFile(filePath, "utf8"), content);
  }
});

test("skill toggle rejects non-boolean values before looking up files", async () => {
  for (const value of [undefined, null, "false", 0, {}, []]) {
    const response = await PATCH(new Request("http://localhost/api/skills", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: "/fixture-never-modify/SKILL.md", disableModelInvocation: value }),
    }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /boolean/);
  }
});
