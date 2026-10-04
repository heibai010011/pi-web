import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");

function fixture() {
  let prepared;
  const preparing = new Promise((resolve) => { prepared = resolve; });
  let promptCalls = 0;
  let release;
  const inner = {
    sessionId: randomUUID(),
    sessionFile: "",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { setUIContext() {}, getRegisteredCommands: () => [] },
    async prompt() { promptCalls += 1; },
    async abort() {},
    abortBash() {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, {
    mcpHost: {
      prepareForPrompt(signal) {
        return new Promise((resolve) => {
          release = resolve;
          signal.addEventListener("abort", resolve, { once: true });
          prepared();
        });
      },
      dispose() {},
    },
  });
  return { wrapper, preparing, release: () => release(), promptCalls: () => promptCalls };
}

for (const action of ["correlated abort", "deletion", "shutdown", "destroy"]) {
  test(`MCP admission is withdrawn by ${action} without starting a prompt`, async () => {
    const f = fixture();
    const promptRequestId = `${Date.now()}:${randomUUID()}`;
    const prompting = f.wrapper.send({ type: "prompt", message: "hello", promptRequestId });
    const rejected = assert.rejects(prompting, /Stopped while MCP servers|no longer available|cancel/i);
    await f.preparing;
    try {
      if (action === "correlated abort") await f.wrapper.send({ type: "abort", promptRequestId });
      else if (action === "deletion") await f.wrapper.shutdownForDeletion();
      else if (action === "shutdown") await f.wrapper.shutdown();
      else f.wrapper.destroy();
      await rejected;
      assert.equal(f.promptCalls(), 0);
      assert.equal(f.wrapper.isRunning(), false);
    } finally {
      f.release();
      f.wrapper.destroy();
    }
  });
}
