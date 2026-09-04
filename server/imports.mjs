import path from 'node:path';

import { arrRequest, mapArrPath, mapLocalPathToArr } from './arr.mjs';

// Manual import makes the application read a folder off disk and parse everything in
// it, so it is slower than the ordinary library endpoints and gets its own budget.
export const IDENTIFY_TIMEOUT_MS = 60000;
export const IMPORT_COMMAND_TIMEOUT_MS = 60000;

const MAX_TEXT_LENGTH = 300;

// The only status that may ever lead to an import. Everything else - including
// 'occupied', 'error' and 'unidentified' - leaves the file exactly where it is.
export const IMPORTABLE = 'importable';
// Identified, but the movie or episode it belongs to already has a tracked file.
// Importing would duplicate or replace that file, so this is the status that answers
// "is there already a tracked copy of this?" with yes.
export const OCCUPIED = 'occupied';

function safeText(value, maximumLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '\ufffd').trim();
  return sanitized ? sanitized.slice(0, maximumLength) : null;
}

function safeBytes(value) {
  const size = Number(value);
  return Number.isFinite(size) && Number.isSafeInteger(size) && size > 0 ? size : null;
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function comparablePath(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() : '';
}

function verdict(status, reason, extra = {}) {
  return {
    status,
    reason: safeText(reason),
    title: null,
    quality: null,
    existing: null,
    target: null,
    rejections: [],
    ...extra,
  };
}

function rejectionReasons(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => safeText(typeof entry === 'string' ? entry : entry?.reason, 200))
    .filter(Boolean)
    .slice(0, 5);
}

function existingFileSummary(file) {
  if (!file) return null;
  return {
    path: safeText(file.path, 1024),
    sizeBytes: safeBytes(file.size),
    quality: safeText(file.quality?.quality?.name, 64),
  };
}

/**
 * The path the application should be given, but only when translating it back lands on
 * exactly the file we are looking at.
 *
 * Without that round trip a misconfigured path mapping would have us name some other
 * file to the application, and manual import acts on the path it is given.
 */
export function arrPathFor(candidate, pathMaps) {
  const arrPath = mapLocalPathToArr(candidate?.path, pathMaps ?? []);
  if (!arrPath) return null;
  return mapArrPath(arrPath, pathMaps ?? []) === path.resolve(candidate.path) ? arrPath : null;
}

function episodeLabel(series, episodes) {
  const name = safeText(series?.title, 160) ?? 'Unknown series';
  if (!episodes.length) return name;
  const season = episodes[0]?.seasonNumber;
  const numbers = episodes
    .map((episode) => episode?.episodeNumber)
    .filter((number) => Number.isInteger(number))
    .sort((left, right) => left - right);
  if (!Number.isInteger(season) || !numbers.length) return name;
  const code = numbers.map((number) => `E${String(number).padStart(2, '0')}`).join('');
  return `${name} — S${String(season).padStart(2, '0')}${code}`;
}

function movieLabel(movie) {
  const title = safeText(movie?.title, 160) ?? 'Unknown movie';
  return Number.isInteger(movie?.year) && movie.year > 0 ? `${title} (${movie.year})` : title;
}

/**
 * Looks up the authoritative state of what an import would land on.
 *
 * The movie and episode records embedded in a manual-import response are not relied on
 * for this: Radarr declares `hasFile` nullable there, and reading it as "no file" when
 * it is simply absent would mean importing a duplicate on top of a file that already
 * exists. Results are cached per batch, so many files from one series cost one call.
 */
