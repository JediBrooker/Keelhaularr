import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { buildImportCommand, identifyOrphans } from './imports.mjs';

// Stands in for Radarr or Sonarr. `routes` maps "METHOD /path" to a handler or a value;
// every request is recorded so the tests can assert what was actually asked.
async function mockArr(context, routes) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://mock');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: request.method, pathname: url.pathname, search: url.search, body });

    const key = `${request.method} ${url.pathname}`;
    const route = routes[key];
    if (route === undefined) {
      response.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: key }));
      return;
    }
    const value = typeof route === 'function' ? route(url, body) : route;
    if (value?.__status) {
      response.writeHead(value.__status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value.body ?? {}));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function connection(kind, url, pathMaps = []) {
  return { kind, id: kind, url, apiKey: 'test', configured: true, pathMaps };
}

function candidate(id, filePath) {
  return { id, path: filePath, app: 'radarr' };
}

const QUALITY = { quality: { id: 7, name: 'Bluray-1080p' }, revision: { version: 1 } };

test('a movie that already has a tracked file is reported as spare, not importable', async (context) => {
  const arr = await mockArr(context, {
    'GET /api/v3/manualimport': [{
      path: '/downloads/The.Film.2024/film.mkv',
      movie: { id: 12, title: 'The Film', year: 2024 },
      quality: QUALITY,
      languages: [{ id: 1, name: 'English' }],
      rejections: [],
    }],
    'GET /api/v3/movie/12': {
      id: 12,
      hasFile: true,
      movieFileId: 900,
      movieFile: { id: 900, path: '/mnt/media/The Film (2024)/film.mkv', size: 8 * 1024 ** 3, quality: QUALITY },
    },
  });

  const results = await identifyOrphans(
    connection('radarr', arr.url),
    [candidate('a', '/downloads/The.Film.2024/film.mkv')],
  );
  const result = results.get('a');

  assert.equal(result.status, 'occupied');
  assert.match(result.reason, /already has a tracked file/);
  assert.equal(result.title, 'The Film (2024)');
  assert.equal(result.existing.path, '/mnt/media/The Film (2024)/film.mkv');
  assert.equal(result.existing.sizeBytes, 8 * 1024 ** 3);
  // Nothing to import: this file is genuinely redundant and may safely be removed.
  assert.equal(result.target, null);
});

test('a movie with no tracked file is importable, carrying what the import needs', async (context) => {
  const arr = await mockArr(context, {
    'GET /api/v3/manualimport': [{
      path: '/downloads/The.Film.2024/film.mkv',
      movie: { id: 12, title: 'The Film', year: 2024 },
      quality: QUALITY,
      languages: [{ id: 1, name: 'English' }],
      releaseGroup: 'GROUP',
      indexerFlags: 2,
      downloadId: 'ABC123',
      rejections: [],
    }],
    'GET /api/v3/movie/12': { id: 12, hasFile: false, movieFileId: 0, movieFile: null },
  });

  const result = (await identifyOrphans(
    connection('radarr', arr.url),
    [candidate('a', '/downloads/The.Film.2024/film.mkv')],
  )).get('a');

  assert.equal(result.status, 'importable');
  assert.match(result.reason, /has no tracked file/);
  assert.equal(result.target.movieId, 12);
  assert.equal(result.target.releaseGroup, 'GROUP');
  assert.equal(result.target.indexerFlags, 2);
  assert.equal(result.target.downloadId, 'ABC123');
  assert.equal(result.arrPath, '/downloads/The.Film.2024/film.mkv');
});

test('a nullable hasFile is not read as "no file"', async (context) => {
  // Radarr declares hasFile as bool? on the record embedded in a manual-import
  // response. Treating an absent value as false would import a duplicate on top of a
  // file that already exists, which is exactly what this feature must never do.
  const arr = await mockArr(context, {
    'GET /api/v3/manualimport': [{
      path: '/downloads/x/film.mkv',
      movie: { id: 12, title: 'The Film', year: 2024 },
      quality: QUALITY,
      rejections: [],
    }],
    'GET /api/v3/movie/12': { id: 12, movieFileId: 900, movieFile: { id: 900, path: '/mnt/media/f.mkv', size: 10 } },
  });

  const result = (await identifyOrphans(connection('radarr', arr.url), [candidate('a', '/downloads/x/film.mkv')])).get('a');
  assert.equal(result.status, 'occupied');
});

