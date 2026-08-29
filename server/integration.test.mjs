import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { link, mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

async function waitForJob(base, cookie, id, attempts = 100) {
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

async function waitUntil(check, label, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
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
  const notifications = [];
  const qbittorrentLogins = [];
  let qbittorrentTorrents = [];
  const commandStates = new Map();
  let nextCommandId = 54;
  let movieDeleted = false;
  let episodeDeleted = false;
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    let value;
    if (request.method === 'POST' && url.pathname === '/api/v2/auth/login') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const credentials = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      qbittorrentLogins.push({
        username: credentials.get('username'),
        password: credentials.get('password'),
        origin: request.headers.origin,
      });
      if (credentials.get('username') !== 'qbit-admin' || credentials.get('password') !== 'qbit-secret') {
        response.writeHead(401).end('Unauthorized');
        return;
      }
      response.writeHead(204, { 'Set-Cookie': `QBT_SID_${mockPort || 0}=fixture-session; Path=/; HttpOnly` }).end();
      return;
    } else if (request.method === 'GET' && url.pathname === '/api/v2/app/version') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('5.2.0');
      return;
    } else if (request.method === 'GET' && url.pathname === '/api/v2/torrents/categories') {
      value = {
        'Kids Movies': { savePath: '/downloads/kids' },
        'do-not-touch': { savePath: '' },
      };
    } else if (request.method === 'GET' && url.pathname === '/api/v2/torrents/info') value = qbittorrentTorrents;
    else if (request.method === 'POST' && url.pathname === '/api/v2/auth/logout') {
      response.writeHead(204).end();
      return;
    } else if (request.method === 'POST' && url.pathname === '/notify') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      notifications.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      value = { ok: true };
    } else if (request.method === 'GET' && url.pathname === '/api/v3/system/status') value = { version: 'test-1.0' };
    else if (request.method === 'GET' && url.pathname === '/api/v3/rootfolder') value = [{ path: moviesRoot }, { path: tvRoot }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/qualitydefinition') value = [{ quality: { id: 4, name: 'Bluray-1080p' }, maxSize: 60 }, { quality: { id: 5, name: 'WEBDL-1080p' }, maxSize: 65 }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/movie') value = [{ id: 1, title: 'Tracked Movie', year: 2020, runtime: 120, monitored: true, hasFile: !movieDeleted, path: path.dirname(trackedMovie), movieFile: movieDeleted ? null : { id: 101, size: 12 * 1024 ** 3, relativePath: path.basename(trackedMovie), quality: { quality: { id: 4, name: 'Bluray-1080p' } } } }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/movie/1') value = { id: 1, hasFile: !movieDeleted };
    else if (request.method === 'GET' && url.pathname === '/api/v3/series') value = [{ id: 7, title: 'Show', runtime: 45, monitored: true, path: path.join(tvRoot, 'Show') }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/episodefile') value = episodeDeleted ? [] : [{ id: 701, seriesId: 7, seasonNumber: 1, size: 6 * 1024 ** 3, relativePath: path.relative(path.join(tvRoot, 'Show'), trackedEpisode), quality: { quality: { id: 5, name: 'WEBDL-1080p' } } }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/episode') value = [{ id: 7001, episodeFileId: 701, seasonNumber: 1, episodeNumber: 1, title: 'Pilot', runtime: 45, monitored: true }];
    else if (request.method === 'GET' && url.pathname === '/api/v3/episode/7001') value = { id: 7001, hasFile: !episodeDeleted };
    else if (request.method === 'GET' && url.pathname === '/api/v3/queue/details') value = [];
    else if (request.method === 'GET' && url.pathname.startsWith('/api/v3/command/')) value = commandStates.get(Number(url.pathname.split('/').pop())) ?? { id: Number(url.pathname.split('/').pop()), status: 'completed' };
    else if (request.method === 'DELETE') {
      deletes.push(url.pathname);
      if (url.pathname.includes('moviefile')) movieDeleted = true;
      if (url.pathname.includes('episodefile')) episodeDeleted = true;
      response.writeHead(204).end();
      return;
    } else if (request.method === 'POST' && url.pathname === '/api/v3/command') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      commands.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      nextCommandId += 1;
      commandStates.set(nextCommandId, { id: nextCommandId, status: 'completed' });
      value = { id: nextCommandId };
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
    RADARR_API_KEY: 'fixture-radarr-key',
    RADARR_MEDIA_ROOTS: moviesRoot,
    RADARR_DOWNLOAD_ROOTS: movieDownloadsRoot,
    SONARR_URL: `http://127.0.0.1:${mockPort}`,
    SONARR_API_KEY: 'fixture-sonarr-key',
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
  assert.equal(initialSettingsText.includes('fixture-radarr-key'), false);
  assert.equal(initialSettingsText.includes('fixture-sonarr-key'), false);
  const initialSettings = JSON.parse(initialSettingsText).settings;
  assert.equal(initialSettings.radarr.apiKeyConfigured, true);
  assert.equal(initialSettings.defaults.maxMbPerMinute, 85);
  assert.deepEqual(initialSettings.qbittorrent.recovery, {
    enabled: false,
    slowSpeedKibPerSecond: 100,
    slowMinutes: 30,
    stalledMinutes: 30,
    excludedCategories: [],
  });
  assert.deepEqual(initialSettings.server.storageRoots, [moviesRoot, tvRoot]);
  assert.equal((await fetch(`${base}/api/connections/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/settings/qbittorrent/categories`)).status, 401);
  assert.equal((await fetch(`${base}/api/qbittorrent/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/qbittorrent/recovery/status`)).status, 401);

  const initialConnectionsResponse = await fetch(`${base}/api/connections/status`, {
    headers: { Cookie: cookie },
  });
  assert.equal(initialConnectionsResponse.status, 200);
  assert.deepEqual(await initialConnectionsResponse.json(), {
    connections: {
      radarr: { status: 'connected', version: 'test-1.0', error: null },
      sonarr: { status: 'connected', version: 'test-1.0', error: null },
    },
  });

  const initialStatusResponse = await fetch(`${base}/api/status`, { headers: { Cookie: cookie } });
  assert.equal(initialStatusResponse.status, 200);
  assert.deepEqual((await initialStatusResponse.json()).ignoreSummary, {
    count: 0,
    totalSizeBytes: 0,
    unknownSizeCount: 0,
    totalOverageBytes: 0,
    unknownOverageCount: 0,
  });

  const directoryUrl = `${base}/api/storage/directories?path=${encodeURIComponent(`${moviesRoot}/`)}`;
  assert.equal((await fetch(directoryUrl)).status, 401);
  const directoriesResponse = await fetch(directoryUrl, { headers: { Cookie: cookie } });
  assert.equal(directoriesResponse.status, 200);
  const directories = await directoriesResponse.json();
  assert.deepEqual(directories.suggestions.map((entry) => entry.name), ['Orphan Movie', 'Tracked Movie']);
  assert.equal(directories.current.path, moviesRoot);
  const invalidDirectory = await fetch(`${base}/api/storage/directories?path=relative`, { headers: { Cookie: cookie } });
  assert.equal(invalidDirectory.status, 400);

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
      useArrQualityDefinitions: true,
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
      useArrQualityDefinitions: false,
      includeUnmonitored: false,
      mediaRoots: [tvRoot],
      downloadRoots: [tvDownloadsRoot],
      pathMaps: [],
    },
    qbittorrent: {
      url: `http://127.0.0.1:${mockPort}`,
      username: 'qbit-admin',
      password: 'qbit-secret',
      clearPassword: false,
      pathMaps: [],
      recovery: {
        enabled: true,
        slowSpeedKibPerSecond: 0,
        slowMinutes: 45,
        stalledMinutes: 60,
        excludedCategories: ['', 'do-not-touch', ' Kids Movies '],
      },
    },
    orphan: {
      action: 'quarantine',
      trashDir: quarantineRoot,
      allowPermanentDelete: false,
      ignoreDirectories: ['extras', 'trailers'],
      maxFiles: 50000,
      hardlinkMinAgeHours: 0,
      mediaExtensions: ['mkv', 'mp4'],
      retentionDays: 30,
    },
    schedule: {
      enabled: false,
      intervalHours: 24,
      notificationType: 'generic',
      webhookUrl: `http://127.0.0.1:${mockPort}/notify`,
      clearWebhook: false,
      notifyWhenClear: false,
    },
  };
  const saveSettingsResponse = await request('/api/settings', settingsUpdate, 'PUT');
  assert.equal(saveSettingsResponse.status, 200);
  const savedSettingsText = await saveSettingsResponse.text();
  assert.equal(savedSettingsText.includes('updated-radarr-key'), false);
  assert.equal(savedSettingsText.includes('qbit-secret'), false);
  assert.equal(savedSettingsText.includes('/notify'), false);
  assert.equal(savedSettingsText.includes('"newPassword"'), false);
  const savedSettings = JSON.parse(savedSettingsText);
  assert.equal(savedSettings.settings.defaults.maxMbPerMinute, 70);
  assert.equal(savedSettings.settings.sonarr.maxMbPerMinuteOverride, 75);
  assert.equal(savedSettings.settings.radarr.useArrQualityDefinitions, true);
  assert.equal(savedSettings.settings.qbittorrent.passwordConfigured, true);
  assert.deepEqual(savedSettings.settings.qbittorrent.recovery, settingsUpdate.qbittorrent.recovery);
  assert.equal(savedSettings.config.radarr.maxMbPerMinute, 70);
  assert.equal(savedSettings.config.sonarr.maxMbPerMinute, 75);
  assert.deepEqual(savedSettings.config.qbittorrent.recovery, settingsUpdate.qbittorrent.recovery);

  const recoveryStatusResponse = await fetch(`${base}/api/qbittorrent/recovery/status`, {
    headers: { Cookie: cookie },
  });
  assert.equal(recoveryStatusResponse.status, 200);
  const recoveryStatus = await recoveryStatusResponse.json();
  assert.equal(recoveryStatus.enabled, true);
  assert.equal(recoveryStatus.running, true);

  const changedQbittorrentSave = await request('/api/settings', {
    ...settingsUpdate,
    account: { ...settingsUpdate.account, newPassword: '' },
    qbittorrent: {
      ...settingsUpdate.qbittorrent,
      url: `http://127.0.0.1:${mockPort}/different-server`,
      password: '',
    },
  }, 'PUT');
  assert.equal(changedQbittorrentSave.status, 400);
  assert.match((await changedQbittorrentSave.json()).error, /password again/i);

  for (const [recovery, message] of [
    [{ ...settingsUpdate.qbittorrent.recovery, slowSpeedKibPerSecond: 1048577 }, /slow-speed threshold/i],
    [{ ...settingsUpdate.qbittorrent.recovery, slowMinutes: 0 }, /slow duration/i],
    [{ ...settingsUpdate.qbittorrent.recovery, stalledMinutes: 10081 }, /stalled duration/i],
    [{ ...settingsUpdate.qbittorrent.recovery, excludedCategories: ['duplicate', 'duplicate'] }, /duplicate/i],
    [{ ...settingsUpdate.qbittorrent.recovery, excludedCategories: ['x'.repeat(257)] }, /256/i],
    [{ ...settingsUpdate.qbittorrent.recovery, excludedCategories: Array.from({ length: 101 }, (_, index) => `category-${index}`) }, /100/i],
  ]) {
    const invalidRecovery = await request('/api/settings', {
      ...settingsUpdate,
      account: { ...settingsUpdate.account, newPassword: '' },
      qbittorrent: { ...settingsUpdate.qbittorrent, recovery },
    }, 'PUT');
    assert.equal(invalidRecovery.status, 400);
    assert.match((await invalidRecovery.json()).error, message);
  }

  const recoveryWithoutQbittorrent = await request('/api/settings', {
    ...settingsUpdate,
    account: { ...settingsUpdate.account, newPassword: '' },
    qbittorrent: { ...settingsUpdate.qbittorrent, url: '' },
  }, 'PUT');
  assert.equal(recoveryWithoutQbittorrent.status, 400);
  assert.match((await recoveryWithoutQbittorrent.json()).error, /configured qBittorrent/i);

  const recoveryWithoutArr = await request('/api/settings', {
    ...settingsUpdate,
    account: { ...settingsUpdate.account, newPassword: '' },
    radarr: { ...settingsUpdate.radarr, url: '', apiKey: '', clearApiKey: true },
    sonarr: { ...settingsUpdate.sonarr, url: '', apiKey: '', clearApiKey: true },
  }, 'PUT');
  assert.equal(recoveryWithoutArr.status, 400);
  assert.match((await recoveryWithoutArr.json()).error, /configured Arr/i);

  const persistedPath = path.join(tempRoot, 'config', 'settings.json');
  const persisted = JSON.parse(await readFile(persistedPath, 'utf8'));
  assert.equal(persisted.values.APP_PASSWORD, 'yo');
  assert.equal(persisted.values.RADARR_API_KEY, 'updated-radarr-key');
  assert.equal(persisted.values.QBITTORRENT_PASSWORD, 'qbit-secret');
  assert.equal(persisted.values.QBITTORRENT_RECOVERY_ENABLED, 'true');
  assert.equal(
    persisted.values.QBITTORRENT_RECOVERY_EXCLUDED_CATEGORIES_JSON,
    JSON.stringify(settingsUpdate.qbittorrent.recovery.excludedCategories),
  );
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

  const qbittorrentConnection = await request('/api/settings/test', {
    app: 'qbittorrent',
    url: `http://127.0.0.1:${mockPort}`,
    username: 'qbit-admin',
    password: '',
    pathMaps: [],
  });
  assert.equal(qbittorrentConnection.status, 200);
  const qbittorrentConnectionResult = await qbittorrentConnection.json();
  assert.equal(qbittorrentConnectionResult.version, '5.2.0');
  assert.deepEqual(qbittorrentConnectionResult.categories, [
    { name: '', savePath: '', synthetic: true },
    { name: 'Kids Movies', savePath: '/downloads/kids' },
    { name: 'do-not-touch', savePath: '' },
  ]);
  assert.deepEqual(qbittorrentLogins.at(-1), {
    username: 'qbit-admin',
    password: 'qbit-secret',
    origin: `http://127.0.0.1:${mockPort}`,
  });
  const loginCountBeforeChangedTarget = qbittorrentLogins.length;
  const changedTargetTest = await request('/api/settings/test', {
    app: 'qbittorrent',
    url: `http://127.0.0.1:${mockPort}/different-server`,
    username: 'qbit-admin',
    password: '',
    pathMaps: [],
  });
  assert.equal(changedTargetTest.status, 400);
  assert.equal(qbittorrentLogins.length, loginCountBeforeChangedTarget);

  const savedCategoriesResponse = await fetch(`${base}/api/settings/qbittorrent/categories`, {
    headers: { Cookie: cookie },
  });
  assert.equal(savedCategoriesResponse.status, 200);
  assert.deepEqual((await savedCategoriesResponse.json()).categories, [
    { name: '', savePath: '', synthetic: true },
    { name: 'Kids Movies', savePath: '/downloads/kids' },
    { name: 'do-not-touch', savePath: '' },
  ]);

  qbittorrentTorrents = [
    {
      hash: 'integration-metadata-hash',
      name: 'Integration metadata release',
      category: 'Kids Movies',
      state: 'metaDL',
      dlspeed: 0,
      progress: 0,
      amount_left: 1,
      added_on: 1,
      last_activity: 1,
    },
    {
      hash: 'integration-forced-metadata-hash',
      name: 'Integration forced metadata release',
      category: 'Kids Movies',
      state: 'forcedMetaDL',
      dlspeed: 0,
      progress: 0,
      amount_left: 1,
      added_on: 1,
      last_activity: 1,
    },
  ];
  const qbittorrentStatusResponse = await fetch(`${base}/api/qbittorrent/status`, {
    headers: { Cookie: cookie },
  });
  assert.equal(qbittorrentStatusResponse.status, 200);
  assert.deepEqual(await qbittorrentStatusResponse.json(), {
    status: 'connected',
    version: '5.2.0',
    totalTorrentCount: 2,
    incompleteTorrentCount: 2,
    metadataPendingCount: 2,
    unresolvedIncompleteCount: 0,
  });
  const scanResponse = await request('/api/scan');
  assert.equal(scanResponse.status, 200);
  const scan = await scanResponse.json();
  assert.deepEqual(scan.ignoreSummary, {
    count: 0,
    totalSizeBytes: 0,
    unknownSizeCount: 0,
    totalOverageBytes: 0,
    unknownOverageCount: 0,
  });
  assert.deepEqual(scan.oversized.map((item) => item.app).sort(), ['radarr', 'sonarr']);
  assert.equal(scan.oversized.find((item) => item.app === 'radarr').maxMbPerMinute, 60);
  assert.equal(scan.oversized.find((item) => item.app === 'radarr').limitSource, 'arr-quality-definition');
  assert.deepEqual(scan.orphans.map((item) => item.title).sort(), [
    'Avatar.Fire.And.Ash.2160p.mkv',
    'Lost.Show.S01E01.mkv',
    'Orphan.Movie.mkv',
    'Relinked.Before.Apply.mkv',
  ]);
  assert.equal(scan.orphans.find((item) => item.title === 'Avatar.Fire.And.Ash.2160p.mkv').source, 'download');
  assert.equal(scan.orphans.some((item) => item.title === 'Tracked.Movie.Release.mkv'), false);
  assert.equal(scan.orphans.some((item) => item.title === 'Show.S01E01.Release.mkv'), false);
  assert.equal(scan.qbittorrentSafety.checked, true);
  assert.equal(scan.qbittorrentSafety.metadataPendingCount, 2);
  assert.equal(scan.qbittorrentSafety.unresolvedIncompleteCount, 0);
  assert.deepEqual(scan.qbittorrentSafety.metadataPendingTorrents.map(({ name, hash, hashPrefix, state, reason, rawPath }) => ({ name, hash, hashPrefix, state, reason, rawPath })), [
    {
      name: 'Integration metadata release',
      hash: 'integration-metadata-hash',
      hashPrefix: 'integration-',
      state: 'metaDL',
      reason: 'metadata-pending',
      rawPath: null,
    },
    {
      name: 'Integration forced metadata release',
      hash: 'integration-forced-metadata-hash',
      hashPrefix: 'integration-',
      state: 'forcedMetaDL',
      reason: 'metadata-pending',
      rawPath: null,
    },
  ]);
  assert.equal(scan.warnings.some((warning) => /qBittorrent/.test(warning)), false);

  const invalidIgnoreScope = await request('/api/exclusions', {
    ids: [scan.oversized[0].id],
    scope: 'unknown',
  });
  assert.equal(invalidIgnoreScope.status, 400);
  assert.deepEqual(await invalidIgnoreScope.json(), {
    error: 'Choose either oversized or orphan ignore scope.',
  });

  const exclusionResponse = await request('/api/exclusions', { ids: [scan.oversized[0].id] });
  assert.equal(exclusionResponse.status, 200);
  const exclusionPayload = await exclusionResponse.json();
  const exclusions = exclusionPayload.exclusions;
  assert.equal(exclusions.length, 1);
  const ignoredOversized = scan.oversized.find((item) => item.id === scan.oversized[0].id);
  assert.deepEqual(exclusionPayload.ignoreSummary, {
    count: 1,
    totalSizeBytes: ignoredOversized.sizeBytes,
    unknownSizeCount: 0,
    totalOverageBytes: ignoredOversized.overageBytes,
    unknownOverageCount: 0,
  });
  assert.deepEqual({
    scope: exclusions[0].scope,
    path: exclusions[0].path,
    sizeBytes: exclusions[0].sizeBytes,
    limitBytes: exclusions[0].limitBytes,
    overageBytes: exclusions[0].overageBytes,
  }, {
    scope: 'oversized',
    path: ignoredOversized.path,
    sizeBytes: ignoredOversized.sizeBytes,
    limitBytes: ignoredOversized.limitBytes,
    overageBytes: ignoredOversized.overageBytes,
  });
  const storedOversizedExclusions = JSON.parse(await readFile(path.join(tempRoot, 'config', 'exclusions.json'), 'utf8'));
  assert.equal(storedOversizedExclusions.records[0].sizeBytes, ignoredOversized.sizeBytes);
  assert.equal(storedOversizedExclusions.records[0].limitBytes, ignoredOversized.limitBytes);
  assert.equal(storedOversizedExclusions.records[0].overageBytes, ignoredOversized.overageBytes);
  const excludedScan = await request('/api/scan');
  const excludedScanPayload = await excludedScan.json();
  assert.equal(excludedScanPayload.oversized.length, 1);
  assert.deepEqual(excludedScanPayload.ignoreSummary, exclusionPayload.ignoreSummary);
  const removeExclusionResponse = await request(`/api/exclusions/${exclusions[0].id}`, {}, 'DELETE');
  assert.equal(removeExclusionResponse.status, 200);
  assert.deepEqual((await removeExclusionResponse.json()).ignoreSummary, {
    count: 0,
    totalSizeBytes: 0,
    unknownSizeCount: 0,
    totalOverageBytes: 0,
    unknownOverageCount: 0,
  });
  const restoredScan = await request('/api/scan');
  assert.equal((await restoredScan.json()).oversized.length, 2);

  const ignoredOrphan = scan.orphans.find((item) => item.path === orphanMovie);
  assert.ok(ignoredOrphan);
  assert.equal(ignoredOrphan.exclusionKeys.length, 1);
  const orphanExclusionResponse = await request('/api/exclusions', { ids: [ignoredOrphan.id], scope: 'orphan' });
  assert.equal(orphanExclusionResponse.status, 200);
  const orphanExclusionPayload = await orphanExclusionResponse.json();
  const orphanExclusions = orphanExclusionPayload.exclusions;
  assert.equal(orphanExclusions.length, 1);
  const orphanExclusion = orphanExclusions[0];
  assert.deepEqual(orphanExclusionPayload.ignoreSummary, {
    count: 1,
    totalSizeBytes: ignoredOrphan.sizeBytes,
    unknownSizeCount: 0,
    totalOverageBytes: 0,
    unknownOverageCount: 0,
  });
  assert.deepEqual({
    scope: orphanExclusion.scope,
    app: orphanExclusion.app,
    title: orphanExclusion.title,
    subtitle: orphanExclusion.subtitle,
    path: orphanExclusion.path,
    sizeBytes: orphanExclusion.sizeBytes,
    keys: orphanExclusion.keys,
  }, {
    scope: 'orphan',
    app: ignoredOrphan.app,
    title: ignoredOrphan.title,
    subtitle: ignoredOrphan.subtitle,
    path: ignoredOrphan.path,
    sizeBytes: ignoredOrphan.sizeBytes,
    keys: ignoredOrphan.exclusionKeys,
  });
  const storedExclusions = JSON.parse(await readFile(path.join(tempRoot, 'config', 'exclusions.json'), 'utf8'));
  assert.equal(storedExclusions.records[0].scope, 'orphan');
  assert.equal(storedExclusions.records[0].path, orphanMovie);
  assert.equal(storedExclusions.records[0].sizeBytes, ignoredOrphan.sizeBytes);
  assert.equal(Object.hasOwn(storedExclusions.records[0], 'overageBytes'), false);

  const ignoredOrphanScanResponse = await request('/api/scan');
  assert.equal(ignoredOrphanScanResponse.status, 200);
  const ignoredOrphanScan = await ignoredOrphanScanResponse.json();
  assert.equal(ignoredOrphanScan.orphans.some((item) => item.id === ignoredOrphan.id), false);
  const ignoredOrphanAction = await request('/api/orphans/apply', {
    ids: [ignoredOrphan.id],
    action: 'quarantine',
  });
  assert.equal(ignoredOrphanAction.status, 409);
  assert.deepEqual(await ignoredOrphanAction.json(), {
    error: 'None of the selected orphan files are still eligible.',
  });

  const ignoredScheduleResponse = await request('/api/schedule/run');
  assert.equal(ignoredScheduleResponse.status, 200);
  const ignoredReport = (await ignoredScheduleResponse.json()).report;
  assert.equal(ignoredReport.orphanCount, scan.orphans.length - 1);
  assert.equal(
    ignoredReport.orphanBytes,
    scan.orphans.reduce((total, item) => total + item.sizeBytes, 0) - ignoredOrphan.sizeBytes,
  );

  const removeOrphanExclusionResponse = await request(`/api/exclusions/${orphanExclusion.id}`, {}, 'DELETE');
  assert.equal(removeOrphanExclusionResponse.status, 200);
  const removeOrphanExclusionPayload = await removeOrphanExclusionResponse.json();
  assert.deepEqual(removeOrphanExclusionPayload.exclusions, []);
  assert.deepEqual(removeOrphanExclusionPayload.ignoreSummary, {
    count: 0,
    totalSizeBytes: 0,
    unknownSizeCount: 0,
    totalOverageBytes: 0,
    unknownOverageCount: 0,
  });
  const restoredOrphanScanResponse = await request('/api/scan');
  assert.equal(restoredOrphanScanResponse.status, 200);
  assert.equal((await restoredOrphanScanResponse.json()).orphans.some((item) => item.id === ignoredOrphan.id), true);

  const oversized = await request('/api/oversized/apply', { ids: scan.oversized.map((item) => item.id) });
  assert.equal(oversized.status, 202);
  const oversizedResult = await oversized.json();
  const oversizedJob = await waitForJob(base, cookie, oversizedResult.job.id);
  assert.equal(oversizedJob.status, 'completed');
  assert.equal(oversizedJob.items.every((item) => item.status === 'complete'), true);
  const jobsResponse = await fetch(`${base}/api/jobs`, { headers: { Cookie: cookie } });
  const jobSummaries = (await jobsResponse.json()).jobs;
  assert.equal(jobSummaries[0].itemCount, 2);
  assert.equal(Object.hasOwn(jobSummaries[0], 'items'), false);
  assert.equal(deletes.length, 2);
  assert.deepEqual(commands.map((command) => command.name).sort(), ['EpisodeSearch', 'MoviesSearch']);

  const recoveredLibraryPath = path.join(moviesRoot, 'Recovered', 'Relinked.Before.Apply.mkv');
  await mkdir(path.dirname(recoveredLibraryPath), { recursive: true });
  await link(relinkedBeforeApply, recoveredLibraryPath);
  const orphanIds = scan.orphans.map((item) => item.id);
  const missingAction = await request('/api/orphans/apply', { ids: orphanIds });
  assert.equal(missingAction.status, 400);
  assert.deepEqual(await missingAction.json(), {
    error: 'Choose either quarantine or permanent for the selected orphan files.',
  });
  const invalidAction = await request('/api/orphans/apply', { ids: orphanIds, action: 'Permanent' });
  assert.equal(invalidAction.status, 400);
  const unconfirmedPermanent = await request('/api/orphans/apply', {
    ids: orphanIds,
    action: 'permanent',
  });
  assert.equal(unconfirmedPermanent.status, 400);
  assert.deepEqual(await unconfirmedPermanent.json(), {
    error: 'Permanent deletion requires explicit confirmation.',
  });
  const orphans = await request('/api/orphans/apply', { ids: orphanIds, action: 'quarantine' });
  assert.equal(orphans.status, 202);
  const orphanResult = await orphans.json();
  assert.equal(orphanResult.job.action, 'quarantine');
  assert.match(orphanResult.job.title, /^Quarantine 3 orphan files$/);
  const orphanJob = await waitForJob(base, cookie, orphanResult.job.id);
  assert.equal(orphanJob.status, 'completed');
  assert.equal(orphanJob.action, 'quarantine');
  assert.equal(orphanJob.items.length, 3);
  assert.equal(orphanJob.items.every((item) => item.status === 'complete'), true);
  assert.equal((await collectFiles(quarantineRoot)).length, 3);
  assert.equal((await stat(relinkedBeforeApply)).nlink, 2);

  const quarantineResponse = await fetch(`${base}/api/quarantine`, { headers: { Cookie: cookie } });
  const quarantine = await quarantineResponse.json();
  assert.equal(quarantine.records.length, 3);
  const restoreRecord = quarantine.records.find((record) => record.title === 'Orphan.Movie.mkv');
  const restoreResponse = await request(`/api/quarantine/${restoreRecord.id}/restore`);
  assert.equal(restoreResponse.status, 200);
  assert.equal((await stat(orphanMovie)).isFile(), true);
  assert.equal((await collectFiles(quarantineRoot)).length, 2);

  const permanentScanResponse = await request('/api/scan');
  assert.equal(permanentScanResponse.status, 200);
  const permanentCandidate = (await permanentScanResponse.json()).orphans
    .find((candidate) => candidate.path === orphanMovie);
  assert.ok(permanentCandidate);
  const permanentResponse = await request('/api/orphans/apply', {
    ids: [permanentCandidate.id],
    action: 'permanent',
    confirmPermanent: true,
  });
  assert.equal(permanentResponse.status, 202);
  const permanentResult = await permanentResponse.json();
  assert.equal(permanentResult.job.action, 'permanent');
  assert.equal(permanentResult.job.title, 'Delete 1 orphan file');
  const permanentJob = await waitForJob(base, cookie, permanentResult.job.id);
  assert.equal(permanentJob.status, 'completed');
  assert.equal(permanentJob.action, 'permanent');
  assert.equal(permanentJob.items[0].phase, 'deleted');
  await assert.rejects(stat(orphanMovie), { code: 'ENOENT' });

  const storageResponse = await fetch(`${base}/api/storage/health`, { headers: { Cookie: cookie } });
  assert.equal(storageResponse.status, 200);
  const storage = await storageResponse.json();
  assert.equal(storage.roots.every((root) => root.readable && root.writable), true);
  assert.equal(storage.compatibility.every((item) => item.hardlinksPossible), true);

  const reportResponse = await request('/api/schedule/run');
  assert.equal(reportResponse.status, 200);
  assert.equal((await reportResponse.json()).report.notification.status, 'sent');
  assert.equal(notifications.length, 2);

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
  const persistedJobsResponse = await fetch(`${restartedBase}/api/jobs`, { headers: { Cookie: persistedCookie } });
  assert.equal(persistedJobsResponse.status, 200);
  const persistedJobs = (await persistedJobsResponse.json()).jobs;
  assert.equal(persistedJobs.length, 3);
  assert.equal(persistedJobs.every((job) => job.status === 'completed'), true);
  const persistedQuarantineJobResponse = await fetch(
    `${restartedBase}/api/jobs/${orphanResult.job.id}`,
    { headers: { Cookie: persistedCookie } },
  );
  assert.equal(persistedQuarantineJobResponse.status, 200);
  assert.equal((await persistedQuarantineJobResponse.json()).job.action, 'quarantine');
  const persistedPermanentJobResponse = await fetch(
    `${restartedBase}/api/jobs/${permanentResult.job.id}`,
    { headers: { Cookie: persistedCookie } },
  );
  assert.equal(persistedPermanentJobResponse.status, 200);
  assert.equal((await persistedPermanentJobResponse.json()).job.action, 'permanent');
  const persistedQuarantineResponse = await fetch(`${restartedBase}/api/quarantine`, { headers: { Cookie: persistedCookie } });
  assert.equal(persistedQuarantineResponse.status, 200);
  assert.equal((await persistedQuarantineResponse.json()).records.length, 2);
  const persistedScheduleResponse = await fetch(`${restartedBase}/api/schedule`, { headers: { Cookie: persistedCookie } });
  assert.equal(persistedScheduleResponse.status, 200);
  const persistedSchedule = await persistedScheduleResponse.json();
  assert.equal(persistedSchedule.lastReport.notification.status, 'sent');
});

