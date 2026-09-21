import assert from 'node:assert/strict';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DISTINCT, DUPLICATE, LINKED, NOT_APPLICABLE, UNVERIFIED,
  summarizeDuplicates, verifyDuplicate, verifyDuplicates,
} from './duplicates.mjs';
import { IMPORTABLE, OCCUPIED } from './imports.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-dupes-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function occupied(localPath) {
  return { status: OCCUPIED, existing: { localPath, sizeBytes: null, quality: null, path: null } };
}

test('a spare copy with identical bytes is a duplicate that can be relinked', async (context) => {
  const root = await fixture(context);
  const download = path.join(root, 'download.mkv');
  const library = path.join(root, 'library.mkv');
  await writeFile(download, 'the very same bytes');
  await writeFile(library, 'the very same bytes');

  const verdict = await verifyDuplicate({ id: 'a', path: download }, occupied(library), { mode: 'sampled' });
  assert.equal(verdict.status, DUPLICATE);
  assert.equal(verdict.relinkable, true);
  assert.equal(verdict.reclaimableBytes, 'the very same bytes'.length);
  assert.equal(verdict.libraryPath, library);
});

test('a different release of the same film is spare but not a duplicate', async (context) => {
  const root = await fixture(context);
  const download = path.join(root, 'download.mkv');
  const library = path.join(root, 'library.mkv');
  // Identification calls both of these "spare" - the size is what tells them apart.
  await writeFile(download, 'a 2160p remux of the film');
  await writeFile(library, 'a 1080p webrip');

  const verdict = await verifyDuplicate({ id: 'a', path: download }, occupied(library), { mode: 'size' });
  assert.equal(verdict.status, DISTINCT);
  assert.equal(verdict.relinkable, false);
  assert.equal(verdict.reclaimableBytes, 0);
});

test('an equal-size pair is left unverified until something reads it', async (context) => {
  const root = await fixture(context);
  const download = path.join(root, 'download.mkv');
  const library = path.join(root, 'library.mkv');
  await writeFile(download, 'aaaaaaaaaa');
  await writeFile(library, 'bbbbbbbbbb');

  // The cheap pass must not promote "same length" into "same file".
  const cheap = await verifyDuplicate({ id: 'a', path: download }, occupied(library), { mode: 'size' });
  assert.equal(cheap.status, UNVERIFIED);
  assert.equal(cheap.relinkable, false);

  const read = await verifyDuplicate({ id: 'a', path: download }, occupied(library), { mode: 'sampled' });
  assert.equal(read.status, DISTINCT);
});

test('a file already sharing the library inode is reported as costing nothing', async (context) => {
  const root = await fixture(context);
  const download = path.join(root, 'download.mkv');
  const library = path.join(root, 'library.mkv');
  await writeFile(library, 'shared');
  await link(library, download);

  const verdict = await verifyDuplicate({ id: 'a', path: download }, occupied(library), { mode: 'size' });
  assert.equal(verdict.status, LINKED);
  assert.equal(verdict.reclaimableBytes, 0);
});

test('an untraceable library path is unverified rather than assumed safe', async () => {
  const verdict = await verifyDuplicate({ id: 'a', path: '/nowhere/file.mkv' }, occupied(null), { mode: 'size' });
  assert.equal(verdict.status, UNVERIFIED);
  assert.match(verdict.reason, /path mappings/);
});

test('a file the library is missing has nothing to compare against', async () => {
  const verdict = await verifyDuplicate({ id: 'a', path: '/nowhere/file.mkv' }, { status: IMPORTABLE }, { mode: 'size' });
  assert.equal(verdict.status, NOT_APPLICABLE);
});

test('the scan pass only looks at spare copies and honours its budget', async (context) => {
  const root = await fixture(context);
  const candidates = [];
  const identifications = [];
  for (let index = 0; index < 4; index += 1) {
    const download = path.join(root, `download-${index}.mkv`);
    const library = path.join(root, `library-${index}.mkv`);
    await writeFile(download, `payload ${index}`);
    await writeFile(library, `payload ${index}`);
    candidates.push({ id: `c${index}`, path: download });
    identifications.push({ id: `c${index}`, ...occupied(library) });
  }
  // One row the library is missing entirely: it must not consume any of the budget.
  candidates.unshift({ id: 'missing', path: path.join(root, 'download-0.mkv') });
  identifications.unshift({ id: 'missing', status: IMPORTABLE });

  const verdicts = await verifyDuplicates(candidates, identifications, { mode: 'sampled', limit: 2 });
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((verdict) => verdict.status === DUPLICATE));

  const summary = summarizeDuplicates(verdicts);
  assert.equal(summary.duplicates, 2);
  assert.equal(summary.relinkable, 2);
  assert.equal(summary.reclaimableBytes, 'payload 0'.length * 2);
});
