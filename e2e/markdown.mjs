// Run against an existing dev server; all session data is mocked, never persisted.
// PLAYWRIGHT_CHANNEL=chrome uses an installed browser instead of the bundled one.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const id = "mock-markdown-regression";
  const now = new Date().toISOString();
  const info = {
    id, path: "/mock/session.jsonl", cwd: "/mock", name: "Markdown regression fixture",
    created: now, modified: now, messageCount: 2, firstMessage: "Render fixture",
  };
  const content = "这是**重点。**后文\n\n`` `a\\`b` ``\n\n`code` 与 \\(x\\)\n\n"
    + "```text\nabc\n``` nope\n\\(x\\)\n```";
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/sessions") {
      return route.fulfill({ json: { sessions: [info], runningSessionIds: [], sessionListVersion: 1 } });
    }
    if (path === `/api/sessions/${id}`) {
      return route.fulfill({ json: {
        sessionId: id, filePath: info.path, info, leafId: "a", tree: [], totalActiveMs: 0,
        context: {
          messages: [
            { role: "user", content: "Render fixture", timestamp: Date.now() },
            {
              role: "assistant", content: [{ type: "text", text: content }], timestamp: Date.now(),
              provider: "test", model: "fixture", stopReason: "stop",
              usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
            },
          ],
          entryIds: ["u", "a"], oldestEntryId: "u", hasMore: false, thinkingLevel: "off", model: null,
        },
        stats: {
          totalMessages: 2, userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
        },
      } });
    }
    if (path === `/api/agent/${id}`) return route.fulfill({ json: { running: false } });
    if (path === "/api/agent/running") {
      return route.fulfill({ json: { runningSessionIds: [], sessionListVersion: 1 } });
    }
    // Never let fixture interactions write to the user's actual server state.
    if (route.request().method() !== "GET") return route.fulfill({ json: {} });
    return route.continue();
  });
  await page.goto(`${base}/?session=${id}`);
  await page.locator(".markdown-body strong").filter({ hasText: "重点。" }).waitFor();
  assert.equal(await page.locator(".markdown-body .katex").count(), 1, "only math outside code renders");
  const inline = await page.locator(".markdown-inline-code").allTextContents();
  assert.ok(inline.includes("`a\\`b`"), "legal multi-backtick span preserves literal content");
  assert.ok(inline.includes("code"));
  assert.ok((await page.locator(".markdown-body").allTextContents()).join("\n").includes("\\(x\\)"), "fenced source stays literal");
  assert.deepEqual(errors, []);
  console.log("PASS browser Markdown: CJK emphasis, literal backticks, code/math boundaries, no page errors");
} finally {
  await browser.close();
}
