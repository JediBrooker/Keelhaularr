import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mapArrPath } from './arr.mjs';
import { scanOrphans } from './orphans.mjs';

const isRoot = process.getuid?.() === 0;

function baseConfig(overrides = {}) {
  return {
    extensions: new Set(['.mkv']),
    ignoreDirectories: new Set(),
    maxFiles: 10000,
    hardlinkMinAgeHours: 0,
    qbittorrent: { configured: false },
    ...overrides,
  };
}

function connectedArr(knownPaths = []) {
  return {
    radarr: {
      app: 'radarr', kind: 'radarr', status: 'connected', candidates: [],
      knownPaths: new Set(knownPaths),
    },
  };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-safety-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('mapArrPath refuses a path it cannot resolve instead of inventing one', () => {
  // Each of these used to become `<cwd>/<input>` - a path that can never match a real
  // file, so every file the application tracked looked untracked, i.e. deletable.
  assert.equal(mapArrPath('C:\\Media\\Film.mkv', []), null);
  assert.equal(mapArrPath('\\\\nas\\media\\Film.mkv', []), null);
  assert.equal(mapArrPath('relative/Film.mkv', []), null);
  assert.equal(mapArrPath('', []), null);
  assert.equal(mapArrPath(null, []), null);

  // A trailing slash in a mapping used to disable it silently: only one slash was
  // stripped, so `/mnt/media//` matched nothing at all.
  const doubled = [{ from: '/mnt/media//', to: '/movies' }];
  assert.equal(mapArrPath('/mnt/media/Film/x.mkv', doubled), '/movies/Film/x.mkv');
  assert.equal(mapArrPath('/mnt/media', doubled), '/movies');

  const single = [{ from: '/mnt/media', to: '/movies' }];
  assert.equal(mapArrPath('/mnt/media/Film/x.mkv', single), '/movies/Film/x.mkv');
  // Boundary, not string prefix.
  assert.equal(mapArrPath('/mnt/media-4k/Film/x.mkv', single), '/mnt/media-4k/Film/x.mkv');
  // A mapping cannot be used to escape its own destination.
  assert.equal(mapArrPath('/mnt/media/../../etc/passwd', single), null);
  // An unmapped absolute path is still passed through, which is the common setup.
  assert.equal(mapArrPath('/movies/Film/x.mkv', []), '/movies/Film/x.mkv');
});

test('a root where nothing the application tracks resolves is withheld, not emptied', async (context) => {
  const root = await fixture(context);
  const movies = path.join(root, 'movies');
  await mkdir(path.join(movies, 'Film'), { recursive: true });
  await writeFile(path.join(movies, 'Film', 'x.mkv'), 'the only copy');

  const config = baseConfig({
    instances: [{ id: 'radarr', kind: 'radarr', mediaRoots: [movies], downloadRoots: [] }],
  });

  // Radarr is healthy and DOES track this file, but reports it under a path that a
  // broken mapping failed to translate into the container.
  const scan = await scanOrphans(config, connectedArr(['/mnt/media/Film/x.mkv']));

  assert.deepEqual(scan.candidates, []);
  assert.match(scan.warnings.join(' '), /none of them resolve inside/);
  assert.match(scan.warnings.join(' '), /path mapping is wrong/);
});

test('a genuinely untracked file is still reported when the mapping is sound', async (context) => {
  const root = await fixture(context);
  const movies = path.join(root, 'movies');
  await mkdir(movies, { recursive: true });
  const tracked = path.join(movies, 'Tracked.mkv');
  const stray = path.join(movies, 'Stray.mkv');
  await writeFile(tracked, 'a');
  await writeFile(stray, 'b');

  const config = baseConfig({
    instances: [{ id: 'radarr', kind: 'radarr', mediaRoots: [movies], downloadRoots: [] }],
  });
  const scan = await scanOrphans(config, connectedArr([tracked]));

  // The sanity floor must not suppress real findings: one tracked path resolves here,
  // so the root is trusted and the stray is reported.
  assert.deepEqual(scan.candidates.map((candidate) => candidate.path), [stray]);
  assert.doesNotMatch(scan.warnings.join(' '), /path mapping is wrong/);
});

test('an unreadable media root withholds that app\'s completed downloads', async (context) => {
  const root = await fixture(context);
  const movies = path.join(root, 'movies-not-mounted');
  const downloads = path.join(root, 'downloads');
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(downloads, 'Release.mkv'), 'download copy');

  const config = baseConfig({
    instances: [{ id: 'radarr', kind: 'radarr', mediaRoots: [movies], downloadRoots: [downloads] }],
  });
  const scan = await scanOrphans(config, connectedArr([path.join(movies, 'Film.mkv')]));

  // "No library hardlink" is only meaningful when the library was actually readable.
  // Previously the missing root produced one easily-missed warning and every completed
  // download was offered as a broken-hardlink orphan.
  assert.deepEqual(scan.candidates, []);
  assert.match(scan.warnings.join(' '), /media root is not readable/);
  assert.match(scan.warnings.join(' '), /library could not be surveyed completely/);
});

