import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  discoverArrSettings,
  discoverDownloadFolders,
  hostValue,
  mediaServerNotification,
  qbittorrentClient,
  reachableHost,
  serviceUrl,
  suggestMediaServerPathMaps,
} from './discovery.mjs';

async function stubServer(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function json(response, value) {
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

function fields(values) {
  return Object.entries(values).map(([name, value]) => ({ name, value }));
}

async function tempTree(context, folders) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-discovery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of folders) await mkdir(path.join(root, folder), { recursive: true });
  return root;
}

test('only a plain host name or address is taken from another application', () => {
  assert.equal(hostValue('qbittorrent'), 'qbittorrent');
  assert.equal(hostValue('192.168.1.20'), '192.168.1.20');
  assert.equal(hostValue('http://nas.local/'), 'nas.local');
  assert.equal(hostValue('[fd00::20]'), 'fd00::20');
  assert.equal(hostValue('user:pass@evil.example'), '');
  assert.equal(hostValue('host name'), '');
  assert.equal(hostValue('********'), '');
  assert.equal(serviceUrl({ host: 'fd00::20', port: 8080, useSsl: true, urlBase: '/qbt/' }), 'https://[fd00::20]:8080/qbt');
  assert.equal(serviceUrl({ host: 'plex', port: 32400, useSsl: false, urlBase: '../../x?y' }), 'http://plex:32400');
});

test('the enabled qBittorrent client with the highest priority is used, and its password never is', () => {
  const clients = [
    { implementation: 'Sabnzbd', enable: true, priority: 1, fields: fields({ host: 'sab' }) },
    { implementation: 'QBittorrent', enable: false, priority: 1, name: 'Off', fields: fields({ host: 'off' }) },
    {
      implementation: 'QBittorrent', enable: true, priority: 5, name: 'Backup',
      fields: fields({ host: 'backup', port: 8081, tvCategory: 'backup-tv' }),
    },
    {
      implementation: 'QBittorrent', enable: true, priority: 1, name: 'Main',
      fields: fields({
        host: 'qbittorrent', port: 8080, useSsl: false, urlBase: '', username: 'admin', password: '********',
        tvCategory: 'tv-sonarr', tvImportedCategory: 'tv-imported', movieCategory: 'radarr',
      }),
    },
  ];
  const client = qbittorrentClient(clients, 'sonarr');
  assert.equal(client.name, 'Main');
  assert.equal(client.host, 'qbittorrent');
  assert.equal(client.port, 8080);
  assert.equal(client.username, 'admin');
  assert.equal(client.category, 'tv-sonarr');
  assert.equal(client.importedCategory, 'tv-imported');
  assert.equal(JSON.stringify(client).includes('********'), false);
  assert.equal(qbittorrentClient(clients, 'radarr').category, 'radarr');
  assert.equal(qbittorrentClient([], 'radarr'), null);
});

test('Plex is preferred over Emby/Jellyfin, and default ports fill a blank one', () => {
  const plex = { implementation: 'PlexServer', fields: fields({ host: '10.0.0.5', port: 32400, authToken: '********' }) };
  const browser = { implementation: 'MediaBrowser', fields: fields({ host: 'jellyfin', port: '', apiKey: '********' }) };
  assert.deepEqual(mediaServerNotification([browser, plex]), {
    kind: 'plex', host: '10.0.0.5', port: 32400, useSsl: false, urlBase: '',
  });
  assert.deepEqual(mediaServerNotification([browser]), {
    kind: 'jellyfin', host: 'jellyfin', port: 8096, useSsl: false, urlBase: '',
  });
  assert.equal(mediaServerNotification([{ implementation: 'Discord', fields: [] }]), null);
});

