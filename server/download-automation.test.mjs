import assert from 'node:assert/strict';
import { mkdir, mkdtemp, link, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-automation-'));
process.env.CONFIG_DIR = path.join(testRoot, 'config');
const { getConfig } = await import('./config.mjs');
const { compilePatterns, blockingPattern, judgeContent } = await import('./content-blocker.mjs');
const { addAttempt, addStrike, readStrikes, strikeRule } = await import('./strikes.mjs');
const { ignoredReason } = await import('./download-ignore.mjs');
const { judgeFailedImport } = await import('./failed-imports.mjs');
const { judgeSeeding, seedingLimitReached } = await import('./seeding-cleanup.mjs');
const { judgeUnlinked } = await import('./unlinked-cleanup.mjs');
const { previewAutomation, tickAutomation, automationStatus } = await import('./automation.mjs');
const { classifyQbittorrentRecoveryTorrent, qbittorrentRecoveryPolicyIdentity } = await import('./qbittorrent-recovery.mjs');
const { normalizeQbittorrentTorrent } = await import('./qbittorrent.mjs');
const { notifyDownloadEvent, sendNtfy, ntfyTarget } = await import('./notify.mjs');
const { buildSettingsOverrides, settingsView } = await import('./settings.mjs');
const {
  createDownloadCleanupJob, getJob, listJobs, startJobWorker, stopJobWorker,
} = await import('./jobs.mjs');

// One mock server plays qBittorrent (/api/v2), Radarr (/radarr/api/v3) and ntfy (/ntfy),
// holding just enough state for the automations to read, act and be checked.
const state = {
  torrents: [],
  files: {},
  queue: [],
  history: [],
  manualImport: [],
  altSpeed: false,
  preferences: { excluded_file_names_enabled: false, excluded_file_names: '' },
  requests: [],
  commands: [],
  ntfy: [],
  ntfyStatus: 200,
};

function resetState() {
  Object.assign(state, {
    torrents: [], files: {}, queue: [], history: [], manualImport: [], altSpeed: false,
    preferences: { excluded_file_names_enabled: false, excluded_file_names: '' },
    requests: [], commands: [], ntfy: [], ntfyStatus: 200,
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://mock');
  const body = await readBody(request);
  state.requests.push({ method: request.method, path: url.pathname, search: url.search, body });
  const form = new URLSearchParams(body);
  const route = url.pathname;

  if (route === '/api/v2/auth/login') {
    response.writeHead(200, { 'Set-Cookie': 'SID=mock; HttpOnly' });
    return response.end('Ok.');
  }
  if (route === '/api/v2/auth/logout') return response.end('');
  if (route === '/api/v2/torrents/info') {
    const hashes = url.searchParams.get('hashes')?.split('|');
    return json(response, state.torrents.filter((torrent) => !hashes || hashes.includes(torrent.hash)));
  }
  if (route === '/api/v2/torrents/files') return json(response, state.files[url.searchParams.get('hash')] ?? []);
  if (route === '/api/v2/torrents/properties') {
    const torrent = state.torrents.find((value) => value.hash === url.searchParams.get('hash'));
    return json(response, { is_private: torrent?.private ?? false });
  }
  if (route === '/api/v2/torrents/filePrio') {
    const ids = form.get('id').split('|').map(Number);
    for (const file of state.files[form.get('hash')] ?? []) if (ids.includes(file.index)) file.priority = Number(form.get('priority'));
    return response.end('');
  }
  if (route === '/api/v2/torrents/delete') {
    state.torrents = state.torrents.filter((torrent) => torrent.hash !== form.get('hashes'));
    return response.end('');
  }
  if (route === '/api/v2/transfer/speedLimitsMode') return response.end(state.altSpeed ? '1' : '0');
  if (route === '/api/v2/app/preferences') return json(response, state.preferences);
  if (route === '/api/v2/app/setPreferences') {
    Object.assign(state.preferences, JSON.parse(form.get('json')));
    return response.end('');
  }

  if (route.startsWith('/ntfy')) {
    state.ntfy.push({ path: route, headers: request.headers, body: JSON.parse(body) });
    response.writeHead(state.ntfyStatus);
    return response.end('{}');
  }

  const arr = route.match(/^\/radarr\/api\/v3\/(.+)$/);
  if (arr) {
    const endpoint = arr[1];
    if (endpoint === 'queue/details') return json(response, state.queue);
    if (endpoint === 'downloadclient') {
      return json(response, [{ id: 2, name: 'qBittorrent', enable: true, implementation: 'QBittorrent', protocol: 'torrent' }]);
    }
    if (endpoint === 'history') {
      const downloadId = url.searchParams.get('downloadId');
      const records = state.history.filter((record) => record.downloadId.toLowerCase() === downloadId.toLowerCase());
      return json(response, { page: 1, pageSize: 100, totalRecords: records.length, records });
    }
    if (endpoint === 'manualimport') return json(response, state.manualImport);
    if (endpoint === 'command' && request.method === 'POST') {
      const command = { id: state.commands.length + 100, ...JSON.parse(body), queued: new Date().toISOString(), status: 'queued' };
      state.commands.push(command);
      return json(response, command);
    }
    if (endpoint === 'command') return json(response, state.commands);
    const queueDelete = endpoint.match(/^queue\/(\d+)$/);
    if (queueDelete && request.method === 'DELETE') {
      const record = state.queue.find((value) => value.id === Number(queueDelete[1]));
      if (!record) return json(response, { message: 'not found' }, 404);
      state.queue = state.queue.filter((value) => value.downloadId !== record.downloadId);
      if (url.searchParams.get('removeFromClient') === 'true') {
        state.torrents = state.torrents.filter((torrent) => torrent.hash !== record.downloadId.toLowerCase());
      }
      state.history.push({ id: 900 + state.history.length, eventType: 'downloadFailed', downloadId: record.downloadId, movieId: record.movieId, date: new Date().toISOString() });
      return response.end('');
    }
    if (endpoint.startsWith('movie/')) return json(response, { id: 7, hasFile: false });
  }
  json(response, { error: `unhandled ${request.method} ${route}` }, 404);
});

let base = '';
let activeConfig = null;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  startJobWorker(() => activeConfig);
});

