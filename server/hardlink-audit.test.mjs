import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { COPIED, HARDLINKED, INDETERMINATE, MOVED, classifyImport } from './hardlink-audit.mjs';

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-audit-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, 'torrents'), { recursive: true }),
    mkdir(path.join(root, 'library'), { recursive: true }),
  ]);
  return root;
}

function record(droppedPath, importedPath) {
  return {
    eventType: 'downloadFolderImported',
    date: '2026-09-20T10:00:00Z',
    sourceTitle: 'Some.Release.1080p',
    data: { droppedPath, importedPath },
  };
}

test('an import that left one inode under two names is reported as hardlinked', async (context) => {
  const root = await fixture(context);
  const dropped = path.join(root, 'torrents', 'release.mkv');
  const imported = path.join(root, 'library', 'Film (2024).mkv');
  await writeFile(dropped, 'payload');
  await link(dropped, imported);

  const verdict = await classifyImport(record(dropped, imported), []);
  assert.equal(verdict.status, HARDLINKED);
  assert.equal(verdict.linkCount, 2);
});

test('an import whose source is gone is a move, not a fault', async (context) => {
  const root = await fixture(context);
  const dropped = path.join(root, 'torrents', 'release.mkv');
  const imported = path.join(root, 'library', 'Film (2024).mkv');
  await writeFile(imported, 'payload');

  // One copy exists, in the library. A link-count check alone would call this a
  // failure; it is the correct outcome for a setup that does not seed.
  const verdict = await classifyImport(record(dropped, imported), []);
  assert.equal(verdict.status, MOVED);
});

test('two separate inodes from one import are reported as a copy with its cost', async (context) => {
  const root = await fixture(context);
  const dropped = path.join(root, 'torrents', 'release.mkv');
  const imported = path.join(root, 'library', 'Film (2024).mkv');
  await writeFile(dropped, 'payload bytes');
  await writeFile(imported, 'payload bytes');

  const verdict = await classifyImport(record(dropped, imported), []);
  assert.equal(verdict.status, COPIED);
  assert.equal(verdict.wastedBytes, 'payload bytes'.length);
});

test('a library file that no longer exists is skipped rather than guessed at', async (context) => {
  const root = await fixture(context);
  const dropped = path.join(root, 'torrents', 'release.mkv');
  await writeFile(dropped, 'payload');

  // Upgraded away or deleted since. Judging it would turn ordinary churn into alarms.
  assert.equal(await classifyImport(record(dropped, path.join(root, 'library', 'gone.mkv')), []), null);
});

test('an unmappable path is indeterminate, never a pass', async (context) => {
  const root = await fixture(context);
  const imported = path.join(root, 'library', 'Film (2024).mkv');
  await writeFile(imported, 'payload');

  const windowsSource = await classifyImport(record('C:\\downloads\\release.mkv', imported), []);
  assert.equal(windowsSource.status, INDETERMINATE);

  const missingSource = await classifyImport(record(null, imported), []);
  assert.equal(missingSource.status, INDETERMINATE);
});

test('path mappings are applied to both sides of the comparison', async (context) => {
  const root = await fixture(context);
  const dropped = path.join(root, 'torrents', 'release.mkv');
  const imported = path.join(root, 'library', 'Film (2024).mkv');
  await writeFile(dropped, 'payload');
  await link(dropped, imported);

  const pathMaps = [
    { from: '/data/torrents', to: path.join(root, 'torrents') },
    { from: '/data/media', to: path.join(root, 'library') },
  ];
  const verdict = await classifyImport(
    record('/data/torrents/release.mkv', '/data/media/Film (2024).mkv'),
    pathMaps,
  );
  assert.equal(verdict.status, HARDLINKED);
});