test('connection status probes Arr apps independently without exposing credentials', async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-connections-test-'));
  const requests = [];
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    if (request.method !== 'GET' || url.pathname !== '/api/v3/system/status') {
      response.writeHead(404).end();
      return;
    }

    const apiKey = String(request.headers['x-api-key'] ?? '');
    requests.push(apiKey);
    if (apiKey === 'radarr-status-secret') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        version: `v1\u0000radarr-status-secret-${'x'.repeat(100)}`,
      }));
      return;
    }
    if (apiKey === 'sonarr-status-secret') {
      response.writeHead(503, { 'Content-Type': 'text/plain' })
        .end(`sonarr-status-secret\n${'private detail'.repeat(100)}`);
      return;
    }
    response.writeHead(401).end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockAddress = mock.address();
  const mockPort = typeof mockAddress === 'object' && mockAddress ? mockAddress.port : 0;
  const children = [];

  context.after(async () => {
    for (const child of children) child.kill('SIGTERM');
    mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function start(sonarrConfigured) {
    const port = await freePort();
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        CONFIG_DIR: path.join(tempRoot, `config-${port}`),
        PORT: String(port),
        APP_USERNAME: 'captain',
        APP_PASSWORD: 'connection-password',
        APP_SESSION_SECRET: 'connection-session-secret',
        RADARR_URL: `http://127.0.0.1:${mockPort}`,
        RADARR_API_KEY: 'radarr-status-secret',
        RADARR_MEDIA_ROOTS: '',
        RADARR_DOWNLOAD_ROOTS: '',
        SONARR_URL: sonarrConfigured ? `http://127.0.0.1:${mockPort}` : '',
        SONARR_API_KEY: sonarrConfigured ? 'sonarr-status-secret' : '',
        SONARR_MEDIA_ROOTS: '',
        SONARR_DOWNLOAD_ROOTS: '',
        QBITTORRENT_URL: '',
        QBITTORRENT_RECOVERY_ENABLED: 'false',
        SCHEDULE_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/api/auth/status`);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'captain', password: 'connection-password' }),
    });
    assert.equal(login.status, 200);
    return { base, cookie: login.headers.get('set-cookie')?.split(';', 1)[0] };
  }

  const mixed = await start(true);
  assert.equal((await fetch(`${mixed.base}/api/connections/status`)).status, 401);
  const mixedResponse = await fetch(`${mixed.base}/api/connections/status`, {
    headers: { Cookie: mixed.cookie },
  });
  assert.equal(mixedResponse.status, 200);
  const mixedText = await mixedResponse.text();
  assert.equal(mixedText.includes('radarr-status-secret'), false);
  assert.equal(mixedText.includes('sonarr-status-secret'), false);
  assert.equal(mixedText.includes('private detail'), false);
  const mixedStatus = JSON.parse(mixedText).connections;
  assert.equal(mixedStatus.radarr.status, 'connected');
  assert.equal(mixedStatus.radarr.version.length, 64);
  assert.match(mixedStatus.radarr.version, /^v1�\[redacted\]-/);
  assert.equal(mixedStatus.radarr.error, null);
  assert.deepEqual(mixedStatus.sonarr, {
    status: 'error',
    version: null,
    error: 'Sonarr returned HTTP 503.',
  });

  const withoutSonarr = await start(false);
  const unconfiguredResponse = await fetch(`${withoutSonarr.base}/api/connections/status`, {
    headers: { Cookie: withoutSonarr.cookie },
  });
  assert.equal(unconfiguredResponse.status, 200);
  const unconfiguredStatus = (await unconfiguredResponse.json()).connections;
  assert.equal(unconfiguredStatus.radarr.status, 'connected');
  assert.deepEqual(unconfiguredStatus.sonarr, {
    status: 'not-configured',
    version: null,
    error: null,
  });
  assert.equal(requests.filter((apiKey) => apiKey === 'radarr-status-secret').length, 2);
  assert.equal(requests.filter((apiKey) => apiKey === 'sonarr-status-secret').length, 1);
});

test('an interrupted deletion resumes safely and still queues its replacement search', async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-recovery-test-'));
  let deleted = false;
  let deleteRequests = 0;
  const commands = [];
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    if (request.method === 'GET' && url.pathname === '/api/v3/system/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ version: 'recovery-test' }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v3/movie') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify([{
        id: 12,
        title: 'Recovery Movie',
        year: 2026,
        runtime: 100,
        monitored: true,
        hasFile: !deleted,
        path: '/library/Recovery Movie',
        movieFile: deleted ? null : { id: 1201, size: 20 * 1024 ** 3, relativePath: 'Recovery.Movie.mkv' },
      }]));
      return;
    }
    if (request.method === 'DELETE' && url.pathname === '/api/v3/moviefile/1201') {
      deleteRequests += 1;
      if (deleted) {
        response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'already gone' }));
        return;
      }
      deleted = true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (!response.destroyed) response.writeHead(204).end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v3/command') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      commands.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 99 }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v3/queue/details') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('[]');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v3/command/99') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 99, status: 'completed' }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `${request.method} ${url.pathname}` }));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockAddress = mock.address();
  const mockPort = typeof mockAddress === 'object' && mockAddress ? mockAddress.port : 0;
  const configDir = path.join(tempRoot, 'config');
  const environment = {
    ...process.env,
    CONFIG_DIR: configDir,
    APP_USERNAME: 'captain',
    APP_PASSWORD: 'recovery-password',
    APP_SESSION_SECRET: 'recovery-secret',
    RADARR_URL: `http://127.0.0.1:${mockPort}`,
    RADARR_API_KEY: 'test',
    RADARR_MAX_MB_PER_MIN: '10',
    RADARR_MEDIA_ROOTS: '',
    RADARR_DOWNLOAD_ROOTS: '',
    SONARR_URL: '',
    SONARR_API_KEY: '',
  };
  let child;
  let restartedChild;
  context.after(async () => {
    child?.kill('SIGKILL');
    restartedChild?.kill('SIGTERM');
    mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const start = async () => {
    const port = await freePort();
    const processChild = spawn(process.execPath, ['server/index.mjs'], {
      cwd: path.resolve('.'),
      env: { ...environment, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/api/auth/status`);
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'captain', password: 'recovery-password' }),
    });
    assert.equal(login.status, 200);
    return { processChild, base, cookie: login.headers.get('set-cookie')?.split(';', 1)[0] };
  };

  const first = await start();
  child = first.processChild;
  const scanResponse = await fetch(`${first.base}/api/scan`, { method: 'POST', headers: { Cookie: first.cookie } });
  assert.equal(scanResponse.status, 200);
  const candidate = (await scanResponse.json()).oversized[0];
  assert.ok(candidate);
  const createResponse = await fetch(`${first.base}/api/oversized/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: first.cookie },
    body: JSON.stringify({ ids: [candidate.id] }),
  });
  assert.equal(createResponse.status, 202);
  const jobId = (await createResponse.json()).job.id;
  await waitUntil(() => deleteRequests === 1, 'the first delete request');
  const interruptedState = JSON.parse(await readFile(path.join(configDir, 'jobs.json'), 'utf8'));
  assert.equal(interruptedState.jobs[0].items[0].phase, 'deleting');
  child.kill('SIGKILL');
  await once(child, 'exit');

  const second = await start();
  restartedChild = second.processChild;
  const recoveredJob = await waitForJob(second.base, second.cookie, jobId);
  assert.equal(recoveredJob.status, 'completed');
  assert.equal(recoveredJob.items[0].phase, 'search_queued');
  assert.equal(deleteRequests, 2);
  assert.deepEqual(commands, [{ name: 'MoviesSearch', movieIds: [12] }]);
});

test('ignore summaries preserve legacy records and report unknown sizes safely', async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-ignore-summary-'));
  const configDir = path.join(tempRoot, 'config');
  const gib = 1024 ** 3;
  const knownSizeBytes = 5 * gib;
  const knownOverageBytes = 0;
  const arithmeticRecords = Array.from({ length: 10 }, (_, index) => ({
    id: `ten-minus-seven-${index}`,
    keys: [`radarr:movie:${100 + index}`],
    scope: 'oversized',
    title: `Ten GiB file ${index + 1}`,
    sizeBytes: 10 * gib,
    limitBytes: 7 * gib,
    overageBytes: 0,
    createdAt: '2025-01-06T00:00:00.000Z',
  }));
  const records = [
    ...arithmeticRecords,
    {
      id: 'known-size',
      keys: ['legacy:known'],
      title: 'Known size',
      sizeBytes: knownSizeBytes,
      overageBytes: knownOverageBytes,
      createdAt: '2025-01-05T00:00:00.000Z',
    },
    {
      id: 'zero-size',
      keys: ['legacy:zero'],
      title: 'Empty file',
      scope: 'orphan',
      sizeBytes: 0,
      createdAt: '2025-01-04T00:00:00.000Z',
    },
    {
      id: 'missing-size',
      keys: ['legacy:missing'],
      title: 'Legacy record without a size',
      createdAt: '2025-01-03T00:00:00.000Z',
    },
    {
      id: 'negative-size',
      keys: ['legacy:negative'],
      title: 'Invalid negative size',
      sizeBytes: -1,
      createdAt: '2025-01-02T00:00:00.000Z',
    },
    {
      id: 'string-size',
      keys: ['legacy:string'],
      title: 'Invalid string size',
      sizeBytes: '1024',
      limitBytes: 'invalid',
      overageBytes: gib,
      createdAt: '2025-01-01T00:00:00.000Z',
    },
  ];
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, 'exclusions.json'),
    `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
  );

  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONFIG_DIR: configDir,
      PORT: String(port),
      APP_USERNAME: 'captain',
      APP_PASSWORD: 'summary-password',
      APP_SESSION_SECRET: 'summary-secret',
      RADARR_URL: '',
      RADARR_API_KEY: '',
      RADARR_MEDIA_ROOTS: '',
      RADARR_DOWNLOAD_ROOTS: '',
      SONARR_URL: '',
      SONARR_API_KEY: '',
      SONARR_MEDIA_ROOTS: '',
      SONARR_DOWNLOAD_ROOTS: '',
      QBITTORRENT_URL: '',
      SCHEDULE_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(async () => {
    child.kill('SIGTERM');
    await rm(tempRoot, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/auth/status`);
  const unauthorizedRefresh = await fetch(`${base}/api/exclusions/refresh`, { method: 'POST' });
  assert.equal(unauthorizedRefresh.status, 401);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'summary-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  const headers = { Cookie: cookie };
  const expectedSummary = {
    count: 15,
    totalSizeBytes: knownSizeBytes + (100 * gib),
    unknownSizeCount: 3,
    totalOverageBytes: knownOverageBytes + (30 * gib),
    unknownOverageCount: 4,
  };

  const statusResponse = await fetch(`${base}/api/status`, { headers });
  assert.equal(statusResponse.status, 200);
  assert.deepEqual((await statusResponse.json()).ignoreSummary, expectedSummary);

  const exclusionsResponse = await fetch(`${base}/api/exclusions`, { headers });
  assert.equal(exclusionsResponse.status, 200);
  const exclusionsPayload = await exclusionsResponse.json();
  assert.equal(exclusionsPayload.exclusions.length, records.length);
  assert.equal(exclusionsPayload.exclusions.find((record) => record.id === 'missing-size').sizeBytes, undefined);
  assert.deepEqual(exclusionsPayload.ignoreSummary, expectedSummary);

  const scanResponse = await fetch(`${base}/api/scan`, { method: 'POST', headers });
  assert.equal(scanResponse.status, 200);
  assert.deepEqual((await scanResponse.json()).ignoreSummary, expectedSummary);

  const deleteResponse = await fetch(`${base}/api/exclusions/known-size`, { method: 'DELETE', headers });
  assert.equal(deleteResponse.status, 200);
  const deletePayload = await deleteResponse.json();
  assert.equal(deletePayload.exclusions.length, records.length - 1);
  assert.deepEqual(deletePayload.ignoreSummary, {
    count: 14,
    totalSizeBytes: 100 * gib,
    unknownSizeCount: 3,
    totalOverageBytes: 30 * gib,
    unknownOverageCount: 3,
  });
});

