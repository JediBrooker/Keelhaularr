import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { evaluateReplacements, normalizeRelease } from './replacements.mjs';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

// MAX_MB_PER_MIN=85 over a 120 minute runtime plus a 1 GiB tolerance.
const LIMIT_BYTES = Math.round(85 * MIB) * 120 + GIB;
const TRACKED_MOVIE_BYTES = 12 * GIB;

async function sparseFile(filePath, size) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, 'w');
  await handle.truncate(size);
  await handle.close();
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

// Generous budget, and the child's own output is surfaced on failure so a crashed
// server reports its actual error instead of an opaque timeout.
async function waitForServer(url, child, attempts = 200, delayMs = 50) {
  let output = '';
  child.stdout?.on('data', (chunk) => { output += chunk; });
  child.stderr?.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}:\n${output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Timed out waiting for ${url}. Server output:\n${output}`);
}

async function waitForJob(base, cookie, id, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${base}/api/jobs/${id}`, { headers: { Cookie: cookie } });
    if (response.ok) {
      const { job } = await response.json();
      if (!['queued', 'running', 'cancelling'].includes(job.status)) return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

async function collectFiles(root) {
  const output = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(full);
      if (entry.isFile()) output.push(full);
    }
  }
  return output;
}

/**
 * Boots a real server against a mock Radarr holding one oversized tracked movie.
 *
 * `releases` is what the mock's interactive-search endpoint returns.
 * `reportedDirectory` lets a test make the Arr-reported path fall outside every
 * configured media root, which is how the unmappable case is exercised.
 */
