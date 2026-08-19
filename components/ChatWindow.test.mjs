import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = {
  chatWindow: readFileSync(path.join(here, "ChatWindow.tsx"), "utf8"),
  chatInput: readFileSync(path.join(here, "ChatInput.tsx"), "utf8"),
  en: readFileSync(path.join(here, "..", "lib", "i18n", "messages", "en.ts"), "utf8"),
  zh: readFileSync(path.join(here, "..", "lib", "i18n", "messages", "zh-CN.ts"), "utf8"),
};

test("ChatWindow forwards a live run status to the composer", () => {
  // The composer-level chip must be driven by agentRunning || bashRunning so
  // a long conversation that scrolled the in-stream indicator out of view
  // still shows current activity at the bottom.
  assert.match(source.chatWindow, /streamStatus=\{/);
  assert.match(source.chatWindow, /phaseLabel\(agentPhase, t\) \?\? t\("chat\.agentWorking"\)/);
  assert.match(source.chatWindow, /t\("chat\.runningCommand"\)/);
});

test("ChatInput renders the status chip only while streaming", () => {
  assert.match(source.chatInput, /isStreaming && streamStatus/);
  assert.match(source.chatInput, /aria-live="polite"/);
});

test("agentWorking copy exists in both locales", () => {
  assert.match(source.en, /"chat\.agentWorking": "Working…"/);
  assert.match(source.zh, /"chat\.agentWorking": "正在处理…"/);
});
