import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { fsCache: false });
const { splitModelRef, createImageGenerationExtension } = await jiti.import('./image-gen-extension.ts');
const { mergeAssistantImages, getImagesModels } = await jiti.import('./image-gen.ts');

test('explicit malformed model references fail without consulting default providers', async () => {
  let tool;
  createImageGenerationExtension().factory({ registerTool(value) { tool = value; } });
  for (const model of ['', 'invalid-model', '/flux', 'openrouter/', '   ', ' /flux', 'openrouter/ ']) {
    let consulted = false;
    const result = await tool.execute('test', { prompt: 'cat', model }, undefined, undefined, {
      modelRegistry: {
        getProviderAuthStatus() { consulted = true; return { configured: false }; },
        async getProviderAuth() { throw new Error('Must not request credentials'); },
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /provider\/modelId/);
    assert.equal(consulted, false);
  }
});

test('image tool rejects blank prompts before model lookup or generation', async () => {
  let tool;
  createImageGenerationExtension().factory({ registerTool(value) { tool = value; } });
  for (const prompt of ['', ' \n\t ']) {
    const result = await tool.execute('test', { prompt, model: 'unconfigured/model' }, undefined, undefined, {
      modelRegistry: {
        getProviderAuthStatus() { throw new Error('Unexpected provider lookup'); },
        async getProviderAuth() { throw new Error('Unexpected credential lookup'); },
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires a prompt/);
  }
});

test('explicit refs preserve slash-qualified catalog model IDs', () => {
  const credentials = { read: async () => undefined, list: async () => [] };
  const models = getImagesModels(credentials);
  assert.equal(getImagesModels(credentials), models);
  assert.ok(models.getModels().length > 0, 'SDK image catalog must not be empty');
  for (const model of models.getModels()) {
    assert.equal(model.type, 'image');
    assert.equal(model.api, 'openrouter-images');
    const parsed = splitModelRef(`${model.provider}/${model.id}`);
    assert.deepEqual(parsed, { provider: model.provider, modelId: model.id });
    assert.ok(models.getModel(parsed.provider, parsed.modelId));
  }
});

test('unified SDK image dispatch resolves stored auth and preserves payload hooks', async () => {
  const reads = [];
  const models = getImagesModels({
    async read(provider) { reads.push(provider); return { type: 'api_key', key: 'test-image-key' }; },
    async list() { return []; },
  });
  const model = models.getModels()[0];
  let dispatched = false;
  const result = await models.generateImages(model, { input: [{ type: 'text', text: 'cat' }] }, {
    onPayload(payload) { return { ...payload, seed: 7, image_config: { aspect_ratio: '1:1' } }; },
    async fetch(url, init) {
      dispatched = true;
      assert.match(String(url), /\/chat\/completions$/);
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-image-key');
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, model.id);
      assert.equal(payload.seed, 7);
      assert.deepEqual(payload.image_config, { aspect_ratio: '1:1' });
      return new Response(JSON.stringify({
        id: 'test-response',
        choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(dispatched, true);
  assert.ok(reads.includes('openrouter'));
  assert.equal(result.stopReason, 'stop', result.errorMessage);
  assert.deepEqual(result.output, [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]);
});

test('single text-only response is an error and preserves provider explanation', () => {
  const output = [{ type: 'text', text: 'Unable to fulfill this request.' }];
  const result = mergeAssistantImages([{ api: 'openrouter-images', provider: 'openrouter', model: 'test', output, stopReason: 'stop', timestamp: 1 }]);
  assert.equal(result.stopReason, 'error');
  assert.match(result.errorMessage, /no images/);
  assert.deepEqual(result.output, output);
});

test('single aborted response retains its terminal state', () => {
  const result = { api: 'openrouter-images', provider: 'openrouter', model: 'test', output: [], stopReason: 'aborted', timestamp: 1 };
  assert.equal(mergeAssistantImages([result]), result);
});
