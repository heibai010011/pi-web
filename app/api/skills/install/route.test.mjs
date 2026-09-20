import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test("skill installation rejects invalid input before invoking installer", async () => {
  for (const body of ["{", "null", "[]", ...[
    { package: 42 },
    ...[null, {}, "Project", "", false].map(scope => ({ package: "fixture-never-install", scope })),
    ...[42, {}, " "].map(cwd => ({ package: "fixture-never-install", scope: "project", cwd })),
  ].map(JSON.stringify)]) {
    const response = await POST(new Request("http://localhost/api/skills/install", {
      method: "POST", headers: { Host: "localhost", "Content-Type": "application/json" }, body,
    }));
    assert.equal(response.status, 400, body);
  }
});
