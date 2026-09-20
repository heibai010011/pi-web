import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const command = { type: "image_generate", prompt: "draw a cat", imageModel: { provider: "openrouter", modelId: "test-image-model" } };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function outcome() {
  return {
    result: {
      api: "openrouter-images", provider: "openrouter", model: "test-image-model",
      output: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      stopReason: "stop", timestamp: Date.now(),
    },
    durationMs: 12, requestedCount: 1,
  };
}

function fixture(t) {
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendModelChange("test-chat", "chat-model");
  const oldLeaf = manager.appendMessage({ role: "user", content: "prior conversation", timestamp: 1 });
  const gate = deferred();
  const entered = deferred();
  const events = [];
  let calls = 0;
  let signal;
  let disposed = false;
  const originalMessages = manager.buildSessionContext().messages;
  const inner = {
    sessionId: randomUUID(), sessionManager: manager,
    isBashRunning: false, isStreaming: false, isCompacting: false,
    model: { provider: "test-chat", id: "chat-model" },
    extensionRunner: {},
    agent: {
      state: { messages: originalMessages, systemPrompt: "test", thinkingLevel: "off" },
    },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    abort: async () => {}, abortBash() {}, dispose() { disposed = true; },
    async navigateTree(targetId) { manager.branch(targetId); return { cancelled: false }; },
    async prompt(_text, options) { options.preflightResult(true); },
  };
  const wrapper = new AgentSessionWrapper(inner, {
    generateImage: async (_request, requestSignal) => {
      calls++;
      signal = requestSignal;
      entered.resolve();
      return gate.promise;
    },
  });
  wrapper.onEvent((event) => events.push(event));
  t.after(() => { gate.resolve(outcome()); wrapper.destroy(); });
  return { inner, manager, wrapper, gate, entered, events, oldLeaf,
    get calls() { return calls; }, get signal() { return signal; },
    get disposed() { return disposed; }, originalMessages };
}

test("oversized direct commands never invoke generation or write session entries", async (t) => {
  const f = fixture(t);
  const entries = f.manager.getEntries().slice();
  for (const count of [5, 10]) {
    for (const extra of [{ data: "extra", mimeType: "image/png" }, null]) {
      const images = Array.from({ length: count }, (_, index) => index < 4
        ? { data: String(index), mimeType: "image/png" } : extra);
      await assert.rejects(f.wrapper.send({ ...command, images }), { name: "ImageGenerationValidationError", status: 400 });
      assert.equal(f.calls, 0);
      assert.deepEqual(f.manager.getEntries(), entries);
      assert.equal(f.inner.agent.state.messages, f.originalMessages);
      assert.equal(f.wrapper.isRunning(), false);
      assert.equal(f.events.filter(event => event.type === "image_generation_start").length, 0);
    }
  }
});

// Provider work is gated and injected: these tests never access auth or the network.
test("completed image generation synchronizes live context and emits lifecycle events", async (t) => {
  const f = fixture(t);
  const initialMessages = f.inner.agent.state.messages.length;
  const sending = f.wrapper.send(command);
  await f.entered.promise;
  assert.equal(f.wrapper.isRunning(), true);
  assert.equal((await f.wrapper.send({ type: "get_state" })).isGeneratingImage, true);
  assert.equal(f.events.filter((e) => e.type === "image_generation_start").length, 1);
  f.gate.resolve(outcome());
  const response = await sending;
  assert.equal(response.ok, true);
  assert.notEqual(f.inner.agent.state.messages, f.originalMessages);
  assert.equal(f.inner.agent.state.messages.length, initialMessages + 3);
  assert.deepEqual(f.inner.agent.state.messages, f.manager.buildSessionContext().messages);
  assert.equal(f.inner.agent.state.messages.at(-1).content[0].type, "image");
  let nextPromptContext;
  f.inner.prompt = async (_text, options) => {
    nextPromptContext = f.inner.agent.state.messages.slice();
    options.preflightResult(true);
  };
  await f.wrapper.send({ type: "prompt", message: "describe the generated image" });
  assert.equal(nextPromptContext.at(-1).content[0].data, "AAAA");
  await nextTurn();
  assert.equal(f.wrapper.isRunning(), false);
  assert.equal((await f.wrapper.send({ type: "get_state" })).isGeneratingImage, false);
  assert.equal(f.events.filter((e) => e.type === "image_generation_end").length, 1);
});

