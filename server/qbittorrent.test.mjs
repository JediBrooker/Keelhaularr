import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  getQbittorrentTorrent,
  inspectQbittorrent,
  listQbittorrentCategories,
  listQbittorrentTorrents,
  mapQbittorrentPath,
  pathIsProtected,
} from './qbittorrent.mjs';

function connection(overrides = {}) {
  return {
    configured: true,
    url: 'http://qbittorrent.invalid',
    username: 'captain',
    password: 'secret',
    pathMaps: [{ from: '/remote/downloads', to: '/data/downloads' }],
    ...overrides,
  };
}

function mockQbittorrent(context, { loginStatus = 200, loginBody = 'Ok.', cookie = 'SID=legacy-session' } = {}) {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ endpoint: url.pathname, init });
    if (url.pathname === '/api/v2/auth/login') {
      return new Response(loginStatus === 204 ? null : loginBody, {
        status: loginStatus,
        headers: cookie ? { 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Strict` } : {},
      });
    }
    if (url.pathname === '/api/v2/app/version') return new Response('5.2.1');
    if (url.pathname === '/api/v2/torrents/info') {
      return Response.json([
        { name: 'still-downloading', progress: 0.25, amount_left: 750, content_path: '/remote/downloads/still-downloading' },
        { name: 'left-reported', progress: 1, amount_left: 10, content_path: '/remote/downloads/left-reported.mkv' },
        { name: 'completed', progress: 1, amount_left: 0, content_path: '/remote/downloads/completed.mkv' },
      ]);
    }
    if (url.pathname === '/api/v2/auth/logout') return new Response('');
    return new Response('not found', { status: 404 });
  };
  return calls;
}

test('legacy 200 login forwards the SID cookie and selects only incomplete torrents', async (context) => {
  const calls = mockQbittorrent(context);

  const snapshot = await inspectQbittorrent(connection());

  assert.equal(snapshot.status, 'connected');
  assert.equal(snapshot.version, '5.2.1');
  assert.equal(snapshot.totalTorrentCount, 3);
  assert.equal(snapshot.incompleteTorrentCount, 2);
  assert.deepEqual(snapshot.incompletePaths, [
    path.resolve('/data/downloads/still-downloading'),
    path.resolve('/data/downloads/left-reported.mkv'),
  ]);
  assert.equal(snapshot.unmappedIncompleteCount, 0);
  const authenticatedCalls = calls.filter(({ endpoint }) => endpoint !== '/api/v2/auth/login');
  assert.ok(authenticatedCalls.length >= 3);
  assert.ok(authenticatedCalls.every(({ init }) => init.headers.Cookie === 'SID=legacy-session'));
});

test('modern 204 login forwards its QBT_SID cookie', async (context) => {
  const calls = mockQbittorrent(context, {
    loginStatus: 204,
    loginBody: '',
    cookie: 'QBT_SID=modern-session',
  });

  const snapshot = await inspectQbittorrent(connection());

  assert.equal(snapshot.status, 'connected');
  const authenticatedCalls = calls.filter(({ endpoint }) => endpoint !== '/api/v2/auth/login');
  assert.ok(authenticatedCalls.length >= 3);
  assert.ok(authenticatedCalls.every(({ init }) => init.headers.Cookie === 'QBT_SID=modern-session'));
});

test('category discovery preserves exact data and always includes synthetic Uncategorized', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === '/api/v2/auth/login') {
      return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=category-session' } });
    }
    if (url.pathname === '/api/v2/torrents/categories') {
      return Response.json({
        'Radarr UHD': {
          name: 'server-supplied-name-is-not-authoritative',
          savePath: 'D:\\Downloads\\Movies UHD',
          downloadPath: 'D:\\Incomplete',
          color: '#112233',
        },
        'Sonarr/Anime': { name: 'Sonarr/Anime', savePath: '/downloads/Anime' },
      });
    }
    if (url.pathname === '/api/v2/auth/logout') return new Response('');
    return new Response('not found', { status: 404 });
  };

  const categories = await listQbittorrentCategories(connection());

  assert.deepEqual(categories, [
    { name: '', savePath: '', synthetic: true },
    {
      name: 'Radarr UHD',
      savePath: 'D:\\Downloads\\Movies UHD',
      downloadPath: 'D:\\Incomplete',
      color: '#112233',
    },
    { name: 'Sonarr/Anime', savePath: '/downloads/Anime' },
  ]);
  assert.equal(calls.filter(({ url }) => url.pathname === '/api/v2/auth/login').length, 1);
  assert.equal(calls.filter(({ url }) => url.pathname === '/api/v2/torrents/info').length, 0);
  assert.ok(calls
    .filter(({ url }) => url.pathname !== '/api/v2/auth/login')
    .every(({ init }) => init.headers.Cookie === 'SID=category-session'));
});

test('single torrent lookup URL-encodes and exact-matches the opaque hash', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const hash = 'MiXeD/hash|with space';
  let inventoryUrl = null;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/v2/auth/login') {
      return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=lookup-session' } });
    }
    if (url.pathname === '/api/v2/torrents/info') {
      inventoryUrl = String(input);
      return Response.json([
        {
          hash,
          name: 'Exact match',
          category: 'Radarr',
          state: 'stalledDL',
          dlspeed: 0,
          progress: 0.4,
          amount_left: 600,
          added_on: 100,
          last_activity: 200,
        },
        {
          hash: hash.toLowerCase(),
          name: 'Case-folded mismatch',
          category: 'Radarr',
          state: 'stalledDL',
          dlspeed: 0,
          progress: 0.4,
          amount_left: 600,
          added_on: 100,
          last_activity: 200,
        },
      ]);
    }
    if (url.pathname === '/api/v2/auth/logout') return new Response('');
    return new Response('not found', { status: 404 });
  };

  const torrent = await getQbittorrentTorrent(connection(), hash);

  assert.equal(torrent.hash, hash);
  assert.equal(new URL(inventoryUrl).searchParams.get('hashes'), hash);
  assert.match(inventoryUrl, /hashes=MiXeD%2Fhash%7Cwith%20space/);
});

test('recovery inventory preserves aliases and marks malformed fields ineligible', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') {
      return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=inventory-session' } });
    }
    if (endpoint === '/api/v2/torrents/info') {
      return Response.json([
        {
          hash: 'ExAcT-Opaque-Hash',
          name: '  Release Name  ',
          category: 'Sonarr/Anime',
          state: 'downloading',
          dlspeed: 8192,
          progress: 0.5,
          amount_left: 123456,
          added_on: 1710000000,
          last_activity: 1710000300,
          tracker: 'https://tracker.invalid/announce',
          magnet_uri: 'magnet:?xt=urn:btih:sensitive-passkey',
        },
        {
          hash: 'malformed',
          name: 'Malformed speed',
          category: 'Radarr',
          state: 'downloading',
          dlspeed: 'slow',
          progress: 1.1,
          amount_left: -1,
          added_on: 1.5,
          last_activity: null,
        },
      ]);
    }
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response('not found', { status: 404 });
  };

  const torrents = await listQbittorrentTorrents(connection());

  assert.equal(torrents[0].recoveryFieldsValid, true);
  assert.equal(torrents[0].hash, 'ExAcT-Opaque-Hash');
  assert.equal(torrents[0].name, '  Release Name  ');
  assert.equal(torrents[0].category, 'Sonarr/Anime');
  assert.equal(torrents[0].amount_left, 123456);
  assert.equal(torrents[0].amountLeft, 123456);
  assert.equal(torrents[0].added_on, 1710000000);
  assert.equal(torrents[0].addedOn, 1710000000);
  assert.equal(torrents[0].last_activity, 1710000300);
  assert.equal(torrents[0].lastActivity, 1710000300);
  assert.equal(torrents[0].tracker, undefined);
  assert.equal(torrents[0].magnet_uri, undefined);
  assert.equal(torrents[1].recoveryFieldsValid, false);
  assert.equal(torrents[1].dlspeed, null);
  assert.equal(torrents[1].progress, null);
  assert.equal(torrents[1].amountLeft, null);
  assert.equal(torrents[1].addedOn, null);
  assert.equal(torrents[1].lastActivity, null);
});

test('path mapping uses the longest matching prefix and normalizes Windows separators', () => {
  assert.equal(
    mapQbittorrentPath('/remote/downloads/tv/show/episode.mkv', [
      { from: '/remote/downloads', to: '/data/general' },
      { from: '/remote/downloads/tv', to: '/data/television' },
    ]),
    path.resolve('/data/television/show/episode.mkv'),
  );
  assert.equal(
    mapQbittorrentPath('D:\\Torrents\\TV\\Show\\episode.mkv', [
      { from: 'D:\\Torrents', to: '/data/general' },
      { from: 'D:\\Torrents\\TV', to: '/data/television' },
    ]),
    path.resolve('/data/television/Show/episode.mkv'),
  );
  assert.equal(
    mapQbittorrentPath('D:\\Torrents-Old\\movie.mkv', [
      { from: 'D:\\Torrents', to: '/data/general' },
    ]),
    null,
  );
  assert.equal(
    mapQbittorrentPath('d:\\torrents\\TV\\Show\\episode.mkv///', [
      { from: 'D:\\TORRENTS\\tv\\', to: '/data/television' },
    ]),
    path.resolve('/data/television/Show/episode.mkv'),
  );
  assert.equal(
    mapQbittorrentPath('/remote/downloads/tv/show/episode.mkv', [
      { from: '/remote/downloads/////', to: '/data/general' },
      { from: '/remote/downloads/tv', to: '/data/television' },
    ]),
    path.resolve('/data/television/show/episode.mkv'),
  );
});

test('metadata-pending torrents are described without counting as unmapped while other missing paths fail closed', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.2.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json([
      { hash: 'metadata-hash', name: 'Fetching metadata', state: 'metaDL', progress: 0, amount_left: 1 },
      { hash: 'forced-metadata-hash', name: 'Forced metadata', state: 'forcedMetaDL', progress: 0, amount_left: 1 },
      { hash: 'missing-path-hash', name: 'Queued without a path', state: 'queuedDL', progress: 0.2, amount_left: 80 },
      { hash: 'mapped-hash', name: 'Mapped download', state: 'downloading', progress: 0.4, amount_left: 60, content_path: '/remote/downloads/mapped' },
    ]);
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };

  const snapshot = await inspectQbittorrent(connection());

  assert.equal(snapshot.incompleteTorrentCount, 4);
  assert.deepEqual(snapshot.incompletePaths, [path.resolve('/data/downloads/mapped')]);
  assert.equal(snapshot.metadataPendingCount, 2);
  assert.deepEqual(snapshot.metadataPendingTorrents, [
    {
      name: 'Fetching metadata',
      hash: 'metadata-hash',
      hashPrefix: 'metadata-has',
      state: 'metaDL',
      reason: 'metadata-pending',
      rawPath: null,
    },
    {
      name: 'Forced metadata',
      hash: 'forced-metadata-hash',
      hashPrefix: 'forced-metad',
      state: 'forcedMetaDL',
      reason: 'metadata-pending',
      rawPath: null,
    },
  ]);
  assert.equal(snapshot.metadataPendingOmittedCount, 0);
  assert.equal(snapshot.unmappedIncompleteCount, 1);
  assert.deepEqual(snapshot.unresolvedIncompleteTorrents, [{
    name: 'Queued without a path',
    hash: 'missing-path-hash',
    hashPrefix: 'missing-path',
    state: 'queuedDL',
    reason: 'missing-content-path',
    rawPath: null,
  }]);
});

test('unresolved inspection details are bounded and strip control characters', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const torrents = Array.from({ length: 103 }, (_, index) => ({
    hash: `${index}\u0000${'h'.repeat(200)}`,
    name: `Unsafe\nname ${index} ${'n'.repeat(300)}`,
    state: `queuedDL\t${'s'.repeat(100)}`,
    progress: 0.1,
    amount_left: 90,
    ...(index === 0 ? { content_path: `relative\n${'p'.repeat(5000)}` } : {}),
  }));
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.2.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json(torrents);
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };

  const snapshot = await inspectQbittorrent(connection());
  const first = snapshot.unresolvedIncompleteTorrents[0];

  assert.equal(snapshot.unmappedIncompleteCount, 103);
  assert.equal(snapshot.unresolvedIncompleteTorrents.length, snapshot.detailLimit);
  assert.equal(snapshot.unresolvedIncompleteOmittedCount, 3);
  assert.equal(first.reason, 'unmappable-content-path');
  assert.equal(first.name.length, 256);
  assert.equal(first.hash.length, 128);
  assert.equal(first.state.length, 64);
  assert.equal(first.rawPath.length, 4096);
  assert.doesNotMatch(`${first.name}${first.hash}${first.state}${first.rawPath}`, /[\u0000-\u001f\u007f]/);
});

test('malformed torrent progress is treated as incomplete and fails closed without a content path', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.0.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json([{ name: 'malformed', progress: 'unknown' }]);
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };
  const snapshot = await inspectQbittorrent(connection());
  assert.equal(snapshot.incompleteTorrentCount, 1);
  assert.equal(snapshot.unmappedIncompleteCount, 1);
});

test('protected paths match the exact path and its subtree, but not prefix siblings or parents', () => {
  const protectedPaths = ['/data/downloads/incomplete'];
  assert.equal(pathIsProtected('/data/downloads/incomplete', protectedPaths), true);
  assert.equal(pathIsProtected('/data/downloads/incomplete/season/episode.mkv', protectedPaths), true);
  assert.equal(pathIsProtected('/data/downloads/incomplete-old/episode.mkv', protectedPaths), false);
  assert.equal(pathIsProtected('/data/downloads', protectedPaths), false);
});

test('a 200 Fails login response is rejected as failed authentication', async (context) => {
  const calls = mockQbittorrent(context, { loginBody: 'Fails.', cookie: '' });

  await assert.rejects(inspectQbittorrent(connection()), /qBittorrent login failed/);
  assert.deepEqual(calls.map(({ endpoint }) => endpoint), ['/api/v2/auth/login']);
});
