import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  assertNotRecentlyWatched,
  inspectMediaServer,
  mapMediaServerPath,
  watchedPathMatch,
} from './mediaserver.mjs';

const DAY = 86400000;

async function stubServer(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function json(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

test('media-server path mapping refuses what it cannot resolve', () => {
  const maps = [{ from: '/media/movies', to: '/movies' }];

  assert.equal(mapMediaServerPath('/media/movies/Film/Film.mkv', maps), '/movies/Film/Film.mkv');
  // Boundary, not string prefix: a sibling directory must not match.
  assert.equal(mapMediaServerPath('/media/movies-4k/Film/Film.mkv', maps), '/media/movies-4k/Film/Film.mkv');
  // Windows and UNC paths cannot be resolved to a container path, so they are refused
  // rather than turned into a cwd-relative fiction.
  assert.equal(mapMediaServerPath('C:\\Media\\Film.mkv', maps), null);
  assert.equal(mapMediaServerPath('\\\\nas\\media\\Film.mkv', maps), null);
  assert.equal(mapMediaServerPath('Film.mkv', maps), null);
  assert.equal(mapMediaServerPath('', maps), null);
  // A mapping cannot be used to escape its own destination.
  assert.equal(mapMediaServerPath('/media/movies/../../etc/passwd', maps), null);

  assert.equal(watchedPathMatch('/movies/Film/Film.mkv', ['/movies/Film/Film.mkv']), true);
  assert.equal(watchedPathMatch('/movies/Film/Film.mkv', ['/movies/Film/Other.mkv']), false);
});

test('Jellyfin watch history is filtered to the configured window, and live playback always counts', async (context) => {
  const recent = new Date(Date.now() - 2 * DAY).toISOString();
  const old = new Date(Date.now() - 400 * DAY).toISOString();
  const stub = await stubServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    if (url.pathname === '/Sessions') {
      return json(response, [{ NowPlayingItem: { Path: '/media/movies/Playing/Playing.mkv', Name: 'Playing' } }]);
    }
    if (url.pathname === '/Users') return json(response, [{ Id: 'user-1' }]);
    if (url.pathname === '/Users/user-1/Items') {
      return json(response, {
        Items: [
          { Path: '/media/movies/Recent/Recent.mkv', Name: 'Recent', UserData: { LastPlayedDate: recent } },
          { Path: '/media/movies/Ancient/Ancient.mkv', Name: 'Ancient', UserData: { LastPlayedDate: old } },
          { Path: '/media/movies/NoDate/NoDate.mkv', Name: 'NoDate', UserData: {} },
        ],
      });
    }
    response.writeHead(404).end('{}');
  });
  context.after(() => stub.close());

  const snapshot = await inspectMediaServer({
    configured: true, kind: 'jellyfin', url: stub.url, token: 't',
    watchedWithinDays: 30, pathMaps: [{ from: '/media/movies', to: '/movies' }],
  });

  assert.equal(snapshot.status, 'connected');
  assert.deepEqual(snapshot.protectedPaths.sort(), ['/movies/Playing/Playing.mkv', '/movies/Recent/Recent.mkv']);
  // Something playing right now is protected regardless of the lookback window.
  assert.equal(snapshot.inProgressCount, 1);
  // Outside the window, or with no play date at all, is not protected.
  assert.equal(snapshot.protectedPaths.includes('/movies/Ancient/Ancient.mkv'), false);
  assert.equal(snapshot.protectedPaths.includes('/movies/NoDate/NoDate.mkv'), false);
});