after(async () => {
  await stopJobWorker();
  server.close();
  await rm(testRoot, { recursive: true, force: true });
});

const HASH = 'a'.repeat(40);
const downloads = path.join(testRoot, 'downloads');
const library = path.join(testRoot, 'library');

function makeConfig(overrides = {}) {
  return getConfig({
    ARR_INSTANCES: 'radarr:radarr',
    RADARR_URL: `${base}/radarr`,
    RADARR_API_KEY: 'fixture-key',
    RADARR_MEDIA_ROOTS: '',
    RADARR_DOWNLOAD_ROOTS: '',
    RADARR_PATH_MAPS: '',
    SONARR_URL: '',
    QBITTORRENT_URL: base,
    QBITTORRENT_USERNAME: 'captain',
    QBITTORRENT_PASSWORD: 'secret',
    QBITTORRENT_PATH_MAPS: `/qbit=>${downloads}`,
    QBITTORRENT_RECOVERY_ENABLED: 'false',
    MEDIA_EXTENSIONS: '',
    NTFY_URL: '',
    NOTIFICATION_WEBHOOK_URL: '',
    DOWNLOAD_IGNORE_JSON: '',
    FAILED_IMPORT_JSON: '',
    CONTENT_BLOCKER_JSON: '',
    SEEDING_CLEANUP_JSON: '',
    UNLINKED_CLEANUP_JSON: '',
    ...overrides,
  });
}

function rawTorrent(overrides = {}) {
  return {
    hash: HASH,
    name: 'Some.Movie.2024.1080p',
    category: 'radarr',
    state: 'stalledUP',
    dlspeed: 0,
    progress: 1,
    amount_left: 0,
    added_on: 1_700_000_000,
    last_activity: Math.floor(Date.now() / 1000) - 60,
    ratio: 0.5,
    seeding_time: 3600,
    completion_on: Math.floor(Date.now() / 1000) - 3 * 86400,
    num_complete: 20,
    total_size: 1000,
    tags: '',
    content_path: '/qbit/Some.Movie.2024.1080p',
    save_path: '/qbit',
    private: false,
    ...overrides,
  };
}

function queueRecord(overrides = {}) {
  return {
    id: 41,
    downloadId: HASH.toUpperCase(),
    protocol: 'torrent',
    downloadClient: 'qBittorrent',
    movieId: 7,
    title: 'Some.Movie.2024.1080p',
    trackedDownloadState: 'importBlocked',
    trackedDownloadStatus: 'warning',
    statusMessages: [{ title: 'Some.Movie.2024.1080p', messages: ['No files found are eligible for import'] }],
    ...overrides,
  };
}

function fakeClient({ files = [], isPrivate = false } = {}) {
  return { files: async () => files, isPrivate: async () => isPrivate };
}

function contextFor(config, { client, queue = [], now = Date.now(), commit = true, ...rest } = {}) {
  const queueByHash = new Map();
  for (const record of queue) {
    const hash = record.downloadId.toLowerCase();
    if (!queueByHash.has(hash)) queueByHash.set(hash, []);
    queueByHash.get(hash).push({ app: 'radarr', record, downloadClients: [] });
  }
  return { client, queueByHash, now, nowIso: new Date(now).toISOString(), commit, ...rest };
}

