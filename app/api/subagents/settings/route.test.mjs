import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-settings-route-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, PUT } = await jiti.import("./route.ts");

// Under `--test-isolation=none` every test file in the run mutates the one
// shared process.env at module init and hooks of other files run in between.
// Point the agent dir at THIS file's temp dir inside each test body (the
// only place whose timing is guaranteed) so the route always writes here.
function useOwnAgentDir() {
  process.env.PI_CODING_AGENT_DIR = testAgentDir;
}

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

function request(body, contentType = "application/json") {
  return new Request("http://localhost/api/subagents/settings", {
    method: "PUT",
    headers: { "Content-Type": contentType, Host: "localhost" },
    body: JSON.stringify(body),
  });
}

test("settings route defaults off and persists both switch states", async () => {
  useOwnAgentDir();
  let response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });

  response = await PUT(request({ enabled: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: true });
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "agents", "settings.json"), "utf8")),
    { version: 1, builtInEnabled: true },
  );

  response = await PUT(request({ enabled: false, version: 999, injectedSetting: { active: true } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
  assert.deepEqual(
    JSON.parse(await readFile(join(testAgentDir, "agents", "settings.json"), "utf8")),
    { version: 1, builtInEnabled: false },
  );
});

test("invalid JSON settings requests preserve the stored settings", async () => {
  useOwnAgentDir();
  assert.equal((await PUT(request({ enabled: true }))).status, 200);
  const settingsPath = join(testAgentDir, "agents", "settings.json");
  const before = await readFile(settingsPath, "utf8");
  for (const body of ["null", "{", "[]", '"enabled"', "true", "42"]) {
    const response = await PUT(new Request("http://localhost/api/subagents/settings", {
      method: "PUT", headers: { "Content-Type": "application/json", Host: "localhost" }, body,
    }));
    assert.equal(response.status, 400, body);
    assert.match((await response.json()).error, /JSON/);
    assert.equal(await readFile(settingsPath, "utf8"), before);
  }
});

test("settings route reports corrupt storage and recovers after repair", async (t) => {
  useOwnAgentDir();
  assert.equal((await PUT(request({ enabled: true }))).status, 200);
  const settingsPath = join(testAgentDir, "agents", "settings.json");
  const original = await readFile(settingsPath, "utf8");
  t.after(() => writeFile(settingsPath, original));
  await writeFile(settingsPath, "SENSITIVE_FIXTURE");
  const invalid = await PUT(request({ enabled: "true" }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "enabled must be a boolean" });
  assert.equal(await readFile(settingsPath, "utf8"), "SENSITIVE_FIXTURE");
  for (const response of [await GET(), await PUT(request({ enabled: false }))]) {
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(typeof body.error, "string");
    assert.doesNotMatch(body.error, /SENSITIVE/);
    assert.equal(Object.hasOwn(body, "enabled"), false);
    assert.equal(await readFile(settingsPath, "utf8"), "SENSITIVE_FIXTURE");
  }
  await writeFile(settingsPath, '{"builtInEnabled":true,"privateMetadata":{"fixture":"not-for-response"}}');
  assert.deepEqual(await (await GET()).json(), { enabled: true });
  const recovered = await PUT(request({ enabled: false }));
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { enabled: false });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    builtInEnabled: false, version: 1, privateMetadata: { fixture: "not-for-response" },
  });
});

test("settings route validates mutations", async () => {
  useOwnAgentDir();
  assert.equal((await PUT(request({ enabled: true }))).status, 200);
  const settingsPath = join(testAgentDir, "agents", "settings.json");
  const before = await readFile(settingsPath, "utf8");
  const untrusted = await PUT(new Request("http://localhost/api/subagents/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Host: "localhost", Origin: "https://untrusted.invalid" },
    body: JSON.stringify({ enabled: false }),
  }));
  assert.equal(untrusted.status, 403);
  assert.equal(await readFile(settingsPath, "utf8"), before);
  for (const enabled of [undefined, null, 0, 1, [], {}, "true"]) {
    const invalid = await PUT(request({ enabled }));
    assert.equal(invalid.status, 400);
    assert.equal(await readFile(settingsPath, "utf8"), before);
  }
  let response = await PUT(request({ enabled: "yes" }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "enabled must be a boolean" });

  response = await PUT(request({ enabled: false }, "text/plain"));
  assert.equal(response.status, 415);
  assert.deepEqual(await response.json(), { error: "Content-Type must be application/json" });
  assert.equal(await readFile(settingsPath, "utf8"), before);
});