async function harness(context, {
  releases = [],
  requireReplacement = false,
  reportedDirectory = null,
  releaseStatus = 200,
} = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-oversize-'));
  const moviesRoot = path.join(tempRoot, 'movies');
  const quarantineRoot = path.join(tempRoot, 'quarantine');
  const trackedMovie = path.join(moviesRoot, 'Tracked Movie (2020)', 'Tracked.Movie.mkv');
  await sparseFile(trackedMovie, TRACKED_MOVIE_BYTES);
  await mkdir(quarantineRoot, { recursive: true });

  const deletes = [];
  const commands = [];
  const releaseQueries = [];
  // Snapshot of the filesystem at the moment Arr is asked to drop its record. This is
  // what proves the quarantine move happens BEFORE the record is removed.
  const stateAtDelete = [];
  let movieDeleted = false;
  let nextCommandId = 900;

  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    let value;
    if (request.method === 'GET' && url.pathname === '/api/v3/system/status') {
      value = { version: 'test-1.0' };
    } else if (request.method === 'GET' && url.pathname === '/api/v3/movie') {
      value = movieDeleted ? [{ id: 1, title: 'Tracked Movie', hasFile: false, monitored: true }] : [{
        id: 1,
        title: 'Tracked Movie',
        year: 2020,
        runtime: 120,
        monitored: true,
        hasFile: true,
        path: reportedDirectory ?? path.dirname(trackedMovie),
        movieFile: {
          id: 101,
          size: TRACKED_MOVIE_BYTES,
          relativePath: path.basename(trackedMovie),
          quality: { quality: { id: 4, name: 'Bluray-1080p' } },
        },
      }];
    } else if (request.method === 'GET' && url.pathname === '/api/v3/movie/1') {
      value = { id: 1, hasFile: !movieDeleted };
    } else if (request.method === 'GET' && url.pathname === '/api/v3/release') {
      releaseQueries.push(url.search);
      if (releaseStatus !== 200) {
        response.writeHead(releaseStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'indexer exploded' }));
        return;
      }
      value = releases;
    } else if (request.method === 'GET' && url.pathname === '/api/v3/series') {
      value = [];
    } else if (request.method === 'GET' && url.pathname === '/api/v3/queue/details') {
      value = [];
    } else if (request.method === 'GET' && url.pathname.startsWith('/api/v3/command/')) {
      value = { id: Number(url.pathname.split('/').pop()), status: 'completed' };
    } else if (request.method === 'DELETE') {
      stateAtDelete.push({
        pathname: url.pathname,
        originalStillPresent: existsSync(trackedMovie),
        quarantinedFiles: (await collectFiles(quarantineRoot)).length,
      });
      deletes.push(url.pathname);
      if (url.pathname.includes('moviefile')) movieDeleted = true;
      response.writeHead(204).end();
      return;
    } else if (request.method === 'POST' && url.pathname === '/api/v3/command') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      commands.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      nextCommandId += 1;
      value = { id: nextCommandId };
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `${request.method} ${url.pathname}` }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockPort = mock.address().port;
  const appPort = await freePort();

  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONFIG_DIR: path.join(tempRoot, 'config'),
      PORT: String(appPort),
      APP_USERNAME: 'captain',
      APP_PASSWORD: 'test-password',
      APP_SESSION_SECRET: 'test-session-secret',
      RADARR_URL: `http://127.0.0.1:${mockPort}`,
      RADARR_API_KEY: 'fixture-radarr-key',
      RADARR_MEDIA_ROOTS: moviesRoot,
      RADARR_DOWNLOAD_ROOTS: '',
      SONARR_URL: '',
      SONARR_API_KEY: '',
      SONARR_MEDIA_ROOTS: '',
      SONARR_DOWNLOAD_ROOTS: '',
      QBITTORRENT_URL: '',
      QBITTORRENT_RECOVERY_ENABLED: 'false',
      SCHEDULE_ENABLED: 'false',
      MAX_MB_PER_MIN: '85',
      OVERSIZE_TOLERANCE_GIB: '1',
      ORPHAN_TRASH_DIR: quarantineRoot,
      OVERSIZE_REQUIRE_REPLACEMENT: String(requireReplacement),
      STORAGE_ROOTS: moviesRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  context.after(async () => {
    child.kill('SIGTERM');
    mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${appPort}`;
  await waitForServer(`${base}/api/auth/status`, child);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];

  const api = (endpoint, body, method = 'POST') => fetch(`${base}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const scan = async () => {
    const response = await api('/api/scan', {});
    assert.equal(response.status, 200);
    return response.json();
  };

  return {
    base, cookie, api, scan, trackedMovie, moviesRoot, quarantineRoot,
    deletes, commands, releaseQueries, stateAtDelete,
    listQuarantine: async () => (await (await fetch(`${base}/api/quarantine`, { headers: { Cookie: cookie } })).json()),
    quarantinedFiles: () => collectFiles(quarantineRoot),
  };
}

const compliantRelease = {
  guid: 'compliant-1',
  title: 'Tracked Movie 2020 1080p BluRay x265',
  size: 9 * GIB,
  indexer: 'Test Indexer',
  seeders: 40,
  protocol: 'torrent',
  quality: { quality: { id: 4, name: 'Bluray-1080p' } },
};

const bloatedRelease = {
  guid: 'bloated-1',
  title: 'Tracked Movie 2020 2160p REMUX',
  size: 60 * GIB,
  indexer: 'Test Indexer',
  seeders: 10,
  protocol: 'torrent',
  quality: { quality: { id: 4, name: 'Bluray-1080p' } },
};

test('release evaluation only accepts a release that fits the limit and beats the current file', () => {
  const candidate = { app: 'radarr', searchIds: [1], sizeBytes: TRACKED_MOVIE_BYTES, limitBytes: LIMIT_BYTES };

  const available = evaluateReplacements(candidate, [bloatedRelease, compliantRelease]);
  assert.equal(available.status, 'available');
  assert.equal(available.compliantCount, 1);
  assert.equal(available.best.guid, 'compliant-1');

  // Fits the limit but is not smaller than what is already on disk.
  const notAnUpgrade = evaluateReplacements(
    { ...candidate, sizeBytes: 8 * GIB },
    [{ ...compliantRelease, size: 9 * GIB }],
  );
  assert.equal(notAnUpgrade.status, 'none');

  // Arr already says it would refuse this release, so it cannot count as a replacement.
  assert.equal(evaluateReplacements(candidate, [{ ...compliantRelease, rejected: true }]).status, 'none');
  assert.equal(evaluateReplacements(candidate, [bloatedRelease]).status, 'none');
  assert.equal(evaluateReplacements(candidate, []).status, 'none');

  // A file with no usable limit must never report a replacement as available.
  assert.equal(evaluateReplacements({ ...candidate, limitBytes: 0 }, [compliantRelease]).status, 'unsupported');

  assert.equal(normalizeRelease({ guid: 'g', title: 'no size' }), null);
  assert.equal(normalizeRelease({ title: 'no guid', size: 10 }), null);
  assert.equal(normalizeRelease(compliantRelease).title, 'Tracked Movie 2020 1080p BluRay x265');
});

test('the replacement check reports availability without touching the file', async (context) => {
  const app = await harness(context, { releases: [bloatedRelease, compliantRelease] });
  const scan = await app.scan();
  assert.equal(scan.oversized.length, 1);
  const candidate = scan.oversized[0];

  const response = await app.api('/api/oversized/replacements', { ids: [candidate.id] });
  assert.equal(response.status, 200);
  const [verdict] = (await response.json()).replacements;
  assert.equal(verdict.status, 'available');
  assert.equal(verdict.compliantCount, 1);
  assert.equal(verdict.best.title, compliantRelease.title);
  assert.match(app.releaseQueries[0], /movieId=1/);

  // Read-only: nothing removed, nothing searched, file untouched.
  assert.equal(existsSync(app.trackedMovie), true);
  assert.deepEqual(app.deletes, []);
  assert.deepEqual(app.commands, []);
});

test('the replacement gate withholds the delete when no compliant release exists', async (context) => {
  const app = await harness(context, { releases: [bloatedRelease], requireReplacement: true });
  const scan = await app.scan();
  const candidate = scan.oversized[0];

  const created = await app.api('/api/oversized/apply', {
    ids: [candidate.id], action: 'permanent', confirmPermanent: true,
  });
  assert.equal(created.status, 202);
  const job = await waitForJob(app.base, app.cookie, (await created.json()).job.id);

  assert.equal(job.status, 'completed_with_errors');
  assert.equal(job.items[0].status, 'failed');
  assert.match(job.items[0].error, /No compliant replacement is available/);
  assert.equal(job.items[0].replacementCheck.status, 'none');

  // The point of the gate: the file survives and Arr was never asked to drop it.
  assert.equal(existsSync(app.trackedMovie), true);
  assert.deepEqual(app.deletes, []);
  assert.deepEqual(app.commands, []);
});

test('the replacement gate withholds the delete when the interactive search fails', async (context) => {
  const app = await harness(context, { requireReplacement: true, releaseStatus: 500 });
  const scan = await app.scan();
  const created = await app.api('/api/oversized/apply', {
    ids: [scan.oversized[0].id], action: 'permanent', confirmPermanent: true,
  });
  const job = await waitForJob(app.base, app.cookie, (await created.json()).job.id);

  assert.equal(job.items[0].status, 'failed');
  assert.equal(job.items[0].replacementCheck.status, 'error');
  assert.equal(existsSync(app.trackedMovie), true);
  assert.deepEqual(app.deletes, []);
});

test('the replacement gate allows the delete once a compliant release exists', async (context) => {
  const app = await harness(context, {
    releases: [bloatedRelease, compliantRelease], requireReplacement: true,
  });
  const scan = await app.scan();
  const created = await app.api('/api/oversized/apply', {
    ids: [scan.oversized[0].id], action: 'permanent', confirmPermanent: true,
  });
  const job = await waitForJob(app.base, app.cookie, (await created.json()).job.id);

  assert.equal(job.status, 'completed');
  assert.equal(job.items[0].status, 'complete');
  assert.equal(job.items[0].replacementCheck.status, 'available');
  assert.equal(app.deletes.length, 1);
  assert.match(app.deletes[0], /moviefile\/101/);
  assert.deepEqual(app.commands, [{ name: 'MoviesSearch', movieIds: [1] }]);
});

test('quarantining an oversized file moves it to the Brig before the Arr record is removed', async (context) => {
  const app = await harness(context, { releases: [compliantRelease] });
  const scan = await app.scan();
  const candidate = scan.oversized[0];

  const created = await app.api('/api/oversized/apply', { ids: [candidate.id], action: 'quarantine' });
  assert.equal(created.status, 202);
  const job = await waitForJob(app.base, app.cookie, (await created.json()).job.id);

  assert.equal(job.status, 'completed');
  assert.equal(job.items[0].status, 'complete');
  // The finished record must still say HOW the file was removed, even after the
  // replacement search step has run.
  assert.equal(job.items[0].removal, 'quarantined');
  assert.equal(job.items[0].phase, 'search_queued');
  assert.match(job.items[0].outcome, /Moved to the Brig\. Replacement search queued\./);
  assert.equal(job.items[0].destination.startsWith(app.quarantineRoot), true);

  // Ordering is the safety property: by the time Arr is told to drop its record, the
  // file is already safely in the Brig.
  assert.equal(app.stateAtDelete.length, 1);
  assert.equal(app.stateAtDelete[0].originalStillPresent, false);
  assert.equal(app.stateAtDelete[0].quarantinedFiles, 1);

  assert.equal(existsSync(app.trackedMovie), false);
  const quarantined = await app.quarantinedFiles();
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].startsWith(app.quarantineRoot), true);

  // Recorded in the Brig against its true original path, so restore can work.
  const { records } = await app.listQuarantine();
  assert.equal(records.length, 1);
  assert.equal(records[0].originalPath, app.trackedMovie);
  assert.equal(records[0].originalRoot, app.moviesRoot);
  assert.equal(records[0].app, 'radarr');

  // A replacement search is still requested, exactly as the delete path does.
  assert.deepEqual(app.commands, [{ name: 'MoviesSearch', movieIds: [1] }]);
});

