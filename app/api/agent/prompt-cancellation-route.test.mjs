import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createJiti } from 'jiti';
const cancellation = await createJiti(import.meta.url).import('../../../lib/prompt-cancellation.ts');
const imageGeneration = await createJiti(import.meta.url).import('../../../lib/image-gen.ts');
const source = await readFile(new URL('./[id]/route.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function harness(overrides = {}) {
  const calls = { starts: 0, paths: 0, sends: 0 };
  const session = { promptCancellationVersion: 1, isAlive: () => true, send: async () => { calls.sends++; } };
  const deps = {
    '@/lib/image-gen': imageGeneration,
    '@/lib/prompt-cancellation': { ...cancellation, promptCancellation: new cancellation.PromptCancellationRegistry() },
    'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
    '@/lib/session-reader': { resolveSessionPath: async () => { calls.paths++; return 'fixture.jsonl'; } },
    '@/lib/rpc-manager': { getRpcSession: () => overrides.existing, setRpcSessionTools: async () => {},
      startRpcSession: async () => { calls.starts++; if (overrides.start) await overrides.start(); return { session }; } },
  };
  const exports = {}; vm.runInNewContext(compiled, { exports, require: name => deps[name] });
  const id = randomUUID();
  return { calls, post: body => exports.POST(new Request('http://fixture', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) }) };
}
const token = () => `${Date.now()}:${randomUUID()}`;
test('oversized image commands return 400 before startup or session writes', async () => {
  for (const count of [5, 10]) {
    for (const extra of [{ data: 'ref', mimeType: 'image/png' }, null]) {
      const { calls, post } = harness();
      const images = Array.from({ length: count }, (_, index) => index < 4 ? { data: String(index), mimeType: 'image/png' } : extra);
      const response = await post({ type: 'image_generate', prompt: 'cat', images });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /at most 4 reference images/);
      assert.deepEqual(calls, { starts: 0, paths: 0, sends: 0 });
    }
  }
});
test('route maps only recognized image errors to 400 and keeps valid images intact', async () => {
  const images = Array.from({ length: 4 }, (_, index) => ({ data: String(index), mimeType: 'image/png' }));
  let received;
  const { post } = harness({ existing: { isAlive: () => true, send: async body => { received = body; } } });
  assert.equal((await post({ type: 'image_generate', images })).status, 200);
  assert.deepEqual(received.images, images);
  for (const [error, status] of [[new imageGeneration.ImageGenerationValidationError('invalid references'), 400],
    [Object.assign(new Error('provider failed'), { status: 400 }), 500]]) {
    const { post } = harness({ existing: { isAlive: () => true, send: async () => { throw error; } } });
    assert.equal((await post({ type: 'image_generate', images })).status, status);
  }
});
test('abort-only request records cancellation without path resolution or startup', async () => {
  const { calls, post } = harness(); const promptRequestId = token();
  assert.equal((await post({ type: 'abort', promptRequestId })).status, 200);
  const rejected = await post({ type: 'prompt', message: 'A', promptRequestId });
  assert.equal(rejected.status, 409); assert.equal((await rejected.json()).accepted, false);
  assert.deepEqual(calls, { starts: 0, paths: 0, sends: 0 });
});
test('cancellation during startup prevents sending to newly created wrapper', async () => {
  const entered = deferred(); const gate = deferred();
  const { calls, post } = harness({ start: async () => { entered.resolve(); await gate.promise; } });
  const promptRequestId = token(); const pending = post({ type: 'prompt', message: 'A', promptRequestId });
  await entered.promise;
  assert.equal((await post({ type: 'abort', promptRequestId })).status, 200);
  gate.resolve(); const result = await pending;
  assert.equal(result.status, 409); assert.equal((await result.json()).accepted, false);
  assert.equal(calls.starts, 1); assert.equal(calls.sends, 0);
});
test('old HMR wrappers fail closed without uncorrelated abort or prompt', async () => {
  let sends = 0;
  const { post } = harness({ existing: { isAlive: () => true, send: async () => { sends++; } } });
  for (const type of ['abort', 'prompt']) {
    const response = await post({ type, promptRequestId: token() });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /stop and reload/);
  }
  assert.equal(sends, 0);
});
test('strict malformed/unsupported tokens return 400; missing token keeps legacy startup', async () => {
  const { calls, post } = harness();
  for (const body of [{ type: 'prompt', promptRequestId: null }, { type: 'abort', promptRequestId: 'x' },
    { type: 'prompt', promptRequestId: token(), streamingBehavior: 'followUp' }]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.equal(calls.starts, 0);
  assert.equal((await post({ type: 'abort' })).status, 200);
  assert.equal(calls.starts, 1);
});