test('an episode file is spare when any episode it covers already has a file', async (context) => {
  const arr = await mockArr(context, {
    'GET /api/v3/manualimport': [{
      path: '/downloads/Show.S01E01E02/ep.mkv',
      series: { id: 5, title: 'The Show' },
      seasonNumber: 1,
      episodes: [{ id: 51, seasonNumber: 1, episodeNumber: 1 }, { id: 52, seasonNumber: 1, episodeNumber: 2 }],
      quality: QUALITY,
      rejections: [],
    }],
    'GET /api/v3/episode': [
      { id: 51, hasFile: false, episodeFileId: 0 },
      { id: 52, hasFile: true, episodeFileId: 77, episodeFile: { id: 77, path: '/mnt/tv/ep2.mkv', size: 2 * 1024 ** 3 } },
    ],
  });

  const result = (await identifyOrphans(
    { ...connection('sonarr', arr.url) },
    [{ id: 'a', path: '/downloads/Show.S01E01E02/ep.mkv', app: 'sonarr' }],
  )).get('a');

  assert.equal(result.status, 'occupied');
  assert.equal(result.title, 'The Show — S01E01E02');
  assert.match(result.reason, /1 of the 2 episodes/);
});

test('an episode file whose episodes have no files is importable', async (context) => {
  const arr = await mockArr(context, {
    'GET /api/v3/manualimport': [{
      path: '/downloads/Show.S01E01/ep.mkv',
      series: { id: 5, title: 'The Show' },
      seasonNumber: 1,
      episodes: [{ id: 51, seasonNumber: 1, episodeNumber: 1 }],
      quality: QUALITY,
      rejections: [],
    }],
    'GET /api/v3/episode': [{ id: 51, hasFile: false, episodeFileId: 0 }],
  });

  const result = (await identifyOrphans(
    connection('sonarr', arr.url),
    [{ id: 'a', path: '/downloads/Show.S01E01/ep.mkv', app: 'sonarr' }],
  )).get('a');

  assert.equal(result.status, 'importable');
  assert.equal(result.title, 'The Show — S01E01');
  assert.deepEqual(result.target.episodeIds, [51]);
  assert.equal(result.target.seriesId, 5);
});

test('files the application cannot place, or will not accept, are never importable', async (context) => {
  const arr = await mockArr(context, {
    'GET /api/v3/manualimport': [
      // Parsed, but matched to nothing.
      { path: '/downloads/mixed/unknown.mkv', movie: null, quality: QUALITY, rejections: [] },
      // Matched, but the application itself refuses it.
      {
        path: '/downloads/mixed/sample.mkv',
        movie: { id: 13, title: 'Other Film', year: 2020 },
        quality: QUALITY,
        rejections: [{ reason: 'Sample', type: 'permanent' }],
      },
    ],
    'GET /api/v3/movie/13': { id: 13, hasFile: false, movieFileId: 0 },
  });

  const results = await identifyOrphans(connection('radarr', arr.url), [
    candidate('unknown', '/downloads/mixed/unknown.mkv'),
    candidate('sample', '/downloads/mixed/sample.mkv'),
    // Present on our disk, but the application did not offer it at all.
    candidate('absent', '/downloads/mixed/absent.mkv'),
  ]);

  assert.equal(results.get('unknown').status, 'unidentified');
  assert.equal(results.get('sample').status, 'blocked');
  assert.deepEqual(results.get('sample').rejections, ['Sample']);
  assert.equal(results.get('absent').status, 'unidentified');
  for (const id of ['unknown', 'sample', 'absent']) assert.equal(results.get(id).target, null);
});

