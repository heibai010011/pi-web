// In-process HTTP regression suite with temporary session fixtures.
// Calls real route handlers without starting a Next server or browser.
// HTML export also exercises the SDK CLI child process, so spawning must be
// available. Browser/SSR coverage lives in e2e/run.mjs and component tests.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL(".", import.meta.url));
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-http-e2e-"));
const project = join(agentDir, "project");
const sessionDir = join(agentDir, "sessions", "e2e");
mkdirSync(project, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_PASSWORD = "";

const timestamp = "2026-08-23T00:00:00.000Z";
const LONG = "e2e-long-session";
const BRANCH = "e2e-branch-session";
const RICH = "e2e-rich-session";
const text = (i) => `E2E message ${String(i).padStart(4, "0")}`;
const ids = (start, end) => Array.from({ length: end - start }, (_, i) => `e${start + i}`);

function message(id, parentId, role, content) {
  return { type: "message", id, parentId, timestamp, message: { role, content } };
}
function writeSession(id, entries) {
  const header = { type: "session", version: 3, id, timestamp, cwd: project };
  writeFileSync(join(sessionDir, `2026-08-23T00-00-00-000Z_${id}.jsonl`),
    [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

const longEntries = Array.from({ length: 5000 }, (_, i) =>
  message(`e${i}`, i ? `e${i - 1}` : null, i % 2 ? "assistant" : "user", text(i)));
writeSession(LONG, longEntries);
writeSession(BRANCH, [
  message("root", null, "user", "Branch root"),
  message("old", "root", "assistant", "Inactive branch answer"),
  message("new", "root", "assistant", "Active branch answer"),
]);
const richEntries = [
  message("user", null, "user", "Render **E2E markdown**"),
  message("answer", "user", "assistant", [{ type: "text", text: "E2E final answer\n```js\nconsole.log('E2E code');\n```" }]),
];
Object.assign(richEntries.at(-1).message, { provider: "test", model: "E2E Model" });
writeSession(RICH, richEntries);

// Route handlers through jiti with @ alias, mirroring how Next resolves them.
const jiti = createJiti(join(root, "x.mjs"), {
  alias: { "@": root.replace(/[\\/]$/, "") },
  interopDefault: true,
  moduleCache: false,
});

const sessionsRoute = await jiti.import(join(root, "app/api/sessions/route.ts"));
const sessionDetail = await jiti.import(join(root, "app/api/sessions/[id]/route.ts"));
const sessionContext = await jiti.import(join(root, "app/api/sessions/[id]/context/route.ts"));

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(`PASS: ${name}`);
  } catch (error) {
    results.push(`FAIL: ${name} — ${error.message.split("\n")[0]}`);
    process.exitCode = 1;
  }
};

// ---- run.mjs assertions, verbatim semantics ----
const list = await sessionsRoute.GET(new Request("http://localhost/api/sessions"));
const listed = await list.json();
check("session catalogue lists all fixtures", () =>
  assert.deepEqual((listed.sessions ?? []).map((s) => s.id).sort(), [LONG, BRANCH, RICH].sort()));

const detail = await sessionDetail.GET(new Request(`http://localhost/api/sessions/${LONG}?deferThinking=1&deferMedia=1`), { params: Promise.resolve({ id: LONG }) });
const detailBody = await detail.json();
check("long session opens with exactly the last 50 entries", () => {
  assert.deepEqual(detailBody.context.entryIds, ids(4950, 5000));
  assert.equal(detailBody.context.messages.length, 50);
  assert.equal(detailBody.context.hasMore, true);
  assert.ok(JSON.stringify(detailBody).length < 100_000, "Detail transferred unbounded history");
});

const tailRes = await sessionContext.GET(new Request(`http://localhost/api/sessions/${LONG}/context?tail=50`), { params: Promise.resolve({ id: LONG }) });
const tail = await tailRes.json();
check("tail context returns the same 50-entry page", () => {
  assert.deepEqual(tail.context.entryIds, ids(4950, 5000));
  assert.equal(tail.context.messages.length, 50);
});

const branchRes = await sessionContext.GET(new Request(`http://localhost/api/sessions/${BRANCH}/context?leafId=old`), { params: Promise.resolve({ id: BRANCH }) });
const selectedBranch = await branchRes.json();
check("branch context follows the selected leaf", () =>
  assert.deepEqual(selectedBranch.context.entryIds, ["root", "old"]));

const rootPageRes = await sessionContext.GET(new Request(`http://localhost/api/sessions/${BRANCH}/context?before=old&tail=1`), { params: Promise.resolve({ id: BRANCH }) });
const rootPage = await rootPageRes.json();
check("pagination reaches the root and reports hasMore=false", () => {
  assert.deepEqual(rootPage.context.entryIds, ["root"]);
  assert.equal(rootPage.context.hasMore, false);
});

const beforeRootRes = await sessionContext.GET(new Request(`http://localhost/api/sessions/${BRANCH}/context?before=root`), { params: Promise.resolve({ id: BRANCH }) });
const beforeRoot = await beforeRootRes.json();
check("paging before the root yields an empty context", () => {
  assert.deepEqual(beforeRoot.context.entryIds, []);
  assert.equal(beforeRoot.context.hasMore, false);
});

const missing = await sessionDetail.GET(new Request("http://localhost/api/sessions/e2e-does-not-exist"), { params: Promise.resolve({ id: "e2e-does-not-exist" }) });
check("unknown session returns 404", () => assert.equal(missing.status, 404));

// ---- merged local features still intact ----
const richDetail = await sessionDetail.GET(new Request(`http://localhost/api/sessions/${RICH}`), { params: Promise.resolve({ id: RICH }) });
const richBody = await richDetail.json();
check("rich session detail returns 200 with messages", () => {
  assert.equal(richDetail.status, 200);
  assert.ok(Array.isArray(richBody.context?.messages) && richBody.context.messages.length >= 2,
    `messages: ${JSON.stringify(richBody).slice(0, 200)}`);
});
const richFlat = JSON.stringify(richBody);
check("code fence and model info survive load", () => {
  assert.ok(richFlat.includes("E2E code"), "code fence survives load");
  assert.ok(richFlat.includes("E2E Model"), "model display info survives load");
});

// ---- new upstream routes (v0.9.0) ----
const searchRoute = await jiti.import(join(root, "app/api/sessions/search/route.ts"));
const searchRes = await searchRoute.GET(new Request(`http://localhost/api/sessions/search?q=${encodeURIComponent("E2E message 0421")}`));
const searchBody = await searchRes.json();
check("session search finds the message in the long session", () => {
  assert.equal(searchRes.status, 200);
  assert.ok(searchBody.results?.some((r) => r.session?.id === LONG || r.sessionId === LONG),
    `results: ${JSON.stringify(searchBody).slice(0, 200)}`);
});

// ---- local feature: session-org route ----
const orgRoutePath = join(root, "app/api/session-org/route.ts");
try {
  const orgRoute = await jiti.import(orgRoutePath);
  const orgRes = await orgRoute.GET?.(new Request(`http://localhost/api/session-org?projectKey=${encodeURIComponent(project)}`));
  check("session-org route responds 200 with a projectKey", () => {
    assert.ok(orgRes, "GET handler exists");
    assert.equal(orgRes.status, 200, JSON.stringify(orgRes));
  });
} catch (error) {
  check("session-org route loads and runs", () => { throw error; });
}

// ---- export route (recursive-tree patch path) ----
try {
  const exportRoute = await jiti.import(join(root, "app/api/sessions/[id]/export/route.ts"));
  const response = await exportRoute.GET(new Request(`http://localhost/api/sessions/${LONG}/export`), {
    params: Promise.resolve({ id: LONG }),
  });
  const html = await response.text();
  check("long session exports HTML with iterative tree helpers and safe headers", () => {
    assert.equal(response.status, 200, html.slice(0, 1000));
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(response.headers.get("content-disposition"), /^attachment;/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'");
    const encodedData = html.match(/<script[^>]*id="session-data"[^>]*>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(encodedData, "export contains embedded session data");
    const sessionData = Buffer.from(encodedData.trim(), "base64").toString("utf8");
    assert.ok(sessionData.includes("E2E message 4999"), "export includes the latest entry");
    assert.ok(html.includes("function sortChildren(root)"));
  });
  const preview = await exportRoute.GET(new Request(`http://localhost/api/sessions/${BRANCH}/export?inline=1`), {
    params: Promise.resolve({ id: BRANCH }),
  });
  const previewHtml = await preview.text();
  check("inline session export preserves security headers and HTML", () => {
    assert.equal(preview.status, 200, previewHtml.slice(0, 1000));
    assert.match(preview.headers.get("content-disposition"), /^inline;/);
    assert.match(preview.headers.get("content-type"), /text\/html/);
    assert.equal(preview.headers.get("content-security-policy"), "frame-ancestors 'none'");
    assert.equal(preview.headers.get("x-frame-options"), "DENY");
    assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
    assert.ok(previewHtml.includes('id="session-data"'));
  });
  const missingExport = await exportRoute.GET(new Request("http://localhost/api/sessions/e2e-does-not-exist/export"), {
    params: Promise.resolve({ id: "e2e-does-not-exist" }),
  });
  const missingExportBody = await missingExport.json();
  check("unknown session export returns a JSON 404", () => {
    assert.equal(missingExport.status, 404);
    assert.deepEqual(missingExportBody, { error: "Session not found" });
  });
} catch (error) {
  check("export route loads and runs", () => { throw error; });
}

console.log(results.join("\n"));
rmSync(agentDir, { recursive: true, force: true });
