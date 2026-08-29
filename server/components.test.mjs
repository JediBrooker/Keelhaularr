import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { replacementProgress } from './arr.mjs';
import { applyOrphanCandidate, assertCandidateUnchanged, scanOrphans } from './orphans.mjs';

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

test('qBittorrent excludes incomplete torrent content but leaves completed downloads eligible', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-media');
  const downloadRoot = path.join(testRoot, 'qbit-downloads');
  const activeRoot = path.join(downloadRoot, 'active-release');
  await mkdir(mediaRoot);
  await mkdir(activeRoot, { recursive: true });
  const libraryOrphan = path.join(mediaRoot, 'unknown.mkv');
  const activeDownload = path.join(activeRoot, 'active.mkv');
  const completedDownload = path.join(downloadRoot, 'completed.mkv');
  await Promise.all([
    writeFile(libraryOrphan, 'unknown library file'),
    writeFile(activeDownload, 'active torrent file'),
    writeFile(completedDownload, 'completed torrent file'),
  ]);
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test-session; Path=/' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.2.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json([
      { content_path: activeRoot, progress: 0.4, amount_left: 100 },
      { content_path: completedDownload, progress: 1, amount_left: 0 },
    ]);
    if (endpoint === '/api/v2/auth/logout') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const scan = await scanOrphans(config, arr);
  assert.deepEqual(scan.candidates.map((candidate) => candidate.path).sort(), [completedDownload, libraryOrphan].sort());
  assert.equal(scan.warnings.length, 0);
});

test('qBittorrent failure withholds download roots while library orphan scanning continues', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-outage-media');
  const downloadRoot = path.join(testRoot, 'qbit-outage-downloads');
  await mkdir(mediaRoot);
  await mkdir(downloadRoot);
  const libraryOrphan = path.join(mediaRoot, 'unknown.mkv');
  await writeFile(libraryOrphan, 'unknown library file');
  await writeFile(path.join(downloadRoot, 'unsafe.mkv'), 'download file');
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const scan = await scanOrphans(config, arr);
  assert.deepEqual(scan.candidates.map((candidate) => candidate.path), [libraryOrphan]);
  assert.match(scan.warnings.join(' '), /safety check failed.*withheld/i);
});

test('one incomplete qBittorrent path outside monitored roots withholds all download candidates', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-outside-media');
  const downloadRoot = path.join(testRoot, 'qbit-outside-downloads');
  const activeRoot = path.join(downloadRoot, 'active');
  await mkdir(mediaRoot);
  await mkdir(activeRoot, { recursive: true });
  await writeFile(path.join(activeRoot, 'active.mkv'), 'active');
  await writeFile(path.join(downloadRoot, 'otherwise-eligible.mkv'), 'eligible');
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test-session' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.0.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json([
      { content_path: activeRoot, progress: 0.5, amount_left: 50 },
      { content_path: '/unrelated/download', progress: 0.5, amount_left: 50 },
    ]);
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const scan = await scanOrphans(config, arr);
  assert.equal(scan.candidates.length, 0);
  assert.match(scan.warnings.join(' '), /outside the configured completed-download roots.*withheld/i);
});

test('a newly incomplete torrent is preserved by the immediate pre-change check', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-race-media');
  const downloadRoot = path.join(testRoot, 'qbit-race-downloads');
  await mkdir(mediaRoot);
  await mkdir(downloadRoot);
  const source = path.join(downloadRoot, 'started-later.mkv');
  await writeFile(source, 'torrent file');
  let incomplete = false;
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response(null, { status: 204, headers: { 'Set-Cookie': 'QBT_SID_8080=test-session; Path=/' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.2.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json([
      { content_path: source, progress: incomplete ? 0.2 : 1, amount_left: incomplete ? 100 : 0 },
    ]);
    if (endpoint === '/api/v2/auth/logout') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
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
  const candidate = (await scanOrphans(config, arr)).candidates[0];
  assert.equal(candidate.path, source);
  incomplete = true;
  await assert.rejects(applyOrphanCandidate(config, candidate), /incomplete torrent.*preserved/i);
  assert.equal(await readFile(source, 'utf8'), 'torrent file');
});

test('same-size source changes are rejected during recovery revalidation', async () => {
  const source = path.join(testRoot, 'recovery-revalidation.mkv');
  await writeFile(source, 'original');
  const before = await stat(source, { bigint: true });
  const candidate = {
    path: source,
    sizeBytes: Number(before.size),
    identity: `${before.dev}:${before.ino}`,
    linkCount: Number(before.nlink),
    modifiedAt: new Date(Number(before.mtimeMs)).toISOString(),
  };
  await writeFile(source, 'modified');
  const future = new Date(Date.now() + 60000);
  await utimes(source, future, future);
  await assert.rejects(assertCandidateUnchanged(candidate), /changed after revalidation/i);
});

test('a source changed during the remote safety request is preserved', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const downloadRoot = path.join(testRoot, 'remote-check-race');
  await mkdir(downloadRoot);
  const source = path.join(downloadRoot, 'race.mkv');
  await writeFile(source, 'original');
  const before = await stat(source, { bigint: true });
  const candidate = {
    app: 'radarr',
    source: 'download',
    path: source,
    root: downloadRoot,
    relativePath: 'race.mkv',
    sizeBytes: Number(before.size),
    identity: `${before.dev}:${before.ino}`,
    linkCount: Number(before.nlink),
    modifiedAt: new Date(Number(before.mtimeMs)).toISOString(),
  };
  let changed = false;
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test-session' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.0.0');
    if (endpoint === '/api/v2/torrents/info') {
      if (!changed) {
        changed = true;
        await writeFile(source, 'modified');
        const future = new Date(Date.now() + 60000);
        await utimes(source, future, future);
      }
      return Response.json([]);
    }
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { downloadRoots: [downloadRoot] },
    sonarr: { downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    orphanAction: 'permanent',
  };
  await assert.rejects(applyOrphanCandidate(config, candidate), /changed after revalidation/i);
  assert.equal(await readFile(source, 'utf8'), 'modified');
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