test('manual and scheduled scans refresh exact overages while non-authoritative scans preserve them', async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-ignore-overage-backfill-'));
  const configDir = path.join(tempRoot, 'config');
  const gib = 1024 ** 3;
  const authoritativeSizeBytes = 10 * gib;
  const legacyStoredSizeBytes = 9 * gib;
  const limitBytes = 10 * 1024 ** 2 * 100;
  const expectedCurrentOverage = authoritativeSizeBytes - limitBytes;
  const legacyOverageWithoutLimit = 1234;
  const records = [
    {
      id: 'legacy-oversized',
      keys: ['radarr:movie:42'],
      scope: 'oversized',
      title: 'Legacy oversized movie',
      sizeBytes: legacyStoredSizeBytes,
      createdAt: '2025-02-03T00:00:00.000Z',
    },
    {
      id: 'orphan-without-overage',
      keys: ['orphan:path:fixture'],
      scope: 'orphan',
      title: 'Ignored orphan',
      sizeBytes: gib,
      createdAt: '2025-02-02T00:00:00.000Z',
    },
    {
      id: 'unmatched-known-overage',
      keys: ['sonarr:episode:999'],
      scope: 'oversized',
      title: 'Previously measured episode',
      sizeBytes: 2 * gib,
      overageBytes: legacyOverageWithoutLimit,
      createdAt: '2025-02-01T00:00:00.000Z',
    },
  ];
  await mkdir(configDir, { recursive: true });
  await writeFile(
    path.join(configDir, 'exclusions.json'),
    `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
  );

  let movieHasFile = true;
  let movieMonitored = true;
  let currentMovieFileId = 420;
  let currentMovieSizeBytes = authoritativeSizeBytes;
  let currentRelativePath = 'Legacy.oversized.movie.mkv';
  const mock = createServer((request, response) => {
    const url = new URL(request.url, 'http://mock');
    let value;
    if (request.method === 'GET' && url.pathname === '/api/v3/system/status') {
      value = { version: 'test-1.0' };
    } else if (request.method === 'GET' && url.pathname === '/api/v3/movie') {
      value = [{
        id: 42,
        title: 'Legacy oversized movie',
        runtime: 100,
        monitored: movieMonitored,
        hasFile: movieHasFile,
        path: '/library/Legacy oversized movie',
        movieFile: movieHasFile ? {
          id: currentMovieFileId,
          size: currentMovieSizeBytes,
          relativePath: currentRelativePath,
          quality: { quality: { id: 4, name: 'Bluray-1080p' } },
        } : null,
      }];
    } else {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockAddress = mock.address();
  const mockPort = typeof mockAddress === 'object' && mockAddress ? mockAddress.port : 0;
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONFIG_DIR: configDir,
      PORT: String(port),
      APP_USERNAME: 'captain',
      APP_PASSWORD: 'backfill-password',
      APP_SESSION_SECRET: 'backfill-secret',
      RADARR_URL: `http://127.0.0.1:${mockPort}`,
      RADARR_API_KEY: 'fixture-key',
      RADARR_MEDIA_ROOTS: '',
      RADARR_DOWNLOAD_ROOTS: '',
      RADARR_MAX_MB_PER_MIN: '',
      RADARR_OVERSIZE_TOLERANCE_GIB: '',
      RADARR_USE_ARR_QUALITY_DEFINITIONS: 'false',
      RADARR_INCLUDE_UNMONITORED: 'false',
      SONARR_URL: '',
      SONARR_API_KEY: '',
      SONARR_MEDIA_ROOTS: '',
      SONARR_DOWNLOAD_ROOTS: '',
      SONARR_MAX_MB_PER_MIN: '',
      SONARR_OVERSIZE_TOLERANCE_GIB: '',
      QBITTORRENT_URL: '',
      MAX_MB_PER_MIN: '10',
      OVERSIZE_TOLERANCE_GIB: '0',
      SCHEDULE_ENABLED: 'false',
      NOTIFICATION_WEBHOOK_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mockClosed = false;
  context.after(async () => {
    child.kill('SIGTERM');
    if (!mockClosed) mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/auth/status`);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'backfill-password' }),
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get('set-cookie')?.split(';', 1)[0] };

  const initialStatus = await fetch(`${base}/api/status`, { headers });
  assert.equal(initialStatus.status, 200);
  assert.deepEqual((await initialStatus.json()).ignoreSummary, {
    count: 3,
    totalSizeBytes: 12 * gib,
    unknownSizeCount: 0,
    totalOverageBytes: 0,
    unknownOverageCount: 2,
  });

  const refreshResponse = await fetch(`${base}/api/exclusions/refresh`, { method: 'POST', headers });
  assert.equal(refreshResponse.status, 200);
  const refreshedExclusionsPayload = await refreshResponse.json();
  assert.equal(refreshedExclusionsPayload.exclusions.length, records.length);
  assert.deepEqual(refreshedExclusionsPayload.ignoreSummary, {
    count: 3,
    totalSizeBytes: 13 * gib,
    unknownSizeCount: 0,
    totalOverageBytes: expectedCurrentOverage,
    unknownOverageCount: 1,
  });
  const refreshPersisted = JSON.parse(await readFile(path.join(configDir, 'exclusions.json'), 'utf8'));
  const refreshedLegacy = refreshPersisted.records.find((record) => record.id === 'legacy-oversized');
  assert.equal(refreshedLegacy.sizeBytes, authoritativeSizeBytes);
  assert.equal(refreshedLegacy.limitBytes, limitBytes);
  assert.equal(refreshedLegacy.overageBytes, expectedCurrentOverage);

  const scanResponse = await fetch(`${base}/api/scan`, { method: 'POST', headers });
  assert.equal(scanResponse.status, 200);
  const scan = await scanResponse.json();
  assert.deepEqual(scan.oversized, []);
  assert.deepEqual(scan.ignoreSummary, {
    count: 3,
    totalSizeBytes: 13 * gib,
    unknownSizeCount: 0,
    totalOverageBytes: expectedCurrentOverage,
    unknownOverageCount: 1,
  });
  const persisted = JSON.parse(await readFile(path.join(configDir, 'exclusions.json'), 'utf8'));
  assert.deepEqual({
    sizeBytes: persisted.records.find((record) => record.id === 'legacy-oversized').sizeBytes,
    limitBytes: persisted.records.find((record) => record.id === 'legacy-oversized').limitBytes,
    overageBytes: persisted.records.find((record) => record.id === 'legacy-oversized').overageBytes,
  }, {
    sizeBytes: authoritativeSizeBytes,
    limitBytes,
    overageBytes: expectedCurrentOverage,
  });
  assert.equal(Object.hasOwn(persisted.records.find((record) => record.id === 'orphan-without-overage'), 'overageBytes'), false);

  movieHasFile = false;
  const missingFileScanResponse = await fetch(`${base}/api/scan`, { method: 'POST', headers });
  assert.equal(missingFileScanResponse.status, 200);
  assert.deepEqual((await missingFileScanResponse.json()).ignoreSummary, scan.ignoreSummary);

  movieHasFile = true;
  movieMonitored = false;
  currentMovieSizeBytes = 500 * 1024 ** 2;
  const unmonitoredScanResponse = await fetch(`${base}/api/scan`, { method: 'POST', headers });
  assert.equal(unmonitoredScanResponse.status, 200);
  assert.deepEqual((await unmonitoredScanResponse.json()).ignoreSummary, scan.ignoreSummary);

  movieMonitored = true;
  currentMovieFileId = 421;
  currentRelativePath = 'Legacy.replacement.mkv';
  const scheduledScanResponse = await fetch(`${base}/api/schedule/run`, { method: 'POST', headers });
  assert.equal(scheduledScanResponse.status, 200);
  assert.equal((await scheduledScanResponse.json()).report.oversizedCount, 0);
  const refreshedStatusResponse = await fetch(`${base}/api/status`, { headers });
  assert.equal(refreshedStatusResponse.status, 200);
  const refreshedSummary = (await refreshedStatusResponse.json()).ignoreSummary;
  assert.deepEqual(refreshedSummary, {
    count: 3,
    totalSizeBytes: (3 * gib) + (500 * 1024 ** 2),
    unknownSizeCount: 0,
    totalOverageBytes: 0,
    unknownOverageCount: 1,
  });
  const refreshedPersistence = JSON.parse(await readFile(path.join(configDir, 'exclusions.json'), 'utf8'));
  assert.deepEqual({
    sizeBytes: refreshedPersistence.records.find((record) => record.id === 'legacy-oversized').sizeBytes,
    limitBytes: refreshedPersistence.records.find((record) => record.id === 'legacy-oversized').limitBytes,
    overageBytes: refreshedPersistence.records.find((record) => record.id === 'legacy-oversized').overageBytes,
  }, {
    sizeBytes: 500 * 1024 ** 2,
    limitBytes,
    overageBytes: 0,
  });

  await new Promise((resolve) => mock.close(resolve));
  mockClosed = true;
  const failedRefreshResponse = await fetch(`${base}/api/exclusions/refresh`, { method: 'POST', headers });
  assert.equal(failedRefreshResponse.status, 200);
  assert.deepEqual((await failedRefreshResponse.json()).ignoreSummary, refreshedSummary);
  const failedScanResponse = await fetch(`${base}/api/scan`, { method: 'POST', headers });
  assert.equal(failedScanResponse.status, 200);
  const failedScan = await failedScanResponse.json();
  assert.equal(failedScan.connections.radarr.status, 'error');
  assert.deepEqual(failedScan.ignoreSummary, refreshedSummary);
});
