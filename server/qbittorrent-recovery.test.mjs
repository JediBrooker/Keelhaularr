import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-qbit-recovery-'));
process.env.CONFIG_DIR = path.join(testRoot, 'config');
const {
  qbittorrentRecoveryPolicyIdentity,
  tickQbittorrentRecovery,
} = await import('./qbittorrent-recovery.mjs');
const {
  findMatchingSearchCommand,
  hasArrDownloadFailedSince,
  listArrHistoryByDownloadId,
  removeQbittorrentRecoveryFromArr,
  resolveQbittorrentRecoveryOwnership,
} = await import('./arr.mjs');
const {
  cancelJob,
  createQbittorrentRecoveryJob,
  getJob,
  listJobs,
  retryJob,
  startJobWorker,
  stopJobWorker,
} = await import('./jobs.mjs');

after(async () => {
  stopJobWorker();
  await rm(testRoot, { recursive: true, force: true });
});

function config(tag, recovery = {}, apps = {}) {
  return {
    qbittorrent: {
      configured: true,
      url: `http://qbit-${tag}.invalid`,
      username: 'captain',
      password: 'secret',
      recovery: {
        enabled: true,
        slowSpeedKibPerSecond: 100,
        slowMinutes: 1,
        stalledMinutes: 1,
        excludedCategories: [],
        ...recovery,
      },
    },
    radarr: { configured: false, url: '', apiKey: '', kind: 'radarr' },
    sonarr: { configured: false, url: '', apiKey: '', kind: 'sonarr' },
    ...apps,
  };
}

function torrent(hash, overrides = {}) {
  return {
    hash,
    name: `Release ${hash}`,
    category: 'movies',
    state: 'downloading',
    dlspeed: 10 * 1024,
    progress: 0.4,
    amount_left: 600,
    added_on: 1,
    last_activity: 1,
    recoveryFieldsValid: true,
    ...overrides,
  };
}

function ownershipFor(value) {
  return {
    id: `qbittorrent:${value.hash.toLowerCase()}`,
    app: 'radarr',
    hash: value.hash.toLowerCase(),
    downloadId: value.hash.toUpperCase(),
    queueId: 41,
    downloadClientName: 'qBittorrent',
    downloadClientId: 2,
    searchIds: [7],
    seriesId: null,
    historyIds: [91],
    title: value.name,
    subtitle: 'Radarr download',
    category: value.category,
    state: value.state,
    downloadSpeedBytesPerSecond: value.dlspeed,
  };
}

function acceptingEnqueue(captured) {
  return async (_config, candidates) => {
    captured.push(...candidates);
    return { items: candidates.map((candidate) => ({ candidate })) };
  };
}

test('recovery is opt-in and does not poll when disabled', { concurrency: false }, async () => {
  const disabled = config('disabled', { enabled: false });
  let polls = 0;
  const status = await tickQbittorrentRecovery(disabled, () => undefined, {
    now: Date.UTC(2026, 0, 1),
    listTorrents: async () => { polls += 1; return []; },
  });
  assert.equal(polls, 0);
  assert.equal(status.enabled, false);
  assert.equal(status.observedCount, 0);
});

test('slow and stalled windows must remain continuous and enqueue at most once', { concurrency: false }, async () => {
  const value = config('continuous');
  const slow = torrent('slowhash');
  const stalled = torrent('stalledhash', { category: 'tv', state: 'stalledDL', dlspeed: 0 });
  const inventory = async () => [slow, stalled];
  const captured = [];
  const options = {
    listTorrents: inventory,
    resolveOwnership: async (_config, candidate) => ownershipFor(candidate),
  };
  const base = Date.UTC(2026, 0, 2);
  await tickQbittorrentRecovery(value, acceptingEnqueue(captured), { ...options, now: base });
  await tickQbittorrentRecovery(value, acceptingEnqueue(captured), { ...options, now: base + 59_000 });
  assert.equal(captured.length, 0);
  await tickQbittorrentRecovery(value, acceptingEnqueue(captured), { ...options, now: base + 60_000 });
  assert.deepEqual(captured.map((candidate) => candidate.reason).sort(), ['slow', 'stalled']);
  await tickQbittorrentRecovery(value, acceptingEnqueue(captured), { ...options, now: base + 120_000 });
  assert.equal(captured.length, 2);
});

