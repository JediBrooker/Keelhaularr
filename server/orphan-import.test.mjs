import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { link, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * A Radarr that owns one movie and can be told to behave like a real import.
 *
 * `importBehaviour` decides what the mock does to the filesystem when the ManualImport
 * command arrives - hardlink, move, or nothing - which is how the test exercises the
 * three outcomes that matter without depending on a real Radarr.
 */
async function mockRadarr(context, { libraryPath, importBehaviour }) {
  const state = { hasFile: false, movieFilePath: null };
  const commands = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const send = (value, status = 200) => response
      .writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(value));

    if (url.pathname === '/api/v3/system/status') return send({ version: 'import-test' });
    if (url.pathname === '/api/v3/rootfolder') return send([{ path: '/library' }]);
    if (url.pathname === '/api/v3/qualitydefinition') return send([]);
    if (url.pathname === '/api/v3/tag') return send([]);

    if (url.pathname === '/api/v3/movie') {
      return send([{
        id: 12,
        title: 'The Film',
        year: 2024,
        runtime: 100,
        monitored: true,
        hasFile: state.hasFile,
        path: path.dirname(libraryPath),
        movieFile: state.hasFile
          ? { id: 900, size: 1024, relativePath: path.basename(libraryPath), path: state.movieFilePath, quality: { quality: { name: 'Bluray-1080p' } } }
          : null,
      }]);
    }

    if (url.pathname === '/api/v3/movie/12') {
      return send({
        id: 12,
        title: 'The Film',
        year: 2024,
        hasFile: state.hasFile,
        movieFileId: state.hasFile ? 900 : 0,
        movieFile: state.hasFile
          ? { id: 900, path: state.movieFilePath, size: 1024, quality: { quality: { name: 'Bluray-1080p' } } }
          : null,
      });
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
        size: 1024,
        movie: { id: 12, title: 'The Film', year: 2024 },
        quality: { quality: { id: 7, name: 'Bluray-1080p' }, revision: { version: 1 } },
        languages: [{ id: 1, name: 'English' }],
        releaseGroup: 'GROUP',
        indexerFlags: 0,
        rejections: [],
      })));
    }

    if (url.pathname === '/api/v3/command' && request.method === 'POST') {
      const command = JSON.parse(body);
      commands.push(command);
      if (command.name === 'ManualImport') {
        const source = command.files[0].path;
        await mkdir(path.dirname(libraryPath), { recursive: true });
        if (importBehaviour === 'hardlink') {
          // What Radarr does while a torrent is still seeding: the source stays put.
          await link(source, libraryPath);
          state.hasFile = true;
          state.movieFilePath = libraryPath;
        } else if (importBehaviour === 'move') {
          const { rename } = await import('node:fs/promises');
          await rename(source, libraryPath);
          state.hasFile = true;
          state.movieFilePath = libraryPath;
        }
        // 'none' leaves the library untouched while still reporting success, which is
        // what a rejection during the import itself looks like from the outside.
      }
      return send({ id: 99, name: command.name, status: 'queued' });
    }

    if (url.pathname === '/api/v3/command/99') return send({ id: 99, status: 'completed' });

    return send({ error: `${request.method} ${url.pathname}` }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, commands, state };
}

async function startApp(context, { mediaRoot, downloadRoot, radarrUrl }) {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'kh-import-cfg-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONFIG_DIR: path.join(configRoot, 'config'),
      PORT: String(port),
      APP_USERNAME: 'captain',
      APP_PASSWORD: 'import-password',
      APP_SESSION_SECRET: 'import-secret',
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
    body: JSON.stringify({ username: 'captain', password: 'import-password' }),
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

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-import-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const mediaRoot = path.join(root, 'movies');
  const downloadRoot = path.join(root, 'downloads');
  await mkdir(mediaRoot, { recursive: true });
  await mkdir(path.join(downloadRoot, 'The.Film.2024'), { recursive: true });
  const orphan = path.join(downloadRoot, 'The.Film.2024', 'the.film.2024.mkv');
  await writeFile(orphan, 'x'.repeat(1024));
  return { root, mediaRoot, downloadRoot, orphan, libraryPath: path.join(mediaRoot, 'The Film (2024).mkv') };
}

async function findOrphan(app, orphanPath) {
  const scan = await (await app.call('/api/scan')).json();
  const candidate = scan.orphans.find((entry) => entry.path === orphanPath);
  assert.ok(candidate, `orphan not found among ${scan.orphans.map((o) => o.path).join(', ')}`);
  return candidate;
}

async function waitForJob(app, jobId) {
  let job;
  await waitUntil(async () => {
    job = (await (await app.call(`/api/jobs/${jobId}`, undefined, 'GET')).json()).job;
    return !['queued', 'running', 'cancelling'].includes(job.status);
  }, `job ${jobId}`);
  return job;
}

