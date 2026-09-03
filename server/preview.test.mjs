import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, open as fsOpen, readdir, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const GIB = 1024 ** 3;
const TRACKED_BYTES = 30 * GIB;

async function harness(context, { reportedDirectory = null, requireReplacement = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-preview-'));
  const movies = path.join(root, 'movies');
  const quarantine = path.join(root, 'quarantine');
  const tracked = path.join(movies, 'Tracked (2020)', 'Tracked.mkv');
  await mkdir(path.dirname(tracked), { recursive: true });
  const handle = await fsOpen(tracked, 'w');
  await handle.truncate(TRACKED_BYTES);
  await handle.close();
  await mkdir(quarantine, { recursive: true });

  const mutations = [];
  const mock = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    let value;
    if (url.pathname === '/api/v3/system/status') value = { version: '5.0.0' };
    else if (url.pathname === '/api/v3/movie') {
      value = [{
        id: 1, title: 'Tracked', year: 2020, runtime: 120, monitored: true, hasFile: true,
        path: reportedDirectory ?? path.dirname(tracked),
        movieFile: {
          id: 101, size: TRACKED_BYTES, relativePath: 'Tracked.mkv',
          quality: { quality: { id: 4, name: 'Bluray-1080p' } },
        },
      }];
    } else if (url.pathname === '/api/v3/series') value = [];
    else if (url.pathname === '/api/v3/queue/details') value = [];
    else if (url.pathname === '/api/v3/release') value = [];
    else if (request.method !== 'GET') {
      // Any non-GET to Radarr is a mutation. A dry run must produce none.
      mutations.push(`${request.method} ${url.pathname}`);
      response.writeHead(204).end();
      return;
    } else { response.writeHead(404).end('{}'); return; }
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
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONFIG_DIR: path.join(root, 'config'), PORT: String(appPort),
      APP_USERNAME: 'captain', APP_PASSWORD: 'pw', APP_SESSION_SECRET: 'secret',
      RADARR_URL: `http://127.0.0.1:${mockPort}`, RADARR_API_KEY: 'k',
      RADARR_MEDIA_ROOTS: movies, RADARR_DOWNLOAD_ROOTS: '',
      SONARR_URL: '', SONARR_API_KEY: '', SONARR_MEDIA_ROOTS: '', SONARR_DOWNLOAD_ROOTS: '',
      QBITTORRENT_URL: '', QBITTORRENT_RECOVERY_ENABLED: 'false', SCHEDULE_ENABLED: 'false',
      MAX_MB_PER_MIN: '85', OVERSIZE_TOLERANCE_GIB: '1', ORPHAN_TRASH_DIR: quarantine,
      OVERSIZE_REQUIRE_REPLACEMENT: String(requireReplacement), STORAGE_ROOTS: movies,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });

  context.after(async () => {
    child.kill('SIGTERM');
    mock.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${appPort}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
    try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password: 'pw' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const call = (url, body) => fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });

  const quarantineFiles = async () => {
    const found = [];
    const stack = [quarantine];
    while (stack.length) {
      const dir = stack.pop();
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        if (entry.isFile()) found.push(full);
      }
    }
    return found;
  };

  return { base, cookie, call, tracked, quarantine, mutations, quarantineFiles };
}

test('a dry run reports every gate and changes nothing at all', async (context) => {
  const app = await harness(context);
  const scan = await (await app.call('/api/scan', {})).json();
  assert.equal(scan.oversized.length, 1);
  const before = await stat(app.tracked);

  const response = await app.call('/api/preview', {
    tab: 'oversized', action: 'quarantine', ids: [scan.oversized[0].id],
  });
  assert.equal(response.status, 200);
  const { preview } = await response.json();

  assert.equal(preview.summary.total, 1);
  assert.equal(preview.summary.eligibleCount, 1);
  assert.equal(preview.summary.withheldCount, 0);
  assert.equal(preview.summary.recoverable, true);

  const [row] = preview.rows;
  assert.equal(row.eligible, true);
  assert.equal(row.action, 'quarantine');
  // It names the exact destination the real job would use.
  assert.equal(row.destination.startsWith(app.quarantine), true);
  const names = row.gates.map((entry) => entry.name);
  assert.ok(names.includes('Application connected'));
  assert.ok(names.includes('Still over its limit'));
  assert.ok(names.includes('Reachable inside a media root'));
  assert.equal(row.gates.every((entry) => ['pass', 'fail', 'warn', 'unknown'].includes(entry.status)), true);

  // The whole point: nothing moved, nothing was removed, no write reached Radarr.
  assert.equal(existsSync(app.tracked), true);
  const after = await stat(app.tracked);
  assert.equal(after.size, before.size);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(app.mutations, []);
  assert.deepEqual(await app.quarantineFiles(), []);
  assert.deepEqual((await (await fetch(`${app.base}/api/jobs`, { headers: { Cookie: app.cookie } })).json()).jobs, []);
});