function createTargetCache(connection) {
  const cache = new Map();
  return async (kind, id) => {
    const key = `${kind}:${id}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        if (kind === 'movie') return arrRequest(connection, `movie/${id}`, { timeoutMs: IDENTIFY_TIMEOUT_MS });
        const episodes = await arrRequest(connection, `episode?seriesId=${id}`, { timeoutMs: IDENTIFY_TIMEOUT_MS });
        return new Map((Array.isArray(episodes) ? episodes : []).map((episode) => [episode?.id, episode]));
      })());
    }
    return cache.get(key);
  };
}

async function classifyRadarr(item, lookup) {
  const movieId = positiveId(item?.movie?.id);
  if (!movieId) {
    return verdict('unidentified', 'Radarr could not work out which movie this file is.');
  }
  const label = movieLabel(item.movie);

  let movie;
  try {
    movie = await lookup('movie', movieId);
  } catch (error) {
    return verdict('error', `Radarr could not be asked whether ${label} already has a file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!movie || typeof movie !== 'object') {
    return verdict('error', `Radarr returned no usable record for ${label}.`);
  }

  if (movie.hasFile === true || positiveId(movie.movieFileId)) {
    return verdict(OCCUPIED, `${label} already has a tracked file, so this copy is spare.`, {
      title: label,
      quality: safeText(item?.quality?.quality?.name, 64),
      existing: existingFileSummary(movie.movieFile),
    });
  }

  const rejections = rejectionReasons(item?.rejections);
  if (rejections.length) {
    return verdict('blocked', `Radarr will not import this file: ${rejections.join('; ')}`, {
      title: label, quality: safeText(item?.quality?.quality?.name, 64), rejections,
    });
  }

  return verdict(IMPORTABLE, `${label} has no tracked file. Radarr can import this copy.`, {
    title: label,
    quality: safeText(item?.quality?.quality?.name, 64),
    target: {
      movieId,
      quality: item?.quality ?? null,
      languages: Array.isArray(item?.languages) ? item.languages : [],
      releaseGroup: typeof item?.releaseGroup === 'string' ? item.releaseGroup : null,
      indexerFlags: Number.isInteger(item?.indexerFlags) ? item.indexerFlags : 0,
      downloadId: typeof item?.downloadId === 'string' ? item.downloadId : null,
    },
  });
}

async function classifySonarr(item, lookup) {
  const seriesId = positiveId(item?.series?.id);
  const episodeIds = (Array.isArray(item?.episodes) ? item.episodes : [])
    .map((episode) => positiveId(episode?.id))
    .filter(Boolean);
  if (!seriesId || !episodeIds.length) {
    return verdict('unidentified', 'Sonarr could not work out which episode this file is.');
  }
  const label = episodeLabel(item.series, item.episodes);

  let episodes;
  try {
    episodes = await lookup('series', seriesId);
  } catch (error) {
    return verdict('error', `Sonarr could not be asked whether ${label} already has a file: ${error instanceof Error ? error.message : String(error)}`);
  }
  const known = episodeIds.map((id) => episodes?.get?.(id)).filter(Boolean);
  if (known.length !== episodeIds.length) {
    return verdict('error', `Sonarr did not report every episode this file covers, so whether ${label} already has a file could not be established.`);
  }

  // Any episode that already has a file makes this an upgrade or a duplicate rather
  // than a repair, and which of those it is only the owner can decide.
  const taken = known.filter((episode) => episode.hasFile === true || positiveId(episode.episodeFileId));
  if (taken.length) {
    const which = taken.length === known.length ? label : `${taken.length} of the ${known.length} episodes in ${label}`;
    return verdict(OCCUPIED, `${which} already has a tracked file, so this copy is spare.`, {
      title: label,
      quality: safeText(item?.quality?.quality?.name, 64),
      existing: existingFileSummary(taken[0].episodeFile),
    });
  }

  const rejections = rejectionReasons(item?.rejections);
  if (rejections.length) {
    return verdict('blocked', `Sonarr will not import this file: ${rejections.join('; ')}`, {
      title: label, quality: safeText(item?.quality?.quality?.name, 64), rejections,
    });
  }

  return verdict(IMPORTABLE, `${label} has no tracked file. Sonarr can import this copy.`, {
    title: label,
    quality: safeText(item?.quality?.quality?.name, 64),
    target: {
      seriesId,
      episodeIds,
      quality: item?.quality ?? null,
      languages: Array.isArray(item?.languages) ? item.languages : [],
      releaseGroup: typeof item?.releaseGroup === 'string' ? item.releaseGroup : null,
      indexerFlags: Number.isInteger(item?.indexerFlags) ? item.indexerFlags : 0,
      releaseType: typeof item?.releaseType === 'string' ? item.releaseType : null,
      downloadId: typeof item?.downloadId === 'string' ? item.downloadId : null,
    },
  });
}

