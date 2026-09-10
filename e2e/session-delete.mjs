// Mocked browser regression: never deletes or edits real sessions.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
try {
  const page = await browser.newPage({ locale: "en-US" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const now = new Date().toISOString();
  const makeSession = (id, name, extra = {}) => ({
    id, name, path: `/mock/${id}.jsonl`, cwd: "/mock", created: now, modified: now,
    messageCount: 2, firstMessage: name, ...extra,
  });
  const parent = makeSession("mock-parent", "Cascade parent");
  const child = makeSession("mock-child", "Cascade child", {
    parentSessionId: parent.id,
    relation: { kind: "subagent", parentSessionId: parent.id, profile: "test", description: "Child", status: "completed" },
  });
  const grandchild = makeSession("mock-grandchild", "Cascade grandchild", {
    parentSessionId: child.id,
    relation: { kind: "subagent", parentSessionId: child.id, profile: "test", description: "Grandchild", status: "completed" },
  });
  const fork = makeSession("mock-fork", "Preserved fork", {
    parentSessionId: parent.id, relation: { kind: "fork", originSessionId: parent.id },
  });
  let sessions = [parent, child, grandchild, fork];
  const deletedRequests = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/sessions") {
      return route.fulfill({ json: { sessions, runningSessionIds: [], sessionListVersion: deletedRequests.length + 1 } });
    }
    if (path === "/api/agent/running") {
      return route.fulfill({ json: { runningSessionIds: [], sessionListVersion: deletedRequests.length + 1 } });
    }
    if (path === `/api/sessions/${parent.id}` && request.method() === "DELETE") {
      deletedRequests.push(parent.id);
      sessions = [{ ...fork, parentSessionId: undefined, relation: undefined }];
      return route.fulfill({ json: { ok: true, deletedIds: [parent.id, child.id, grandchild.id] } });
    }
    // No write request from this fixture may reach the actual server.
    if (request.method() !== "GET") return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto(base);
  const parentLabel = page.getByText(parent.name, { exact: true });
  await parentLabel.waitFor();
  await parentLabel.hover();
  const row = parentLabel.locator("xpath=ancestor::div[.//button[contains(@title, 'Shift')]][1]");
  await row.locator("button[title*='Shift']").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await parentLabel.waitFor({ state: "detached" });
  await page.getByText(fork.name, { exact: true }).waitFor();
  assert.deepEqual(deletedRequests, [parent.id]);
  await page.reload();
  await page.getByText(fork.name, { exact: true }).waitFor();
  assert.equal(await page.getByText(parent.name, { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS browser deletion: cascade response removes parent, preserves fork through refresh, no real writes");
} finally {
  await browser.close();
}
