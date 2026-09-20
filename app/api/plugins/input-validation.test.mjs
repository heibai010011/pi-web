import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test("plugin mutations reject invalid scopes and types before filesystem authorization", async () => {
  const base = { action: "install", cwd: "/fixture-not-authorized", source: "fixture-never-install" };
  const bodies = ["{", "null", "[]", ...[
    ...["Project", "", null, false, 42, {}, []].map(scope => ({ ...base, scope })),
    ...[42, {}, null, ""].map(cwd => ({ ...base, cwd })),
    ...[42, {}, null, "unknown"].map(action => ({ ...base, action })),
    ...[42, {}, null, ""].map(source => ({ ...base, source })),
  ].map(JSON.stringify)];
  for (const body of bodies) {
    const response = await POST(new Request("http://localhost/api/plugins", {
      method: "POST", headers: { Host: "localhost", "Content-Type": "application/json" }, body,
    }));
    assert.equal(response.status, 400, body);
  }
});