/**
 * Identifies every candidate against one application.
 *
 * Never throws: a failure becomes status 'error' on the affected candidates so that
 * every caller has to decide what to do about it, and the import gate can treat
 * anything that is not 'importable' as "leave the file alone".
 */
export async function identifyOrphans(connection, candidates) {
  const checkedAt = new Date().toISOString();
  const stamp = (result) => ({ ...result, checkedAt });
  const results = new Map();

  if (!connection?.configured) {
    for (const candidate of candidates) {
      results.set(candidate.id, stamp(verdict('unsupported', 'This application is not configured.')));
    }
    return results;
  }

  // One manual-import call reads a whole folder, so files that share a folder - the
  // usual shape of both a release folder and a season folder - are identified together.
  const byFolder = new Map();
  for (const candidate of candidates) {
    const arrPath = arrPathFor(candidate, connection.pathMaps);
    if (!arrPath) {
      results.set(candidate.id, stamp(verdict(
        'unsupported',
        `This file's path cannot be translated into a path ${connection.kind ?? 'the application'} would recognise. Check Settings → Connections → path mapping.`,
      )));
      continue;
    }
    const folder = arrPath.includes('\\')
      ? arrPath.slice(0, arrPath.lastIndexOf('\\')) || arrPath
      : path.posix.dirname(arrPath);
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push({ candidate, arrPath });
  }

  const lookup = createTargetCache(connection);
  for (const [folder, entries] of byFolder) {
    let items;
    try {
      items = await arrRequest(
        connection,
        `manualimport?folder=${encodeURIComponent(folder)}&filterExistingFiles=false`,
        { timeoutMs: IDENTIFY_TIMEOUT_MS },
      );
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      const reason = timedOut
        ? `Identifying the contents of ${folder} timed out.`
        : `${folder} could not be identified: ${error instanceof Error ? error.message : String(error)}`;
      for (const { candidate } of entries) results.set(candidate.id, stamp(verdict('error', reason)));
      continue;
    }
    if (!Array.isArray(items)) {
      for (const { candidate } of entries) {
        results.set(candidate.id, stamp(verdict('error', 'The application returned an invalid manual-import response.')));
      }
      continue;
    }

    const byPath = new Map(items.map((item) => [comparablePath(item?.path), item]));
    for (const { candidate, arrPath } of entries) {
      const item = byPath.get(comparablePath(arrPath));
      if (!item) {
        results.set(candidate.id, stamp(verdict(
          'unidentified',
          `${connection.kind === 'sonarr' ? 'Sonarr' : 'Radarr'} did not offer this file for import, so it cannot say what it is.`,
        )));
        continue;
      }
      const classified = connection.kind === 'sonarr'
        ? await classifySonarr(item, lookup)
        : await classifyRadarr(item, lookup);
      results.set(candidate.id, stamp({ ...classified, arrPath }));
    }
  }

  return results;
}

export async function identifyOrphansForCandidates(config, candidates) {
  const byApp = new Map();
  for (const candidate of candidates) {
    if (!byApp.has(candidate.app)) byApp.set(candidate.app, []);
    byApp.get(candidate.app).push(candidate);
  }
  const merged = new Map();
  for (const [app, group] of byApp) {
    const results = await identifyOrphans(config[app], group);
    for (const [id, result] of results) merged.set(id, result);
  }
  return candidates.map((candidate) => ({ id: candidate.id, ...merged.get(candidate.id) }));
}

/**
 * Builds the ManualImport command payload.
 *
 * importMode 'auto' is deliberate and is the whole point of the feature: it hands the
 * decision back to Radarr/Sonarr, which hardlink or copy while a torrent is still
 * seeding and move otherwise, honouring their own "Use Hardlinks instead of Copy"
 * setting. Forcing 'move' here would break seeding; forcing 'copy' would waste a second
 * copy on disk where a hardlink was wanted.
 */
