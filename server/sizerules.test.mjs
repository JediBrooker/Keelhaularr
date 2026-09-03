import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { getConfig, matchSizeRule } from './config.mjs';
import { scanRadarr, scanSonarr } from './arr.mjs';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

function limitBytes(maxMbPerMinute, runtimeMinutes, toleranceGib) {
  return Math.round(maxMbPerMinute * MIB) * runtimeMinutes + Math.round(toleranceGib * GIB);
}

async function radarrStub(context, { movies, tags = [], definitions = [] }) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    const send = (value) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/api/v3/system/status') return send({ version: '5.0.0' });
    if (url.pathname === '/api/v3/movie') return send(movies);
    if (url.pathname === '/api/v3/series') return send(movies);
    if (url.pathname === '/api/v3/tag') return send(tags);
    if (url.pathname === '/api/v3/qualitydefinition') return send(definitions);
    if (url.pathname === '/api/v3/episodefile') return send([]);
    if (url.pathname === '/api/v3/episode') return send([]);
    response.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

const movie = (overrides = {}) => ({
  id: 1,
  title: 'Film',
  year: 2020,
  runtime: 100,
  monitored: true,
  hasFile: true,
  path: '/movies/Film (2020)',
  tags: [],
  movieFile: {
    id: 11,
    size: 20 * GIB,
    relativePath: 'Film.mkv',
    path: '/movies/Film (2020)/Film.mkv',
    quality: { quality: { id: 4, name: 'Bluray-1080p' } },
  },
  ...overrides,
});

function radarrConnection(url, extra = {}) {
  return getConfig({
    RADARR_URL: url,
    RADARR_API_KEY: 'k',
    RADARR_MEDIA_ROOTS: '/movies',
    MAX_MB_PER_MIN: '85',
    OVERSIZE_TOLERANCE_GIB: '1',
    ...extra,
  }).radarr;
}

test('rule matching requires every stated criterion and takes the first match', () => {
  const rules = getConfig({
    RADARR_URL: 'http://x', RADARR_API_KEY: 'k',
    RADARR_SIZE_RULES_JSON: JSON.stringify([
      { label: 'anime on the kids root', tag: 'anime', root: '/movies/kids', maxMbPerMinute: 20 },
      { label: 'any anime', tag: 'anime', maxMbPerMinute: 40 },
      { label: 'remux quality', quality: 'Bluray-2160p Remux', maxMbPerMinute: 900 },
    ]),
  }).radarr.sizeRules;

  // Both criteria must match for the narrower rule.
  assert.equal(matchSizeRule(rules, { tags: ['anime'], root: '/movies/kids' }).label, 'anime on the kids root');
  assert.equal(matchSizeRule(rules, { tags: ['anime'], root: '/movies/other' }).label, 'any anime');
  assert.equal(matchSizeRule(rules, { root: '/movies/kids' }), null);
  // Matching is case-insensitive on tag and quality names.
  assert.equal(matchSizeRule(rules, { quality: 'BLURAY-2160P REMUX' }).label, 'remux quality');
  // Nothing matched means the caller falls back to its own default.
  assert.equal(matchSizeRule(rules, { tags: ['documentary'] }), null);
  assert.equal(matchSizeRule([], { tags: ['anime'] }), null);
});

test('a file matching no rule is judged exactly as it was before rules existed', async (context) => {
  const url = await radarrStub(context, {
    movies: [movie()],
    tags: [{ id: 7, label: 'anime' }],
  });

  const withoutRules = await scanRadarr(radarrConnection(url));
  const withRules = await scanRadarr(radarrConnection(url, {
    RADARR_SIZE_RULES_JSON: JSON.stringify([{ tag: 'anime', maxMbPerMinute: 10 }]),
  }));

  assert.equal(withoutRules.candidates.length, 1);
  assert.equal(withRules.candidates.length, 1);
  const before = withoutRules.candidates[0];
  const after = withRules.candidates[0];
  // The movie carries no tags, so the anime rule must not touch it.
  assert.equal(after.limitBytes, before.limitBytes);
  assert.equal(after.maxMbPerMinute, before.maxMbPerMinute);
  assert.equal(after.overageBytes, before.overageBytes);
  assert.equal(after.limitSource, 'keelhaularr');
  assert.equal(after.ruleLabel, null);
});

test('a matching tag rule replaces both the MB/min and the tolerance', async (context) => {
  const url = await radarrStub(context, {
    movies: [movie({ tags: [7] })],
    tags: [{ id: 7, label: 'anime' }],
  });

  const scan = await scanRadarr(radarrConnection(url, {
    RADARR_SIZE_RULES_JSON: JSON.stringify([
      { label: 'Anime', tag: 'anime', maxMbPerMinute: 40, toleranceGib: 0.5 },
    ]),
  }));

  const [candidate] = scan.candidates;
  assert.equal(candidate.limitSource, 'size-rule');
  assert.equal(candidate.ruleLabel, 'Anime');
  assert.equal(candidate.maxMbPerMinute, 40);
  assert.equal(candidate.limitBytes, limitBytes(40, 100, 0.5));
  assert.equal(candidate.toleranceBytes, Math.round(0.5 * GIB));
});

