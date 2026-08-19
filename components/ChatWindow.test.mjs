import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = {
  chatWindow: readFileSync(path.join(here, "ChatWindow.tsx"), "utf8"),
  chatInput: readFileSync(path.join(here, "ChatInput.tsx"), "utf8"),
  useAgentSession: readFileSync(path.join(here, "..", "hooks", "useAgentSession.ts"), "utf8"),
  globals: readFileSync(path.join(here, "..", "app", "globals.css"), "utf8"),
};

test("a retry restart clears the retry banner as soon as the new attempt streams", () => {
  // pi emits auto_retry_start, sleeps, then restarts the answer; the
  // auto_retry_end(success) only arrives when that answer COMPLETES. The UI
  // must not show "retrying" over the entire retried response.
  assert.match(source.useAgentSession, /case "message_start":[\s\S]*?setRetryInfo\(null\)/);
});

test("ChatInput no longer carries a composer-level run-status strip", () => {
  assert.doesNotMatch(source.chatInput, /streamStatus/);
  assert.doesNotMatch(source.chatInput, /aria-live="polite"/);
});

test("ChatWindow no longer forwards streamStatus", () => {
  assert.doesNotMatch(source.chatWindow, /streamStatus/);
});

test("streamed content shows a blinking caret while it renders", () => {
  const md = readFileSync(path.join(here, "MarkdownBody.tsx"), "utf8");
  // The cursor must appear only while the message is still streaming.
  assert.match(md, /isStreaming && <span className="streaming-cursor"/);
});

test("streaming caret css exists with reduced-motion fallback", () => {
  assert.match(source.globals, /\.streaming-cursor \{/);
  assert.match(source.globals, /prefers-reduced-motion[\s\S]*?\.streaming-cursor \{ animation: none/);
});