test('recovery, reason, category, policy, outage, and polling gaps reset observation windows', { concurrency: false }, async () => {
  const base = Date.UTC(2026, 0, 3);
  const captured = [];
  const enqueue = acceptingEnqueue(captured);
  const resolveOwnership = async (_config, candidate) => ownershipFor(candidate);

  const recoveredConfig = config('recovered');
  const slow = torrent('recoverhash');
  await tickQbittorrentRecovery(recoveredConfig, enqueue, { now: base, listTorrents: async () => [slow], resolveOwnership });
  await tickQbittorrentRecovery(recoveredConfig, enqueue, { now: base + 30_000, listTorrents: async () => [{ ...slow, dlspeed: 200 * 1024 }], resolveOwnership });
  await tickQbittorrentRecovery(recoveredConfig, enqueue, { now: base + 60_000, listTorrents: async () => [slow], resolveOwnership });
  await tickQbittorrentRecovery(recoveredConfig, enqueue, { now: base + 119_000, listTorrents: async () => [slow], resolveOwnership });
  assert.equal(captured.length, 0);
  await tickQbittorrentRecovery(recoveredConfig, enqueue, { now: base + 120_000, listTorrents: async () => [slow], resolveOwnership });
  assert.equal(captured.length, 1);

  const resetConfig = config('reason-category');
  const changing = torrent('changinghash', { category: 'a' });
  await tickQbittorrentRecovery(resetConfig, enqueue, { now: base, listTorrents: async () => [changing], resolveOwnership });
  await tickQbittorrentRecovery(resetConfig, enqueue, { now: base + 30_000, listTorrents: async () => [{ ...changing, state: 'stalledDL' }], resolveOwnership });
  await tickQbittorrentRecovery(resetConfig, enqueue, { now: base + 60_000, listTorrents: async () => [{ ...changing, state: 'stalledDL', category: 'b' }], resolveOwnership });
  await tickQbittorrentRecovery(resetConfig, enqueue, { now: base + 119_000, listTorrents: async () => [{ ...changing, state: 'stalledDL', category: 'b' }], resolveOwnership });
  assert.equal(captured.length, 1);
  await tickQbittorrentRecovery(resetConfig, enqueue, { now: base + 120_000, listTorrents: async () => [{ ...changing, state: 'stalledDL', category: 'b' }], resolveOwnership });
  assert.equal(captured.length, 2);

  const originalPolicy = config('policy', { slowSpeedKibPerSecond: 100 });
  const changedPolicy = config('policy', { slowSpeedKibPerSecond: 150 });
  const policyTorrent = torrent('policyhash');
  await tickQbittorrentRecovery(originalPolicy, enqueue, { now: base, listTorrents: async () => [policyTorrent], resolveOwnership });
  await tickQbittorrentRecovery(changedPolicy, enqueue, { now: base + 60_000, listTorrents: async () => [policyTorrent], resolveOwnership });
  assert.equal(captured.length, 2);
  await tickQbittorrentRecovery(changedPolicy, enqueue, { now: base + 120_000, listTorrents: async () => [policyTorrent], resolveOwnership });
  assert.equal(captured.length, 3);

  const outageConfig = config('outage');
  const outageTorrent = torrent('outagehash');
  await tickQbittorrentRecovery(outageConfig, enqueue, { now: base, listTorrents: async () => [outageTorrent], resolveOwnership });
  await tickQbittorrentRecovery(outageConfig, enqueue, { now: base + 30_000, listTorrents: async () => { throw new Error('offline'); }, resolveOwnership });
  await tickQbittorrentRecovery(outageConfig, enqueue, { now: base + 90_000, listTorrents: async () => [outageTorrent], resolveOwnership });
  await tickQbittorrentRecovery(outageConfig, enqueue, { now: base + 149_000, listTorrents: async () => [outageTorrent], resolveOwnership });
  assert.equal(captured.length, 3);
  await tickQbittorrentRecovery(outageConfig, enqueue, { now: base + 150_000, listTorrents: async () => [outageTorrent], resolveOwnership });
  assert.equal(captured.length, 4);

  const gapConfig = config('gap');
  const gapTorrent = torrent('gaphash');
  await tickQbittorrentRecovery(gapConfig, enqueue, { now: base, maxPollGapMs: 90_000, listTorrents: async () => [gapTorrent], resolveOwnership });
  await tickQbittorrentRecovery(gapConfig, enqueue, { now: base + 120_000, maxPollGapMs: 90_000, listTorrents: async () => [gapTorrent], resolveOwnership });
  assert.equal(captured.length, 4);
  await tickQbittorrentRecovery(gapConfig, enqueue, { now: base + 180_000, maxPollGapMs: 90_000, listTorrents: async () => [gapTorrent], resolveOwnership });
  assert.equal(captured.length, 5);
});

