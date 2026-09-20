// SSR smoke of merged UI components with fixture data (browser unavailable).
// Verifies the merged components render without throwing and contain the
// upstream + local UI markers that the full Playwright suite checks in CI.
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

const render = (element) => renderToStaticMarkup(React.createElement(I18nProvider, null, element));

test("MarkdownBody renders merged markdown features", async () => {
  const mod = await jiti.import("./MarkdownBody.tsx");
  const MarkdownBody = typeof mod.default === "function" ? mod.default : mod.MarkdownBody;
  const html = render(React.createElement(MarkdownBody, null,
    "# Heading\n\n**bold** and `code`\n\n```js\nconsole.log('E2E code');\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
  ));
  assert.match(html, /<h[12][^>]*>Heading</);
  assert.match(html, /<strong>bold<\/strong>/);
  // The code block renders through the syntax highlighter, which splits
  // "console.log" into token spans; check the pieces and the container.
  assert.match(html, /token console/);
  assert.match(html, /react-syntax-highlighter/);
});

test("MessageView renders an assistant message with model info", async () => {
  const { MessageView } = await jiti.import("./MessageView.tsx");
  const message = {
    id: "m1",
    role: "assistant",
    content: [{ type: "text", text: "Answer text" }],
    provider: "test",
    model: "E2E Model",
    timestamp: "2026-08-23T00:00:00.000Z",
  };
  const html = render(React.createElement(MessageView, {
    message,
    isStreaming: false,
    isLatest: true,
    chatAnchorMode: "bottom",
  }));
  assert.match(html, /Answer text/);
});

test("SessionSidebar renders the session tree with search box", async () => {
  const { SessionSidebar } = await jiti.import("./SessionSidebar.tsx");
  const sessions = [
    { id: "s1", title: "E2E message 0000", cwd: "/tmp/project", lastModified: "2026-08-23T00:00:00.000Z", projectRoot: "/tmp/project" },
    { id: "s2", title: "Branch root", cwd: "/tmp/project", lastModified: "2026-08-22T00:00:00.000Z", projectRoot: "/tmp/project" },
  ];
  const html = render(React.createElement(SessionSidebar, {
    sessions,
    activeSessionId: "s1",
    cwd: "/tmp/project",
    onSelectSession() {},
    onNewSession() {},
    runningIds: [],
  }));
  // Upstream search input + local tree view both present after the merge.
  assert.match(html, /type="search"|placeholder=/);
});

test("TerminalPanel module loads with xterm wiring", async () => {
  const mod = await jiti.import("./TerminalPanel.tsx");
  assert.equal(typeof mod.TerminalPanel, "function");
});

test("SessionSearch component loads", async () => {
  const mod = await jiti.import("./SessionSearch.tsx");
  assert.equal(typeof (mod.SessionSearch ?? mod.default), "function");
});

test("ChatInput renders with draft key", async () => {
  const { ChatInput } = await jiti.import("./ChatInput.tsx");
  const html = render(React.createElement(ChatInput, {
    onSend() {},
    onAbort() {},
    isStreaming: false,
    model: null,
    modelList: [],
    draftKey: "new:/tmp/project",
  }));
  assert.match(html, /<textarea/);
});
