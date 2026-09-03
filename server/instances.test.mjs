import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { allArrCandidates, arrInstanceUrls, arrInstances, arrScanResults, scanArr } from './arr.mjs';
import { getConfig } from './config.mjs';
import { scanOrphans } from './orphans.mjs';

const GIB = 1024 ** 3;

function movie(id, title, directory) {
  return {
    id,
    title,
    year: 2020,
    runtime: 100,
    monitored: true,
    hasFile: true,
    path: directory,
    tags: [],
    movieFile: {
      id: id * 100,
      size: 20 * GIB,
      relativePath: `${title}.mkv`,
      path: `${directory}/${title}.mkv`,
      quality: { quality: { id: 4, name: 'Bluray-1080p' } },
    },
  };
}

async function arrStub(context, movies) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    const send = (value) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/api/v3/system/status') return send({ version: '5.0.0' });
    if (url.pathname === '/api/v3/movie') return send(movies);
    if (url.pathname === '/api/v3/series') return send([]);
    if (url.pathname === '/api/v3/qualitydefinition') return send([]);
    if (url.pathname === '/api/v3/tag') return send([]);
    response.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('an installation with no instance list behaves exactly as it always did', async (context) => {
  const url = await arrStub(context, [movie(1, 'Film', '/movies/Film (2020)')]);
  const config = getConfig({
    RADARR_URL: url, RADARR_API_KEY: 'k', RADARR_MEDIA_ROOTS: '/movies',
    MAX_MB_PER_MIN: '85', OVERSIZE_TOLERANCE_GIB: '1',
  });

  assert.deepEqual(config.instances.map((instance) => instance.id), ['radarr', 'sonarr']);
  // The historical accessors still point at the same objects, so no call site changed
  // meaning underneath.
  assert.equal(config.radarr, config.instances[0]);
  assert.equal(config.sonarr, config.instances[1]);
  assert.equal(config.radarr, config['radarr']);

  const scan = await scanArr(config);
  const [candidate] = scan.radarr.candidates;
  // THE property that makes this change safe: candidate ids and exclusion keys embed
  // the instance id, and for a default installation that id is still the literal
  // 'radarr'. Every ignore-list entry, quarantine record and durable job ever written
  // stays valid.
  assert.equal(candidate.app, 'radarr');
  assert.deepEqual(candidate.exclusionKeys, ['radarr:movie:1']);
  assert.equal(scan.radarr.kind, 'radarr');
  assert.deepEqual(arrInstanceUrls(config), { radarr: url, sonarr: '' });
});

test('a second Radarr is scanned independently and cannot collide with the first', async (context) => {
  const primary = await arrStub(context, [movie(1, 'Film', '/movies/Film (2020)')]);
  // Deliberately the SAME movie id on the second instance: ids only collide if the
  // instance id is not part of the identity.
  const fourK = await arrStub(context, [movie(1, 'Film4K', '/movies-4k/Film (2020)')]);

  const config = getConfig({
    ARR_INSTANCES: 'radarr:radarr,radarr4k:radarr,sonarr:sonarr',
    RADARR_URL: primary, RADARR_API_KEY: 'k1', RADARR_MEDIA_ROOTS: '/movies',
    RADARR4K_URL: fourK, RADARR4K_API_KEY: 'k2', RADARR4K_MEDIA_ROOTS: '/movies-4k',
    RADARR4K_LABEL: 'Radarr 4K',
    MAX_MB_PER_MIN: '85', OVERSIZE_TOLERANCE_GIB: '1',
  });

  assert.equal(config.radarr4k.label, 'Radarr 4K');
  // Each instance resolves to its own connection through the long-standing lookup.
  assert.equal(config['radarr'].url, primary);
  assert.equal(config['radarr4k'].url, fourK);

  const scan = await scanArr(config);
  const candidates = allArrCandidates(scan);
  assert.equal(candidates.length, 2);

  const byApp = Object.fromEntries(candidates.map((candidate) => [candidate.app, candidate]));
  assert.deepEqual(Object.keys(byApp).sort(), ['radarr', 'radarr4k']);
  // Same movie id on both instances, but distinct candidate ids and exclusion keys.
  assert.notEqual(byApp.radarr.id, byApp.radarr4k.id);
  assert.deepEqual(byApp.radarr.exclusionKeys, ['radarr:movie:1']);
  assert.deepEqual(byApp.radarr4k.exclusionKeys, ['radarr4k:movie:1']);

  // Aliases must not make a result appear twice.
  assert.equal(arrScanResults(scan).length, 3);
  assert.deepEqual(arrInstanceUrls(config), { radarr: primary, radarr4k: fourK, sonarr: '' });
});