async function waitForJob(id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = getJob(id);
    if (job && !['queued', 'running', 'cancelling'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Job ${id} did not settle.`);
}

test('every automation is off and in dry run by default, with Cleanuparr\'s values', () => {
  const config = makeConfig();
  for (const key of ['failedImports', 'contentBlocker', 'seedingCleanup', 'unlinkedCleanup']) {
    assert.equal(config[key].enabled, false, key);
    assert.equal(config[key].dryRun, true, key);
  }
  assert.equal(config.failedImports.maxStrikes, 3);
  assert.equal(config.failedImports.intervalMinutes, 5);
  assert.equal(config.failedImports.forceImportAttempts, 3);
  assert.equal(config.failedImports.ignorePrivate, true);
  assert.equal(config.failedImports.deletePrivate, false);
  assert.equal(config.strikes.inactivityHours, 24);
  assert.equal(config.contentBlocker.listUrl, 'https://cleanuparr.pages.dev/static/blacklist');
  assert.equal(config.contentBlocker.ignorePrivate, true);
  assert.equal(config.qbittorrent.recovery.ignoreSlowWhenAltSpeed, true);
  assert.throws(() => makeConfig({ QBITTORRENT_URL: '', SEEDING_CLEANUP_JSON: '{"enabled":true}' }), /requires a configured qBittorrent/);
  assert.throws(() => makeConfig({ DOWNLOAD_IGNORE_JSON: '{"hashes":["not-a-hash"]}' }), /hexadecimal/);
  assert.throws(() => makeConfig({ SEEDING_CLEANUP_JSON: '{"rules":[{"category":"a"},{"category":"a"}]}' }), /two rules/);
  const seeding = makeConfig({ SEEDING_CLEANUP_JSON: '{"rules":[{"category":"tv","maxRatio":0},{"category":"films"}]}' }).seedingCleanup;
  assert.deepEqual(seeding.rules.map((rule) => [rule.maxRatio, rule.maxSeedHours, rule.deleteFiles]), [[0, -1, true], [-1, -1, true]]);
});

test('blocklist patterns use Cleanuparr\'s format against the file name only', () => {
  const compiled = compilePatterns(['*.exe', '*sample.mkv', 'Trailer.*', '*(sample).*', 'VOSTFR', '# comment', '', 'regex:^setup\\d+\\.bin$', 'regex:(']);
  assert.equal(compiled.patterns.length, 6);
  assert.equal(compiled.invalid, 1);
  assert.equal(blockingPattern('Movie/Setup.EXE', compiled), '*.exe');
  assert.equal(blockingPattern('Movie/movie-sample.mkv', compiled), '*sample.mkv');
  assert.equal(blockingPattern('Movie/Trailer.mp4', compiled), 'Trailer.*');
  assert.equal(blockingPattern('Movie (sample).avi', compiled), '*(sample).*');
  assert.equal(blockingPattern('Extras/VOSTFR', compiled), 'VOSTFR');
  assert.equal(blockingPattern('Extras/setup12.bin', compiled), 'regex:^setup\\d+\\.bin$');
  assert.equal(blockingPattern('Movie/Movie.2024.mkv', compiled), null);
  assert.equal(blockingPattern('Movie/Movie.2024.mkv', compiled, 'allowlist'), 'not on the allowlist');
  assert.equal(blockingPattern('Movie/Trailer.mp4', compiled, 'allowlist'), null);
});

test('strikes count per check, expire after the inactivity window, and reset on progress when asked', async () => {
  const now = Date.UTC(2026, 9, 1);
  const options = { now, inactivityHours: 24 };
  assert.equal((await addStrike('test-rule', 'B'.repeat(40), options)).count, 1);
  assert.equal((await addStrike('test-rule', 'b'.repeat(40), { ...options, now: now + 1000 })).count, 2);
  assert.equal(readStrikes('test-rule', 'b'.repeat(40), { now: now + 1000 + 24 * 3_600_000 }).count, 2);
  assert.equal(readStrikes('test-rule', 'b'.repeat(40), { now: now + 1001 + 24 * 3_600_000 }), null);
  assert.equal((await addStrike('test-rule', 'b'.repeat(40), { now: now + 25 * 3_600_000 })).count, 1);

  const hash = 'c'.repeat(40);
  await addStrike('progress-rule', hash, { now, progress: 100, resetOnProgress: true });
  assert.equal((await addStrike('progress-rule', hash, { now, progress: 100, resetOnProgress: true })).count, 2);
  assert.equal((await addStrike('progress-rule', hash, { now, progress: 150, resetOnProgress: true })).count, 1);
  assert.equal((await addStrike('slow-rule', hash, { now, progress: 100 })).count, 1);
  assert.equal((await addStrike('slow-rule', hash, { now, progress: 150 })).count, 2);

  // A dry run keeps its own count, so turning dry run off starts from zero.
  await addStrike(strikeRule('dry-rule', true), hash, options);
  assert.equal(readStrikes(strikeRule('dry-rule', false), hash, options), null);
  assert.equal((await addAttempt('attempt-rule', hash, options)).attempts, 1);
  assert.equal((await addAttempt('attempt-rule', hash, options)).attempts, 2);
  assert.equal(readStrikes('attempt-rule', hash, options).count, 0);
});

test('ignore lists match hash, exact category, and tag; recovery honours them and alternative speed', () => {
  const config = { downloadIgnore: { categories: ['books'], tags: ['keep'], hashes: [HASH] } };
  assert.match(ignoredReason(config, { hash: HASH.toUpperCase(), category: 'x', tags: [] }), /hash/);
  assert.match(ignoredReason(config, { hash: 'd'.repeat(40), category: 'books', tags: [] }), /"books"/);
  assert.equal(ignoredReason(config, { hash: 'd'.repeat(40), category: 'Books', tags: [] }), null);
  assert.match(ignoredReason(config, { hash: 'd'.repeat(40), category: 'x', tags: ['KEEP'] }), /tag/i);
  assert.match(ignoredReason({}, { hash: 'd'.repeat(40), category: 'tv', tags: [] }, { categories: ['tv'], tags: [], hashes: [] }, 'seeding list'), /seeding list/);

  const recovery = { slowSpeedKibPerSecond: 100, slowMinutes: 30, stalledMinutes: 30, metadataMinutes: 15, excludedCategories: [], ignoreSlowWhenAltSpeed: true };
  const slow = normalizeQbittorrentTorrent(rawTorrent({ state: 'downloading', progress: 0.5, amount_left: 500, dlspeed: 1024 }));
  assert.equal(classifyQbittorrentRecoveryTorrent(slow, recovery)?.reason, 'slow');
  assert.equal(classifyQbittorrentRecoveryTorrent(slow, recovery, { altSpeed: true }), null);
  assert.equal(classifyQbittorrentRecoveryTorrent(slow, { ...recovery, ignoreSlowWhenAltSpeed: false }, { altSpeed: true })?.reason, 'slow');
  const stalled = { ...slow, state: 'stalledDL' };
  assert.equal(classifyQbittorrentRecoveryTorrent(stalled, recovery, { altSpeed: true })?.reason, 'stalled');
  assert.equal(classifyQbittorrentRecoveryTorrent({ ...stalled, category: 'books' }, recovery, { ignore: config.downloadIgnore }), null);

  // Upgrading leaves an existing recovery policy's identity alone, so no window restarts.
  const plain = makeConfig();
  const legacy = { ...plain, downloadIgnore: undefined, qbittorrent: { ...plain.qbittorrent, recovery: { ...plain.qbittorrent.recovery, ignoreSlowWhenAltSpeed: undefined } } };
  assert.equal(qbittorrentRecoveryPolicyIdentity(plain), qbittorrentRecoveryPolicyIdentity(legacy));
  assert.notEqual(qbittorrentRecoveryPolicyIdentity(makeConfig({ DOWNLOAD_IGNORE_JSON: '{"categories":["books"]}' })), qbittorrentRecoveryPolicyIdentity(plain));
});

test('failed imports try a forced import first, then strike, then act; private torrents are left alone', async () => {
  resetState();
  const config = makeConfig({ FAILED_IMPORT_JSON: JSON.stringify({ enabled: true, dryRun: false, maxStrikes: 2, forceImportAttempts: 1 }) });
  const torrent = normalizeQbittorrentTorrent(rawTorrent({ hash: 'e'.repeat(40) }));
  const queue = [queueRecord({ downloadId: 'E'.repeat(40) })];
  state.manualImport = [{ path: '/qbit/Some.Movie.2024.1080p/movie.mkv', movie: { id: 7 }, rejections: [{ reason: 'Locked', type: 'temporary' }] }];
  const client = fakeClient();
  const now = Date.now();

  const preview = await judgeFailedImport(config, torrent, contextFor(config, { client, queue, now, commit: false }));
  assert.equal(preview.verdict, 'attempt');
  assert.equal(state.commands.length, 0, 'a preview sends nothing');

  const first = await judgeFailedImport(config, torrent, contextFor(config, { client, queue, now }));
  assert.equal(first.verdict, 'attempt');
  assert.equal(state.commands.length, 1);
  assert.equal(state.commands[0].name, 'ManualImport');
  assert.equal(state.commands[0].files[0].movieId, 7);

  // Attempts used up, and a permanent rejection is never forced.
  state.manualImport = [{ path: '/qbit/x/sample.mkv', movie: { id: 7 }, rejections: [{ reason: 'Sample', type: 'permanent' }] }];
  const second = await judgeFailedImport(config, torrent, contextFor(config, { client, queue, now }));
  assert.equal(second.verdict, 'strike');
  assert.match(second.detail, /strike 1 of 2 after 1 forced import attempt/);
  const third = await judgeFailedImport(config, torrent, contextFor(config, { client, queue, now }));
  assert.equal(third.verdict, 'act');
  assert.equal(third.action, 'arr-remove');
  assert.equal(third.keepInClient, false);
  assert.match(third.reason, /No files found are eligible for import/);
  assert.equal(state.commands.length, 1);

  const privateTorrent = normalizeQbittorrentTorrent(rawTorrent({ hash: 'f'.repeat(40) }));
  const privateVerdict = await judgeFailedImport(config, privateTorrent, contextFor(config, {
    client: fakeClient({ isPrivate: true }), queue: [queueRecord({ downloadId: 'F'.repeat(40) })], now,
  }));
  assert.equal(privateVerdict.verdict, 'ignored');
  // An unreadable private flag counts as private.
  const unknown = await judgeFailedImport(config, privateTorrent, contextFor(config, {
    client: fakeClient({ isPrivate: null }), queue: [queueRecord({ downloadId: 'F'.repeat(40) })], now,
  }));
  assert.equal(unknown.verdict, 'ignored');

  const healthy = await judgeFailedImport(config, privateTorrent, contextFor(config, {
    client, queue: [queueRecord({ downloadId: 'F'.repeat(40), trackedDownloadStatus: 'ok', trackedDownloadState: 'importPending' })], now,
  }));
  assert.equal(healthy, null);
});

test('the content blocker skips blocked files, and removes a torrent only when every file is blocked', async () => {
  const config = makeConfig({ CONTENT_BLOCKER_JSON: JSON.stringify({ enabled: true, dryRun: false, listUrl: '', patterns: ['*.exe', '*.lnk'] }) });
  const { loadBlocklist } = await import('./content-blocker.mjs');
  const blocklist = await loadBlocklist(config.contentBlocker);
  const torrent = normalizeQbittorrentTorrent(rawTorrent({ hash: '1'.repeat(40), state: 'downloading', progress: 0.2, amount_left: 800 }));
  const queue = [queueRecord({ downloadId: '1'.repeat(40), trackedDownloadState: 'downloading', trackedDownloadStatus: 'ok' })];
  const mixed = fakeClient({ files: [
    { index: 0, name: 'Movie/Movie.mkv', size: 900, priority: 1 },
    { index: 1, name: 'Movie/Codec.exe', size: 10, priority: 1 },
  ] });
  const skip = await judgeContent(config, torrent, contextFor(config, { client: mixed, queue, blocklist, inspected: new Map() }));
  assert.equal(skip.action, 'skip-files');
  assert.deepEqual(skip.fileIndexes, [1]);
  assert.match(skip.reason, /Codec\.exe matches \*\.exe/);

  const allBad = fakeClient({ files: [
    { index: 0, name: 'Movie/Movie.mkv.lnk', size: 1, priority: 1 },
    { index: 1, name: 'Movie/Setup.exe', size: 10, priority: 0 },
  ] });
  const remove = await judgeContent(config, torrent, contextFor(config, { client: allBad, queue, blocklist }));
  assert.equal(remove.action, 'arr-remove');

  const clean = fakeClient({ files: [{ index: 0, name: 'Movie/Movie.mkv', size: 900, priority: 1 }] });
  const inspected = new Map();
  assert.equal(await judgeContent(config, torrent, contextFor(config, { client: clean, queue, blocklist, inspected })), null);
  assert.equal(inspected.get('1'.repeat(40)), blocklist.identity);

  // Not in an Arr queue: a download added by hand is never inspected.
  assert.equal(await judgeContent(config, torrent, contextFor(config, { client: mixed, queue: [], blocklist })), null);
  const privateVerdict = await judgeContent(config, torrent, contextFor(config, { client: { ...mixed, isPrivate: async () => true }, queue, blocklist }));
  assert.equal(privateVerdict.verdict, 'ignored');
});

test('seeding rules: ratio, seed time, inactivity, minimums, and never a download still being imported', async () => {
  const now = Date.now();
  const rule = { category: 'tv', maxRatio: 1, minSeedHours: 2, maxSeedHours: 48, maxInactiveDays: 7, minSeeders: 0, deleteFiles: false };
  const torrent = (overrides) => normalizeQbittorrentTorrent(rawTorrent({ category: 'tv', ...overrides }));
  assert.equal(seedingLimitReached(rule, torrent({ ratio: 1.2, seeding_time: 3 * 3600 }), now), 'ratio 1.20 reached the 1 limit');
  assert.equal(seedingLimitReached(rule, torrent({ ratio: 1.2, seeding_time: 3600 }), now), null, 'minimum seed time first');
  assert.match(seedingLimitReached(rule, torrent({ ratio: 0.1, seeding_time: 49 * 3600 }), now), /past the 48 h limit/);
  assert.match(seedingLimitReached(rule, torrent({ ratio: 0.1, seeding_time: 3 * 3600, last_activity: Math.floor(now / 1000) - 8 * 86400 }), now), /8\.0 days/);
  assert.match(seedingLimitReached({ ...rule, maxRatio: 0, minSeedHours: 0 }, torrent({ ratio: 0, seeding_time: 0 }), now), /ratio 0\.00/);
  assert.equal(seedingLimitReached({ ...rule, maxRatio: -1, maxSeedHours: -1, maxInactiveDays: -1 }, torrent({ ratio: 50, seeding_time: 999 * 3600 }), now), null);

  const config = makeConfig({ SEEDING_CLEANUP_JSON: JSON.stringify({ enabled: true, dryRun: false, rules: [{ ...rule, minSeeders: 5 }] }) });
  const done = torrent({ ratio: 1.5, seeding_time: 3 * 3600 });
  const act = await judgeSeeding(config, done, contextFor(config, { client: fakeClient() }));
  assert.equal(act.action, 'client-remove');
  assert.equal(act.deleteFiles, false);
  const importing = await judgeSeeding(config, done, contextFor(config, { client: fakeClient(), queue: [queueRecord({ trackedDownloadStatus: 'ok' })] }));
  assert.equal(importing.verdict, 'preserved');
  const rare = await judgeSeeding(config, torrent({ ratio: 1.5, seeding_time: 3 * 3600, num_complete: 2 }), contextFor(config, { client: fakeClient() }));
  assert.equal(rare.verdict, 'preserved');
  assert.match(rare.detail, /2 seeders/);
  assert.equal(await judgeSeeding(config, torrent({ ratio: 9, progress: 0.9, amount_left: 100, state: 'downloading' }), contextFor(config, { client: fakeClient() })), null);
  assert.equal(await judgeSeeding(config, torrent({ ratio: 9, category: 'movies' }), contextFor(config, { client: fakeClient() })), null);
});

test('file deletion is refused for a last copy nobody imported, and unlinked torrents need import proof', async () => {
  await mkdir(path.join(downloads, 'Linked'), { recursive: true });
  await mkdir(path.join(downloads, 'Unlinked'), { recursive: true });
  await mkdir(library, { recursive: true });
  await writeFile(path.join(downloads, 'Linked', 'movie.mkv'), 'x'.repeat(100));
  await link(path.join(downloads, 'Linked', 'movie.mkv'), path.join(library, 'movie.mkv'));
  await writeFile(path.join(downloads, 'Unlinked', 'movie.mkv'), 'y'.repeat(200));
  await writeFile(path.join(downloads, 'Unlinked', 'movie.nfo'), 'z'.repeat(5));

  const files = (folder) => [
    { index: 0, name: `${folder}/movie.mkv`, size: 100, priority: 1 },
    ...(folder === 'Unlinked' ? [{ index: 1, name: `${folder}/movie.nfo`, size: 5, priority: 1 }] : []),
  ];
  const seedingConfig = makeConfig({ SEEDING_CLEANUP_JSON: JSON.stringify({ enabled: true, dryRun: false, rules: [{ category: 'radarr', maxRatio: 0 }] }) });
  const linked = normalizeQbittorrentTorrent(rawTorrent({ hash: '2'.repeat(40), name: 'Linked' }));
  const linkedVerdict = await judgeSeeding(seedingConfig, linked, contextFor(seedingConfig, { client: fakeClient({ files: files('Linked') }), importedCheck: async () => null }));
  assert.equal(linkedVerdict.action, 'client-remove');
  assert.equal(linkedVerdict.freedBytes, 0, 'the library keeps a hardlink, so nothing is freed');

  const unlinked = normalizeQbittorrentTorrent(rawTorrent({ hash: '3'.repeat(40), name: 'Unlinked' }));
  const refused = await judgeSeeding(seedingConfig, unlinked, contextFor(seedingConfig, { client: fakeClient({ files: files('Unlinked') }), importedCheck: async () => null }));
  assert.equal(refused.verdict, 'preserved');
  assert.match(refused.detail, /may be the only copy/);
  const unmapped = await judgeSeeding(seedingConfig, { ...unlinked, savePath: '/elsewhere' }, contextFor(seedingConfig, { client: fakeClient({ files: files('Unlinked') }), importedCheck: async () => 'radarr' }));
  assert.match(unmapped.detail, /could not be mapped/);

  const unlinkedConfig = makeConfig({ UNLINKED_CLEANUP_JSON: JSON.stringify({ enabled: true, dryRun: false, minCompletedHours: 24 }) });
  const proven = await judgeUnlinked(unlinkedConfig, unlinked, contextFor(unlinkedConfig, { client: fakeClient({ files: files('Unlinked') }), importedCheck: async () => 'radarr' }));
  assert.equal(proven.action, 'client-remove');
  assert.equal(proven.freedBytes, 205);
  const unproven = await judgeUnlinked(unlinkedConfig, unlinked, contextFor(unlinkedConfig, { client: fakeClient({ files: files('Unlinked') }), importedCheck: async () => null }));
  assert.equal(unproven.verdict, 'preserved');
  assert.equal(await judgeUnlinked(unlinkedConfig, linked, contextFor(unlinkedConfig, { client: fakeClient({ files: files('Linked') }), importedCheck: async () => 'radarr' })), null, 'still linked');
  const young = normalizeQbittorrentTorrent(rawTorrent({ hash: '3'.repeat(40), name: 'Unlinked', completion_on: Math.floor(Date.now() / 1000) - 3600 }));
  assert.equal(await judgeUnlinked(unlinkedConfig, young, contextFor(unlinkedConfig, { client: fakeClient({ files: files('Unlinked') }), importedCheck: async () => 'radarr' })), null);
  const ignoredRoot = makeConfig({ UNLINKED_CLEANUP_JSON: JSON.stringify({ enabled: true, dryRun: false, ignoredRoots: [path.join(downloads, 'Unlinked')] }) });
  assert.equal((await judgeUnlinked(ignoredRoot, unlinked, contextFor(ignoredRoot, { client: fakeClient({ files: files('Unlinked') }), importedCheck: async () => 'radarr' }))).verdict, 'ignored');
});

test('a failed import is removed through Arr, blocklisted, searched for, and notified', async () => {
  resetState();
  const hash = '4'.repeat(40);
  state.torrents = [rawTorrent({ hash })];
  state.queue = [queueRecord({ downloadId: hash.toUpperCase() })];
  state.history = [{ id: 91, eventType: 'grabbed', downloadId: hash.toUpperCase(), movieId: 7, date: new Date().toISOString() }];
  activeConfig = makeConfig({
    FAILED_IMPORT_JSON: JSON.stringify({ enabled: true, dryRun: false, maxStrikes: 2, forceImportAttempts: 0 }),
    NTFY_URL: `${base}/ntfy/home-alerts`,
    NTFY_TOKEN: 'tk_secret',
  });
  const now = Date.now();
  const first = await tickAutomation(activeConfig, createDownloadCleanupJob, { features: ['failedImports'], now });
  assert.equal(first.failedImports.decisions[0].verdict, 'strike');
  const second = await tickAutomation(activeConfig, createDownloadCleanupJob, { features: ['failedImports'], now: now + 1000 });
  assert.equal(second.failedImports.decisions[0].verdict, 'act');

  const job = listJobs().find((value) => value.type === 'download-cleanup' && value.items[0].candidate.hash === hash);
  assert.ok(job, 'a durable job was created');
  const settled = await waitForJob(job.id);
  const item = settled.items[0];
  assert.equal(item.status, 'complete', item.error ?? '');
  assert.equal(item.phase, 'search_queued');
  assert.match(item.outcome, /strike 2 of 2/);
  const deletion = state.requests.find((request) => request.method === 'DELETE' && request.path === '/radarr/api/v3/queue/41');
  assert.match(deletion.search, /removeFromClient=true/);
  assert.match(deletion.search, /blocklist=true/);
  assert.deepEqual(state.commands.map((command) => [command.name, command.movieIds]), [['MoviesSearch', [7]]]);
  assert.equal(state.ntfy.length, 1);
  assert.equal(state.ntfy[0].path, '/ntfy/');
  assert.equal(state.ntfy[0].body.topic, 'home-alerts');
  assert.match(state.ntfy[0].body.message, /blocklisted/);
  assert.equal(state.ntfy[0].headers.authorization, 'Bearer tk_secret');

  const status = automationStatus(activeConfig, { jobs: listJobs() });
  assert.equal(status.failedImports.history.doneCount, 1);
  assert.ok(status.failedImports.decisions.some((decision) => decision.verdict === 'act'));
});

test('blocked files are skipped in qBittorrent, and a finished torrent is removed by its seeding rule', async () => {
  resetState();
  const blockedHash = '5'.repeat(40);
  const seededHash = '6'.repeat(40);
  state.torrents = [
    rawTorrent({ hash: blockedHash, state: 'downloading', progress: 0.3, amount_left: 700 }),
    rawTorrent({ hash: seededHash, name: 'Linked', category: 'done', ratio: 2 }),
  ];
  state.files[blockedHash] = [
    { index: 0, name: 'Movie/Movie.mkv', size: 900, priority: 1, progress: 0.3 },
    { index: 1, name: 'Movie/Codec.exe', size: 10, priority: 1, progress: 0 },
  ];
  state.files[seededHash] = [{ index: 0, name: 'Linked/movie.mkv', size: 100, priority: 1, progress: 1 }];
  state.queue = [queueRecord({ downloadId: blockedHash.toUpperCase(), trackedDownloadState: 'downloading', trackedDownloadStatus: 'ok' })];
  activeConfig = makeConfig({
    CONTENT_BLOCKER_JSON: JSON.stringify({ enabled: true, dryRun: false, listUrl: `${base}/list`, syncExcludedFileNames: true }),
    SEEDING_CLEANUP_JSON: JSON.stringify({ enabled: true, dryRun: false, rules: [{ category: 'done', maxRatio: 1 }] }),
  });
  const results = await tickAutomation(activeConfig, createDownloadCleanupJob, {
    features: ['contentBlocker', 'seedingCleanup'],
    fetchBlocklist: async () => ['*.exe', 'regex:^nope$'],
  });
  assert.equal(results.contentBlocker.error, null);
  assert.equal(results.contentBlocker.decisions[0].action, 'skip-files');
  assert.equal(results.seedingCleanup.decisions[0].action, 'client-remove');
  // Only wildcard patterns carry over to qBittorrent.
  assert.equal(state.preferences.excluded_file_names, '*.exe');
  assert.equal(state.preferences.excluded_file_names_enabled, true);

  const jobs = listJobs().filter((job) => job.type === 'download-cleanup'
    && job.items.some((item) => [blockedHash, seededHash].includes(item.candidate.hash)));
  assert.equal(jobs.length, 2);
  for (const job of jobs) {
    const settled = await waitForJob(job.id);
    assert.equal(settled.items[0].status, 'complete', settled.items[0].error ?? '');
  }
  assert.equal(state.files[blockedHash][1].priority, 0);
  assert.equal(state.files[blockedHash][0].priority, 1);
  assert.equal(state.torrents.some((torrent) => torrent.hash === seededHash), false);
  const deletion = state.requests.find((request) => request.path === '/api/v2/torrents/delete');
  assert.match(deletion.body, /deleteFiles=true/);
  assert.equal(state.torrents.some((torrent) => torrent.hash === blockedHash), true, 'a partly blocked torrent carries on');
});

test('a job judged under one policy is preserved when the policy changes before it acts', async () => {
  resetState();
  const hash = '7'.repeat(40);
  state.torrents = [rawTorrent({ hash, name: 'Linked', category: 'done', ratio: 2 })];
  state.files[hash] = [{ index: 0, name: 'Linked/movie.mkv', size: 100, priority: 1, progress: 1 }];
  const original = makeConfig({ SEEDING_CLEANUP_JSON: JSON.stringify({ enabled: true, dryRun: false, rules: [{ category: 'done', maxRatio: 1 }] }) });
  activeConfig = original;
  const preview = await previewAutomation(original, { features: ['seedingCleanup'] });
  assert.equal(preview.features.seedingCleanup.decisions[0].verdict, 'would-act');
  assert.equal(state.requests.some((request) => request.path === '/api/v2/torrents/delete'), false, 'preview changes nothing');

  let jobId = null;
  await tickAutomation(original, async (config, candidates) => {
    const job = await createDownloadCleanupJob(config, candidates);
    jobId = job.id;
    // Raised before the worker reaches it: the torrent no longer qualifies under the rule now in force.
    activeConfig = makeConfig({ SEEDING_CLEANUP_JSON: JSON.stringify({ enabled: true, dryRun: false, rules: [{ category: 'done', maxRatio: 5 }] }) });
    return job;
  }, { features: ['seedingCleanup'] });
  const settled = await waitForJob(jobId);
  assert.equal(settled.items[0].status, 'failed');
  assert.match(settled.items[0].error, /settings changed/);
  assert.equal(state.torrents.length, 1);

  // Dry run never creates a job.
  const dry = makeConfig({ SEEDING_CLEANUP_JSON: JSON.stringify({ enabled: true, dryRun: true, rules: [{ category: 'done', maxRatio: 1 }] }) });
  const before = listJobs().length;
  const result = await tickAutomation(dry, createDownloadCleanupJob, { features: ['seedingCleanup'] });
  assert.equal(result.seedingCleanup.decisions[0].verdict, 'would-act');
  assert.equal(listJobs().length, before);
});

test('ntfy publishes JSON to the server root and a failed notification never throws', async () => {
  resetState();
  assert.deepEqual(ntfyTarget('https://ntfy.sh/my-topic'), { server: 'https://ntfy.sh', topic: 'my-topic' });
  assert.deepEqual(ntfyTarget('https://host/sub/path/topic'), { server: 'https://host/sub/path', topic: 'topic' });
  assert.throws(() => ntfyTarget('https://ntfy.sh/'), /topic/);
  await sendNtfy({ configured: true, url: `${base}/ntfy/alerts`, priority: 4 }, { title: 'Blöcked ✓', message: 'hi' });
  assert.equal(state.ntfy[0].body.title, 'Blöcked ✓');
  assert.equal(state.ntfy[0].body.priority, 4);
  state.ntfyStatus = 500;
  const results = await notifyDownloadEvent({ ntfy: { configured: true, url: `${base}/ntfy/alerts`, downloadEvents: true } }, { kind: 'removed', rule: 'seeding', title: 'X' });
  assert.equal(results.ntfy.status, 'failed');
});

test('settings validate the automations and never return the ntfy topic or token', () => {
  const config = makeConfig();
  const view = settingsView(config);
  const input = {
    account: { username: 'captain', sessionDays: 30, cookieSecure: false },
    defaults: { maxMbPerMinute: 85, toleranceGib: 1 },
    radarr: { ...view.radarr, pathMaps: [] },
    sonarr: { ...view.sonarr, pathMaps: [] },
    orphan: { trashDir: '', ignoreDirectories: [], maxFiles: 1000, mediaExtensions: ['mkv'], hardlinkMinAgeHours: 24 },
    automation: {
      ...view.automation,
      downloadIgnore: { categories: ['books'], tags: [], hashes: [] },
      seedingCleanup: { ...view.automation.seedingCleanup, rules: [{ category: 'tv', maxRatio: 0 }] },
    },
    ntfy: { url: 'https://ntfy.sh/jedi-alerts', token: 'tk_x', priority: 3, downloadEvents: true, scanReports: false },
  };
  const overrides = buildSettingsOverrides(input, {});
  assert.equal(JSON.parse(overrides.DOWNLOAD_IGNORE_JSON).categories[0], 'books');
  assert.equal(JSON.parse(overrides.SEEDING_CLEANUP_JSON).rules[0].maxSeedHours, -1);
  const saved = getConfig({ ...overrides, ARR_INSTANCES: 'radarr:radarr', SONARR_URL: '' });
  const savedView = JSON.stringify(settingsView(saved));
  assert.equal(savedView.includes('jedi-alerts'), false);
  assert.equal(savedView.includes('tk_x'), false);
  assert.equal(settingsView(saved).ntfy.urlConfigured, true);
  assert.throws(() => buildSettingsOverrides({ ...input, ntfy: { url: 'https://ntfy.sh/' } }, {}), /topic/);
  assert.throws(() => buildSettingsOverrides({
    ...input, automation: { seedingCleanup: { rules: [{ category: 'tv', minSeedHours: 10, maxSeedHours: 5 }] } },
  }, {}), /shorter than its minimum/);
});
