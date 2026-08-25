import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { replacementProgress } from './arr.mjs';
import { applyOrphanCandidate, scanOrphans } from './orphans.mjs';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-components-'));
process.env.CONFIG_DIR = path.join(testRoot, 'config');
const { createJsonStore } = await import('./state.mjs');
const { cleanupExpiredQuarantine, listQuarantine, recordQuarantine, restoreQuarantine } = await import('./quarantine.mjs');
after(() => rm(testRoot, { recursive: true, force: true }));

test('atomic state updates are serialized and kept private', async () => {
  const store = createJsonStore('counter.json', { version: 1, counter: 0 });
  await Promise.all(Array.from({ length: 40 }, () => store.update((document) => {
    document.counter += 1;
  })));
  assert.equal(store.read().counter, 40);
  assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).counter, 40);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
});

test('replacement tracking distinguishes a search, queued download, imported file, and missing result', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let commandStatus = 'started';
  let commandMissing = false;
  let queued = false;
  let hasFile = false;
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v3/command/99') {
      return commandMissing ? Response.json({}, { status: 404 }) : Response.json({ id: 99, status: commandStatus });
    }
    if (endpoint === '/api/v3/queue/details') return Response.json(queued ? [{ movieId: 12 }] : []);
    if (endpoint === '/api/v3/movie/12') return Response.json({ id: 12, hasFile });
    return Response.json({}, { status: 404 });
  };
  const connection = { url: 'http://fixture.invalid', kind: 'radarr', apiKey: 'fixture' };
  const candidate = { app: 'radarr', searchIds: [12] };
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'searching');
  commandStatus = 'completed';
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'no_result');
  queued = true;
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'download_queued');
  queued = false;
  hasFile = true;
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'downloaded');
  commandMissing = true;
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'downloaded');
  hasFile = false;
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'unknown');
  commandMissing = false;
  commandStatus = 'failed';
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'search_failed');
});

test('an orphan that gains a hardlink after scanning is preserved', async () => {
  const mediaRoot = path.join(testRoot, 'media');
  const downloadRoot = path.join(testRoot, 'downloads');
  await mkdir(mediaRoot);
  await mkdir(downloadRoot);
  const source = path.join(downloadRoot, 'movie.mkv');
  await writeFile(source, 'fixture media');
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
    orphanAction: 'permanent',
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const scan = await scanOrphans(config, arr);
  assert.equal(scan.candidates.length, 1);
  await link(source, path.join(mediaRoot, 'imported.mkv'));
  await assert.rejects(applyOrphanCandidate(config, scan.candidates[0]), /changed after revalidation/);
  assert.equal((await stat(source)).nlink, 2);
});

test('Brig restore refuses collisions and retention remains opt-in', async (context) => {
  const original = path.join(testRoot, 'original', 'movie.mkv');
  const quarantined = path.join(testRoot, 'brig', 'movie.mkv');
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(quarantined));
  await writeFile(original, 'a replacement that must be kept');
  await writeFile(quarantined, 'old media');
  const record = await recordQuarantine({
    app: 'radarr', title: 'movie.mkv', sizeBytes: 9, path: original, root: path.dirname(original),
  }, quarantined);
  await assert.rejects(restoreQuarantine(record.id), /already exists/);
  assert.equal(await readFile(original, 'utf8'), 'a replacement that must be kept');
  assert.equal(await readFile(quarantined, 'utf8'), 'old media');
  await unlink(original);
  await restoreQuarantine(record.id);
  assert.equal(await readFile(original, 'utf8'), 'old media');
  assert.equal(listQuarantine().length, 0);

  await writeFile(quarantined, 'expired media');
  await recordQuarantine({ app: 'radarr', title: 'movie.mkv', sizeBytes: 13, path: original, root: path.dirname(original) }, quarantined);
  const realNow = Date.now;
  context.after(() => { Date.now = realNow; });
  const future = realNow() + 2 * 86400000;
  Date.now = () => future;
  assert.deepEqual(await cleanupExpiredQuarantine(0), []);
  assert.equal(listQuarantine().length, 1);
  assert.equal((await cleanupExpiredQuarantine(1)).length, 1);
  assert.equal(listQuarantine().length, 0);
  await assert.rejects(stat(quarantined), { code: 'ENOENT' });
  assert.equal(await readFile(original, 'utf8'), 'old media');
});