test('category exclusions are exact, include Uncategorized, malformed torrents skip, and each tick caps at three', { concurrency: false }, async () => {
  const value = config('excluded', {
    slowMinutes: 0,
    stalledMinutes: 0,
    excludedCategories: ['movies', ''],
  });
  const candidates = [
    torrent('excluded-movies', { category: 'movies' }),
    torrent('excluded-empty', { category: '' }),
    torrent('case-sensitive', { category: 'Movies' }),
    torrent('second', { category: 'tv' }),
    torrent('third', { category: 'music' }),
    torrent('fourth', { category: 'books' }),
    torrent('malformed', { category: 'other', recoveryFieldsValid: false, dlspeed: null }),
  ];
  const captured = [];
  await tickQbittorrentRecovery(value, acceptingEnqueue(captured), {
    now: Date.UTC(2026, 0, 4),
    listTorrents: async () => candidates,
    resolveOwnership: async (_config, candidate) => ownershipFor(candidate),
  });
  assert.equal(captured.length, 3);
  assert.ok(captured.some((candidate) => candidate.hash === 'case-sensitive'));
  assert.ok(captured.every((candidate) => !['excluded-movies', 'excluded-empty', 'malformed'].includes(candidate.hash)));
});

function mockArrFetch(context, handler) {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = handler;
}

function historyPage(records, overrides = {}) {
  return {
    page: 1,
    pageSize: 100,
    totalRecords: records.length,
    records,
    ...overrides,
  };
}

test('ownership resolution fails closed for no, ambiguous, and non-qBittorrent matches', { concurrency: false }, async (context) => {
  const value = config('ownership', {}, {
    radarr: { configured: true, url: 'http://radarr.invalid', apiKey: 'r', kind: 'radarr' },
    sonarr: { configured: true, url: 'http://sonarr.invalid', apiKey: 's', kind: 'sonarr' },
  });
  const target = torrent('abcdef');
  let scenario = 'none';
  mockArrFetch(context, async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/v3/queue/details') {
      if (scenario === 'none') return Response.json([]);
      if (scenario === 'ambiguous') return Response.json([{ id: 1, movieId: 7, downloadId: 'ABCDEF', protocol: 'torrent', downloadClient: 'qBittorrent' }]);
      return Response.json(url.hostname === 'radarr.invalid'
        ? [{ id: 1, movieId: 7, downloadId: 'ABCDEF', protocol: 'torrent', downloadClient: 'Transmission' }]
        : []);
    }
    if (url.pathname === '/api/v3/downloadclient') {
      return Response.json(scenario === 'non-qbittorrent' && url.hostname === 'radarr.invalid'
        ? [{ id: 2, name: 'Transmission', enable: true, implementation: 'Transmission', protocol: 'torrent' }]
        : [{ id: 2, name: 'qBittorrent', enable: true, implementation: 'QBittorrent', protocol: 'torrent' }]);
    }
    return Response.json({ records: [], totalRecords: 0 });
  });

  await assert.rejects(resolveQbittorrentRecoveryOwnership(value, target), /found 0/);
  scenario = 'ambiguous';
  await assert.rejects(resolveQbittorrentRecoveryOwnership(value, target), /found 2/);
  scenario = 'non-qbittorrent';
  await assert.rejects(resolveQbittorrentRecoveryOwnership(value, target), /does not resolve.*qBittorrent/i);
});

