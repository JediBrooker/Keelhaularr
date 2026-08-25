import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open, readdir, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

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
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server.close();
  await once(server, 'close');
  return port;
}

async function waitFor(url, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function collectFiles(root) {
  const output = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile()) output.push(fullPath);
    }
  }
  return output;
}

test('authenticated scan, replacement search, and orphan quarantine', async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-test-'));
  const moviesRoot = path.join(tempRoot, 'movies');
  const tvRoot = path.join(tempRoot, 'tv');
  const quarantineRoot = path.join(tempRoot, 'quarantine');
  const trackedMovie = path.join(moviesRoot, 'Tracked Movie', 'Tracked.Movie.mkv');
  const orphanMovie = path.join(moviesRoot, 'Orphan Movie', 'Orphan.Movie.mkv');
  const trackedEpisode = path.join(tvRoot, 'Show', 'Season 01', 'Show.S01E01.mkv');
  const orphanEpisode = path.join(tvRoot, 'Lost Show', 'Lost.Show.S01E01.mkv');
  await Promise.all([
    sparseFile(trackedMovie, 12 * 1024 ** 3),
    sparseFile(orphanMovie, 2 * 1024 ** 2),
    sparseFile(trackedEpisode, 6 * 1024 ** 3),
    sparseFile(orphanEpisode, 3 * 1024 ** 2),
    mkdir(quarantineRoot, { recursive: true }),
  ]);

  const commands = [];
  const deletes = [];
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    let value;
    if (request.method === 'GET' && url.pathname === '/api/v3/system/status') value = { version: 'test-1.0' };
    else if (request.method === 'GET' && url.pathname === '/api/v3/movie') value = [{ id: 1, title: 'Tracked Movie', year: 2020, runtime: 120, monitored: true, hasFile: true, path: path.dirname(trackedMovie), movieFile: { id: 101, size: 12 * 1024 ** 3, relativePath: path.basename(trackedMovie), quality: { quality: { name: 'Bluray-1080p' } } } }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/series') value = [{ id: 7, title: 'Show', runtime: 45, monitored: true, path: path.join(tvRoot, 'Show') }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/episodefile') value = [{ id: 701, seriesId: 7, seasonNumber: 1, size: 6 * 1024 ** 3, relativePath: path.relative(path.join(tvRoot, 'Show'), trackedEpisode), quality: { quality: { name: 'WEBDL-1080p' } } }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/episode') value = [{ id: 7001, episodeFileId: 701, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', runtime: 45, monitored: true }];
    else if (request.method === 'DELETE') {
      deletes.push(url.pathname);
      response.writeHead(204).end();
      return;
    } else if (request.method === 'POST' && url.pathname === '/api/v3/command') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      commands.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      value = { id: 55 };
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `${request.method} ${url.pathname}` }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockAddress = mock.address();
  const mockPort = typeof mockAddress === 'object' && mockAddress ? mockAddress.port : 0;
  const appPort = await freePort();

  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_USERNAME: 'captain',
      APP_PASSWORD: 'test-password',
      APP_SESSION_SECRET: 'test-session-secret',
      RADARR_URL: `http://127.0.0.1:${mockPort}`,
      RADARR_API_KEY: 'test',
      RADARR_MEDIA_ROOTS: moviesRoot,
      SONARR_URL: `http://127.0.0.1:${mockPort}`,
      SONARR_API_KEY: 'test',
      SONARR_MEDIA_ROOTS: tvRoot,
      MAX_MB_PER_MIN: '85',
      OVERSIZE_TOLERANCE_GIB: '1',
      ORPHAN_ACTION: 'quarantine',
      ORPHAN_TRASH_DIR: quarantineRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  context.after(async () => {
    child.kill('SIGTERM');
    mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${appPort}`;
  await waitFor(`${base}/api/auth/status`);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie?.startsWith('keelhaularr_session='));

  const request = (url, body = {}) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

  const scanResponse = await request('/api/scan');
  assert.equal(scanResponse.status, 200);
  const scan = await scanResponse.json();
  assert.deepEqual(scan.oversized.map((item) => item.app).sort(), ['radarr', 'sonarr']);
  assert.deepEqual(scan.orphans.map((item) => item.title).sort(), ['Lost.Show.S01E01.mkv', 'Orphan.Movie.mkv']);

  const oversized = await request('/api/oversized/apply', { ids: scan.oversized.map((item) => item.id) });
  const oversizedResult = await oversized.json();
  assert.equal(oversizedResult.matched, 2);
  assert.equal(oversizedResult.results.every((result) => result.status === 'deleted'), true);
  assert.equal(deletes.length, 2);
  assert.deepEqual(commands.map((command) => command.name).sort(), ['EpisodeSearch', 'MoviesSearch']);

  const orphans = await request('/api/orphans/apply', { ids: scan.orphans.map((item) => item.id) });
  const orphanResult = await orphans.json();
  assert.equal(orphanResult.matched, 2);
  assert.equal(orphanResult.results.every((result) => result.status === 'quarantined'), true);
  assert.equal((await collectFiles(quarantineRoot)).length, 2);

  const unauthenticated = await fetch(`${base}/api/status`);
  assert.equal(unauthenticated.status, 401);
  const ui = await fetch(base);
  assert.equal(ui.status, 200);
});
