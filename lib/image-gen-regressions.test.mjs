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
  const models = getImagesModels({ read: async () => undefined, list: async () => [] });
  for (const model of models.getModels()) {
    const parsed = splitModelRef(`${model.provider}/${model.id}`);
    assert.deepEqual(parsed, { provider: model.provider, modelId: model.id });
    assert.ok(models.getModel(parsed.provider, parsed.modelId));
  }
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
