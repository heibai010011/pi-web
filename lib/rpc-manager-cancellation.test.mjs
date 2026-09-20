import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const token = () => `${Date.now()}:${randomUUID()}`;
function fixture(prompt, abort = async () => {}) {
  const inner = { sessionId: randomUUID(), sessionFile: '', isStreaming: false, isCompacting: false,
    isBashRunning: false, agent: { state: {} }, prompt, abort };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.resetIdleTimer = () => {};
  wrapper.notifyAgentRunCompleteIfIdle = () => {};
  wrapper.waitForExtensionsBound = async () => {};
  return wrapper;
}
test('correlated Stop during extension binding cannot start a prompt after release', async () => {
  const bound = deferred(); let starts = 0; let aborts = 0;
  const wrapper = fixture(async (_, options) => { options.preflightResult(true); starts++; }, async () => { aborts++; });
  wrapper.waitForExtensionsBound = () => bound.promise;
  const promptRequestId = token();
  const pending = wrapper.send({ type: 'prompt', message: 'A', promptRequestId });
  const rejection = assert.rejects(pending, /cancel/i);
  await wrapper.send({ type: 'abort', promptRequestId });
  bound.resolve(); await rejection;
  assert.equal(starts, 0); assert.equal(aborts, 0);
});
test('Stop while SDK awaits preflight prevents start, and duplicate token cannot execute twice', async () => {
  const hook = deferred(); const entered = deferred(); let starts = 0;
  const wrapper = fixture(async (_, options) => { entered.resolve(); await hook.promise; options.preflightResult(true); starts++; });
  const promptRequestId = token();
  const pending = wrapper.send({ type: 'prompt', message: 'A', promptRequestId });
  const rejection = assert.rejects(pending, /cancel/i);
  await entered.promise;
  await wrapper.send({ type: 'abort', promptRequestId });
  hook.resolve(); await rejection;
  assert.equal(wrapper.pendingPromptCount, 0); assert.equal(wrapper.correlatedOwner, null);
  await assert.rejects(wrapper.send({ type: 'prompt', message: 'A', promptRequestId }), /cancel|Duplicate/i);
  assert.equal(starts, 0);
});
test('completed token cannot execute again and canceled preflight releases owner/count', async () => {
  let starts = 0;
  const wrapper = fixture(async (_, options) => { options.preflightResult(true); starts++; });
  const promptRequestId = token();
  await wrapper.send({ type: 'prompt', message: 'A', promptRequestId });
  await new Promise(setImmediate);
  await assert.rejects(wrapper.send({ type: 'prompt', message: 'A', promptRequestId }), /Duplicate/);
  assert.equal(starts, 1);
  assert.equal(wrapper.pendingPromptCount, 0); assert.equal(wrapper.correlatedOwner, null);
});
test('exact owner remains until actual promise settles; unrelated abort does nothing', async () => {
  const run = deferred(); let aborts = 0;
  const wrapper = fixture(async (_, options) => { options.preflightResult(true); await run.promise; }, async () => { aborts++; });
  const a = token();
  await wrapper.send({ type: 'prompt', message: 'A', promptRequestId: a });
  await wrapper.send({ type: 'abort', promptRequestId: token() });
  assert.equal(aborts, 0);
  await assert.rejects(wrapper.send({ type: 'prompt', message: 'B', promptRequestId: token() }), /active prompt/);
  await wrapper.send({ type: 'abort', promptRequestId: a });
  assert.equal(aborts, 1);
  run.resolve(); await new Promise(setImmediate);
  await assert.rejects(wrapper.send({ type: 'prompt', message: 'A', promptRequestId: a }), /cancel|Duplicate/);
});
test('abort drain blocks newer B even when A promise settles before abort finishes', async () => {
  const aRun = deferred(); const abortDrain = deferred(); const abortEntered = deferred(); let starts = 0; let aborts = 0;
  const wrapper = fixture(async (message, options) => { options.preflightResult(true); starts++; if (message === 'A') await aRun.promise; },
    async () => { aborts++; abortEntered.resolve(); await abortDrain.promise; });
  const a = token();
  await wrapper.send({ type: 'prompt', message: 'A', promptRequestId: a });
  const stopping = wrapper.send({ type: 'abort', promptRequestId: a });
  await abortEntered.promise; aRun.resolve(); await new Promise(setImmediate);
  const b = wrapper.send({ type: 'prompt', message: 'B', promptRequestId: token() });
  await new Promise(setImmediate); assert.equal(starts, 1);
  abortDrain.resolve(); await stopping; await b;
  assert.equal(starts, 2);
  await wrapper.send({ type: 'abort', promptRequestId: a });
  assert.equal(aborts, 1);
});