test('one call identifies every file in a folder', async (context) => {
  const arr = await mockArr(context, {
    'GET /api/v3/manualimport': [
      { path: '/downloads/season/e1.mkv', movie: { id: 1, title: 'A', year: 2020 }, quality: QUALITY, rejections: [] },
      { path: '/downloads/season/e2.mkv', movie: { id: 1, title: 'A', year: 2020 }, quality: QUALITY, rejections: [] },
      { path: '/downloads/season/e3.mkv', movie: { id: 1, title: 'A', year: 2020 }, quality: QUALITY, rejections: [] },
    ],
    'GET /api/v3/movie/1': { id: 1, hasFile: false, movieFileId: 0 },
  });

  await identifyOrphans(connection('radarr', arr.url), [
    candidate('a', '/downloads/season/e1.mkv'),
    candidate('b', '/downloads/season/e2.mkv'),
    candidate('c', '/downloads/season/e3.mkv'),
  ]);

  // Manual import reads a whole folder off disk, so doing it once per file would make a
  // season folder cost a scan per episode. The movie lookup is cached the same way.
  assert.equal(arr.requests.filter((entry) => entry.pathname === '/api/v3/manualimport').length, 1);
  assert.equal(arr.requests.filter((entry) => entry.pathname === '/api/v3/movie/1').length, 1);
});

test('a path the application would not recognise is refused before anything is asked', async (context) => {
  const arr = await mockArr(context, { 'GET /api/v3/manualimport': [] });
  // The container sees /movies; Radarr sees /mnt/media. The file must be named to
  // Radarr in its own terms, and the folder queried in its own terms too.
  const mapped = connection('radarr', arr.url, [{ from: '/mnt/media', to: '/movies' }]);

  const results = await identifyOrphans(mapped, [
    candidate('inside', '/movies/Film/x.mkv'),
    // Outside every mapping and outside the library: passed through unchanged.
    candidate('outside', '/somewhere/else/x.mkv'),
  ]);

  assert.equal(results.get('inside').status, 'unidentified');
  const folders = arr.requests
    .filter((entry) => entry.pathname === '/api/v3/manualimport')
    .map((entry) => new URL(`http://mock${entry.pathname}${entry.search}`).searchParams.get('folder'));
  assert.ok(folders.includes('/mnt/media/Film'), `asked for ${folders.join(', ')}`);
  assert.ok(folders.includes('/somewhere/else'));
});

test('an application that cannot be reached reports an error, never an import', async (context) => {
  const arr = await mockArr(context, {
    'GET /api/v3/manualimport': { __status: 500, body: { error: 'boom' } },
  });

  const result = (await identifyOrphans(connection('radarr', arr.url), [candidate('a', '/downloads/x/f.mkv')])).get('a');
  assert.equal(result.status, 'error');
  assert.equal(result.target, null);

  const unconfigured = (await identifyOrphans({ kind: 'radarr', configured: false }, [candidate('a', '/x/f.mkv')])).get('a');
  assert.equal(unconfigured.status, 'unsupported');
});

test('the import command defers the hardlink-or-move decision to the application', async () => {
  const movie = buildImportCommand('radarr', '/mnt/media/f.mkv', {
    movieId: 12, quality: QUALITY, languages: [{ id: 1 }], releaseGroup: 'G', indexerFlags: 0, downloadId: 'D',
  });
  assert.equal(movie.name, 'ManualImport');
  // 'auto' is the whole point: Radarr and Sonarr hardlink or copy while a torrent is
  // still seeding and move otherwise, honouring their own "Use Hardlinks instead of
  // Copy" setting. Forcing move would break seeding; forcing copy would waste a copy.
  assert.equal(movie.importMode, 'auto');
  assert.equal(movie.files.length, 1);
  assert.equal(movie.files[0].movieId, 12);
  assert.equal(movie.files[0].path, '/mnt/media/f.mkv');
  assert.equal(Object.hasOwn(movie.files[0], 'seriesId'), false);

  const episode = buildImportCommand('sonarr', '/mnt/tv/e.mkv', {
    seriesId: 5, episodeIds: [51, 52], quality: QUALITY, languages: [], indexerFlags: 0,
  });
  assert.equal(episode.importMode, 'auto');
  assert.equal(episode.files[0].seriesId, 5);
  assert.deepEqual(episode.files[0].episodeIds, [51, 52]);
  assert.equal(Object.hasOwn(episode.files[0], 'movieId'), false);
});
