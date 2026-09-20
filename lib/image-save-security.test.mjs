import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, link, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { fsCache: false });
const { saveImageExclusive } = await jiti.import('./image-save.ts');

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'pi-image-save-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cwd = join(base, 'project');
  const outside = join(base, 'outside');
  await mkdir(cwd); await mkdir(outside);
  return { cwd, outside, roots: new Set([cwd]) };
}

test('empty image data is rejected before creating the output directory', async (t) => {
  const { cwd, roots } = await fixture(t);
  await assert.rejects(saveImageExclusive(cwd, 'image/png', 'empty.png', Buffer.alloc(0), roots), /empty/);
  assert.deepEqual(await readdir(cwd), []);
});

test('a file occupying generated-images is rejected without alteration', async (t) => {
  const { cwd, roots } = await fixture(t);
  const occupied = join(cwd, 'generated-images');
  await writeFile(occupied, 'preserved');
  await assert.rejects(saveImageExclusive(cwd, 'image/png', 'cat.png', Buffer.from('new'), roots), /Access denied/);
  assert.equal(await readFile(occupied, 'utf8'), 'preserved');
});

test('concurrent same-name saves preserve every image', async (t) => {
  const { cwd, roots } = await fixture(t);
  const results = await Promise.all(['first', 'second', 'third'].map((data) =>
    saveImageExclusive(cwd, 'image/png', 'cat.png', Buffer.from(data), roots)));
  assert.equal(new Set(results.map(r => r.filePath)).size, 3);
  assert.deepEqual(await Promise.all(results.map(r => readFile(r.filePath, 'utf8'))), ['first', 'second', 'third']);
});

test('same-name directory collision is preserved and image uses another name', async (t) => {
  const { cwd, roots } = await fixture(t);
  const existing = join(cwd, 'generated-images', 'cat.png');
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, 'sentinel'), 'preserved');
  const saved = await saveImageExclusive(cwd, 'image/png', 'cat.png', Buffer.from('image bytes'), roots);
  assert.notEqual(saved.filePath, existing);
  assert.equal(await readFile(saved.filePath, 'utf8'), 'image bytes');
  assert.equal(await readFile(join(existing, 'sentinel'), 'utf8'), 'preserved');
});

test('long Chinese filenames remain writable after a collision', async (t) => {
  const { cwd, roots } = await fixture(t);
  const name = `${'图'.repeat(110)}.webp`;
  const results = [];
  for (const data of ['first', 'second']) {
    results.push(await saveImageExclusive(cwd, 'image/webp', name, Buffer.from(data), roots));
  }
  assert.notEqual(results[0].filePath, results[1].filePath);
  for (const result of results) assert.ok(Buffer.byteLength(result.fileName, 'utf8') <= 255);
  assert.deepEqual(await Promise.all(results.map(r => readFile(r.filePath, 'utf8'))), ['first', 'second']);
});

test('rejects generated-images directory junctions outside roots', async (t) => {
  const { cwd, outside, roots } = await fixture(t);
  await symlink(outside, join(cwd, 'generated-images'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveImageExclusive(cwd, 'image/png', 'cat.png', Buffer.from('data'), roots), /Access denied/);
});

test('rejects cwd junction escaping allowed roots before mkdir', async (t) => {
  const { cwd, outside, roots } = await fixture(t);
  const link = join(cwd, 'linked');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveImageExclusive(link, 'image/png', 'cat.png', Buffer.from('data'), roots), /Access denied/);
});

test('existing destination symlinks never overwrite their targets', async (t) => {
  const { cwd, outside, roots } = await fixture(t);
  await mkdir(join(cwd, 'generated-images'));
  const target = join(outside, 'original.png');
  const link = join(cwd, 'generated-images', 'cat.png');
  await writeFile(target, 'original');
  try {
    await symlink(target, link, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Creating file symlinks requires Windows developer mode or elevation');
      return;
    }
    throw error;
  }
  const result = await saveImageExclusive(cwd, 'image/png', 'cat.png', Buffer.from('new'), roots);
  assert.notEqual(result.filePath, link);
  assert.equal(await readFile(target, 'utf8'), 'original');
  assert.equal(await readFile(result.filePath, 'utf8'), 'new');
});

test('existing hard links never overwrite their original file', async (t) => {
  const { cwd, outside, roots } = await fixture(t);
  await mkdir(join(cwd, 'generated-images'));
  const original = join(outside, 'original.png');
  const destination = join(cwd, 'generated-images', 'cat.png');
  await writeFile(original, 'original');
  await link(original, destination);
  const result = await saveImageExclusive(cwd, 'image/png', 'cat.png', Buffer.from('new'), roots);
  assert.notEqual(result.filePath, destination);
  assert.equal(await readFile(original, 'utf8'), 'original');
  assert.equal(await readFile(destination, 'utf8'), 'original');
  assert.equal(await readFile(result.filePath, 'utf8'), 'new');
});

test('existing destinations are not truncated', async (t) => {
  const { cwd, roots } = await fixture(t);
  await mkdir(join(cwd, 'generated-images'));
  const original = join(cwd, 'generated-images', 'cat.png');
  await writeFile(original, 'original');
  const result = await saveImageExclusive(cwd, 'image/png', 'cat.png', Buffer.from('new'), roots);
  assert.notEqual(result.filePath, original);
  assert.equal(await readFile(original, 'utf8'), 'original');
  assert.equal(await readFile(result.filePath, 'utf8'), 'new');
});
