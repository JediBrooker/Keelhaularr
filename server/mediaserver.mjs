import path from 'node:path';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_QUERY = 400;
const MAX_USERS = 40;
const MAX_SECTIONS = 40;

function apiError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeText(value, maximumLength = 200) {
  if (typeof value !== 'string') return null;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '\ufffd').trim();
  return sanitized ? sanitized.slice(0, maximumLength) : null;
}

// Same shape as the Arr and qBittorrent mappers: an exact match or a `${from}/`
// boundary only, never a bare string prefix, and a mapped result must stay inside its
// destination. Returns null when it cannot be resolved, which the caller treats as a
// reason to withhold rather than to proceed.
export function mapMediaServerPath(input, pathMaps = []) {
  if (typeof input !== 'string' || !input) return null;
  const normalizedInput = input.replaceAll('\\', '/');
  for (const mapping of pathMaps) {
    const from = String(mapping.from ?? '').replaceAll('\\', '/').replace(/\/+$/, '');
    if (!from) continue;
    if (normalizedInput === from || normalizedInput.startsWith(`${from}/`)) {
      const suffix = normalizedInput.slice(from.length).replace(/^\/+/, '');
      const destination = path.resolve(String(mapping.to ?? ''));
      const mapped = path.resolve(destination, suffix);
      const relative = path.relative(destination, mapped);
      return relative.startsWith('..') || path.isAbsolute(relative) ? null : mapped;
    }
  }
  if (/^[a-z]:\//i.test(normalizedInput) || normalizedInput.startsWith('//')) return null;
  return path.isAbsolute(normalizedInput) ? path.resolve(normalizedInput) : null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED',
]);

// "fetch failed" is all Node says on its own. The reason is in `cause`, and each one
// has a different fix, so it is named rather than passed through.
export function describeFetchFailure(error, url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    // Reported below without a host.
  }
  const host = parsed?.host ?? 'the media server';
  if (parsed && LOOPBACK_HOSTS.has(parsed.hostname)) {
    return `Could not connect to ${host}. Inside Keelhaularr's Docker container, ${parsed.hostname} is Keelhaularr itself, not the machine it runs on. Use the media server's LAN address instead (for example http://192.168.1.20:32400), or http://host.docker.internal:${parsed.port || (parsed.protocol === 'https:' ? '443' : '80')} when it runs on this same LXC.`;
  }
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return `${host} did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Check the address, and that a firewall or VLAN is not blocking this LXC from reaching it.`;
  }
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ECONNREFUSED') return `${host} refused the connection. Check the port, and that the media server is running and listening on that address.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `The name ${parsed?.hostname ?? host} could not be resolved from inside Keelhaularr. Use the media server's IP address instead.`;
  if (['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(code)) {
    return `${host} could not be reached from inside Keelhaularr (${code}). Check the address and that this LXC can reach that network.`;
  }
  if (TLS_CODES.has(code)) {
    return `${host} presented a certificate Keelhaularr cannot verify (${code}). Use http:// on the local network, or the server's own https:// address whose certificate matches, such as Plex's *.plex.direct URL.`;
  }
  const causeMessage = error?.cause?.message ?? '';
  if (/redirect/i.test(causeMessage) || /redirect/i.test(error?.message ?? '')) {
    return `${host} answered with a redirect, which is not followed so the token is never sent elsewhere. Enter the address it redirects to, usually https:// instead of http://.`;
  }
  return `Could not connect to ${host}: ${causeMessage || error?.message || String(error)}`;
}

async function request(url, headers) {
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
      headers: { Accept: 'application/json', ...headers },
    });
  } catch (error) {
    throw apiError(describeFetchFailure(error, url));
  }
  if (response.status === 401 || response.status === 403) {
    throw apiError(`The media server rejected the token (HTTP ${response.status}). Check the X-Plex-Token or API key, and that it belongs to the server owner or an administrator.`);
  }
  if (!response.ok) throw apiError(`The media server returned HTTP ${response.status}.`);
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw apiError('The media server returned an invalid response.');
  }
}

function withinWindow(timestamp, cutoffMs) {
  if (!timestamp) return false;
  const played = new Date(timestamp).getTime();
  return Number.isFinite(played) && played >= cutoffMs;
}

// ---------------------------------------------------------------- Jellyfin / Emby

function jellyfinHeaders(connection) {
  return { 'X-Emby-Token': connection.token };
}

async function collectJellyfin(connection, cutoffMs) {
  const base = connection.url.replace(/\/+$/, '');
  const headers = jellyfinHeaders(connection);
  const paths = [];
  let inProgress = 0;

  // Anything on screen right now, regardless of the lookback window.
  const sessions = await request(`${base}/Sessions`, headers);
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const nowPlaying = session?.NowPlayingItem;
    if (nowPlaying?.Path) {
      paths.push({ raw: nowPlaying.Path, reason: 'playing now', title: safeText(nowPlaying.Name) });
      inProgress += 1;
    }
  }

  const users = await request(`${base}/Users`, headers);
  const userList = (Array.isArray(users) ? users : []).slice(0, MAX_USERS);
  for (const user of userList) {
    const id = safeText(user?.Id, 64);
    if (!id) continue;
    const query = new URLSearchParams({
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode',
      Filters: 'IsPlayed',
      SortBy: 'DatePlayed',
      SortOrder: 'Descending',
      Limit: String(MAX_ITEMS_PER_QUERY),
      Fields: 'Path',
      EnableUserData: 'true',
    });
    const played = await request(`${base}/Users/${encodeURIComponent(id)}/Items?${query}`, headers);
    for (const item of Array.isArray(played?.Items) ? played.Items : []) {
      if (!item?.Path) continue;
      if (!withinWindow(item?.UserData?.LastPlayedDate, cutoffMs)) continue;
      paths.push({ raw: item.Path, reason: 'watched recently', title: safeText(item?.Name) });
    }
  }
  return { paths, inProgress };
}