export function buildImportCommand(app, arrPath, target) {
  const shared = {
    path: arrPath,
    quality: target.quality ?? undefined,
    languages: target.languages?.length ? target.languages : undefined,
    releaseGroup: target.releaseGroup ?? undefined,
    indexerFlags: target.indexerFlags ?? 0,
    downloadId: target.downloadId ?? undefined,
  };
  const file = app === 'sonarr'
    ? { ...shared, seriesId: target.seriesId, episodeIds: target.episodeIds, releaseType: target.releaseType ?? undefined }
    : { ...shared, movieId: target.movieId };
  return { name: 'ManualImport', importMode: 'auto', files: [file] };
}

export async function requestImport(connection, app, arrPath, target) {
  const command = await arrRequest(connection, 'command', {
    method: 'POST',
    body: JSON.stringify(buildImportCommand(app, arrPath, target)),
    timeoutMs: IMPORT_COMMAND_TIMEOUT_MS,
  });
  const id = positiveId(command?.id);
  if (!id) throw new Error('The application accepted the import but returned no command to follow.');
  return id;
}

export async function importCommandStatus(connection, commandId) {
  const command = await arrRequest(connection, `command/${commandId}`, { timeoutMs: IMPORT_COMMAND_TIMEOUT_MS });
  const status = safeText(command?.status, 32)?.toLowerCase() ?? 'unknown';
  return {
    status,
    finished: ['completed', 'failed', 'aborted', 'cancelled'].includes(status),
    succeeded: status === 'completed',
    message: safeText(command?.message, 200),
  };
}

/**
 * Whether the movie or episodes an import targeted now have a tracked file.
 *
 * This is how an import is proven rather than assumed. A completed command is not
 * evidence on its own: Radarr and Sonarr report ManualImport as completed even when the
 * file was rejected during the import itself, so the only honest confirmation is that
 * the library now holds what it did not hold before.
 */
export async function targetHasFile(connection, app, target) {
  if (app === 'sonarr') {
    const episodes = await arrRequest(connection, `episode?seriesId=${target.seriesId}`, { timeoutMs: IDENTIFY_TIMEOUT_MS });
    const byId = new Map((Array.isArray(episodes) ? episodes : []).map((episode) => [episode?.id, episode]));
    return target.episodeIds.every((id) => {
      const episode = byId.get(id);
      return Boolean(episode && (episode.hasFile === true || positiveId(episode.episodeFileId)));
    });
  }
  const movie = await arrRequest(connection, `movie/${target.movieId}`, { timeoutMs: IDENTIFY_TIMEOUT_MS });
  return Boolean(movie && (movie.hasFile === true || positiveId(movie.movieFileId)));
}

// The cheap identification used on every scan.
//
// `manualimport` is thorough but makes the application read a folder off disk and run
// full import decisions over it, which is far too much to do on a schedule. `parse` is
// a pure string match against the library - no disk access at all - so it can answer
// "which movie or episode is this?" for every untracked file on every scan.
//
// The two are not interchangeable. `parse` cannot report rejections or produce the
// payload an import needs, so the manual check and the import itself still use
// `manualimport`. What `parse` gives is the one thing worth knowing at a glance:
// whether the library already has this.
export const PARSE_TIMEOUT_MS = 15000;
const PARSE_CACHE_LIMIT = 5000;

// A release name always parses to the same thing, so this is cacheable for the life of
// the process. Crucially it caches only the name-to-id match and never whether that
// target has a file: occupancy is recomputed from each fresh scan, so a cached parse
// can never produce a stale "already in the library" verdict.
const parseCache = new Map();

function cacheParse(key, value) {
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    parseCache.delete(parseCache.keys().next().value);
  }
  parseCache.set(key, value);
  return value;
}