test('each instance only owns its own media root when scanning for orphans', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-instances-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const hd = path.join(root, 'movies');
  const uhd = path.join(root, 'movies-4k');
  await mkdir(hd, { recursive: true });
  await mkdir(uhd, { recursive: true });
  const hdFile = path.join(hd, 'Tracked.mkv');
  const uhdFile = path.join(uhd, 'Tracked4K.mkv');
  const stray = path.join(uhd, 'Stray.mkv');
  await writeFile(hdFile, 'a');
  await writeFile(uhdFile, 'b');
  await writeFile(stray, 'c');

  const config = getConfig({
    ARR_INSTANCES: 'radarr:radarr,radarr4k:radarr',
    RADARR_URL: 'http://one', RADARR_API_KEY: 'k1', RADARR_MEDIA_ROOTS: hd,
    RADARR4K_URL: 'http://two', RADARR4K_API_KEY: 'k2', RADARR4K_MEDIA_ROOTS: uhd,
    MEDIA_EXTENSIONS: 'mkv',
  });

  // Each instance reports only the file it actually tracks.
  const arrResults = {
    radarr: { app: 'radarr', kind: 'radarr', status: 'connected', knownPaths: new Set([hdFile]), candidates: [] },
    radarr4k: { app: 'radarr4k', kind: 'radarr4k', status: 'connected', knownPaths: new Set([uhdFile]), candidates: [] },
  };

  const scan = await scanOrphans(config, arrResults);
  const orphanPaths = scan.candidates.map((candidate) => candidate.path).sort();

  // Only the genuinely untracked file is reported. Critically, the 4K instance's
  // tracked file is NOT reported as an orphan just because the other instance does not
  // know about it - which is the failure mode a single-instance setup would have had.
  assert.deepEqual(orphanPaths, [stray]);
  assert.equal(scan.candidates[0].app, 'radarr4k');
});

test('an instance whose application is unreachable withholds only its own roots', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-instances-fail-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const hd = path.join(root, 'movies');
  const uhd = path.join(root, 'movies-4k');
  await mkdir(hd, { recursive: true });
  await mkdir(uhd, { recursive: true });
  await writeFile(path.join(hd, 'Stray.mkv'), 'a');
  await writeFile(path.join(uhd, 'Stray4K.mkv'), 'b');

  const config = getConfig({
    ARR_INSTANCES: 'radarr:radarr,radarr4k:radarr',
    RADARR_URL: 'http://one', RADARR_API_KEY: 'k1', RADARR_MEDIA_ROOTS: hd,
    RADARR4K_URL: 'http://two', RADARR4K_API_KEY: 'k2', RADARR4K_MEDIA_ROOTS: uhd,
    MEDIA_EXTENSIONS: 'mkv',
  });

  const scan = await scanOrphans(config, {
    radarr: { app: 'radarr', status: 'connected', knownPaths: new Set(), candidates: [] },
    // The 4K instance failed, so its root must be withheld rather than treated as empty.
    radarr4k: { app: 'radarr4k', status: 'error', knownPaths: new Set(), candidates: [] },
  });

  assert.deepEqual(scan.candidates.map((candidate) => candidate.path), [path.join(hd, 'Stray.mkv')]);
  assert.match(scan.warnings.join(' '), /radarr4k orphan scan withheld/);
});

test('the instance helper falls back to the historical pair for a config without a list', () => {
  const resolved = arrInstances({
    radarr: { url: 'http://r', configured: true },
    sonarr: { url: 'http://s', configured: true },
  });
  assert.deepEqual(resolved.map((instance) => instance.id), ['radarr', 'sonarr']);
  assert.deepEqual(arrInstances({}), []);
});