test('Plex sessions and recently-viewed items are both collected', async (context) => {
  const recentSeconds = Math.floor((Date.now() - DAY) / 1000);
  const stub = await stubServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    if (url.pathname === '/status/sessions') {
      return json(response, {
        MediaContainer: {
          Metadata: [{ title: 'Streaming', Media: [{ Part: [{ file: '/data/movies/Streaming/Streaming.mkv' }] }] }],
        },
      });
    }
    if (url.pathname === '/library/sections') {
      return json(response, { MediaContainer: { Directory: [{ key: '1' }] } });
    }
    if (url.pathname === '/library/sections/1/all') {
      if (url.searchParams.get('type') !== '1') return json(response, { MediaContainer: {} });
      return json(response, {
        MediaContainer: {
          Metadata: [
            { title: 'Watched', lastViewedAt: recentSeconds, Media: [{ Part: [{ file: '/data/movies/Watched/Watched.mkv' }] }] },
            { title: 'Stale', lastViewedAt: 1, Media: [{ Part: [{ file: '/data/movies/Stale/Stale.mkv' }] }] },
          ],
        },
      });
    }
    response.writeHead(404).end('{}');
  });
  context.after(() => stub.close());

  const snapshot = await inspectMediaServer({
    configured: true, kind: 'plex', url: stub.url, token: 't',
    watchedWithinDays: 30, pathMaps: [{ from: '/data/movies', to: '/movies' }],
  });

  assert.deepEqual(snapshot.protectedPaths.sort(), ['/movies/Streaming/Streaming.mkv', '/movies/Watched/Watched.mkv']);
  assert.equal(snapshot.inProgressCount, 1);
  assert.equal(snapshot.protectedPaths.includes('/movies/Stale/Stale.mkv'), false);
});

test('the watch guard fails closed and only constrains a configured server', async (context) => {
  const candidate = { app: 'radarr', path: '/movies/Film/Film.mkv', localPath: '/movies/Film/Film.mkv' };

  // Not configured is not a constraint: the guard is opt-in.
  await assertNotRecentlyWatched({ mediaServer: { configured: false } }, candidate);

  // Configured but unreachable must PRESERVE the file, never wave it through.
  await assert.rejects(
    assertNotRecentlyWatched({
      mediaServer: {
        configured: true, kind: 'jellyfin', url: 'http://127.0.0.1:1', token: 't',
        watchedWithinDays: 30, pathMaps: [],
      },
    }, candidate),
    /watch check failed immediately before the file change; file preserved/,
  );

  // A watched path that cannot be mapped is also a reason to withhold, because we
  // cannot prove the file we are about to remove is not the one being watched.
  const unmappable = await stubServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    if (url.pathname === '/Sessions') {
      return json(response, [{ NowPlayingItem: { Path: 'C:\\Media\\Film.mkv', Name: 'Windows path' } }]);
    }
    if (url.pathname === '/Users') return json(response, []);
    response.writeHead(404).end('{}');
  });
  context.after(() => unmappable.close());
  await assert.rejects(
    assertNotRecentlyWatched({
      mediaServer: {
        configured: true, kind: 'jellyfin', url: unmappable.url, token: 't',
        watchedWithinDays: 30, pathMaps: [],
      },
    }, candidate),
    /could not be mapped to a local path; file preserved/,
  );
});

test('the watch guard withholds a watched file and permits an unwatched one', async (context) => {
  const stub = await stubServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    if (url.pathname === '/Sessions') return json(response, []);
    if (url.pathname === '/Users') return json(response, [{ Id: 'u' }]);
    if (url.pathname === '/Users/u/Items') {
      return json(response, {
        Items: [{
          Path: '/movies/Watched/Watched.mkv',
          Name: 'Watched',
          UserData: { LastPlayedDate: new Date(Date.now() - DAY).toISOString() },
        }],
      });
    }
    response.writeHead(404).end('{}');
  });
  context.after(() => stub.close());

  const config = {
    mediaServer: {
      configured: true, kind: 'jellyfin', url: stub.url, token: 't',
      watchedWithinDays: 7, pathMaps: [],
    },
  };

  await assert.rejects(
    assertNotRecentlyWatched(config, { path: '/movies/Watched/Watched.mkv' }),
    /played within the last 7 day\(s\)/,
  );
  await assertNotRecentlyWatched(config, { path: '/movies/Untouched/Untouched.mkv' });
});