test('a dry run marks permanent removal as unrecoverable and quarantine as recoverable', async (context) => {
  const app = await harness(context);
  const scan = await (await app.call('/api/scan', {})).json();
  const ids = [scan.oversized[0].id];

  const permanent = (await (await app.call('/api/preview', { tab: 'oversized', action: 'permanent', ids })).json()).preview;
  const recoverGate = permanent.rows[0].gates.find((entry) => entry.name === 'Recoverable afterwards');
  assert.equal(recoverGate.status, 'fail');
  assert.match(recoverGate.detail, /cannot be undone/);
  assert.equal(permanent.summary.recoverable, false);
  // Unrecoverability is a warning to the operator, not a reason to withhold the file.
  assert.equal(permanent.rows[0].eligible, true);
  assert.equal(permanent.rows[0].destination, null);

  const quarantined = (await (await app.call('/api/preview', { tab: 'oversized', action: 'quarantine', ids })).json()).preview;
  assert.equal(quarantined.rows[0].gates.find((entry) => entry.name === 'Recoverable afterwards'), undefined);
  assert.equal(quarantined.summary.recoverable, true);

  assert.deepEqual(app.mutations, []);
});

test('a dry run predicts the unreachable-path refusal before anything is attempted', async (context) => {
  const app = await harness(context, { reportedDirectory: '/somewhere/else/Tracked (2020)' });
  const scan = await (await app.call('/api/scan', {})).json();

  const { preview } = await (await app.call('/api/preview', {
    tab: 'oversized', action: 'quarantine', ids: [scan.oversized[0].id],
  })).json();

  const [row] = preview.rows;
  assert.equal(row.eligible, false);
  assert.equal(preview.summary.withheldCount, 1);
  const reach = row.gates.find((entry) => entry.name === 'Reachable inside a media root');
  assert.equal(reach.status, 'fail');
  assert.match(reach.detail, /configured media root/);
  assert.deepEqual(app.mutations, []);
});

test('the replacement gate is reported as pending when the policy is on but not pre-checked', async (context) => {
  const app = await harness(context, { requireReplacement: true });
  const scan = await (await app.call('/api/scan', {})).json();

  // Without checkReplacements the indexers are not queried, so the gate is honest
  // about being deferred rather than claiming a verdict it has not established.
  const deferred = (await (await app.call('/api/preview', {
    tab: 'oversized', action: 'quarantine', ids: [scan.oversized[0].id],
  })).json()).preview;
  const pending = deferred.rows[0].gates.find((entry) => entry.name === 'Compliant replacement available');
  assert.equal(pending.status, 'unknown');
  assert.match(pending.detail, /immediately before removal/);

  // With it on, the mock offers no releases, so the gate fails under the policy.
  const checked = (await (await app.call('/api/preview', {
    tab: 'oversized', action: 'quarantine', ids: [scan.oversized[0].id], checkReplacements: true,
  })).json()).preview;
  const verdict = checked.rows[0].gates.find((entry) => entry.name === 'Compliant replacement available');
  assert.equal(verdict.status, 'fail');
  assert.equal(checked.rows[0].eligible, false);
  assert.deepEqual(app.mutations, []);
});

test('preview rejects malformed requests', async (context) => {
  const app = await harness(context);
  const scan = await (await app.call('/api/scan', {})).json();
  const ids = [scan.oversized[0].id];

  assert.equal((await app.call('/api/preview', { tab: 'nonsense', action: 'quarantine', ids })).status, 400);
  assert.equal((await app.call('/api/preview', { tab: 'oversized', action: 'incinerate', ids })).status, 400);
  assert.equal((await app.call('/api/preview', { tab: 'oversized', action: 'quarantine', ids: [] })).status, 400);
  assert.equal((await app.call('/api/preview', { tab: 'oversized', action: 'quarantine', ids: ['nope'] })).status, 409);
  assert.deepEqual(app.mutations, []);
});