test('a service Radarr reaches on localhost or by a Docker name is looked for on Radarr\'s own host', async () => {
  const reachable = new Set(['192.168.1.50:8080']);
  const probe = async (host, port) => reachable.has(`${host}:${port}`);

  // localhost means Radarr's own machine; it is never tried from inside Keelhaularr.
  assert.deepEqual(await reachableHost('localhost', 8080, '192.168.1.50', probe), { host: '192.168.1.50', reachable: true });
  assert.deepEqual(await reachableHost('127.0.0.1', 8080, '192.168.1.50', probe), { host: '192.168.1.50', reachable: true });
  // A Docker service name that does not resolve here falls back to the same place.
  assert.deepEqual(await reachableHost('qbittorrent', 8080, '192.168.1.50', probe), { host: '192.168.1.50', reachable: true });
  // An address that answers is kept as it is.
  reachable.add('10.0.0.9:8080');
  assert.deepEqual(await reachableHost('10.0.0.9', 8080, '192.168.1.50', probe), { host: '10.0.0.9', reachable: true });
  // Nothing answering keeps what the application said, marked unreachable.
  assert.deepEqual(await reachableHost('qbittorrent', 9999, '192.168.1.50', probe), { host: 'qbittorrent', reachable: false });
});

test('a Radarr test discovers its qBittorrent and Plex without returning any secret', async (context) => {
  const seen = [];
  const stub = await stubServer((request, response) => {
    const url = new URL(request.url, 'http://stub');
    seen.push(`${url.pathname}:${request.headers['x-api-key']}`);
    if (url.pathname === '/api/v3/downloadclient') {
      return json(response, [{
        implementation: 'QBittorrent', enable: true, priority: 1, name: 'qBittorrent',
        fields: fields({ host: 'localhost', port: 8080, username: 'admin', password: '********', movieCategory: 'radarr' }),
      }]);
    }
    if (url.pathname === '/api/v3/notification') {
      return json(response, [{
        implementation: 'PlexServer', name: 'Plex',
        fields: fields({ host: 'plex', port: 32400, useSsl: false, authToken: '********' }),
      }]);
    }
    if (url.pathname === '/api/v3/remotepathmapping') {
      return json(response, [
        { host: 'localhost', remotePath: '/downloads/', localPath: '/data/torrents/' },
        { host: 'other', remotePath: '/elsewhere/', localPath: '/x/' },
      ]);
    }
    if (url.pathname === '/api/v3/history') {
      assert.equal(url.searchParams.get('eventType'), '3');
      return json(response, { records: [
        { eventType: 'downloadFolderImported', data: { importedPath: '/movies/Film (2020)/Film.mkv' } },
        { eventType: 'grabbed', data: { importedPath: '/movies/Ignored/Ignored.mkv' } },
      ] });
    }
    response.writeHead(404).end();
  });
  context.after(() => stub.close());

  const probe = async (host, port) => host === '192.168.1.50' && (port === 8080 || port === 32400);
  const discovery = await discoverArrSettings(
    { kind: 'radarr', url: stub.url, apiKey: 'radarr-key' },
    { kind: 'radarr', arrHost: '192.168.1.50', probe },
  );

  assert.deepEqual(discovery.qbittorrent, {
    url: 'http://192.168.1.50:8080',
    reachable: true,
    username: 'admin',
    category: 'radarr',
    importedCategory: '',
    clientName: 'qBittorrent',
  });
  assert.deepEqual(discovery.mediaServer, { kind: 'plex', url: 'http://192.168.1.50:32400', reachable: true });
  assert.deepEqual(discovery.remotePathMappings, [{ from: '/downloads', to: '/data/torrents' }]);
  assert.deepEqual(discovery.importedPaths, ['/movies/Film (2020)/Film.mkv']);
  assert.equal(JSON.stringify(discovery).includes('********'), false);
  assert.ok(seen.every((entry) => entry.endsWith(':radarr-key')));
});

test('discovery survives an application that refuses every extra request', async (context) => {
  const stub = await stubServer((request, response) => response.writeHead(401).end());
  context.after(() => stub.close());
  const discovery = await discoverArrSettings(
    { kind: 'sonarr', url: stub.url, apiKey: 'key' },
    { kind: 'sonarr', arrHost: '127.0.0.1', probe: async () => false },
  );
  assert.deepEqual(discovery, { qbittorrent: null, mediaServer: null, remotePathMappings: [], importedPaths: [] });
});

function torrent(category, savePath, name) {
  return { category, savePath, contentPath: `${savePath}/${name}` };
}

