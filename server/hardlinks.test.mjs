import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DIFFERENT, IDENTICAL, SAME_INODE, UNKNOWN,
  compareFiles, fileFacts, relinkDuplicate, sampledDigest,
} from './hardlinks.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-hardlinks-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Large enough to exercise the three-window sampling path rather than the whole-file
// shortcut, so the windows themselves are under test.
const LARGE = 8 * 1024 * 1024 * 3 + 4096;

test('compareFiles reports two names for one inode without reading either', async (context) => {
  const root = await fixture(context);
  const first = path.join(root, 'download.mkv');
  const second = path.join(root, 'library.mkv');
  await writeFile(first, 'the same bytes');
  await link(first, second);

  const result = await compareFiles(first, second, { mode: 'full' });
  assert.equal(result.status, SAME_INODE);
  assert.equal(result.first.identity, result.second.identity);
});

test('compareFiles rejects a size mismatch before hashing anything', async (context) => {
  const root = await fixture(context);
  const first = path.join(root, 'download.mkv');
  const second = path.join(root, 'library.mkv');
  await writeFile(first, 'a longer release');
  await writeFile(second, 'shorter');

  const result = await compareFiles(first, second, { mode: 'full' });
  assert.equal(result.status, DIFFERENT);
  assert.match(result.reason, /different sizes/);
});

test('a cheap mode never claims two files are identical', async (context) => {
  const root = await fixture(context);
  const first = path.join(root, 'download.mkv');
  const second = path.join(root, 'library.mkv');
  await writeFile(first, 'identical contents');
  await writeFile(second, 'identical contents');

  // Same size, same bytes - and 'size' mode must still refuse to say so, because it
  // never looked. Anything destructive keying off IDENTICAL depends on this.
  const sized = await compareFiles(first, second, { mode: 'size' });
  assert.equal(sized.status, UNKNOWN);

  const sampled = await compareFiles(first, second, { mode: 'sampled' });
  assert.equal(sampled.status, IDENTICAL);
});

test('sampled comparison catches a difference in the middle of a large file', async (context) => {
  const root = await fixture(context);
  const first = path.join(root, 'download.mkv');
  const second = path.join(root, 'library.mkv');
  const body = randomBytes(LARGE);
  await writeFile(first, body);
  const altered = Buffer.from(body);
  altered[Math.floor(LARGE / 2)] ^= 0xff;
  await writeFile(second, altered);

  const result = await compareFiles(first, second, { mode: 'sampled' });
  assert.equal(result.status, DIFFERENT);
});

test('the sampled digest folds in the size so windows alone cannot collide', async (context) => {
  const root = await fixture(context);
  const first = path.join(root, 'a.mkv');
  const second = path.join(root, 'b.mkv');
  await writeFile(first, Buffer.alloc(1024, 7));
  await writeFile(second, Buffer.alloc(2048, 7));

  const left = await sampledDigest(first);
  const right = await sampledDigest(second);
  assert.notEqual(left.digest, right.digest);
});

test('relinkDuplicate frees the duplicate and leaves the library file untouched', async (context) => {
  const root = await fixture(context);
  const duplicate = path.join(root, 'torrents', 'film.mkv');
  const keep = path.join(root, 'library', 'film.mkv');
  const body = randomBytes(1024 * 512);
  await Promise.all([
    mkdir(path.dirname(duplicate), { recursive: true }),
    mkdir(path.dirname(keep), { recursive: true }),
  ]);
  await writeFile(duplicate, body);
  await writeFile(keep, body);

  const before = await fileFacts(keep);
  const result = await relinkDuplicate(duplicate, keep);

  assert.equal(result.status, 'relinked');
  assert.equal(result.reclaimedBytes, body.length);
  const after = await fileFacts(duplicate);
  const keepAfter = await fileFacts(keep);
  // One inode, two names, and the library side kept the inode it always had.
  assert.equal(after.identity, keepAfter.identity);
  assert.equal(keepAfter.identity, before.identity);
  assert.equal(after.linkCount, 2);
  // The seeding client still finds exactly the bytes it was serving.
  assert.deepEqual(await readFile(duplicate), body);
  // No temporary file survived.
  await assert.rejects(stat(`${duplicate}.keelhaularr-relink`));
});

test('relinkDuplicate refuses when the contents differ, and changes nothing', async (context) => {
  const root = await fixture(context);
  const duplicate = path.join(root, 'download.mkv');
  const keep = path.join(root, 'library.mkv');
  const body = randomBytes(4096);
  const other = Buffer.from(body);
  other[10] ^= 0xff;
  await writeFile(duplicate, body);
  await writeFile(keep, other);

  const before = await fileFacts(duplicate);
  await assert.rejects(relinkDuplicate(duplicate, keep), /not proven identical/);
  const after = await fileFacts(duplicate);
  assert.equal(after.identity, before.identity);
  assert.deepEqual(await readFile(duplicate), body);
});

test('relinking an already-linked pair is a no-op rather than an error', async (context) => {
  const root = await fixture(context);
  const duplicate = path.join(root, 'download.mkv');
  const keep = path.join(root, 'library.mkv');
  await writeFile(keep, 'shared');
  await link(keep, duplicate);

  const result = await relinkDuplicate(duplicate, keep);
  assert.equal(result.status, 'already-linked');
  assert.equal(result.reclaimedBytes, 0);
});

test('relinkDuplicate reports no reclaimed bytes when the duplicate had another link', async (context) => {
  const root = await fixture(context);
  const duplicate = path.join(root, 'download.mkv');
  const sibling = path.join(root, 'another-name.mkv');
  const keep = path.join(root, 'library.mkv');
  const body = randomBytes(2048);
  await writeFile(duplicate, body);
  await link(duplicate, sibling);
  await writeFile(keep, body);

  const result = await relinkDuplicate(duplicate, keep);
  assert.equal(result.status, 'relinked');
  // The blocks are still held by `sibling`, so claiming they were freed would be a lie.
  assert.equal(result.reclaimedBytes, 0);
  assert.equal(result.priorLinkCount, 2);
});
