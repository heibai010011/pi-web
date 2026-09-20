import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const { PromptCancellationRegistry, parsePromptRequestId } = await createJiti(import.meta.url).import('./prompt-cancellation.ts');
const base = 1800000000000;
const token = (time = base, n = 1) => `${time}:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('strict tokens and bounded admission clock including pinned pending preflight', () => {
  for (const invalid of [null, 1, '', 'uuid', token().toUpperCase(), `0${token()}`, token() + ' ']) {
    if (invalid === token()) continue;
    assert.throws(() => parsePromptRequestId(invalid), { status: 400 });
  }
  let now = base; const registry = new PromptCancellationRegistry(() => now);
  registry.claim('s', token());
  now += 300001;
  assert.throws(() => registry.check('s', token()), /Expired/);
  registry.cancel('s', token()); // Long-running owner remains stoppable.
  registry.finish('s', token());
  assert.throws(() => registry.available('s', token()), /Expired/); // even after pruning
  assert.throws(() => registry.available('s', token(now + 30001)), /future/);
  registry.available('s', token(now + 30000));
});
test('scope, duplicate execution, and fail-closed capacity without live tombstone eviction', () => {
  let now = base; const registry = new PromptCancellationRegistry(() => now, 2);
  registry.cancel('s', token());
  registry.claim('other', token());
  assert.throws(() => registry.available('s', token()), /canceled/);
  assert.throws(() => registry.claim('other', token()), /Duplicate/);
  assert.throws(() => registry.cancel('s', token(base, 2)), { status: 503 });
  assert.throws(() => registry.available('s', token()), /canceled/);
  now += 300001;
  registry.cancel('other', token()); // owner pinned, not evicted by capacity pruning
  registry.available('new', token(now, 3));
});