test('completed-download folders come from where each category\'s torrents really are', async (context) => {
  const root = await tempTree(context, [
    'mnt/data/torrents/movies/Film.2020.1080p',
    'mnt/data/torrents/tv/Show.S01.1080p',
    'mnt/data/media/movies',
  ]);
  const storage = path.join(root, 'mnt');
  const layout = {
    defaultSavePath: '/data/torrents',
    categories: [{ name: 'radarr', savePath: '/data/torrents/movies' }, { name: 'tv-sonarr', savePath: '' }],
    torrents: [
      torrent('radarr', '/data/torrents/movies', 'Film.2020.1080p'),
      torrent('tv-sonarr', '/data/torrents/tv', 'Show.S01.1080p'),
    ],
  };
  const result = discoverDownloadFolders(layout, {
    radarr: { categories: ['radarr'], remotePathMappings: [], pathMaps: [] },
    sonarr: { categories: ['tv-sonarr'], remotePathMappings: [], pathMaps: [] },
  }, { storageRoots: [storage], libraryRoots: [path.join(storage, 'data/media/movies')] });

  assert.deepEqual(result.folders.radarr, {
    localPaths: [path.join(storage, 'data/torrents/movies')],
    reported: ['/data/torrents/movies'],
    problems: [],
  });
  assert.deepEqual(result.folders.sonarr.localPaths, [path.join(storage, 'data/torrents/tv')]);
  // Both folders agree that /data is this LXC's <storage>/data, so one mapping covers
  // them and every other category qBittorrent keeps under it.
  assert.deepEqual(result.qbittorrentPathMaps, [{ from: '/data', to: path.join(storage, 'data') }]);
  assert.deepEqual(result.arrPathMaps.radarr, [{ from: '/data', to: path.join(storage, 'data') }]);
  assert.deepEqual(result.arrPathMaps.sonarr, [{ from: '/data', to: path.join(storage, 'data') }]);

  // Nothing is suggested when the existing mappings already land in the right place.
  const mapped = discoverDownloadFolders(layout, {
    radarr: { categories: ['radarr'], remotePathMappings: [], pathMaps: [{ from: '/data', to: path.join(storage, 'data') }] },
  }, { qbittorrentPathMaps: [{ from: '/data', to: path.join(storage, 'data') }], storageRoots: [storage] });
  assert.deepEqual(mapped.qbittorrentPathMaps, []);
  assert.deepEqual(mapped.arrPathMaps.radarr, []);
});

test('Radarr\'s remote path mappings decide which of its own paths needs mapping', async (context) => {
  const root = await tempTree(context, ['mnt/storage/torrents/radarr/Film.2020']);
  const storage = path.join(root, 'mnt');
  // The installer passes each detected mount point, such as /mnt/storage, as a root.
  const mount = path.join(storage, 'storage');
  const layout = {
    defaultSavePath: '/downloads',
    categories: [{ name: 'radarr', savePath: '/downloads/radarr' }],
    torrents: [torrent('radarr', '/downloads/radarr', 'Film.2020')],
  };
  const result = discoverDownloadFolders(layout, {
    radarr: {
      categories: ['radarr'],
      remotePathMappings: [{ from: '/downloads', to: '/data/torrents' }],
      pathMaps: [],
    },
  }, { storageRoots: [mount] });

  const local = path.join(mount, 'torrents/radarr');
  assert.deepEqual(result.folders.radarr.localPaths, [local]);
  // qBittorrent says /downloads/radarr; only its last folder name matches, which is
  // accepted because the torrent inside it is really there.
  assert.deepEqual(result.qbittorrentPathMaps, [{ from: '/downloads', to: path.join(mount, 'torrents') }]);
  // Radarr sees the same folder as /data/torrents/radarr, and the shared trailing
  // "torrents" widens that to the whole of /data.
  assert.deepEqual(result.arrPathMaps.radarr, [{ from: '/data', to: mount }]);

  // Without the torrent as evidence, one shared folder name is not enough.
  const unproven = discoverDownloadFolders({ ...layout, torrents: [] }, {
    radarr: { categories: ['radarr'], remotePathMappings: [], pathMaps: [] },
  }, { storageRoots: [mount] });
  assert.deepEqual(unproven.folders.radarr.localPaths, []);
});