test('a generous rule can exempt a file that would otherwise be flagged', async (context) => {
  const url = await radarrStub(context, {
    movies: [movie({ tags: [9] })],
    tags: [{ id: 9, label: '4k' }],
  });

  // 20 GiB over 100 minutes is oversized at the 85 MB/min default...
  assert.equal((await scanRadarr(radarrConnection(url))).candidates.length, 1);
  // ...and within limits under a 4K rule, so it drops out of the results entirely.
  const exempt = await scanRadarr(radarrConnection(url, {
    RADARR_SIZE_RULES_JSON: JSON.stringify([{ label: '4K', tag: '4k', maxMbPerMinute: 900 }]),
  }));
  assert.deepEqual(exempt.candidates, []);
});

test('a rule outranks the quality definition, which still applies when no rule matches', async (context) => {
  const url = await radarrStub(context, {
    movies: [movie({ tags: [7] })],
    tags: [{ id: 7, label: 'anime' }],
    definitions: [{ quality: { id: 4, name: 'Bluray-1080p' }, maxSize: 150 }],
  });

  const definitionOnly = await scanRadarr(radarrConnection(url, {
    RADARR_USE_ARR_QUALITY_DEFINITIONS: 'true',
  }));
  assert.equal(definitionOnly.candidates[0].limitSource, 'arr-quality-definition');
  assert.equal(definitionOnly.candidates[0].maxMbPerMinute, 150);

  const ruled = await scanRadarr(radarrConnection(url, {
    RADARR_USE_ARR_QUALITY_DEFINITIONS: 'true',
    RADARR_SIZE_RULES_JSON: JSON.stringify([{ label: 'Anime', tag: 'anime', maxMbPerMinute: 40 }]),
  }));
  assert.equal(ruled.candidates[0].limitSource, 'size-rule');
  assert.equal(ruled.candidates[0].maxMbPerMinute, 40);
});

test('tags are only fetched when a rule needs them, and a tag failure does not fail the scan', async (context) => {
  const requested = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    requested.push(url.pathname);
    const send = (value) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/api/v3/system/status') return send({ version: '5.0.0' });
    if (url.pathname === '/api/v3/movie') return send([movie({ tags: [7] })]);
    if (url.pathname === '/api/v3/tag') { response.writeHead(500).end('{}'); return; }
    if (url.pathname === '/api/v3/qualitydefinition') return send([]);
    response.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  // No tag-based rule: the tag endpoint is never called.
  await scanRadarr(radarrConnection(url, {
    RADARR_SIZE_RULES_JSON: JSON.stringify([{ root: '/movies', maxMbPerMinute: 50 }]),
  }));
  assert.equal(requested.includes('/api/v3/tag'), false);

  // Tag-based rule, and the tag call fails: the scan still completes, warns, and falls
  // back to the connection default rather than misapplying a rule.
  const scan = await scanRadarr(radarrConnection(url, {
    RADARR_SIZE_RULES_JSON: JSON.stringify([{ tag: 'anime', maxMbPerMinute: 10 }]),
  }));
  assert.equal(requested.includes('/api/v3/tag'), true);
  assert.equal(scan.status, 'connected');
  assert.equal(scan.candidates[0].limitSource, 'keelhaularr');
  assert.match(scan.warnings.join(' '), /tags could not be read/);
});

test('a root rule matches the media root that contains the file', async (context) => {
  const url = await radarrStub(context, { movies: [movie()] });

  const matched = await scanRadarr(radarrConnection(url, {
    RADARR_SIZE_RULES_JSON: JSON.stringify([{ label: 'Movies root', root: '/movies', maxMbPerMinute: 30 }]),
  }));
  assert.equal(matched.candidates[0].ruleLabel, 'Movies root');

  const unmatched = await scanRadarr(radarrConnection(url, {
    RADARR_SIZE_RULES_JSON: JSON.stringify([{ label: 'Other root', root: '/other', maxMbPerMinute: 30 }]),
  }));
  assert.equal(unmatched.candidates[0].ruleLabel, null);
});

test('Sonarr resolves rules from its series tags', async (context) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    const send = (value) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/api/v3/system/status') return send({ version: '4.0.0' });
    if (url.pathname === '/api/v3/series') {
      return send([{ id: 3, title: 'Show', runtime: 25, monitored: true, path: '/tv/Show', tags: [12] }]);
    }
    if (url.pathname === '/api/v3/tag') return send([{ id: 12, label: 'Anime' }]);
    if (url.pathname === '/api/v3/episodefile') {
      return send([{
        id: 500, seriesId: 3, seasonNumber: 1, size: 6 * GIB,
        relativePath: 'S01E01.mkv', path: '/tv/Show/S01E01.mkv',
        quality: { quality: { id: 5, name: 'WEBDL-1080p' } },
      }]);
    }
    if (url.pathname === '/api/v3/episode') {
      return send([{ id: 900, episodeFileId: 500, seasonNumber: 1, episodeNumber: 1, runtime: 25, monitored: true }]);
    }
    if (url.pathname === '/api/v3/qualitydefinition') return send([]);
    response.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;

  const connection = getConfig({
    SONARR_URL: url, SONARR_API_KEY: 'k', SONARR_MEDIA_ROOTS: '/tv',
    MAX_MB_PER_MIN: '85', OVERSIZE_TOLERANCE_GIB: '1',
    // Tag label casing differs between the rule and Sonarr, which must not matter.
    SONARR_SIZE_RULES_JSON: JSON.stringify([{ label: 'Anime', tag: 'anime', maxMbPerMinute: 30 }]),
  }).sonarr;

  const scan = await scanSonarr(connection);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].limitSource, 'size-rule');
  assert.equal(scan.candidates[0].ruleLabel, 'Anime');
  assert.equal(scan.candidates[0].maxMbPerMinute, 30);
});