// ---------------------------------------------------------------- Plex

function plexHeaders(connection) {
  return { 'X-Plex-Token': connection.token };
}

function plexPartFiles(entry) {
  const files = [];
  for (const media of Array.isArray(entry?.Media) ? entry.Media : []) {
    for (const part of Array.isArray(media?.Part) ? media.Part : []) {
      if (part?.file) files.push(part.file);
    }
  }
  return files;
}

async function collectPlex(connection, cutoffMs) {
  const base = connection.url.replace(/\/+$/, '');
  const headers = plexHeaders(connection);
  const paths = [];
  let inProgress = 0;

  const sessions = await request(`${base}/status/sessions`, headers);
  for (const entry of sessions?.MediaContainer?.Metadata ?? []) {
    for (const file of plexPartFiles(entry)) {
      paths.push({ raw: file, reason: 'playing now', title: safeText(entry?.title) });
      inProgress += 1;
    }
  }

  const sections = await request(`${base}/library/sections`, headers);
  const directories = (sections?.MediaContainer?.Directory ?? []).slice(0, MAX_SECTIONS);
  const cutoffSeconds = Math.floor(cutoffMs / 1000);
  for (const directory of directories) {
    const key = safeText(directory?.key, 32);
    if (!key) continue;
    // type 1 = movie, 4 = episode. Plex filters server-side on lastViewedAt: its
    // "greater than" operator is `>>=`, so the key is `lastViewedAt>>`. A single `>`
    // is not an operator Plex knows, and the page then came back unfiltered and in
    // library order, so a recent watch beyond the first page was never seen. Sorting
    // newest first keeps the most recent plays on the page even if the filter is not
    // applied.
    for (const type of ['1', '4']) {
      const query = new URLSearchParams({
        type,
        'lastViewedAt>>': String(cutoffSeconds),
        sort: 'lastViewedAt:desc',
        'X-Plex-Container-Start': '0',
        'X-Plex-Container-Size': String(MAX_ITEMS_PER_QUERY),
      });
      let page;
      try {
        page = await request(`${base}/library/sections/${encodeURIComponent(key)}/all?${query}`, headers);
      } catch {
        // A section that rejects one item type is not a reason to fail the whole check.
        continue;
      }
      for (const entry of page?.MediaContainer?.Metadata ?? []) {
        const lastViewed = Number(entry?.lastViewedAt);
        if (!Number.isFinite(lastViewed) || lastViewed * 1000 < cutoffMs) continue;
        for (const file of plexPartFiles(entry)) {
          paths.push({ raw: file, reason: 'watched recently', title: safeText(entry?.title) });
        }
      }
    }
  }
  return { paths, inProgress };
}

// ---------------------------------------------------------------- public surface

export async function inspectMediaServer(connection) {
  if (!connection?.configured) {
    return {
      status: 'not-configured',
      protectedPaths: [],
      protectedCount: 0,
      unmappedCount: 0,
      inProgressCount: 0,
      samples: [],
    };
  }

  const cutoffMs = Date.now() - connection.watchedWithinDays * 86400000;
  const collected = connection.kind === 'plex'
    ? await collectPlex(connection, cutoffMs)
    : await collectJellyfin(connection, cutoffMs);

  const mapped = new Map();
  let unmappedCount = 0;
  for (const entry of collected.paths) {
    const localPath = mapMediaServerPath(entry.raw, connection.pathMaps);
    if (!localPath) {
      unmappedCount += 1;
      continue;
    }
    if (!mapped.has(localPath)) mapped.set(localPath, entry);
  }

  return {
    status: 'connected',
    protectedPaths: [...mapped.keys()],
    protectedCount: mapped.size,
    unmappedCount,
    inProgressCount: collected.inProgress,
    samples: [...mapped.entries()].slice(0, 10).map(([localPath, entry]) => ({
      path: localPath,
      title: entry.title,
      reason: entry.reason,
    })),
  };
}

export function watchedPathMatch(candidatePath, protectedPaths) {
  const candidate = path.resolve(candidatePath);
  return protectedPaths.some((protectedPath) => path.resolve(protectedPath) === candidate);
}

/**
 * Fails closed exactly like the qBittorrent guard: when a media server IS configured
 * but cannot be reached, or reports a path that cannot be mapped, the file is withheld
 * rather than removed. An unconfigured media server is simply not a constraint.
 */
export async function assertNotRecentlyWatched(config, candidate) {
  const connection = config.mediaServer;
  if (!connection?.configured) return;

  const localPath = candidate.localPath ?? candidate.path;
  if (!localPath) return;

  let snapshot;
  try {
    snapshot = await inspectMediaServer(connection);
  } catch (error) {
    throw new Error(`The media-server watch check failed immediately before the file change; file preserved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (snapshot.unmappedCount) {
    throw new Error(`The media server reported ${snapshot.unmappedCount} watched path(s) that could not be mapped to a local path; file preserved. Add a media-server path mapping.`);
  }
  if (watchedPathMatch(localPath, snapshot.protectedPaths)) {
    throw new Error(`This file was played within the last ${connection.watchedWithinDays} day(s) according to the media server; file preserved.`);
  }
}