test('a download folder shared with anything else is refused, with the reason', async (context) => {
  const root = await tempTree(context, ['mnt/downloads/Film.2020', 'mnt/downloads/Show.S01', 'mnt/downloads/Game']);
  const storage = path.join(root, 'mnt');
  const manualMode = {
    defaultSavePath: '/downloads',
    categories: [{ name: 'radarr', savePath: '/downloads/radarr' }, { name: 'tv-sonarr', savePath: '' }],
    torrents: [
      torrent('radarr', '/downloads', 'Film.2020'),
      torrent('tv-sonarr', '/downloads', 'Show.S01'),
      torrent('', '/downloads', 'Game'),
    ],
  };
  const result = discoverDownloadFolders(manualMode, {
    radarr: { categories: ['radarr'], remotePathMappings: [], pathMaps: [] },
    sonarr: { categories: ['tv-sonarr'], remotePathMappings: [], pathMaps: [] },
  }, { storageRoots: [storage] });

  assert.deepEqual(result.folders.radarr.localPaths, []);
  assert.deepEqual(result.folders.sonarr.localPaths, []);
  assert.match(result.folders.radarr.problems[0], /also holds torrents in "tv-sonarr", uncategorized/);
  assert.match(result.folders.radarr.problems[0], /Default Torrent Management Mode to Automatic/);
  assert.deepEqual(result.qbittorrentPathMaps, []);
});

test('a download folder that overlaps the library, or cannot be found, is refused', async (context) => {
  const root = await tempTree(context, ['mnt/data/media/movies/incoming/Film.2020']);
  const storage = path.join(root, 'mnt');
  const layout = {
    defaultSavePath: '/data',
    categories: [{ name: 'radarr', savePath: '/data/media/movies/incoming' }, { name: 'tv-sonarr', savePath: '/nowhere/tv' }],
    torrents: [torrent('radarr', '/data/media/movies/incoming', 'Film.2020')],
  };
  const result = discoverDownloadFolders(layout, {
    radarr: { categories: ['radarr'], remotePathMappings: [], pathMaps: [] },
    sonarr: { categories: ['tv-sonarr'], remotePathMappings: [], pathMaps: [] },
  }, { storageRoots: [storage], libraryRoots: [path.join(storage, 'data/media/movies')] });

  assert.deepEqual(result.folders.radarr.localPaths, []);
  assert.match(result.folders.radarr.problems[0], /overlaps the library folder/);
  assert.deepEqual(result.folders.sonarr.localPaths, []);
  assert.match(result.folders.sonarr.problems[0], /cannot find that folder/);
});

test('two applications that resolve to one folder get neither', async (context) => {
  const root = await tempTree(context, ['mnt/data/torrents/complete']);
  const storage = path.join(root, 'mnt');
  // Configured paths only: no torrents yet, so nothing marks the folder as shared.
  const layout = {
    defaultSavePath: '/data/torrents',
    categories: [
      { name: 'radarr', savePath: '/data/torrents/complete' },
      { name: 'tv-sonarr', savePath: '/data/torrents/complete' },
    ],
    torrents: [],
  };
  const result = discoverDownloadFolders(layout, {
    radarr: { categories: ['radarr'], remotePathMappings: [], pathMaps: [] },
    sonarr: { categories: ['tv-sonarr'], remotePathMappings: [], pathMaps: [] },
  }, { storageRoots: [storage] });
  assert.deepEqual(result.folders.radarr.localPaths, []);
  assert.deepEqual(result.folders.sonarr.localPaths, []);
  assert.match(result.folders.radarr.problems[0], /Radarr and Sonarr both download into/);
});

test('an empty category resolves to qBittorrent\'s implicit folder for it', async (context) => {
  const root = await tempTree(context, ['mnt/data/torrents/tv-sonarr']);
  const storage = path.join(root, 'mnt');
  const layout = {
    defaultSavePath: '/data/torrents',
    categories: [{ name: 'tv-sonarr', savePath: '' }],
    torrents: [],
  };
  const result = discoverDownloadFolders(layout, {
    sonarr: { categories: ['tv-sonarr'], remotePathMappings: [], pathMaps: [] },
  }, { storageRoots: [storage] });
  assert.deepEqual(result.folders.sonarr.localPaths, [path.join(storage, 'data/torrents/tv-sonarr')]);
});

