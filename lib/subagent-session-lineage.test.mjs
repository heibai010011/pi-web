import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { runWithSubagentParentSession } = await jiti.import("./subagent-session-lineage.ts");

function tempSessionDir() {
  return mkdtempSync(join(tmpdir(), "subagent-lineage-"));
}

test("persistent sessions created in parent prompt context inherit parentSession", async () => {
  const dir = tempSessionDir();
  try {
    const parent = join(dir, "parent.jsonl");
    const child = runWithSubagentParentSession(parent, () => SessionManager.create(dir, dir));
    assert.equal(child.getHeader()?.parentSession, parent);

    // AsyncLocalStorage must also follow delayed background subagent work.
    const delayed = await runWithSubagentParentSession(parent, () => new Promise((resolve) => {
      setTimeout(() => resolve(SessionManager.create(dir, dir)), 0);
    }));
    assert.equal(delayed.getHeader()?.parentSession, parent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary sessions stay roots and explicit lineage wins", () => {
  const dir = tempSessionDir();
  try {
    const ordinary = SessionManager.create(dir, dir);
    assert.equal(ordinary.getHeader()?.parentSession, undefined);

    const inherited = join(dir, "inherited.jsonl");
    const explicit = join(dir, "explicit.jsonl");
    const child = runWithSubagentParentSession(inherited, () => (
      SessionManager.create(dir, dir, { parentSession: explicit })
    ));
    assert.equal(child.getHeader()?.parentSession, explicit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
