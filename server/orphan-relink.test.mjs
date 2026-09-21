import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

async function waitUntil(check, label, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** A Radarr that already owns the film, so every untracked copy reads as spare. */
async function mockRadarr(context, { libraryPath, sizeBytes }) {
  const movieFile = {
    id: 900,
    path: libraryPath,
    relativePath: path.basename(libraryPath),
    size: sizeBytes,
    quality: { quality: { name: 'Bluray-1080p' } },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    for await (const chunk of request) void chunk;
    const send = (value, status = 200) => response
      .writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(value));

    if (url.pathname === '/api/v3/system/status') return send({ version: 'relink-test' });
    if (url.pathname === '/api/v3/qualitydefinition') return send([]);
    if (url.pathname === '/api/v3/tag') return send([]);
    if (url.pathname === '/api/v3/config/mediamanagement') return send({ copyUsingHardlinks: true, recycleBin: '' });
    if (url.pathname === '/api/v3/history') return send({ page: 1, pageSize: 40, totalRecords: 0, records: [] });

    if (url.pathname === '/api/v3/movie') {
      return send([{
        id: 12,
        title: 'The Film',
        year: 2024,
        runtime: 100,
        monitored: true,
        hasFile: true,
        movieFileId: 900,
        path: path.dirname(libraryPath),
        movieFile,
      }]);
    }
    if (url.pathname === '/api/v3/movie/12') {
      return send({ id: 12, title: 'The Film', year: 2024, hasFile: true, movieFileId: 900, movieFile });
    }
    // The cheap per-scan identification: a pure name match, no disk access.
    if (url.pathname === '/api/v3/parse') {
      return send({ movie: { id: 12, title: 'The Film', year: 2024 } });
    }

    if (url.pathname === '/api/v3/manualimport') {
      const folder = url.searchParams.get('folder');
      const { readdir } = await import('node:fs/promises');
      let entries = [];
      try {
        entries = await readdir(folder);
      } catch {
        entries = [];
      }
      return send(entries.filter((name) => name.endsWith('.mkv')).map((name) => ({
        path: path.join(folder, name),
        relativePath: name,
        folderName: path.basename(folder),
        name,
        size: sizeBytes,
        movie: { id: 12, title: 'The Film', year: 2024 },
        quality: { quality: { id: 7, name: 'Bluray-1080p' }, revision: { version: 1 } },
        languages: [{ id: 1, name: 'English' }],
        releaseGroup: 'GROUP',
        indexerFlags: 0,
        rejections: [],
      })));
    }
    return send({ error: `${request.method} ${url.pathname}` }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}` };
}

async function startApp(context, { mediaRoot, downloadRoot, radarrUrl }) {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'kh-relink-cfg-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONFIG_DIR: path.join(configRoot, 'config'),
      PORT: String(port),
      APP_USERNAME: 'captain',
      APP_PASSWORD: 'relink-password',
      APP_SESSION_SECRET: 'relink-secret',
      RADARR_URL: radarrUrl,
      RADARR_API_KEY: 'test',
      RADARR_MEDIA_ROOTS: mediaRoot,
      RADARR_DOWNLOAD_ROOTS: downloadRoot,
      SONARR_URL: '', SONARR_API_KEY: '', SONARR_MEDIA_ROOTS: '', SONARR_DOWNLOAD_ROOTS: '',
      QBITTORRENT_URL: '', QBITTORRENT_RECOVERY_ENABLED: 'false', SCHEDULE_ENABLED: 'false',
      HARDLINK_MIN_AGE_HOURS: '0',
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
    body: JSON.stringify({ username: 'captain', password: 'relink-password' }),
  });
  assert.equal(login.status, 200, log);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const call = (url, body, method = 'POST') => fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { base, call, log: () => log };
}

/**
 * A download folder and a library that hold the same film as two separate inodes -
 * exactly what an import that copied instead of hardlinking leaves behind.
 */
async function fixture(context, { libraryBody } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-relink-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, 'movies');
  const downloadRoot = path.join(root, 'downloads');
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(path.join(downloadRoot, 'The.Film.2024'), { recursive: true });
  const body = 'x'.repeat(4096);
  const orphan = path.join(downloadRoot, 'The.Film.2024', 'the.film.2024.mkv');
  const libraryPath = path.join(mediaRoot, 'The Film (2024).mkv');
  await writeFile(orphan, body);
  await writeFile(libraryPath, libraryBody ?? body);
  return { root, mediaRoot, downloadRoot, orphan, libraryPath, body, sizeBytes: body.length };
}

async function findOrphan(app, orphanPath) {
  const scan = await (await app.call('/api/scan')).json();
  const candidate = scan.orphans.find((entry) => entry.path === orphanPath);
  assert.ok(candidate, `orphan not found among ${scan.orphans.map((o) => o.path).join(', ')}`);
  return { candidate, scan };
}

async function waitForJob(app, jobId) {
  let job;
  await waitUntil(async () => {
    job = (await (await app.call(`/api/jobs/${jobId}`, undefined, 'GET')).json()).job;
    return !['queued', 'running', 'cancelling'].includes(job.status);
  }, `job ${jobId}`);
  return job;
}

test('a byte-identical spare copy is relinked, freeing its space without removing it', async (context) => {
  const files = await fixture(context);
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath, sizeBytes: files.sizeBytes });
  const app = await startApp(context, { ...files, radarrUrl: radarr.url });

  const { candidate } = await findOrphan(app, files.orphan);
  const beforeLibrary = await stat(files.libraryPath);
  const beforeOrphan = await stat(files.orphan);
  assert.notEqual(beforeOrphan.ino, beforeLibrary.ino, 'the fixture must start as two separate copies');

  const preview = await (await app.call('/api/preview', {
    tab: 'orphans', ids: [candidate.id], action: 'relink',
  })).json();
  assert.equal(preview.preview.rows[0].eligible, true, JSON.stringify(preview));
  // Nothing about a relink is destructive, and the dry run has to say so.
  assert.equal(preview.preview.summary.recoverable, true);

  const created = await app.call('/api/orphans/apply', { ids: [candidate.id], action: 'relink' });
  assert.equal(created.status, 202, app.log());
  const job = await waitForJob(app, (await created.json()).job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.items.map((item) => item.error)));

  const [item] = job.items;
  assert.equal(item.phase, 'relinked');
  assert.equal(item.reclaimedBytes, files.sizeBytes);

  // The file is still there, still byte-for-byte what the torrent was seeding, and now
  // shares the library file's inode.
  const afterOrphan = await stat(files.orphan);
  const afterLibrary = await stat(files.libraryPath);
  assert.equal(afterOrphan.ino, afterLibrary.ino);
  assert.equal(afterLibrary.ino, beforeLibrary.ino, 'the library file must keep its own inode');
  assert.equal(afterOrphan.nlink, 2);
  assert.equal(await readFile(files.orphan, 'utf8'), files.body);

  // And it is no longer an untracked file, because it is no longer a second copy.
  const rescan = await (await app.call('/api/scan')).json();
  assert.equal(rescan.orphans.find((entry) => entry.path === files.orphan), undefined);
});

test('a different release of the same film is refused and left exactly as it was', async (context) => {
  // Same length, different bytes: identification calls it spare either way, so only a
  // content check stands between this file and being replaced with the wrong data.
  const files = await fixture(context, { libraryBody: 'y'.repeat(4096) });
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath, sizeBytes: files.sizeBytes });
  const app = await startApp(context, { ...files, radarrUrl: radarr.url });

  const { candidate } = await findOrphan(app, files.orphan);
  const before = await stat(files.orphan);

  const preview = await (await app.call('/api/preview', {
    tab: 'orphans', ids: [candidate.id], action: 'relink',
  })).json();
  assert.equal(preview.preview.rows[0].eligible, false);

  const created = await app.call('/api/orphans/apply', { ids: [candidate.id], action: 'relink' });
  const job = await waitForJob(app, (await created.json()).job.id);
  assert.equal(job.status, 'completed_with_errors');
  assert.match(job.items[0].error, /not proven identical|different data/);

  const after = await stat(files.orphan);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(files.orphan, 'utf8'), files.body);
});

test('the scan reports a same-size spare copy as worth checking rather than as a duplicate', async (context) => {
  const files = await fixture(context, { libraryBody: 'y'.repeat(4096) });
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath, sizeBytes: files.sizeBytes });
  const app = await startApp(context, { ...files, radarrUrl: radarr.url });

  const { candidate, scan } = await findOrphan(app, files.orphan);
  const verdict = scan.duplicates.find((entry) => entry.id === candidate.id);
  // The cheap per-scan pass only compares lengths, so it must not claim identity.
  assert.equal(verdict.status, 'unverified');
  assert.equal(scan.duplicateSummary.duplicates, 0);

  // The deliberate check reads the files and settles it.
  const identified = await (await app.call('/api/orphans/identify', { ids: [candidate.id] })).json();
  assert.equal(identified.duplicates[0].status, 'distinct');
});