test('an untracked download with no tracked copy is identified and linked into the library', async (context) => {
  const files = await fixture(context);
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath, importBehaviour: 'hardlink' });
  const app = await startApp(context, { ...files, radarrUrl: radarr.url });

  const candidate = await findOrphan(app, files.orphan);

  // Before: the deck can now say what this file actually is, rather than only that
  // nothing tracks it.
  const identified = (await (await app.call('/api/orphans/identify', { ids: [candidate.id] })).json())
    .identifications[0];
  assert.equal(identified.status, 'importable');
  assert.equal(identified.title, 'The Film (2024)');
  assert.match(identified.reason, /has no tracked file/);

  const created = await app.call('/api/orphans/apply', { ids: [candidate.id], action: 'import' });
  assert.equal(created.status, 202);
  const job = await waitForJob(app, (await created.json()).job.id);
  assert.equal(job.status, 'completed', JSON.stringify(job.items.map((item) => item.error)));

  // The command Radarr actually received is the contract with Radarr, so it is asserted
  // literally rather than inferred from the outcome.
  const manual = radarr.commands.filter((command) => command.name === 'ManualImport');
  assert.equal(manual.length, 1);
  assert.equal(manual[0].importMode, 'auto', 'the hardlink-or-move choice belongs to Radarr');
  assert.deepEqual(manual[0].files.map((file) => ({ path: file.path, movieId: file.movieId })), [
    { path: files.orphan, movieId: 12 },
  ]);

  // Hardlinked: one inode, two names, and the download keeps seeding.
  const [source, library] = await Promise.all([stat(files.orphan), stat(files.libraryPath)]);
  assert.equal(source.ino, library.ino);
  assert.equal(source.nlink, 2);
  assert.equal(job.items[0].phase, 'imported');
  assert.match(job.items[0].outcome, /keeps seeding/);

  // And it is no longer untracked, which is the point of the whole exercise.
  const rescan = await (await app.call('/api/scan')).json();
  assert.equal(rescan.orphans.some((entry) => entry.path === files.orphan), false);
});

test('an import that moves the file is reported as a move', async (context) => {
  const files = await fixture(context);
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath, importBehaviour: 'move' });
  const app = await startApp(context, { ...files, radarrUrl: radarr.url });

  const candidate = await findOrphan(app, files.orphan);
  const created = await app.call('/api/orphans/apply', { ids: [candidate.id], action: 'import' });
  const job = await waitForJob(app, (await created.json()).job.id);

  assert.equal(job.status, 'completed', JSON.stringify(job.items.map((item) => item.error)));
  // Which of the two happened is Radarr's decision, and the source file is the evidence.
  assert.match(job.items[0].outcome, /Moved into the library/);
  await assert.rejects(stat(files.orphan), { code: 'ENOENT' });
});

test('a file whose movie already has a tracked copy is reported spare and never imported', async (context) => {
  const files = await fixture(context);
  // The library already holds this movie, entirely separately from the download.
  await writeFile(files.libraryPath, 'y'.repeat(1024));
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath, importBehaviour: 'hardlink' });
  radarr.state.hasFile = true;
  radarr.state.movieFilePath = files.libraryPath;

  const app = await startApp(context, { ...files, radarrUrl: radarr.url });
  const candidate = await findOrphan(app, files.orphan);

  const identified = (await (await app.call('/api/orphans/identify', { ids: [candidate.id] })).json())
    .identifications[0];
  assert.equal(identified.status, 'occupied');
  assert.match(identified.reason, /already has a tracked file/);
  assert.equal(identified.existing.path, files.libraryPath);
  assert.equal(identified.target, null);

  // Asking to import it anyway is refused at the last gate, not obeyed. This is the
  // case that would otherwise put a duplicate into the library.
  const created = await app.call('/api/orphans/apply', { ids: [candidate.id], action: 'import' });
  const job = await waitForJob(app, (await created.json()).job.id);
  assert.equal(job.status, 'completed_with_errors');
  assert.match(job.items[0].error, /already has a tracked file/);
  assert.equal(radarr.commands.filter((command) => command.name === 'ManualImport').length, 0);

  // Both files are exactly as they were.
  assert.equal((await stat(files.orphan)).size, 1024);
  assert.equal((await stat(files.libraryPath)).size, 1024);
});

test('an import the application reports as done but did not perform is a failure, not a success', async (context) => {
  const files = await fixture(context);
  // Radarr answers "completed" but the library gains nothing, which is what a rejection
  // during the import itself looks like from outside.
  const radarr = await mockRadarr(context, { libraryPath: files.libraryPath, importBehaviour: 'none' });
  const app = await startApp(context, { ...files, radarrUrl: radarr.url });

  const candidate = await findOrphan(app, files.orphan);
  const created = await app.call('/api/orphans/apply', { ids: [candidate.id], action: 'import' });
  const job = await waitForJob(app, (await created.json()).job.id);

  assert.equal(job.status, 'completed_with_errors');
  assert.match(job.items[0].error, /still has no tracked file/);
  // The file is untouched and still reported, so nothing is silently lost.
  assert.equal((await stat(files.orphan)).size, 1024);
});
