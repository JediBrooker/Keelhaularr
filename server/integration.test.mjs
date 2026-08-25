import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { link, mkdtemp, mkdir, open, readFile, readdir, rm, stat } from 'node:fs/promises';
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
  const movieDownloadsRoot = path.join(tempRoot, 'torrents', 'movies');
  const tvDownloadsRoot = path.join(tempRoot, 'torrents', 'tv');
  const quarantineRoot = path.join(tempRoot, 'quarantine');
  const trackedMovie = path.join(moviesRoot, 'Tracked Movie', 'Tracked.Movie.mkv');
  const orphanMovie = path.join(moviesRoot, 'Orphan Movie', 'Orphan.Movie.mkv');
  const trackedEpisode = path.join(tvRoot, 'Show', 'Season 01', 'Show.S01E01.mkv');
  const orphanEpisode = path.join(tvRoot, 'Lost Show', 'Lost.Show.S01E01.mkv');
  const linkedMovieDownload = path.join(movieDownloadsRoot, 'Tracked.Movie.Release.mkv');
  const linkedEpisodeDownload = path.join(tvDownloadsRoot, 'Show.S01E01.Release.mkv');
  const staleMovieDownload = path.join(movieDownloadsRoot, 'Avatar.Fire.And.Ash.2160p.mkv');
  const relinkedBeforeApply = path.join(movieDownloadsRoot, 'Relinked.Before.Apply.mkv');
  await Promise.all([
    sparseFile(trackedMovie, 12 * 1024 ** 3),
    sparseFile(orphanMovie, 2 * 1024 ** 2),
    sparseFile(trackedEpisode, 6 * 1024 ** 3),
    sparseFile(orphanEpisode, 3 * 1024 ** 2),
    sparseFile(staleMovieDownload, 35 * 1024 ** 3),
    sparseFile(relinkedBeforeApply, 4 * 1024 ** 2),
    mkdir(tvDownloadsRoot, { recursive: true }),
    mkdir(quarantineRoot, { recursive: true }),
  ]);
  await Promise.all([
    link(trackedMovie, linkedMovieDownload),
    link(trackedEpisode, linkedEpisodeDownload),
  ]);

  const commands = [];
  const deletes = [];
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    let value;
    if (request.method === 'GET' && url.pathname === '/api/v3/system/status') value = { version: 'test-1.0' };
    else if (request.method === 'GET' && url.pathname === '/api/v3/rootfolder') value = [{ path: moviesRoot }, { path: tvRoot }];
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

  const childEnvironment = {
    ...process.env,
    CONFIG_DIR: path.join(tempRoot, 'config'),
    PORT: String(appPort),
    APP_USERNAME: 'captain',
    APP_PASSWORD: 'test-password',
    APP_SESSION_SECRET: 'test-session-secret',
    RADARR_URL: `http://127.0.0.1:${mockPort}`,
    RADARR_API_KEY: 'test',
    RADARR_MEDIA_ROOTS: moviesRoot,
    RADARR_DOWNLOAD_ROOTS: movieDownloadsRoot,
    SONARR_URL: `http://127.0.0.1:${mockPort}`,
    SONARR_API_KEY: 'test',
    SONARR_MEDIA_ROOTS: tvRoot,
    SONARR_DOWNLOAD_ROOTS: tvDownloadsRoot,
    MAX_MB_PER_MIN: '85',
    OVERSIZE_TOLERANCE_GIB: '1',
    ORPHAN_ACTION: 'quarantine',
    ORPHAN_TRASH_DIR: quarantineRoot,
    HARDLINK_MIN_AGE_HOURS: '0',
    STORAGE_ROOTS: `${moviesRoot},${tvRoot}`,
  };
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let restartedChild;

  context.after(async () => {
    child.kill('SIGTERM');
    restartedChild?.kill('SIGTERM');
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

  const request = (url, body = {}, method = 'POST') => fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

  const initialSettingsResponse = await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } });
  assert.equal(initialSettingsResponse.status, 200);
  const initialSettingsText = await initialSettingsResponse.text();
  assert.equal(initialSettingsText.includes('test-password'), false);
  assert.equal(initialSettingsText.includes('"apiKey":"test"'), false);
  const initialSettings = JSON.parse(initialSettingsText).settings;
  assert.equal(initialSettings.radarr.apiKeyConfigured, true);
  assert.equal(initialSettings.defaults.maxMbPerMinute, 85);
  assert.deepEqual(initialSettings.server.storageRoots, [moviesRoot, tvRoot]);

  const settingsUpdate = {
    account: {
      username: 'captain',
      newPassword: 'yo',
      sessionDays: 14,
      cookieSecure: false,
      rotateSessions: false,
    },
    defaults: { maxMbPerMinute: 70, toleranceGib: 0.5 },
    radarr: {
      url: `http://127.0.0.1:${mockPort}`,
      apiKey: 'updated-radarr-key',
      clearApiKey: false,
      maxMbPerMinuteOverride: null,
      toleranceGibOverride: null,
      includeUnmonitored: false,
      mediaRoots: [moviesRoot],
      downloadRoots: [movieDownloadsRoot],
      pathMaps: [],
    },
    sonarr: {
      url: `http://127.0.0.1:${mockPort}`,
      apiKey: '',
      clearApiKey: false,
      maxMbPerMinuteOverride: 75,
      toleranceGibOverride: null,
      includeUnmonitored: false,
      mediaRoots: [tvRoot],
      downloadRoots: [tvDownloadsRoot],
      pathMaps: [],
    },
    orphan: {
      action: 'quarantine',
      trashDir: quarantineRoot,
      allowPermanentDelete: false,
      ignoreDirectories: ['extras', 'trailers'],
      maxFiles: 50000,
      hardlinkMinAgeHours: 0,
      mediaExtensions: ['mkv', 'mp4'],
    },
  };
  const saveSettingsResponse = await request('/api/settings', settingsUpdate, 'PUT');
  assert.equal(saveSettingsResponse.status, 200);
  const savedSettingsText = await saveSettingsResponse.text();
  assert.equal(savedSettingsText.includes('updated-radarr-key'), false);
  assert.equal(savedSettingsText.includes('"newPassword"'), false);
  const savedSettings = JSON.parse(savedSettingsText);
  assert.equal(savedSettings.settings.defaults.maxMbPerMinute, 70);
  assert.equal(savedSettings.settings.sonarr.maxMbPerMinuteOverride, 75);
  assert.equal(savedSettings.config.radarr.maxMbPerMinute, 70);
  assert.equal(savedSettings.config.sonarr.maxMbPerMinute, 75);

  const persistedPath = path.join(tempRoot, 'config', 'settings.json');
  const persisted = JSON.parse(await readFile(persistedPath, 'utf8'));
  assert.equal(persisted.values.APP_PASSWORD, 'yo');
  assert.equal(persisted.values.RADARR_API_KEY, 'updated-radarr-key');
  assert.equal((await stat(persistedPath)).mode & 0o777, 0o600);

  const testConnection = await request('/api/settings/test', {
    app: 'radarr',
    url: `http://127.0.0.1:${mockPort}`,
    apiKey: '',
  });
  assert.equal(testConnection.status, 200);
  const connectionResult = await testConnection.json();
  assert.equal(connectionResult.version, 'test-1.0');
  assert.deepEqual(connectionResult.rootFolders, [moviesRoot, tvRoot]);

  const scanResponse = await request('/api/scan');
  assert.equal(scanResponse.status, 200);
  const scan = await scanResponse.json();
  assert.deepEqual(scan.oversized.map((item) => item.app).sort(), ['radarr', 'sonarr']);
  assert.deepEqual(scan.orphans.map((item) => item.title).sort(), [
    'Avatar.Fire.And.Ash.2160p.mkv',
    'Lost.Show.S01E01.mkv',
    'Orphan.Movie.mkv',
    'Relinked.Before.Apply.mkv',
  ]);
  assert.equal(scan.orphans.find((item) => item.title === 'Avatar.Fire.And.Ash.2160p.mkv').source, 'download');
  assert.equal(scan.orphans.some((item) => item.title === 'Tracked.Movie.Release.mkv'), false);
  assert.equal(scan.orphans.some((item) => item.title === 'Show.S01E01.Release.mkv'), false);

  const oversized = await request('/api/oversized/apply', { ids: scan.oversized.map((item) => item.id) });
  const oversizedResult = await oversized.json();
  assert.equal(oversizedResult.matched, 2);
  assert.equal(oversizedResult.results.every((result) => result.status === 'deleted'), true);
  assert.equal(deletes.length, 2);
  assert.deepEqual(commands.map((command) => command.name).sort(), ['EpisodeSearch', 'MoviesSearch']);

  const recoveredLibraryPath = path.join(moviesRoot, 'Recovered', 'Relinked.Before.Apply.mkv');
  await mkdir(path.dirname(recoveredLibraryPath), { recursive: true });
  await link(relinkedBeforeApply, recoveredLibraryPath);
  const orphans = await request('/api/orphans/apply', { ids: scan.orphans.map((item) => item.id) });
  const orphanResult = await orphans.json();
  assert.equal(orphanResult.matched, 3);
  assert.equal(orphanResult.results.every((result) => result.status === 'quarantined'), true);
  assert.equal((await collectFiles(quarantineRoot)).length, 3);
  assert.equal((await stat(relinkedBeforeApply)).nlink, 2);

  const unauthenticated = await fetch(`${base}/api/status`);
  assert.equal(unauthenticated.status, 401);
  const oldPassword = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'test-password' }),
  });
  assert.equal(oldPassword.status, 401);
  const newPassword = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'yo' }),
  });
  assert.equal(newPassword.status, 200);
  const ui = await fetch(base);
  assert.equal(ui.status, 200);

  child.kill('SIGTERM');
  await once(child, 'exit');
  const restartedPort = await freePort();
  restartedChild = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: { ...childEnvironment, PORT: String(restartedPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const restartedBase = `http://127.0.0.1:${restartedPort}`;
  await waitFor(`${restartedBase}/api/auth/status`);
  const persistedLogin = await fetch(`${restartedBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'yo' }),
  });
  assert.equal(persistedLogin.status, 200);
  const persistedCookie = persistedLogin.headers.get('set-cookie')?.split(';', 1)[0];
  const persistedSettingsResponse = await fetch(`${restartedBase}/api/settings`, { headers: { Cookie: persistedCookie } });
  assert.equal(persistedSettingsResponse.status, 200);
  assert.equal((await persistedSettingsResponse.json()).settings.defaults.maxMbPerMinute, 70);
});