test("image generation rejects concurrent generation, navigation and other mutations", async (t) => {
  const f = fixture(t);
  const sending = f.wrapper.send(command);
  await f.entered.promise;
  const leaf = f.manager.getLeafId();
  for (const mutation of [command, { type: "navigate_tree", targetId: f.oldLeaf },
    { type: "prompt", message: "another turn" }, { type: "compact" },
    { type: "set_tools", toolNames: [] }, { type: "fork", entryId: f.oldLeaf }]) {
    await assert.rejects(f.wrapper.send(mutation), /image|busy|running/i);
  }
  assert.equal(f.calls, 1);
  assert.equal(f.manager.getLeafId(), leaf);
  assert.equal((await f.wrapper.send({ type: "get_state" })).isGeneratingImage, true);
  f.gate.resolve(outcome());
  await sending;
});

test("image generation refuses an already admitted asynchronous mutation", async (t) => {
  const f = fixture(t);
  const navigation = deferred();
  const navigating = deferred();
  f.inner.navigateTree = async () => { navigating.resolve(); await navigation.promise; return { cancelled: false }; };
  const sending = f.wrapper.send({ type: "navigate_tree", targetId: f.oldLeaf });
  t.after(() => navigation.resolve());
  await navigating.promise;
  await assert.rejects(f.wrapper.send(command), /busy|running|command/i);
  assert.equal(f.calls, 0);
  navigation.resolve();
  await sending;
});

for (const stop of ["abort", "deletion", "shutdown"]) {
  test(`${stop} aborts and drains pending image generation before finishing`, async (t) => {
    const f = fixture(t);
    const initialEntries = f.manager.getEntries().length;
    // Observe rejection immediately, so a fast cancellation cannot be unhandled.
    const sending = f.wrapper.send(command).then((value) => ({ value }), (error) => ({ error }));
    await f.entered.promise;
    assert.ok(f.signal instanceof AbortSignal);
    let settled = false;
    const stopping = (stop === "abort" ? f.wrapper.send({ type: "abort" })
      : stop === "deletion" ? f.wrapper.shutdownForDeletion() : f.wrapper.shutdown())
      .then(() => { settled = true; });
    await nextTurn();
    assert.equal(f.signal.aborted, true);
    assert.equal(settled, false, "shutdown/Stop must await the provider continuation");
    if (stop !== "abort") assert.equal(f.disposed, false);
    f.gate.reject(new DOMException("cancelled", "AbortError"));
    await sending;
    await stopping;
    assert.equal(f.manager.getEntries().length, initialEntries, "cancelled generation must not append a turn");
    assert.equal(f.inner.agent.state.messages, f.originalMessages);
    assert.deepEqual(f.inner.agent.state.messages, f.manager.buildSessionContext().messages);
    assert.equal(f.wrapper.isRunning(), false);
    assert.equal(f.events.filter((e) => e.type === "image_generation_end").length, 1);
    if (stop !== "abort") assert.equal(f.disposed, true);
  });
}

test("a provider that resolves after cancellation cannot persist late images", async (t) => {
  const f = fixture(t);
  const initialEntries = f.manager.getEntries().length;
  const sending = f.wrapper.send(command);
  await f.entered.promise;
  const stopping = f.wrapper.send({ type: "abort" });
  await nextTurn();
  assert.equal(f.signal.aborted, true);
  f.gate.resolve(outcome());
  const response = await sending;
  await stopping;
  assert.equal(response.ok, false);
  assert.equal(response.stopReason, "aborted");
  assert.equal(f.manager.getEntries().length, initialEntries);
  assert.equal(f.inner.agent.state.messages, f.originalMessages);
  assert.deepEqual(f.inner.agent.state.messages, f.manager.buildSessionContext().messages);
});

test("direct destroy aborts generation and rejects late successful persistence", async (t) => {
  const f = fixture(t);
  const initialEntries = f.manager.getEntries().length;
  const sending = f.wrapper.send(command);
  await f.entered.promise;
  f.wrapper.destroy();
  assert.equal(f.signal.aborted, true);
  f.gate.resolve(outcome());
  const response = await sending;
  assert.equal(response.stopReason, "aborted");
  assert.equal(f.manager.getEntries().length, initialEntries);
  assert.equal(f.inner.agent.state.messages, f.originalMessages);
  assert.deepEqual(f.inner.agent.state.messages, f.manager.buildSessionContext().messages);
  assert.equal(f.wrapper.isAlive(), false);
});

test("upstream rejection releases image admission and emits a terminal event", async (t) => {
  const f = fixture(t);
  const sending = f.wrapper.send(command);
  const rejection = assert.rejects(sending, /provider failed/);
  await f.entered.promise;
  f.gate.reject(new Error("provider failed"));
  await rejection;
  assert.equal(f.wrapper.isRunning(), false);
  assert.equal((await f.wrapper.send({ type: "get_state" })).isGeneratingImage, false);
  assert.equal(f.events.filter((e) => e.type === "image_generation_end").length, 1);
  await f.wrapper.send({ type: "navigate_tree", targetId: f.oldLeaf });
});