test('a path that could not be saved is never passed on', async (context) => {
  const root = await tempTree(context, ['mnt/data/torrents/a,b']);
  const storage = path.join(root, 'mnt');
  const layout = {
    defaultSavePath: '/data/torrents',
    categories: [{ name: 'radarr', savePath: '/data/torrents/a,b' }],
    torrents: [],
  };
  const result = discoverDownloadFolders(layout, {
    radarr: { categories: ['radarr'], remotePathMappings: [], pathMaps: [] },
  }, { storageRoots: [storage] });
  assert.deepEqual(result.folders.radarr.localPaths, []);
  assert.deepEqual(result.qbittorrentPathMaps, []);
});

test('media-server library folders are mapped by evidence, including to a differently named folder', async (context) => {
  const root = await tempTree(context, [
    'mnt/data/media/movies/Film (2020)',
    'mnt/data/media/tv/Show/Season 01',
    'mnt/data/media/kids/Cartoon (2019)',
  ]);
  const storage = path.join(root, 'mnt');
  const movies = path.join(storage, 'data/media/movies');
  const kids = path.join(storage, 'data/media/kids');
  const result = suggestMediaServerPathMaps([
    // Same last two folder names: found on the name alone, and confirmed by its items.
    { locations: ['/media/movies'], files: ['/media/movies/Film (2020)/Film.mkv'] },
    // A different name altogether; its items are in a configured library folder.
    { locations: ['/films-for-kids'], files: ['/films-for-kids/Cartoon (2019)/Cartoon.mkv'] },
    // Already covered by a mapping.
    { locations: ['/tv'], files: ['/tv/Show/Season 01/Show - S01E01.mkv'] },
    // Nowhere to be found, and a Windows path that cannot be mapped automatically.
    { locations: ['/music/lossless', 'D:\\Media\\Films'], files: [] },
  ], {
    pathMaps: [{ from: '/tv', to: path.join(storage, 'data/media/tv') }],
    storageRoots: [storage],
    libraryRoots: [movies, kids],
  });

  assert.deepEqual(result.suggestions, [
    { from: '/media/movies', to: movies },
    { from: '/films-for-kids', to: kids },
  ]);
  assert.deepEqual(result.unresolved, ['/music/lossless', 'D:\\Media\\Films']);
});

test('a media-server folder whose items are not there is not mapped just because the name matches', async (context) => {
  const root = await tempTree(context, ['mnt/backup/media/movies']);
  const storage = path.join(root, 'mnt');
  const result = suggestMediaServerPathMaps([
    { locations: ['/media/movies'], files: ['/media/movies/Film (2020)/Film.mkv'] },
  ], { storageRoots: [storage] });
  assert.deepEqual(result.suggestions, []);
  assert.deepEqual(result.unresolved, ['/media/movies']);
});

test('an application whose category this qBittorrent does not have is told so', async (context) => {
  const root = await tempTree(context, ['mnt/data/torrents/movies/Film']);
  const storage = path.join(root, 'mnt');
  const layout = {
    defaultSavePath: '/data/torrents',
    categories: [{ name: 'radarr', savePath: '/data/torrents/movies' }],
    torrents: [torrent('radarr', '/data/torrents/movies', 'Film')],
  };
  const result = discoverDownloadFolders(layout, {
    radarr: { categories: ['radarr'], remotePathMappings: [], pathMaps: [] },
    sonarr: { categories: ['tv-other'], remotePathMappings: [], pathMaps: [] },
  }, { storageRoots: [storage] });
  assert.deepEqual(result.folders.radarr.localPaths, [path.join(storage, 'data/torrents/movies')]);
  assert.deepEqual(result.folders.sonarr.localPaths, []);
  assert.match(result.folders.sonarr.problems[0], /no "tv-other" category and no torrents in it/);
});
