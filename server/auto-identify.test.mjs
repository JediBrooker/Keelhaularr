import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

/**
 * A Radarr holding one movie, whose library state the test can flip between scans.
 *
 * `parse` here is deliberately a pure string match with no disk access, mirroring the
 * real endpoint: that is the whole reason identification can run on every scan.
 */
async function mockRadarr(context, { libraryPath }) {
  const state = { hasFile: false };
  const counts = { parse: 0, movie: 0, manualimport: 0 };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    const send = (value) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));

    if (url.pathname === '/api/v3/system/status') return send({ version: 'auto-identify' });
    if (url.pathname === '/api/v3/qualitydefinition' || url.pathname === '/api/v3/tag') return send([]);
    if (url.pathname === '/api/v3/movie') {
      counts.movie += 1;
      return send([{
        id: 12,
        title: 'The Film',
        year: 2024,
        runtime: 100,
        monitored: true,
        hasFile: state.hasFile,
        movieFileId: state.hasFile ? 900 : 0,
        path: path.dirname(libraryPath),
        movieFile: state.hasFile
          ? { id: 900, size: 1024, path: libraryPath, relativePath: path.basename(libraryPath), quality: { quality: { name: 'Bluray-1080p' } } }
          : null,
      }]);
    }
    if (url.pathname === '/api/v3/parse') {
      counts.parse += 1;
      const title = url.searchParams.get('title') ?? '';
      if (!/the\.?film/i.test(title)) return send({ title });
      return send({ title, movie: { id: 12, title: 'The Film', year: 2024 } });
    }
    if (url.pathname === '/api/v3/manualimport') {
      counts.manualimport += 1;
      return send([]);
    }
    return response.writeHead(404, { 'Content-Type': 'application/json' }).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, state, counts };
}

async function startApp(context, { mediaRoot, downloadRoot, radarrUrl, extraEnv = {} }) {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'kh-auto-cfg-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONFIG_DIR: path.join(configRoot, 'config'),
      PORT: String(port),
      APP_USERNAME: 'captain',
      APP_PASSWORD: 'auto-password',
      APP_SESSION_SECRET: 'auto-secret',
      RADARR_URL: radarrUrl,
      RADARR_API_KEY: 'test',
      RADARR_MEDIA_ROOTS: mediaRoot,
      RADARR_DOWNLOAD_ROOTS: downloadRoot,
      SONARR_URL: '', SONARR_API_KEY: '', SONARR_MEDIA_ROOTS: '', SONARR_DOWNLOAD_ROOTS: '',
      QBITTORRENT_URL: '', QBITTORRENT_RECOVERY_ENABLED: 'false', SCHEDULE_ENABLED: 'false',
      HARDLINK_MIN_AGE_HOURS: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  context.after(async () => {
    child.kill('SIGKILL');
    await rm(configRoot, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
    try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'auto-password' }),
  });
  assert.equal(login.status, 200, log);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const scan = async () => (await fetch(`${base}/api/scan`, { method: 'POST', headers: { Cookie: cookie } })).json();
  return { base, cookie, scan };
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-auto-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, 'movies');
  const downloadRoot = path.join(root, 'downloads');
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(path.join(downloadRoot, 'The.Film.2024.1080p'), { recursive: true });
  const orphan = path.join(downloadRoot, 'The.Film.2024.1080p', 'the.film.mkv');
  await writeFile(orphan, 'x'.repeat(1024));
  return { mediaRoot, downloadRoot, orphan, libraryPath: path.join(mediaRoot, 'The Film (2024).mkv') };
}

test('every scan says whether the library already has each untracked file', async (context) => {
  const files = await fixture(context);
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath });
  const app = await startApp(context, { ...files, radarrUrl: radarr.url });

  // Nobody pressed anything: the answer arrives with the scan.
  const first = await app.scan();
  assert.equal(first.orphans.length, 1);
  assert.equal(first.identifications.length, 1);
  assert.equal(first.identifications[0].id, first.orphans[0].id);
  assert.equal(first.identifications[0].status, 'importable');
  assert.equal(first.identifications[0].title, 'The Film (2024)');

  // Radarr gains the file. The verdict must follow, because it decides whether deleting
  // the copy on disk is safe - so it is recomputed per scan and never served stale.
  radarr.state.hasFile = true;
  const second = await app.scan();
  assert.equal(second.identifications[0].status, 'occupied');
  assert.match(second.identifications[0].reason, /already has a tracked file/);

  // And back again, to prove nothing is sticky in either direction.
  radarr.state.hasFile = false;
  assert.equal((await app.scan()).identifications[0].status, 'importable');
});

test('repeated scans do not re-ask about names already parsed', async (context) => {
  const files = await fixture(context);
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath });
  const app = await startApp(context, { ...files, radarrUrl: radarr.url });

  await app.scan();
  const afterFirst = radarr.counts.parse;
  assert.ok(afterFirst >= 1, 'the first scan should parse the name');

  await app.scan();
  await app.scan();
  // A release name always parses to the same movie, so it is asked once. Whether that
  // movie has a file is not cached - it comes from each fresh scan - which is what lets
  // the cache be this aggressive without ever going stale.
  assert.equal(radarr.counts.parse, afterFirst, 'later scans should reuse the parsed name');
  assert.ok(radarr.counts.movie >= 3, 'but library state is re-read every scan');

  // Identifying on every scan must never make the applications read folders from disk.
  assert.equal(radarr.counts.manualimport, 0);
});

test('automatic identification can be turned off, and is bounded when left on', async (context) => {
  const files = await fixture(context);
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath });

  const off = await startApp(context, { ...files, radarrUrl: radarr.url, extraEnv: { ORPHAN_AUTO_IDENTIFY: 'false' } });
  const scan = await off.scan();
  assert.equal(scan.orphans.length, 1);
  assert.deepEqual(scan.identifications, []);
  assert.equal(radarr.counts.parse, 0, 'nothing should be asked when the option is off');

  // A ceiling exists so a misconfigured root finding thousands of untracked files
  // cannot turn every scheduled scan into thousands of requests.
  const capped = await startApp(context, { ...files, radarrUrl: radarr.url, extraEnv: { ORPHAN_AUTO_IDENTIFY_LIMIT: '0' } });
  assert.deepEqual((await capped.scan()).identifications, []);
});