test('Sonarr ownership expands all grabbed episodes and Arr deletion uses the exact safe query', { concurrency: false }, async (context) => {
  const value = config('sonarr', {}, {
    sonarr: { configured: true, url: 'http://sonarr.invalid', apiKey: 's', kind: 'sonarr' },
  });
  const calls = [];
  mockArrFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === '/api/v3/queue/details') return Response.json([
      { id: 31, seriesId: 8, episodeId: 81, downloadId: 'ABCDEF', protocol: 'torrent', downloadClient: 'qBittorrent TV' },
    ]);
    if (url.pathname === '/api/v3/downloadclient') return Response.json([
      { id: 4, name: 'qBittorrent TV', enable: true, implementation: 'QBittorrent', protocol: 'torrent' },
    ]);
    if (url.pathname === '/api/v3/history') return Response.json(historyPage([
      { id: 1, seriesId: 8, episodeId: 81, downloadId: 'abcdef', eventType: 'grabbed' },
      { id: 2, seriesId: 8, episodeId: 82, downloadId: 'ABCDEF', eventType: 'grabbed' },
    ]));
    if (url.pathname === '/api/v3/queue/31' && init.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({}, { status: 404 });
  });

  const owner = await resolveQbittorrentRecoveryOwnership(value, torrent('abcdef', { category: 'tv' }));
  assert.equal(owner.app, 'sonarr');
  assert.deepEqual(owner.searchIds, [81, 82]);
  await removeQbittorrentRecoveryFromArr(value.sonarr, 31);
  const deletion = calls.find(({ init }) => init.method === 'DELETE');
  assert.equal(deletion.url.pathname, '/api/v3/queue/31');
  assert.deepEqual(Object.fromEntries(deletion.url.searchParams), {
    removeFromClient: 'true',
    blocklist: 'true',
    skipRedownload: 'true',
    changeCategory: 'false',
  });
});

test('ownership rejects mixed grabbed history with any malformed or inconsistent media identity', { concurrency: false }, async (context) => {
  const radarrConfig = config('malformed-radarr', {}, {
    radarr: { configured: true, url: 'http://radarr.invalid', apiKey: 'r', kind: 'radarr' },
  });
  const sonarrConfig = config('malformed-sonarr', {}, {
    sonarr: { configured: true, url: 'http://sonarr.invalid', apiKey: 's', kind: 'sonarr' },
  });
  let history = [];
  mockArrFetch(context, async (input) => {
    const url = new URL(input);
    const isRadarr = url.hostname === 'radarr.invalid';
    if (url.pathname === '/api/v3/queue/details') return Response.json(isRadarr
      ? [{ id: 31, movieId: 7, downloadId: 'ABCDEF', protocol: 'torrent', downloadClient: 'qBittorrent' }]
      : [{ id: 32, seriesId: 8, episodeId: 81, downloadId: 'ABCDEF', protocol: 'torrent', downloadClient: 'qBittorrent' }]);
    if (url.pathname === '/api/v3/downloadclient') return Response.json([
      { id: 4, name: 'qBittorrent', enable: true, implementation: 'QBittorrent', protocol: 'torrent' },
    ]);
    if (url.pathname === '/api/v3/history') return Response.json(historyPage(history));
    return Response.json({}, { status: 404 });
  });

  history = [
    { id: 1, movieId: 7, downloadId: 'ABCDEF', eventType: 'grabbed' },
    { id: 2, downloadId: 'ABCDEF', eventType: 'grabbed' },
  ];
  await assert.rejects(
    resolveQbittorrentRecoveryOwnership(radarrConfig, torrent('abcdef')),
    /missing or malformed movie id/i,
  );

  history = [
    { id: 3, seriesId: 8, episodeId: 81, downloadId: 'ABCDEF', eventType: 'grabbed' },
    { id: 4, seriesId: 8, downloadId: 'ABCDEF', eventType: 'grabbed' },
  ];
  await assert.rejects(
    resolveQbittorrentRecoveryOwnership(sonarrConfig, torrent('abcdef', { category: 'tv' })),
    /missing or malformed series or episode id/i,
  );

  history = [
    { id: 5, seriesId: 8, episodeId: 81, downloadId: 'ABCDEF', eventType: 'grabbed' },
    { id: 6, seriesId: 9, episodeId: 82, downloadId: 'ABCDEF', eventType: 'grabbed' },
  ];
  await assert.rejects(
    resolveQbittorrentRecoveryOwnership(sonarrConfig, torrent('abcdef', { category: 'tv' })),
    /exactly one series/i,
  );
});

