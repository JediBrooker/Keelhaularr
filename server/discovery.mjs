import net from 'node:net';
import { constants, accessSync, statSync } from 'node:fs';
import path from 'node:path';

import { arrRequest, mapArrPath } from './arr.mjs';
import { mapMediaServerPath } from './mediaserver.mjs';
import { mapQbittorrentPath } from './qbittorrent.mjs';
import { locateReportedPath, relativeSamples } from './root-access.mjs';

/**
 * Reads what Radarr, Sonarr, qBittorrent and the media server already know about each
 * other, so the settings form can be filled in rather than retyped.
 *
 * Two rules hold throughout. Nothing secret ever comes back: Radarr and Sonarr mask
 * passwords, API keys and tokens anyway, and a masked value is treated as unknown.
 * And nothing is filled in on a guess that could point a scan at the wrong files: a
 * folder is only offered when it exists inside Keelhaularr and, where the applications
 * report what is in it, those names are actually there.
 */

const REQUEST_TIMEOUT_MS = 10000;
// These requests carry an API key to an address typed into the form, so a redirect is
// never followed: the key would go wherever it pointed.
const ARR_REQUEST = { timeoutMs: REQUEST_TIMEOUT_MS, redirect: 'error' };
const PROBE_TIMEOUT_MS = 2000;
// Radarr and Sonarr send this in place of every password, API key and token.
const MASKED_VALUE = '********';
const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '::', '::1']);
const IMPORT_EVENT_TYPE = 3;
const IMPORT_EVENT_NAME = 'downloadFolderImported';
const HISTORY_SAMPLE_SIZE = 30;
const MAX_FOLDERS_PER_APP = 4;

const CATEGORY_FIELDS = {
  radarr: { category: 'movieCategory', importedCategory: 'movieImportedCategory' },
  sonarr: { category: 'tvCategory', importedCategory: 'tvImportedCategory' },
};

const APP_LABELS = { radarr: 'Radarr', sonarr: 'Sonarr' };

function providerFields(provider) {
  const values = new Map();
  for (const field of Array.isArray(provider?.fields) ? provider.fields : []) {
    if (field && typeof field.name === 'string') values.set(field.name, field.value);
  }
  return values;
}

export function plainText(value, maximumLength = 256) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text === MASKED_VALUE || text.length > maximumLength || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text;
}

function portNumber(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// A hostname or an IP address and nothing else, so a value read from another
// application can never carry a path, credentials or a second URL into ours.
export function hostValue(value) {
  let host = plainText(value, 253).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (net.isIP(host)) return host;
  return /^[a-z0-9](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_-]{1,63})*\.?$/i.test(host) ? host.replace(/\.$/, '') : '';
}

function isLoopback(host) {
  const lower = host.toLowerCase();
  return LOOPBACK_HOSTS.has(lower) || /^127\./.test(lower);
}

export function serviceUrl({ host, port, useSsl, urlBase = '' }) {
  const hostPart = net.isIPv6(host) ? `[${host}]` : host;
  const base = plainText(urlBase, 256).replace(/^\/+|\/+$/g, '');
  const safeBase = base && /^[\w.~/-]+$/.test(base) ? `/${base}` : '';
  return `${useSsl ? 'https' : 'http'}://${hostPart}${port ? `:${port}` : ''}${safeBase}`;
}

export function urlHost(url) {
  try {
    const { hostname } = new URL(url);
    return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  } catch {
    return '';
  }
}

