// End-to-end proof that the reclaimed figures reflect what actually happened:
// a quarantine run must NOT count as freed space, a permanent run must, and purging
// from the Brig must move bytes from pending to reclaimed.
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open as fsOpen, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';

test('reclaimed-space accounting separates freed bytes from bytes still held in the Brig', async (context) => {
  const GIB = 1024 ** 3;
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-hist-'));
  const movies = path.join(root, 'movies');
  const quarantine = path.join(root, 'quarantine');
  const fileA = path.join(movies, 'Movie A (2020)', 'A.mkv');
  const fileB = path.join(movies, 'Movie B (2020)', 'B.mkv');
  for (const [f, size] of [[fileA, 30 * GIB], [fileB, 20 * GIB]]) {
  await mkdir(path.dirname(f), { recursive: true });
  const h = await fsOpen(f, 'w');
  await h.truncate(size);
  await h.close();
  }
  await mkdir(quarantine, { recursive: true });

  let deletedIds = new Set();
  const records = () => [
  { id: 1, title: 'Movie A', year: 2020, runtime: 120, monitored: true, hasFile: !deletedIds.has(101), path: path.dirname(fileA), movieFile: deletedIds.has(101) ? null : { id: 101, size: 30 * GIB, relativePath: 'A.mkv', quality: { quality: { id: 4, name: 'Bluray-1080p' } } } },
  { id: 2, title: 'Movie B', year: 2020, runtime: 120, monitored: true, hasFile: !deletedIds.has(102), path: path.dirname(fileB), movieFile: deletedIds.has(102) ? null : { id: 102, size: 20 * GIB, relativePath: 'B.mkv', quality: { quality: { id: 4, name: 'Bluray-1080p' } } } },
  ];

  const mock = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://mock');
  let value;
  if (url.pathname === '/api/v3/system/status') value = { version: '5.0.0' };
  else if (url.pathname === '/api/v3/movie') value = records();
  else if (/^\/api\/v3\/movie\/\d+$/.test(url.pathname)) value = { id: 1, hasFile: true };
  else if (url.pathname === '/api/v3/series') value = [];
  else if (url.pathname === '/api/v3/queue/details') value = [];
  else if (url.pathname === '/api/v3/release') value = [];
  else if (url.pathname.startsWith('/api/v3/command/')) value = { id: 1, status: 'completed' };
  else if (request.method === 'DELETE') {
    const id = Number(url.pathname.split('/').pop());
    deletedIds.add(id);
    response.writeHead(204).end();
    return;
  } else if (url.pathname === '/api/v3/command') value = { id: 7 };
  else { response.writeHead(404).end('{}'); return; }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockPort = mock.address().port;

  const sock = net.createServer();
  sock.listen(0, '127.0.0.1');
  await once(sock, 'listening');
  const appPort = sock.address().port;
  sock.close();
  await once(sock, 'close');

  const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: '/home/user/Keelhaularr',
  env: {
    ...process.env,
    CONFIG_DIR: path.join(root, 'config'), PORT: String(appPort),
    APP_USERNAME: 'captain', APP_PASSWORD: 'pw', APP_SESSION_SECRET: 'secret',
    RADARR_URL: `http://127.0.0.1:${mockPort}`, RADARR_API_KEY: 'k',
    RADARR_MEDIA_ROOTS: movies, RADARR_DOWNLOAD_ROOTS: '',
    SONARR_URL: '', SONARR_API_KEY: '', SONARR_MEDIA_ROOTS: '', SONARR_DOWNLOAD_ROOTS: '',
    QBITTORRENT_URL: '', QBITTORRENT_RECOVERY_ENABLED: 'false', SCHEDULE_ENABLED: 'false',
    MAX_MB_PER_MIN: '85', OVERSIZE_TOLERANCE_GIB: '1', ORPHAN_TRASH_DIR: quarantine,
    STORAGE_ROOTS: movies,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c; });
  child.stderr.on('data', (c) => { log += c; });

  const base = `http://127.0.0.1:${appPort}`;
  for (let i = 0; i < 200; i += 1) {
  try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 50));
  }
  const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'captain', password: 'pw' }),
  });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const call = (url, body, method = 'POST') => fetch(`${base}${url}`, {
  method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: body === undefined ? undefined : JSON.stringify(body),
  });
  const get = async (url) => (await (await fetch(`${base}${url}`, { headers: { Cookie: cookie } })).json());
  const waitJob = async (id) => {
  for (let i = 0; i < 200; i += 1) {
    const { job } = await get(`/api/jobs/${id}`);
    if (!['queued', 'running', 'cancelling'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('job never settled');
  };
  const show = async () => {
  const h = (await get('/api/history')).history;
  return h;
  };

  await show();

  // 1. Quarantine Movie A (30 GiB) -> moved, NOT freed.
  const scan1 = await (await call('/api/scan', {})).json();
  const a = scan1.oversized.find((i) => i.title.includes('Movie A'));
  await waitJob((await (await call('/api/oversized/apply', { ids: [a.id], action: 'quarantine' })).json()).job.id);
  const h1 = await show();

  // 2. Permanently remove Movie B (20 GiB) -> freed.
  const scan2 = await (await call('/api/scan', {})).json();
  const b = scan2.oversized.find((i) => i.title.includes('Movie B'));
  await waitJob((await (await call('/api/oversized/apply', { ids: [b.id], action: 'permanent', confirmPermanent: true })).json()).job.id);
  const h2 = await show();

  // 3. Purge the quarantined file -> pending becomes freed.
  const brig = await get('/api/quarantine');
  await call(`/api/quarantine/${brig.records[0].id}`, undefined, 'DELETE');
  const h3 = await show();

  // 4. The dashboard figure must agree with /api/history.
  const status = await get('/api/status');
  assert.equal(status.reclaimed.totalReclaimedBytes, h3.totalReclaimedBytes);
  assert.equal(status.reclaimed.pendingPurgeBytes, h3.pendingPurgeBytes);

  // Moving a file to the Brig must never be reported as freed space.
  assert.equal(h1.totalReclaimedBytes, 0);
  assert.equal(Math.round(h1.pendingPurgeBytes / GIB), 30);
  // A permanent removal is real free space.
  assert.equal(Math.round(h2.totalReclaimedBytes / GIB), 20);
  assert.equal(Math.round(h2.pendingPurgeBytes / GIB), 30);
  // Purging is the moment quarantined bytes become free space.
  assert.equal(Math.round(h3.totalReclaimedBytes / GIB), 50);
  assert.equal(h3.pendingPurgeBytes, 0);
  assert.equal(h3.runCount, 3);



  context.after(async () => {
    child.kill('SIGTERM');
    mock.close();
    await rm(root, { recursive: true, force: true });
  });
});