test('Arr reconciliation rejects invalid timestamps and ignores stale evidence', { concurrency: false }, async (context) => {
  const connection = { configured: true, url: 'http://radarr.invalid', apiKey: 'r', kind: 'radarr' };
  mockArrFetch(context, async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/v3/history') return Response.json(historyPage([
      { id: 1, movieId: 7, downloadId: 'ABCDEF', eventType: 'downloadFailed', date: '2026-01-01T00:00:00.000Z' },
    ]));
    if (url.pathname === '/api/v3/command') return Response.json([
      { id: 2, name: 'MoviesSearch', body: { movieIds: [7] }, queued: '2026-01-01T00:00:00.000Z' },
    ]);
    return Response.json({}, { status: 404 });
  });

  await assert.rejects(hasArrDownloadFailedSince(connection, 'ABCDEF', 'not-a-date'), /timestamp is invalid/i);
  await assert.rejects(hasArrDownloadFailedSince(connection, 'ABCDEF', '0'), /timestamp is invalid/i);
  await assert.rejects(findMatchingSearchCommand(connection, 'radarr', [7], ''), /timestamp is invalid/i);
  assert.equal(await hasArrDownloadFailedSince(connection, 'ABCDEF', '2026-02-01T00:00:00.000Z'), false);
  assert.equal(await findMatchingSearchCommand(connection, 'radarr', [7], '2026-02-01T00:00:00.000Z'), null);
  assert.equal(await hasArrDownloadFailedSince(connection, 'ABCDEF', '2025-12-01T00:00:00.000Z'), true);
  assert.equal((await findMatchingSearchCommand(connection, 'radarr', [7], '2025-12-01T00:00:00.000Z'))?.id, 2);
});

test('Arr history pagination fails closed on invalid, partial, and over-cap responses', { concurrency: false }, async (context) => {
  const connection = { configured: true, url: 'http://radarr.invalid', apiKey: 'r', kind: 'radarr' };
  let scenario = 'invalid-total';
  mockArrFetch(context, async (input) => {
    const url = new URL(input);
    const page = Number(url.searchParams.get('page'));
    if (scenario === 'invalid-total') {
      return Response.json(historyPage([], { page, totalRecords: '0' }));
    }
    if (scenario === 'partial') {
      return Response.json(historyPage([
        { id: 1, movieId: 7, downloadId: 'ABCDEF', eventType: 'grabbed' },
      ], { page, totalRecords: 150 }));
    }
    const records = Array.from({ length: 100 }, (_, index) => ({
      id: (page - 1) * 100 + index + 1,
      movieId: 7,
      downloadId: 'ABCDEF',
      eventType: 'grabbed',
    }));
    return Response.json(historyPage(records, { page, totalRecords: 10_001 }));
  });

  await assert.rejects(listArrHistoryByDownloadId(connection, 'ABCDEF'), /invalid history pagination contract/i);
  scenario = 'partial';
  await assert.rejects(listArrHistoryByDownloadId(connection, 'ABCDEF'), /ended before all records/i);
  scenario = 'over-cap';
  await assert.rejects(listArrHistoryByDownloadId(connection, 'ABCDEF'), /exceeded the safety cap/i);
});

