import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return { server, port, url: `http://127.0.0.1:${port}` };
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

async function waitFor(url, child) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}:\n${output}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}:\n${output}`);
}

function json(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

function fields(values) {
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}

function arrMock({ root, category, categoryField, imported, qbittorrentPort, plexPort }) {
  return (request, response) => {
    const url = new URL(request.url, 'http://mock');
    if (request.headers['x-api-key'] !== 'arr-key') {
      response.writeHead(401).end();
      return;
    }
    if (url.pathname === '/api/v3/system/status') return json(response, { version: '5.0.0' });
    if (url.pathname === '/api/v3/rootfolder') return json(response, [{ path: root }]);
    if (url.pathname === '/api/v3/downloadclient') {
      return json(response, [{
        implementation: 'QBittorrent', enable: true, priority: 1, name: 'qBittorrent',
        // A Docker service name that only resolves inside Radarr's own network.
        fields: fields({ host: 'qbittorrent.invalid', port: qbittorrentPort, username: 'admin', password: '********', [categoryField]: category }),
      }]);
    }
    if (url.pathname === '/api/v3/notification') {
      return json(response, [{
        implementation: 'PlexServer', name: 'Plex',
        fields: fields({ host: 'localhost', port: plexPort, useSsl: false, authToken: '********' }),
      }]);
    }
    if (url.pathname === '/api/v3/remotepathmapping') return json(response, []);
    if (url.pathname === '/api/v3/history') {
      return json(response, { records: [{ eventType: 'downloadFolderImported', data: { importedPath: imported } }] });
    }
    response.writeHead(404).end();
  };
}

test('testing each connection fills in the rest of the setup', async (context) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-autofill-'));
  context.after(() => rm(tempRoot, { recursive: true, force: true }));
  // What this LXC sees: one mount at <mnt>/storage. Radarr calls its library /movies,
  // Sonarr calls its /tv, qBittorrent saves to /downloads/<category>, and Plex reads
  // /data/movies - four different names for folders that are all here.
  const mnt = path.join(tempRoot, 'mnt');
  const storage = path.join(mnt, 'storage');
  for (const folder of [
    'movies/Film (2020)',
    'tv/Show/Season 01',
    'downloads/radarr/Film.2020.1080p',
    'downloads/tv-sonarr/Show.S01',
    'downloads/tv-sonarr/Show.S02',
  ]) await mkdir(path.join(storage, folder), { recursive: true });
  await writeFile(path.join(storage, 'movies/Film (2020)/Film.mkv'), '');

  const qbittorrentPort = await freePort();
  const plexPort = await freePort();
  const qbittorrentServer = createServer((request, response) => {
    const url = new URL(request.url, 'http://mock');
    if (url.pathname === '/api/v2/auth/login') {
      response.writeHead(200, { 'Set-Cookie': 'SID=fixture; Path=/' }).end('Ok.');
      return;
    }
    if (request.headers.cookie !== 'SID=fixture') {
      response.writeHead(403).end();
      return;
    }
    if (url.pathname === '/api/v2/auth/logout') return response.writeHead(200).end();
    if (url.pathname === '/api/v2/app/version') return response.writeHead(200).end('v4.6.0');
    if (url.pathname === '/api/v2/app/defaultSavePath') return response.writeHead(200).end('/downloads');
    if (url.pathname === '/api/v2/torrents/categories') {
      return json(response, { radarr: { name: 'radarr', savePath: '/downloads/radarr' }, 'tv-sonarr': { name: 'tv-sonarr', savePath: '' } });
    }
    if (url.pathname === '/api/v2/torrents/info') {
      const torrent = (hash, category, name, progress) => ({
        hash, name, category, state: progress < 1 ? 'downloading' : 'uploading', dlspeed: 0, progress,
        amount_left: progress < 1 ? 1024 : 0, added_on: 1, last_activity: 1,
        save_path: `/downloads/${category}`, content_path: `/downloads/${category}/${name}`,
      });
      return json(response, [
        torrent('a', 'radarr', 'Film.2020.1080p', 1),
        torrent('b', 'tv-sonarr', 'Show.S01', 1),
        torrent('c', 'tv-sonarr', 'Show.S02', 0.5),
      ]);
    }
    response.writeHead(404).end();
  });
  // Listening on reserved ports so Radarr's and Sonarr's settings can name them.
  qbittorrentServer.listen(qbittorrentPort, '127.0.0.1');
  await once(qbittorrentServer, 'listening');
  const plexRequests = [];
  const plexServer = createServer((request, response) => {
    const url = new URL(request.url, 'http://mock');
    plexRequests.push(request.headers['x-plex-token']);
    if (url.pathname === '/status/sessions') return json(response, { MediaContainer: {} });
    if (url.pathname === '/library/sections') {
      return json(response, { MediaContainer: { Directory: [
        { key: '1', type: 'movie', title: 'Movies', Location: [{ path: '/data/movies' }] },
      ] } });
    }
    if (url.pathname === '/library/sections/1/all') {
      if (url.searchParams.has('lastViewedAt>>')) return json(response, { MediaContainer: { Metadata: [] } });
      return json(response, { MediaContainer: { Metadata: [
        { Media: [{ Part: [{ file: '/data/movies/Film (2020)/Film.mkv' }] }] },
      ] } });
    }
    response.writeHead(404).end();
  });
  plexServer.listen(plexPort, '127.0.0.1');
  await once(plexServer, 'listening');
  const radarr = await listen(arrMock({
    root: '/movies', category: 'radarr', categoryField: 'movieCategory',
    imported: '/movies/Film (2020)/Film.mkv', qbittorrentPort, plexPort,
  }));
  const sonarr = await listen(arrMock({
    root: '/tv', category: 'tv-sonarr', categoryField: 'tvCategory',
    imported: '/tv/Show/Season 01/Show - S01E01.mkv', qbittorrentPort, plexPort,
  }));
  context.after(() => {
    qbittorrentServer.close();
    plexServer.close();
    radarr.server.close();
    sonarr.server.close();
  });

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
      RADARR_URL: radarr.url,
      RADARR_API_KEY: 'arr-key',
      SONARR_URL: '',
      SONARR_API_KEY: '',
      STORAGE_ROOTS: mnt,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  context.after(() => child.kill('SIGTERM'));
  const base = `http://127.0.0.1:${appPort}`;
  await waitFor(`${base}/api/auth/status`, child);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'test-password' }),
  });
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  const post = async (url, body) => {
    const response = await fetch(`${base}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };

  // Radarr: its library is found through its own recent import, and its qBittorrent
  // and Plex are found where Keelhaularr can actually reach them.
  const radarrTest = await post('/api/settings/test', { app: 'radarr', url: radarr.url, apiKey: '' });
  assert.equal(radarrTest.status, 200);
  assert.deepEqual(radarrTest.body.rootFolderChecks.map(({ reported, localPath }) => ({ reported, localPath })), [
    { reported: '/movies', localPath: path.join(storage, 'movies') },
  ]);
  assert.deepEqual(radarrTest.body.discovered, {
    qbittorrent: {
      url: `http://127.0.0.1:${qbittorrentPort}`,
      reachable: true,
      username: 'admin',
      category: 'radarr',
      clientName: 'qBittorrent',
    },
    mediaServer: { kind: 'plex', url: `http://127.0.0.1:${plexPort}`, reachable: true },
    // Everything in this test is on one filesystem, so there is nothing to move.
    quarantine: null,
  });
  assert.equal(radarrTest.text.includes('arr-key'), false);
  assert.equal(radarrTest.text.includes('********'), false);

  // Sonarr is not saved yet; the form's URL and key are used.
  const sonarrTest = await post('/api/settings/test', { app: 'sonarr', url: sonarr.url, apiKey: 'arr-key' });
  assert.equal(sonarrTest.status, 200);
  assert.equal(sonarrTest.body.rootFolderChecks[0].localPath, path.join(storage, 'tv'));

  // qBittorrent: both applications' completed-download folders and the mappings that
  // reach them, with the incomplete Sonarr torrent inside the folder that was found.
  const arr = {
    radarr: { url: radarr.url, apiKey: '', mediaRoots: [path.join(storage, 'movies')], downloadRoots: [], pathMaps: [] },
    sonarr: { url: sonarr.url, apiKey: 'arr-key', mediaRoots: [path.join(storage, 'tv')], downloadRoots: [], pathMaps: [] },
  };
  const qbittorrentTest = await post('/api/settings/test', {
    app: 'qbittorrent', url: `http://127.0.0.1:${qbittorrentPort}`, username: 'admin', password: 'secret',
    pathMaps: [], downloadRoots: [], arr,
  });
  assert.equal(qbittorrentTest.status, 200);
  assert.deepEqual(qbittorrentTest.body.discovered, {
    downloadFolders: {
      radarr: { localPaths: [path.join(storage, 'downloads/radarr')], problems: [] },
      sonarr: { localPaths: [path.join(storage, 'downloads/tv-sonarr')], problems: [] },
    },
    qbittorrentPathMaps: [{ from: '/downloads', to: path.join(storage, 'downloads') }],
    arrPathMaps: {
      radarr: [{ from: '/downloads', to: path.join(storage, 'downloads') }],
      sonarr: [{ from: '/downloads', to: path.join(storage, 'downloads') }],
    },
    notes: [],
  });
  assert.equal(qbittorrentTest.body.incompleteTorrentCount, 1);
  assert.equal(qbittorrentTest.body.unmappedIncompleteCount, 0);
  assert.equal(qbittorrentTest.body.outsideDownloadRootCount, 0);

  // A saved API key is never sent to a URL it was not saved for. Half-typed folders
  // and mappings elsewhere in the form are only hints, so they do not stop the test,
  // and a one-letter password does not blank that letter out of every note.
  const movedRadarr = await post('/api/settings/test', {
    app: 'qbittorrent', url: `http://127.0.0.1:${qbittorrentPort}`, username: 'admin', password: 'a',
    pathMaps: [], downloadRoots: [],
    arr: {
      radarr: { ...arr.radarr, url: sonarr.url, mediaRoots: ['movies-typed-halfway'], pathMaps: [{ from: '/x' }] },
      sonarr: { ...arr.sonarr, url: '' },
    },
  });
  assert.equal(movedRadarr.status, 200);
  assert.deepEqual(movedRadarr.body.discovered.notes, ['Enter Radarr\'s API key to find its completed-download folder.']);
  assert.deepEqual(movedRadarr.body.discovered.downloadFolders, {});

  // Plex: its library folder is mapped to the library folder Radarr's test found.
  const plexTest = await post('/api/mediaserver/test', {
    kind: 'plex', url: `http://127.0.0.1:${plexPort}`, token: 'plex-token', pathMaps: [], watchedWithinDays: 30,
    libraryRoots: [path.join(storage, 'movies'), path.join(storage, 'tv')],
  });
  assert.equal(plexTest.status, 200);
  assert.deepEqual(plexTest.body.suggestedPathMaps, [{ from: '/data/movies', to: path.join(storage, 'movies') }]);
  assert.deepEqual(plexTest.body.unresolvedLocations, []);
  assert.ok(plexRequests.every((token) => token === 'plex-token'));
});