test('download roots are withheld when no media root is configured at all', async (context) => {
  const root = await fixture(context);
  const downloads = path.join(root, 'downloads');
  await mkdir(downloads, { recursive: true });
  await writeFile(path.join(downloads, 'Release.mkv'), 'download copy');

  const config = baseConfig({
    instances: [{ id: 'radarr', kind: 'radarr', mediaRoots: [], downloadRoots: [downloads] }],
  });
  const scan = await scanOrphans(config, connectedArr([]));

  assert.deepEqual(scan.candidates, []);
  assert.match(scan.warnings.join(' '), /no media roots, so no library exists to prove a download is unlinked/);
});

test('one unreadable subfolder no longer aborts the whole scan', { skip: isRoot }, async (context) => {
  const root = await fixture(context);
  const movies = path.join(root, 'movies');
  const otherRoot = path.join(root, 'other');
  await mkdir(movies, { recursive: true });
  await mkdir(otherRoot, { recursive: true });
  await writeFile(path.join(movies, 'Film.mkv'), 'a');
  await writeFile(path.join(otherRoot, 'Stray.mkv'), 'b');
  // Guaranteed present and 0700 root:root on any directly mounted ext4 volume.
  const lostFound = path.join(movies, 'lost+found');
  await mkdir(lostFound);
  await chmod(lostFound, 0o000);
  context.after(() => chmod(lostFound, 0o755).catch(() => {}));

  const config = baseConfig({
    instances: [{ id: 'radarr', kind: 'radarr', mediaRoots: [movies, otherRoot], downloadRoots: [] }],
  });

  // Previously this threw out of scanOrphans entirely, taking down every root and both
  // applications, and surfaced as a 500 with the orphan feature simply unusable.
  const scan = await scanOrphans(config, connectedArr([path.join(otherRoot, 'Tracked.mkv')]));

  assert.match(scan.warnings.join(' '), /could not read 1 folder\(s\)/);
  // The unreadable root is withheld, but the readable one still produces results.
  assert.deepEqual(scan.candidates.map((candidate) => candidate.path), [path.join(otherRoot, 'Stray.mkv')]);
});

test('an incomplete download-root walk withholds that root', { skip: isRoot }, async (context) => {
  const root = await fixture(context);
  const movies = path.join(root, 'movies');
  const downloads = path.join(root, 'downloads');
  await mkdir(movies, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const tracked = path.join(movies, 'Film.mkv');
  await writeFile(tracked, 'a');
  await writeFile(path.join(downloads, 'Release.mkv'), 'b');
  const blocked = path.join(downloads, 'blocked');
  await mkdir(blocked);
  await chmod(blocked, 0o000);
  context.after(() => chmod(blocked, 0o755).catch(() => {}));

  const config = baseConfig({
    instances: [{ id: 'radarr', kind: 'radarr', mediaRoots: [movies], downloadRoots: [downloads] }],
  });
  const scan = await scanOrphans(config, connectedArr([tracked]));

  assert.deepEqual(scan.candidates.filter((candidate) => candidate.source === 'download'), []);
  assert.match(scan.warnings.join(' '), /could not read 1 folder\(s\)/);
});