test('a quarantined oversized file can be restored from the Brig to its original path', async (context) => {
  const app = await harness(context);
  const scan = await app.scan();
  const created = await app.api('/api/oversized/apply', { ids: [scan.oversized[0].id], action: 'quarantine' });
  await waitForJob(app.base, app.cookie, (await created.json()).job.id);
  assert.equal(existsSync(app.trackedMovie), false);

  const { records } = await app.listQuarantine();
  const restored = await app.api(`/api/quarantine/${records[0].id}/restore`, {});
  assert.equal(restored.status, 200);

  assert.equal(existsSync(app.trackedMovie), true);
  assert.equal((await app.quarantinedFiles()).length, 0);
  assert.equal((await app.listQuarantine()).records.length, 0);
});

test('quarantine fails closed when the file cannot be reached inside a media root', async (context) => {
  // Radarr reports a path that is not under any configured media root and has no
  // mapping, so Keelhaularr cannot prove which file it would be moving.
  const app = await harness(context, { reportedDirectory: '/somewhere/else/Tracked Movie (2020)' });
  const scan = await app.scan();
  assert.equal(scan.oversized.length, 1);

  const created = await app.api('/api/oversized/apply', { ids: [scan.oversized[0].id], action: 'quarantine' });
  assert.equal(created.status, 409);
  assert.match((await created.json()).error, /cannot reach them inside a configured media root/);

  assert.equal(existsSync(app.trackedMovie), true);
  assert.deepEqual(app.deletes, []);
  assert.equal((await app.quarantinedFiles()).length, 0);
});

test('permanent removal of a tracked file requires explicit confirmation', async (context) => {
  const app = await harness(context);
  const scan = await app.scan();
  const ids = [scan.oversized[0].id];

  const unconfirmed = await app.api('/api/oversized/apply', { ids, action: 'permanent' });
  assert.equal(unconfirmed.status, 400);
  assert.match((await unconfirmed.json()).error, /requires explicit confirmation/);

  const badAction = await app.api('/api/oversized/apply', { ids, action: 'incinerate' });
  assert.equal(badAction.status, 400);

  assert.equal(existsSync(app.trackedMovie), true);
  assert.deepEqual(app.deletes, []);
});
