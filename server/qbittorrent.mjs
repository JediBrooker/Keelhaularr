import path from 'node:path';

const REQUEST_TIMEOUT_MS = 15000;

function apiError(message, statusCode) {
  const error = new Error(message);
  if (statusCode) error.statusCode = statusCode;
  return error;
}

function endpointUrl(connection, endpoint) {
  return `${connection.url}/api/v2/${endpoint.replace(/^\//, '')}`;
}

function sessionCookie(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const match = String(value).match(/^([^=;\s]+)=([^;]*)/);
    if (match && /^(?:SID|(?:QBT|QBIT)_SID(?:_.+)?)$/i.test(match[1])) return `${match[1]}=${match[2]}`;
  }
  return '';
}

async function login(connection) {
  const body = new URLSearchParams({
    username: connection.username ?? '',
    password: connection.password ?? '',
  });
  const response = await fetch(endpointUrl(connection, 'auth/login'), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'text/plain',
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: new URL(connection.url).origin,
      Referer: `${connection.url}/`,
    },
    body,
  });
  const detail = (await response.text()).trim();
  const acceptedStatus = response.status === 200 || response.status === 204;
  if (!acceptedStatus || (detail && detail !== 'Ok.')) {
    throw apiError(
      `qBittorrent login failed${response.ok ? '' : ` with HTTP ${response.status}`}${detail && detail !== 'Fails.' ? `: ${detail.slice(0, 300)}` : ''}`,
      response.status === 401 || response.status === 403 ? 502 : undefined,
    );
  }
  return sessionCookie(response.headers);
}