async function waitForJob(id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = getJob(id);
    if (job && !['queued', 'running', 'cancelling'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job ${id}`);
}

async function waitForNoActiveJobs() {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (!listJobs().some((job) => ['queued', 'running', 'cancelling'].includes(job.status))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for the recovery job queue to settle');
}

test('pre-mutation failures do not block a new policy and remain bounded in job history', { concurrency: false }, async () => {
  const original = config('bounded', { slowSpeedKibPerSecond: 100 });
  const changed = config('bounded', { slowSpeedKibPerSecond: 101 });
  const originalIdentity = qbittorrentRecoveryPolicyIdentity(original);
  const changedIdentity = qbittorrentRecoveryPolicyIdentity(changed);
  function candidate(hash, policyIdentity) {
    return {
      ...ownershipFor(torrent(hash)),
      reason: 'slow',
      observedSince: new Date(Date.now() - 120_000).toISOString(),
      detectedAt: new Date().toISOString(),
      policyIdentity,
    };
  }

  for (let index = 0; index < 105; index += 1) {
    assert.ok(await createQbittorrentRecoveryJob(original, [candidate(`bounded-${index}`, originalIdentity)]));
  }
  assert.ok(listJobs().length > 100);
  startJobWorker(() => changed);
  await waitForNoActiveJobs();
  stopJobWorker();
  assert.equal(listJobs().length, 100);

  const replacement = await createQbittorrentRecoveryJob(changed, [candidate('bounded-104', changedIdentity)]);
  assert.ok(replacement);
  await cancelJob(replacement.id);
  startJobWorker(() => changed);
  const cancelled = await waitForJob(replacement.id);
  stopJobWorker();
  assert.equal(cancelled.status, 'cancelled');
});

test('durable recovery jobs dedupe, revalidate, delete through Arr, and never search while qB still has the torrent', { concurrency: false }, async (context) => {
  const value = config('jobs', { slowMinutes: 0 }, {
    radarr: { configured: true, url: 'http://radarr.invalid', apiKey: 'r', kind: 'radarr' },
  });
  value.qbittorrent.url = 'http://qbit.invalid';
  let active = {
    hash: 'firsthash',
    movieId: 7,
    queueId: 41,
    present: true,
    speed: 10 * 1024,
    category: 'movies',
    deleteRemoves: true,
    deleteThrows: false,
    mutateCategoryDuringHistory: null,
  };
  const deletes = [];
  const commands = [];
  mockArrFetch(context, async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test' } });
    if (url.pathname === '/api/v2/torrents/info') return Response.json(active.present ? [{
      hash: active.hash,
      name: `Release ${active.hash}`,
      category: active.category,
      state: 'downloading',
      dlspeed: active.speed,
      progress: 0.4,
      amount_left: 600,
      added_on: 1,
      last_activity: 1,
    }] : []);
    if (url.pathname === '/api/v2/auth/logout') return new Response(null, { status: 204 });
    if (url.pathname === '/api/v3/queue/details') return Response.json(active.present ? [{
      id: active.queueId,
      movieId: active.movieId,
      downloadId: active.hash.toUpperCase(),
      protocol: 'torrent',
      downloadClient: 'qBittorrent',
    }] : []);
    if (url.pathname === '/api/v3/downloadclient') return Response.json([
      { id: 2, name: 'qBittorrent', enable: true, implementation: 'QBittorrent', protocol: 'torrent' },
    ]);
    if (url.pathname === '/api/v3/history') {
      const records = [
        { id: 9, movieId: active.movieId, downloadId: active.hash.toUpperCase(), eventType: 'grabbed' },
      ];
      if (active.mutateCategoryDuringHistory) {
        active.category = active.mutateCategoryDuringHistory;
        active.mutateCategoryDuringHistory = null;
      }
      if (active.mutateApiKeyDuringHistory) {
        value.radarr.apiKey = active.mutateApiKeyDuringHistory;
        active.mutateApiKeyDuringHistory = null;
      }
      return Response.json(historyPage(records));
    }
    if (url.pathname === `/api/v3/queue/${active.queueId}` && init.method === 'DELETE') {
      deletes.push(url);
      if (active.deleteThrows) throw new Error('connection interrupted after DELETE dispatch');
      if (active.deleteRemoves) active.present = false;
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/v3/command' && init.method === 'POST') {
      commands.push(JSON.parse(init.body));
      return Response.json({ id: 73 }, { status: 201 });
    }
    if (url.pathname === '/api/v3/command' && init.method !== 'POST') return Response.json([]);
    return Response.json({}, { status: 404 });
  });

  function candidateForCurrent() {
    const policyIdentity = qbittorrentRecoveryPolicyIdentity(value);
    return {
      id: `qbittorrent:${active.hash}`,
      app: 'radarr',
      hash: active.hash,
      downloadId: active.hash.toUpperCase(),
      queueId: active.queueId,
      downloadClientName: 'qBittorrent',
      downloadClientId: 2,
      searchIds: [active.movieId],
      seriesId: null,
      historyIds: [9],
      title: `Release ${active.hash}`,
      subtitle: 'Radarr download',
      category: active.category,
      state: 'downloading',
      reason: 'slow',
      observedSince: new Date(Date.now() - 120_000).toISOString(),
      detectedAt: new Date().toISOString(),
      policyIdentity,
    };
  }

  const first = await createQbittorrentRecoveryJob(value, [candidateForCurrent()]);
  assert.ok(first);
  assert.equal(await createQbittorrentRecoveryJob(value, [candidateForCurrent()]), null);
  const jobsBeforeObserverAck = listJobs().filter((job) => job.type === 'qbittorrent-recovery'
    && job.items.some((item) => item.candidate.hash === active.hash)).length;
  await tickQbittorrentRecovery(value, createQbittorrentRecoveryJob, {
    now: Date.now(),
    listTorrents: async () => [torrent(active.hash, { category: active.category })],
    resolveOwnership: async (_config, candidate) => ownershipFor(candidate),
  });
  await tickQbittorrentRecovery(value, createQbittorrentRecoveryJob, {
    now: Date.now() + 1_000,
    listTorrents: async () => [torrent(active.hash, { category: active.category })],
    resolveOwnership: async (_config, candidate) => ownershipFor(candidate),
  });
  assert.equal(listJobs().filter((job) => job.type === 'qbittorrent-recovery'
    && job.items.some((item) => item.candidate.hash === active.hash)).length, jobsBeforeObserverAck);
  assert.equal(deletes.length, 0);
  startJobWorker(() => value);
  const completed = await waitForJob(first.id);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.items[0].phase, 'search_queued');
  assert.equal(deletes.length, 1);
  assert.deepEqual(Object.fromEntries(deletes[0].searchParams), {
    removeFromClient: 'true',
    blocklist: 'true',
    skipRedownload: 'true',
    changeCategory: 'false',
  });
  assert.deepEqual(commands, [{ name: 'MoviesSearch', movieIds: [7] }]);

  active = {
    hash: 'remainshash',
    movieId: 8,
    queueId: 42,
    present: true,
    speed: 10 * 1024,
    category: 'movies',
    deleteRemoves: false,
    deleteThrows: false,
    mutateCategoryDuringHistory: null,
  };
  const remains = await createQbittorrentRecoveryJob(value, [candidateForCurrent()]);
  const failedRemoval = await waitForJob(remains.id);
  assert.equal(failedRemoval.status, 'completed_with_errors');
  assert.equal(failedRemoval.items[0].phase, 'arr_removed');
  assert.match(failedRemoval.items[0].error, /still lists the torrent/i);
  assert.equal(commands.length, 1);

  active = {
    hash: 'revalidatedhash',
    movieId: 9,
    queueId: 43,
    present: true,
    speed: 500 * 1024,
    category: 'movies',
    deleteRemoves: true,
    deleteThrows: false,
    mutateCategoryDuringHistory: null,
  };
  const changed = await createQbittorrentRecoveryJob(value, [candidateForCurrent()]);
  const failedRevalidation = await waitForJob(changed.id);
  assert.equal(failedRevalidation.status, 'completed_with_errors');
  assert.equal(failedRevalidation.items[0].phase, 'waiting');
  assert.match(failedRevalidation.items[0].error, /recovered.*policy/i);
  assert.equal(deletes.length, 2);
  assert.equal(commands.length, 1);

  active = {
    hash: 'delayedmutationhash',
    movieId: 10,
    queueId: 44,
    present: true,
    speed: 10 * 1024,
    category: 'movies',
    deleteRemoves: true,
    deleteThrows: false,
    mutateCategoryDuringHistory: 'protected',
  };
  const deletionCountBeforeMutation = deletes.length;
  const changedDuringOwnership = await createQbittorrentRecoveryJob(value, [candidateForCurrent()]);
  const failedDelayedMutation = await waitForJob(changedDuringOwnership.id);
  assert.equal(failedDelayedMutation.status, 'completed_with_errors');
  assert.equal(failedDelayedMutation.items[0].phase, 'waiting');
  assert.match(failedDelayedMutation.items[0].error, /changed category/i);
  assert.equal(deletes.length, deletionCountBeforeMutation);
  assert.equal(commands.length, 1);

  active = {
    hash: 'connectionmutationhash',
    movieId: 12,
    queueId: 46,
    present: true,
    speed: 10 * 1024,
    category: 'movies',
    deleteRemoves: true,
    deleteThrows: false,
    mutateCategoryDuringHistory: null,
    mutateApiKeyDuringHistory: 'rotated-api-key',
  };
  const deletionCountBeforeConnectionMutation = deletes.length;
  const connectionChanged = await createQbittorrentRecoveryJob(value, [candidateForCurrent()]);
  const failedConnectionMutation = await waitForJob(connectionChanged.id);
  assert.equal(failedConnectionMutation.status, 'completed_with_errors');
  assert.equal(failedConnectionMutation.items[0].phase, 'waiting');
  assert.match(failedConnectionMutation.items[0].error, /API connection changed/i);
  assert.equal(deletes.length, deletionCountBeforeConnectionMutation);
  assert.equal(commands.length, 1);
  value.radarr.apiKey = 'r';

  active = {
    hash: 'interrupteddeletehash',
    movieId: 11,
    queueId: 45,
    present: true,
    speed: 10 * 1024,
    category: 'movies',
    deleteRemoves: false,
    deleteThrows: true,
    mutateCategoryDuringHistory: null,
  };
  const deletionCountBeforeInterruption = deletes.length;
  const interrupted = await createQbittorrentRecoveryJob(value, [candidateForCurrent()]);
  const failedInterrupted = await waitForJob(interrupted.id);
  assert.equal(failedInterrupted.status, 'completed_with_errors');
  assert.equal(failedInterrupted.items[0].phase, 'delete_requested');
  const deletionCountAfterInterruption = deletes.length;
  assert.equal(deletionCountAfterInterruption, deletionCountBeforeInterruption + 1);
  active.deleteThrows = false;
  await retryJob(interrupted.id);
  const reconciledFailure = await waitForJob(interrupted.id);
  assert.equal(reconciledFailure.status, 'completed_with_errors');
  assert.equal(reconciledFailure.items[0].phase, 'delete_requested');
  assert.match(reconciledFailure.items[0].error, /not repeated/i);
  assert.equal(deletes.length, deletionCountAfterInterruption);
  assert.equal(commands.length, 1);
  assert.equal(await createQbittorrentRecoveryJob(value, [candidateForCurrent()]), null);
});

test('recovery state is persisted in the private JSON store', { concurrency: false }, async () => {
  const body = JSON.parse(await readFile(path.join(process.env.CONFIG_DIR, 'qbittorrent-recovery.json'), 'utf8'));
  assert.equal(body.version, 1);
  assert.ok(Object.hasOwn(body, 'observations'));
});