async function parseTitle(connection, title) {
  const key = `${connection.id ?? connection.kind} ${title}`;
  if (parseCache.has(key)) return parseCache.get(key);
  let parsed;
  try {
    parsed = await arrRequest(connection, `parse?title=${encodeURIComponent(title)}`, {
      timeoutMs: PARSE_TIMEOUT_MS,
    });
  } catch {
    // Not cached: a connection failure says nothing about the name, and the next scan
    // should try again rather than remember a failure forever.
    return null;
  }
  if (connection.kind === 'sonarr') {
    const seriesId = positiveId(parsed?.series?.id);
    const episodes = (Array.isArray(parsed?.episodes) ? parsed.episodes : [])
      .map((episode) => ({
        id: positiveId(episode?.id),
        seasonNumber: episode?.seasonNumber,
        episodeNumber: episode?.episodeNumber,
      }))
      .filter((episode) => episode.id);
    if (!seriesId || !episodes.length) return cacheParse(key, { matched: false });
    return cacheParse(key, { matched: true, seriesId, episodes, title: parsed.series?.title });
  }
  const movieId = positiveId(parsed?.movie?.id);
  if (!movieId) return cacheParse(key, { matched: false });
  return cacheParse(key, { matched: true, movieId, title: parsed.movie?.title, year: parsed.movie?.year });
}

/**
 * Identifies untracked files by name against what the scan already knows.
 *
 * `withFile` is the set of movie or episode ids the scan already found to have a
 * tracked file, so no extra request is needed to answer the question that matters.
 */
export async function identifyByName(connection, candidates, withFile, limit) {
  const results = new Map();
  if (!connection?.configured) return results;

  const queue = candidates.slice(0, limit);
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const candidate = queue.shift();
      if (!candidate) return;

      // A release folder usually carries more than the file inside it does, so it is
      // tried first, exactly as the applications' own import does.
      const folder = path.basename(path.dirname(candidate.path));
      const file = path.basename(candidate.path, path.extname(candidate.path));
      let parsed = null;
      for (const title of [folder, file]) {
        if (!title || title === '.' || title === '/') continue;
        parsed = await parseTitle(connection, title);
        if (parsed?.matched) break;
      }

      if (!parsed) continue;
      const appName = connection.kind === 'sonarr' ? 'Sonarr' : 'Radarr';
      if (!parsed.matched) {
        results.set(candidate.id, verdict('unidentified', `${appName} does not recognise this name.`));
        continue;
      }

      if (connection.kind === 'sonarr') {
        const label = episodeLabel({ title: parsed.title }, parsed.episodes);
        const taken = parsed.episodes.filter((episode) => withFile.has(episode.id));
        const which = taken.length === parsed.episodes.length
          ? label
          : `${taken.length} of the ${parsed.episodes.length} episodes in ${label}`;
        results.set(candidate.id, taken.length
          ? verdict(OCCUPIED, `${which} already has a tracked file, so this copy is spare.`, { title: label })
          : verdict(IMPORTABLE, `${label} has no tracked file. Sonarr can import this copy.`, { title: label }));
        continue;
      }

      const label = movieLabel({ title: parsed.title, year: parsed.year });
      results.set(candidate.id, withFile.has(parsed.movieId)
        ? verdict(OCCUPIED, `${label} already has a tracked file, so this copy is spare.`, { title: label })
        : verdict(IMPORTABLE, `${label} has no tracked file. Radarr can import this copy.`, { title: label }));
    }
  });
  await Promise.all(workers);
  return results;
}

export async function identifyScanCandidates(config, arrResults, candidates, limit) {
  if (!limit || limit <= 0 || !candidates.length) return [];
  const byApp = new Map();
  for (const candidate of candidates) {
    if (!byApp.has(candidate.app)) byApp.set(candidate.app, []);
    byApp.get(candidate.app).push(candidate);
  }
  const merged = new Map();
  // The budget is shared across applications so a large Radarr library cannot use it up
  // and leave Sonarr's untracked files permanently unidentified.
  const share = Math.max(1, Math.floor(limit / byApp.size));
  for (const [app, group] of byApp) {
    const withFile = arrResults?.[app]?.withFile ?? new Set();
    const results = await identifyByName(config[app], group, withFile, share);
    for (const [id, result] of results) merged.set(id, result);
  }
  return candidates
    .filter((candidate) => merged.has(candidate.id))
    .map((candidate) => ({ id: candidate.id, ...merged.get(candidate.id), source: 'scan' }));
}