async function withSession(connection, work) {
  const cookie = await login(connection);
  const request = async (endpoint, { method = 'GET', accept = 'application/json' } = {}) => {
    const response = await fetch(endpointUrl(connection, endpoint), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: accept,
        Origin: new URL(connection.url).origin,
        Referer: `${connection.url}/`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw apiError(`qBittorrent returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response;
  };

  try {
    return await work(request);
  } finally {
    if (cookie) await request('auth/logout', { method: 'POST', accept: 'text/plain' }).catch(() => undefined);
  }
}

function assertConfigured(connection) {
  if (!connection?.configured) throw apiError('qBittorrent is not configured.');
}

async function readTorrentList(request, query = '') {
  const response = await request(`torrents/info${query}`);
  const torrents = await response.json();
  if (!Array.isArray(torrents)) throw apiError('qBittorrent returned an invalid torrent list.');
  return torrents;
}

function validString(value, { allowEmpty = false } = {}) {
  return typeof value === 'string' && (allowEmpty || value.length > 0) ? value : null;
}

function validNumber(value, { integer = false, maximum = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) return null;
  return integer && !Number.isInteger(value) ? null : value;
}

function normalizeRecoveryTorrent(torrent) {
  const raw = torrent && typeof torrent === 'object' && !Array.isArray(torrent) ? torrent : {};
  const hash = validString(raw.hash);
  const name = validString(raw.name);
  const category = validString(raw.category, { allowEmpty: true });
  const state = validString(raw.state);
  const dlspeed = validNumber(raw.dlspeed);
  const progress = validNumber(raw.progress, { maximum: 1 });
  const amountLeft = validNumber(raw.amount_left, { integer: true });
  const addedOn = validNumber(raw.added_on, { integer: true });
  const lastActivity = validNumber(raw.last_activity, { integer: true });

  return {
    hash,
    name,
    category,
    state,
    dlspeed,
    progress,
    amount_left: amountLeft,
    amountLeft,
    added_on: addedOn,
    addedOn,
    last_activity: lastActivity,
    lastActivity,
    recoveryFieldsValid: hash !== null
      && name !== null
      && category !== null
      && state !== null
      && dlspeed !== null
      && progress !== null
      && amountLeft !== null
      && addedOn !== null
      && lastActivity !== null,
  };
}

export async function listQbittorrentTorrents(connection) {
  assertConfigured(connection);
  return withSession(connection, async (request) => {
    const torrents = await readTorrentList(request);
    return torrents.map(normalizeRecoveryTorrent);
  });
}

export async function getQbittorrentTorrent(connection, hash) {
  assertConfigured(connection);
  if (typeof hash !== 'string' || !hash.length) throw apiError('A qBittorrent torrent hash is required.');

  return withSession(connection, async (request) => {
    const torrents = await readTorrentList(request, `?hashes=${encodeURIComponent(hash)}`);
    const matches = torrents.map(normalizeRecoveryTorrent).filter((torrent) => torrent.hash === hash);
    if (matches.length > 1) throw apiError('qBittorrent returned duplicate torrents for a single hash.');
    return matches[0] ?? null;
  });
}

export async function listQbittorrentCategories(connection) {
  assertConfigured(connection);
  return withSession(connection, async (request) => {
    const categoriesResponse = await request('torrents/categories');
    const payload = await categoriesResponse.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw apiError('qBittorrent returned an invalid category list.');
    }

    const categories = Object.entries(payload)
      .filter(([name]) => name !== '')
      .map(([name, details]) => {
        const extra = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
        return {
          ...extra,
          name,
          savePath: typeof extra.savePath === 'string' ? extra.savePath : '',
        };
      });
    return [{ name: '', savePath: '', synthetic: true }, ...categories];
  });
}

export function mapQbittorrentPath(input, pathMaps = []) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const normalizedInput = input.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  const caseInsensitiveInput = /^[a-z]:\//i.test(normalizedInput) || normalizedInput.startsWith('//');
  const comparableInput = caseInsensitiveInput ? normalizedInput.toLowerCase() : normalizedInput;
  const normalizedMappings = pathMaps
    .filter((mapping) => typeof mapping?.from === 'string' && mapping.from.length)
    .map((mapping) => ({
      ...mapping,
      from: mapping.from.replaceAll('\\', '/').replace(/\/+$/, ''),
    }))
    .sort((a, b) => b.from.length - a.from.length);
  for (const mapping of normalizedMappings) {
    const { from } = mapping;
    const caseInsensitiveFrom = /^[a-z]:\//i.test(from) || from.startsWith('//');
    const comparableFrom = caseInsensitiveFrom ? from.toLowerCase() : from;
    if (caseInsensitiveInput === caseInsensitiveFrom
      && (comparableInput === comparableFrom || comparableInput.startsWith(`${comparableFrom}/`))) {
      const suffix = normalizedInput.slice(from.length).replace(/^\//, '');
      const destination = path.resolve(mapping.to);
      const mapped = path.resolve(destination, suffix);
      const relative = path.relative(destination, mapped);
      return relative.startsWith('..') || path.isAbsolute(relative) ? null : mapped;
    }
  }
  if (/^[a-z]:\//i.test(normalizedInput) || normalizedInput.startsWith('//')) return null;
  return path.isAbsolute(normalizedInput) ? path.resolve(normalizedInput) : null;
}

function torrentContentPath(torrent) {
  if (typeof torrent?.content_path === 'string' && torrent.content_path.trim()) return torrent.content_path;
  return null;
}

function isIncomplete(torrent) {
  const amountLeft = torrent?.amount_left;
  const progress = torrent?.progress;
  if (typeof amountLeft !== 'number' || !Number.isFinite(amountLeft) || amountLeft < 0
    || typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) return true;
  return amountLeft > 0 || progress < 1;
}

export async function inspectQbittorrent(connection) {
  if (!connection?.configured) {
    return {
      status: 'not-configured',
      version: null,
      totalTorrentCount: 0,
      incompleteTorrentCount: 0,
      incompletePaths: [],
      unmappedIncompleteCount: 0,
    };
  }

  return withSession(connection, async (request) => {
    const [versionResponse, torrentsResponse] = await Promise.all([
      request('app/version', { accept: 'text/plain' }),
      request('torrents/info'),
    ]);
    const version = (await versionResponse.text()).trim() || null;
    const torrents = await torrentsResponse.json();
    if (!Array.isArray(torrents)) throw apiError('qBittorrent returned an invalid torrent list.');

    const incomplete = torrents.filter(isIncomplete);
    const mappedPaths = [];
    let unmappedIncompleteCount = 0;
    for (const torrent of incomplete) {
      const mapped = mapQbittorrentPath(torrentContentPath(torrent), connection.pathMaps);
      if (mapped) mappedPaths.push(mapped);
      else unmappedIncompleteCount += 1;
    }

    return {
      status: 'connected',
      version,
      totalTorrentCount: torrents.length,
      incompleteTorrentCount: incomplete.length,
      incompletePaths: [...new Set(mappedPaths)],
      unmappedIncompleteCount,
    };
  });
}

export function pathIsProtected(candidatePath, protectedPaths) {
  const candidate = path.resolve(candidatePath);
  return protectedPaths.some((protectedPath) => {
    const protectedRoot = path.resolve(protectedPath);
    const relative = path.relative(protectedRoot, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}