export function probeTcp(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Where Keelhaularr can reach a service that another application reaches at `host`.
 *
 * `localhost` in Radarr means Radarr's own machine, and a Docker service name such as
 * `qbittorrent` only resolves inside Radarr's Docker network. Either way the service
 * usually publishes the same port on the machine Radarr runs on, which Keelhaularr
 * already reaches, so that is tried as well and whichever answers is used.
 */
export async function reachableHost(host, port, arrHost, probe = probeTcp) {
  const candidates = [];
  if (!isLoopback(host)) candidates.push(host);
  if (arrHost && !candidates.includes(arrHost)) candidates.push(arrHost);
  if (!candidates.length) return { host, reachable: false };
  if (!port) return { host: candidates[0], reachable: false };
  const results = await Promise.all(candidates.map((candidate) => probe(candidate, port).catch(() => false)));
  const index = results.indexOf(true);
  return index === -1 ? { host: candidates[0], reachable: false } : { host: candidates[index], reachable: true };
}

export function qbittorrentClient(clients, kind) {
  const client = (Array.isArray(clients) ? clients : [])
    .filter((entry) => entry && entry.implementation === 'QBittorrent' && entry.enable !== false)
    .sort((first, second) => (Number(first.priority) || 1) - (Number(second.priority) || 1))[0];
  if (!client) return null;
  const fields = providerFields(client);
  const host = hostValue(fields.get('host'));
  if (!host) return null;
  const names = CATEGORY_FIELDS[kind] ?? CATEGORY_FIELDS.radarr;
  return {
    name: plainText(client.name, 128) || 'qBittorrent',
    host,
    port: portNumber(fields.get('port')),
    useSsl: fields.get('useSsl') === true,
    urlBase: plainText(fields.get('urlBase'), 256),
    username: plainText(fields.get('username'), 256),
    category: plainText(fields.get(names.category), 256),
    importedCategory: plainText(fields.get(names.importedCategory), 256),
  };
}

export function mediaServerNotification(notifications) {
  const list = Array.isArray(notifications) ? notifications : [];
  const plex = list.find((entry) => entry?.implementation === 'PlexServer');
  // Radarr and Sonarr call their Emby and Jellyfin connection "MediaBrowser".
  const entry = plex ?? list.find((candidate) => candidate?.implementation === 'MediaBrowser');
  if (!entry) return null;
  const fields = providerFields(entry);
  const host = hostValue(fields.get('host'));
  if (!host) return null;
  return {
    kind: entry === plex ? 'plex' : 'jellyfin',
    host,
    port: portNumber(fields.get('port')) ?? (entry === plex ? 32400 : 8096),
    useSsl: fields.get('useSsl') === true,
    urlBase: plainText(fields.get('urlBase'), 256),
  };
}

function trimTrailingSlash(value) {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

// Remote path mappings translate what the download client reports into what the Arr
// application sees. Only the ones for this client's host apply.
export function remotePathMappings(mappings, clientHost) {
  return (Array.isArray(mappings) ? mappings : [])
    .filter((mapping) => !clientHost || hostValue(mapping?.host).toLowerCase() === clientHost.toLowerCase())
    .map((mapping) => ({
      from: trimTrailingSlash(plainText(mapping?.remotePath, 4096).replaceAll('\\', '/')),
      to: trimTrailingSlash(plainText(mapping?.localPath, 4096).replaceAll('\\', '/')),
    }))
    .filter((mapping) => mapping.from && mapping.to);
}

async function importedPaths(connection) {
  const query = new URLSearchParams({
    page: '1',
    pageSize: String(HISTORY_SAMPLE_SIZE),
    sortKey: 'date',
    sortDirection: 'descending',
    eventType: String(IMPORT_EVENT_TYPE),
  });
  const response = await arrRequest(connection, `history?${query}`, ARR_REQUEST);
  return (Array.isArray(response?.records) ? response.records : [])
    .filter((record) => record?.eventType === IMPORT_EVENT_NAME)
    .map((record) => record?.data?.importedPath)
    .filter((value) => typeof value === 'string' && path.isAbsolute(value));
}

// Emby and Jellyfin share an API; only their public product name tells them apart.
async function identifyMediaBrowser(url) {
  try {
    const response = await fetch(`${url}/System/Info/Public`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return 'jellyfin';
    const info = await response.json();
    return /emby/i.test(String(info?.ProductName ?? '')) ? 'emby' : 'jellyfin';
  } catch {
    return 'jellyfin';
  }
}

export async function readArrDownloadClient(connection, kind) {
  const [clients, mappings] = await Promise.all([
    arrRequest(connection, 'downloadclient', ARR_REQUEST),
    arrRequest(connection, 'remotepathmapping', ARR_REQUEST).catch(() => []),
  ]);
  const client = qbittorrentClient(clients, kind);
  return { client, remotePathMappings: client ? remotePathMappings(mappings, client.host) : [] };
}

/**
 * Everything a successful Radarr or Sonarr test can fill in beyond its own library
 * folders: the qBittorrent it downloads with, the media server it notifies, and recent
 * imports as evidence of where its library really is. Each part is best effort; an
 * application that refuses one request still fills in the rest.
 */
export async function discoverArrSettings(connection, { kind, arrHost, probe = probeTcp, identify = identifyMediaBrowser } = {}) {
  const [downloads, notifications, imports] = await Promise.allSettled([
    readArrDownloadClient(connection, kind),
    arrRequest(connection, 'notification', ARR_REQUEST),
    importedPaths(connection),
  ]);
  const client = downloads.status === 'fulfilled' ? downloads.value.client : null;
  const notification = notifications.status === 'fulfilled' ? mediaServerNotification(notifications.value) : null;

  let qbittorrent = null;
  if (client) {
    const address = await reachableHost(client.host, client.port, arrHost, probe);
    qbittorrent = {
      url: serviceUrl({ ...client, host: address.host }),
      reachable: address.reachable,
      username: client.username,
      category: client.category,
      importedCategory: client.importedCategory,
      clientName: client.name,
    };
  }

  let mediaServer = null;
  if (notification) {
    const address = await reachableHost(notification.host, notification.port, arrHost, probe);
    const url = serviceUrl({ ...notification, host: address.host });
    mediaServer = {
      kind: notification.kind === 'plex' || !address.reachable ? notification.kind : await identify(url),
      url,
      reachable: address.reachable,
    };
  }

  return {
    qbittorrent,
    mediaServer,
    remotePathMappings: downloads.status === 'fulfilled' ? downloads.value.remotePathMappings : [],
    importedPaths: imports.status === 'fulfilled' ? imports.value : [],
  };
}

function usableDirectory(candidate, writable = true) {
  try {
    if (!statSync(candidate).isDirectory()) return false;
    accessSync(candidate, constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0));
    return true;
  } catch {
    return false;
  }
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function overlaps(first, second) {
  return within(first, second) || within(second, first);
}

// Folder lists are comma separated and path mappings are `from=>to` lines joined by
// semicolons, so a path containing any of those, or a line break, could never be
// saved - and a line break pasted into the mappings box would become a mapping of its
// own. Such a path is treated as unusable rather than passed on.
export function savablePath(value) {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f,;]/.test(value) && !value.includes('=>');
}

// `savable` is for paths that become folders or mappings. A torrent's own name is only
// ever compared or used as evidence, so a comma in "Film, The (2020)" is fine there.
function normalizedRemotePath(value, { savable = true } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (savable ? !savablePath(trimmed) : /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  const normalized = trimTrailingSlash(trimmed.replaceAll('\\', '/'));
  return path.posix.isAbsolute(normalized) ? path.posix.normalize(normalized) : null;
}

function applyPrefixMappings(input, mappings) {
  const sorted = [...mappings].sort((first, second) => second.from.length - first.from.length);
  for (const mapping of sorted) {
    if (input === mapping.from || input.startsWith(`${mapping.from}/`)) {
      return `${mapping.to}${input.slice(mapping.from.length)}`;
    }
  }
  return input;
}

/**
 * The widest mapping that still means the same thing: `/downloads/radarr` found at
 * `/mnt/data/torrents/radarr` says `/downloads` is `/mnt/data/torrents`, which also
 * covers every other category qBittorrent keeps there. It keeps at least one folder on
 * the reported side, so a mapping never starts at `/`.
 */
function widenMapping(from, to) {
  const fromParts = from.split('/').filter(Boolean);
  const toParts = to.split('/').filter(Boolean);
  while (fromParts.length > 1 && toParts.length > 1 && fromParts.at(-1) === toParts.at(-1)) {
    fromParts.pop();
    toParts.pop();
  }
  return { from: `/${fromParts.join('/')}`, to: `/${toParts.join('/')}` };
}

// Widened mappings are used only if every folder still lands exactly where it was
// found; two folders that disagree about a shared parent keep their exact mappings.
function chooseMappings(pairs, mapPath, existing) {
  const needed = pairs.filter(({ from, to }) => mapPath(from, existing) !== to);
  if (!needed.length) return [];
  const exact = [...new Map(needed.map((pair) => [pair.from, pair])).values()];
  const widened = [...new Map(needed.map((pair) => {
    const wide = widenMapping(pair.from, pair.to);
    return [wide.from, wide];
  })).values()];
  const conflicting = new Set();
  for (const mapping of widened) {
    const targets = new Set(needed.filter((pair) => widenMapping(pair.from, pair.to).from === mapping.from)
      .map((pair) => widenMapping(pair.from, pair.to).to));
    if (targets.size > 1) conflicting.add(mapping.from);
  }
  const candidate = conflicting.size ? exact : widened;
  const merged = [...existing, ...candidate];
  return needed.every(({ from, to }) => mapPath(from, merged) === to) ? candidate : exact;
}

function sortedMappings(mappings) {
  return [...mappings].sort((first, second) => String(second.from).length - String(first.from).length);
}

function describeCategories(names) {
  const labels = [...names].map((name) => (name ? `"${name}"` : 'uncategorized'));
  return labels.length > 3 ? `${labels.slice(0, 3).join(', ')} and ${labels.length - 3} more` : labels.join(', ');
}

/**
 * Finds each Arr application's completed-download folder from what qBittorrent is
 * actually doing: the save path its torrents in that application's categories really
 * use, falling back to the category's configured path when it has no torrents yet.
 *
 * A folder is refused, with the reason, rather than filled in when it would make the
 * scan wrong. Every file in a completed-download folder that has no hardlink in that
 * application's library is offered for removal, so a folder that also holds another
 * category's torrents - Sonarr's, or anything added by hand - would offer those up as
 * leftovers while they are still seeding.
 */
export function discoverDownloadFolders(layout, apps, options = {}) {
  const { qbittorrentPathMaps = [], storageRoots = [], libraryRoots = [] } = options;
  const torrents = (Array.isArray(layout?.torrents) ? layout.torrents : [])
    .map((torrent) => ({
      category: typeof torrent?.category === 'string' ? torrent.category : '',
      savePath: normalizedRemotePath(torrent?.savePath),
      contentPath: normalizedRemotePath(torrent?.contentPath, { savable: false }),
    }))
    .filter((torrent) => torrent.savePath);
  const categoryPaths = new Map((Array.isArray(layout?.categories) ? layout.categories : [])
    .filter((category) => typeof category?.name === 'string' && category.name)
    .map((category) => [category.name, typeof category.savePath === 'string' ? category.savePath : '']));
  const defaultSavePath = normalizedRemotePath(layout?.defaultSavePath);
  const resolvedLibraries = libraryRoots.filter((root) => typeof root === 'string' && path.isAbsolute(root))
    .map((root) => path.resolve(root));

  const results = {};
  for (const [app, settings] of Object.entries(apps ?? {})) {
    const label = APP_LABELS[app] ?? app;
    const categories = new Set((settings?.categories ?? []).filter((name) => typeof name === 'string' && name));
    if (!categories.size) continue;
    const own = torrents.filter((torrent) => categories.has(torrent.category));
    const counts = new Map();
    for (const torrent of own) counts.set(torrent.savePath, (counts.get(torrent.savePath) ?? 0) + 1);
    const reported = [...counts.entries()].sort((first, second) => second[1] - first[1]).map(([folder]) => folder);
    for (const category of categories) {
      if (own.some((torrent) => torrent.category === category) || !categoryPaths.has(category)) continue;
      // qBittorrent's own rule: an empty category path is <default>/<category>, and a
      // relative one is relative to the default save path.
      const configured = categoryPaths.get(category).replaceAll('\\', '/');
      const folder = path.posix.isAbsolute(configured)
        ? normalizedRemotePath(configured)
        : defaultSavePath ? path.posix.join(defaultSavePath, configured || category) : null;
      if (folder && !reported.includes(folder)) reported.push(folder);
    }

    const folders = [];
    const problems = [];
    if (!reported.length) {
      problems.push(`This qBittorrent has no ${describeCategories(categories)} category and no torrents in it, so ${label}'s completed-download folder could not be found here. If ${label} uses a different qBittorrent, fill in its folder by hand.`);
    }
    for (const folder of reported.slice(0, MAX_FOLDERS_PER_APP)) {
      // Folders are taken busiest first, and one inside another would be refused on
      // save, so a nested or enclosing folder of one already found is left out.
      if (folders.some((entry) => overlaps(entry.reported, folder))) continue;
      const foreign = new Set(torrents
        .filter((torrent) => !categories.has(torrent.category)
          && within(folder, torrent.contentPath ?? torrent.savePath))
        .map((torrent) => torrent.category));
      if (foreign.size) {
        const sharedDefault = folder === defaultSavePath
          ? ' This is qBittorrent\'s default save path, which usually means its torrent management mode is Manual; set Options → Downloads → Default Torrent Management Mode to Automatic so each category saves to its own folder.'
          : ` Give the ${label} category its own save path in qBittorrent.`;
        problems.push(`qBittorrent saves ${label}'s downloads to ${folder}, which also holds torrents in ${describeCategories(foreign)}. Keelhaularr cannot tell ${label}'s leftovers apart from those, so this folder was not filled in.${sharedDefault}`);
        continue;
      }
      const mapped = mapQbittorrentPath(folder, qbittorrentPathMaps);
      let local = mapped && usableDirectory(mapped) ? mapped : null;
      if (!local) {
        const samples = relativeSamples(folder, own.filter((torrent) => torrent.savePath === folder)
          .map((torrent) => torrent.contentPath).filter(Boolean));
        local = locateReportedPath(folder, storageRoots, { samples });
      }
      if (local && !savablePath(local)) local = null;
      if (!local) {
        problems.push(`qBittorrent saves ${label}'s downloads to ${folder}, and Keelhaularr cannot find that folder. If this LXC does not have that storage mounted, add it as a Proxmox mount point and rerun the installer.`);
        continue;
      }
      if (folders.some((entry) => overlaps(entry.local, local))) continue;
      const library = resolvedLibraries.find((root) => overlaps(root, local));
      if (library) {
        problems.push(`${label}'s downloads are in ${local}, which overlaps the library folder ${library}, so it was not filled in. Downloads and the library need separate folders.`);
        continue;
      }
      const arrPath = applyPrefixMappings(folder, settings?.remotePathMappings ?? []);
      folders.push({ reported: folder, local, arrPath });
    }
    results[app] = { folders, problems };
  }

  // The same folder for two applications is the shared-folder problem again, seen from
  // the other side.
  const names = Object.keys(results);
  for (let first = 0; first < names.length; first += 1) {
    for (let second = first + 1; second < names.length; second += 1) {
      const one = results[names[first]];
      const two = results[names[second]];
      const clash = one.folders.find((a) => two.folders.some((b) => overlaps(a.local, b.local)));
      if (!clash) continue;
      const message = `${APP_LABELS[names[first]] ?? names[first]} and ${APP_LABELS[names[second]] ?? names[second]} both download into ${clash.local}, so neither was filled in. Give each its own qBittorrent category save path.`;
      for (const result of [one, two]) {
        result.folders = result.folders.filter((folder) => !overlaps(folder.local, clash.local));
        result.problems.push(message);
      }
    }
  }

  const allFolders = Object.values(results).flatMap((result) => result.folders);
  const qbittorrentMaps = chooseMappings(
    allFolders.map((folder) => ({ from: folder.reported, to: folder.local })),
    (input, maps) => mapQbittorrentPath(input, sortedMappings(maps)),
    qbittorrentPathMaps,
  );
  const arrPathMaps = {};
  for (const [app, result] of Object.entries(results)) {
    arrPathMaps[app] = chooseMappings(
      result.folders.filter((folder) => savablePath(folder.arrPath))
        .map((folder) => ({ from: folder.arrPath, to: folder.local })),
      (input, maps) => mapArrPath(input, sortedMappings(maps)),
      apps[app]?.pathMaps ?? [],
    );
  }

  return {
    folders: Object.fromEntries(Object.entries(results).map(([app, result]) => [app, {
      localPaths: result.folders.map((folder) => folder.local),
      reported: result.folders.map((folder) => folder.reported),
      problems: result.problems,
    }])),
    qbittorrentPathMaps: qbittorrentMaps,
    arrPathMaps,
  };
}

/**
 * For each folder the media server reads its libraries from, the matching folder
 * inside Keelhaularr. Folders that already resolve, directly or through an existing
 * mapping, need nothing. The rest are searched for using the items the server lists
 * in them, and may also match one of the configured library folders under a
 * different name.
 */
export function suggestMediaServerPathMaps(libraries, options = {}) {
  const { pathMaps = [], storageRoots = [], libraryRoots = [] } = options;
  const suggestions = [];
  const unresolved = [];
  for (const library of Array.isArray(libraries) ? libraries : []) {
    for (const location of library?.locations ?? []) {
      const reported = normalizedRemotePath(location);
      if (!reported) {
        unresolved.push(String(location));
        continue;
      }
      if (suggestions.some((mapping) => mapping.from === reported)) continue;
      const current = mapMediaServerPath(reported, sortedMappings(pathMaps));
      if (current && usableDirectory(current, false)) continue;
      const samples = relativeSamples(reported, library.files ?? []);
      const local = locateReportedPath(reported, storageRoots, {
        samples,
        extraCandidates: libraryRoots,
        writable: false,
      });
      if (local && savablePath(local)) suggestions.push({ from: reported, to: local });
      else unresolved.push(reported);
    }
  }
  return { suggestions, unresolved };
}
