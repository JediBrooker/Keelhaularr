import { createHash } from 'node:crypto';
import path from 'node:path';
import { matchSizeRule } from './config.mjs';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function stableId(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

function qualityName(mediaFile) {
  return mediaFile?.quality?.quality?.name ?? mediaFile?.quality?.name ?? 'Unknown quality';
}

function safeSizeBytes(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function recordOverageObservation(result, app, exclusionKeys, sizeBytes, limitBytes) {
  const overageBytes = Math.max(0, sizeBytes - limitBytes);
  result.overageObservations.push({ app, exclusionKeys, sizeBytes, limitBytes, overageBytes });
  return overageBytes;
}

function joinArrPath(parent, child) {
  if (!parent) return child ?? '';
  if (!child) return parent;
  const separator = parent.includes('\\') ? '\\' : '/';
  return `${parent.replace(/[\\/]$/, '')}${separator}${child.replace(/^[\\/]/, '')}`;
}

export function mapArrPath(input, pathMaps) {
  if (!input) return null;
  const normalizedInput = input.replaceAll('\\', '/');
  for (const mapping of pathMaps) {
    const from = mapping.from.replaceAll('\\', '/').replace(/\/$/, '');
    if (normalizedInput === from || normalizedInput.startsWith(`${from}/`)) {
      const suffix = normalizedInput.slice(from.length).replace(/^\//, '');
      return path.resolve(mapping.to, suffix);
    }
  }
  return path.resolve(input);
}

// Resolves which configured media root contains a mapped library file, so an
// oversized file can be quarantined relative to its own root. Returns null when the
// path is outside every configured root, which makes quarantine fail closed.
function tagLabelMap(tags) {
  const labels = new Map();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const id = Number(tag?.id);
    const label = typeof tag?.label === 'string' ? tag.label.trim().toLowerCase() : '';
    if (Number.isFinite(id) && label) labels.set(id, label);
  }
  return labels;
}

function resolveTagNames(ids, labels) {
  if (!Array.isArray(ids) || !labels.size) return [];
  return ids.map((id) => labels.get(Number(id))).filter(Boolean);
}

export function resolveMediaRoot(localPath, mediaRoots = []) {
  if (!localPath) return null;
  const resolved = path.resolve(localPath);
  let match = null;
  for (const mediaRoot of mediaRoots) {
    const root = path.resolve(mediaRoot);
    const relative = path.relative(root, resolved);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (!match || root.length > match.length) match = root;
  }
  return match;
}

export const DEFAULT_ARR_TIMEOUT_MS = 30000;

export async function arrRequest(connection, endpoint, init = {}) {
  const { timeoutMs = DEFAULT_ARR_TIMEOUT_MS, ...requestInit } = init;
  const response = await fetch(`${connection.url}/api/v3/${endpoint.replace(/^\//, '')}`, {
    ...requestInit,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': connection.apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    const error = new Error(`${connection.kind} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    error.statusCode = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Resolves the limit for one file. Precedence, most specific first:
 *   1. a matching size rule, which is an explicit instruction from the user
 *   2. the application's quality definition, when that option is enabled
 *   3. the connection's own configured MB/min
 * A file that matches no rule therefore behaves exactly as it did before rules existed.
 */
function resolveLimit(connection, mediaFile, definitions, context) {
  const rule = matchSizeRule(connection.sizeRules ?? [], context);
  if (rule) {
    return {
      maxMbPerMinute: rule.maxMbPerMinute,
      toleranceGib: rule.toleranceGib,
      limitSource: 'size-rule',
      ruleLabel: rule.label,
    };
  }
  const { maxMbPerMinute, limitSource } = qualityMaximum(connection, mediaFile, definitions);
  return { maxMbPerMinute, toleranceGib: connection.toleranceGib, limitSource, ruleLabel: null };
}

function qualityMaximum(connection, mediaFile, definitions) {
  if (!connection.useArrQualityDefinitions) {
    return { maxMbPerMinute: connection.maxMbPerMinute, limitSource: 'keelhaularr' };
  }
  const qualityId = Number(mediaFile?.quality?.quality?.id ?? mediaFile?.quality?.id);
  const definition = definitions.find((item) => Number(item?.quality?.id) === qualityId);
  const maximum = Number(definition?.maxSize);
  if (Number.isFinite(maximum) && maximum > 0) {
    return { maxMbPerMinute: maximum, limitSource: 'arr-quality-definition' };
  }
  return { maxMbPerMinute: connection.maxMbPerMinute, limitSource: 'keelhaularr-fallback' };
}

async function mapLimit(values, limit, work) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await work(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function baseResult(app, configured) {
  return {
    // `app` is the instance id and is what every candidate, exclusion key and job
    // record is keyed on. `kind` is retained as an alias so existing consumers and
    // stored records keep working.
    app,
    kind: app,
    status: configured ? 'connecting' : 'not-configured',
    version: null,
    candidates: [],
    overageObservations: [],
    knownPaths: new Set(),
    warnings: [],
    error: null,
  };
}

export async function scanRadarr(connection) {
  const result = baseResult(connection.id ?? 'radarr', connection.configured);
  if (!connection.configured) return result;

  try {
    const [movies, status, definitions, tags] = await Promise.all([
      arrRequest(connection, 'movie'),
      arrRequest(connection, 'system/status'),
      connection.useArrQualityDefinitions
        ? arrRequest(connection, 'qualitydefinition').catch((error) => {
          result.warnings.push(`Radarr quality definitions could not be read; using the Keelhaularr fallback limit: ${error.message}`);
          return [];
        })
        : Promise.resolve([]),
      // Tag labels are only needed when a rule matches on one.
      (connection.sizeRules ?? []).some((rule) => rule.tag)
        ? arrRequest(connection, 'tag').catch((error) => {
          result.warnings.push(`Radarr tags could not be read, so tag-based size rules were skipped: ${error.message}`);
          return [];
        })
        : Promise.resolve([]),
    ]);
    result.status = 'connected';
    result.version = status?.version ?? null;
    const tagLabels = tagLabelMap(tags);

    for (const movie of movies) {
      const mediaFile = movie.movieFile;
      if (!movie.hasFile || !mediaFile) continue;
      const arrPath = mediaFile.path || joinArrPath(movie.path, mediaFile.relativePath);
      const localPath = mapArrPath(arrPath, connection.pathMaps);
      if (localPath) result.knownPaths.add(localPath);

      if (!connection.includeUnmonitored && !movie.monitored) continue;
      const runtimeMinutes = Number(movie.runtime) || 110;
      const mediaRoot = resolveMediaRoot(localPath, connection.mediaRoots);
      const { maxMbPerMinute, toleranceGib, limitSource, ruleLabel } = resolveLimit(
        connection, mediaFile, definitions,
        { tags: resolveTagNames(movie.tags, tagLabels), root: mediaRoot, quality: qualityName(mediaFile) },
      );
      const configuredLimitBytes = Math.round(maxMbPerMinute * MIB) * runtimeMinutes;
      const toleranceBytes = Math.round(toleranceGib * GIB);
      const limitBytes = configuredLimitBytes + toleranceBytes;
      const sizeBytes = safeSizeBytes(mediaFile.size);
      if (sizeBytes === null) continue;
      const exclusionKeys = [`${result.app}:movie:${movie.id}`];
      const overageBytes = recordOverageObservation(
        result, result.app, exclusionKeys, sizeBytes, limitBytes,
      );
      if (overageBytes === 0) continue;

      result.candidates.push({
        id: stableId(result.app, mediaFile.id, arrPath),
        app: result.app,
        fileId: Number(mediaFile.id),
        searchIds: [Number(movie.id)],
        exclusionKeys,
        title: movie.title ?? 'Unknown movie',
        subtitle: [movie.year, qualityName(mediaFile)].filter(Boolean).join(' · '),
        path: arrPath,
        localPath,
        root: mediaRoot,
        sizeBytes,
        configuredLimitBytes,
        toleranceBytes,
        limitBytes,
        overageBytes,
        runtimeMinutes,
        maxMbPerMinute,
        limitSource,
        ruleLabel,
      });
    }
  } catch (error) {
    result.status = 'error';
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function episodeCode(episodes) {
  if (!episodes.length) return 'Unknown episode';
  return episodes
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber)
    .map((episode) => `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`)
    .join('-');
}

export async function scanSonarr(connection) {
  const result = baseResult(connection.id ?? 'sonarr', connection.configured);
  if (!connection.configured) return result;

  try {
    const [seriesList, status, definitions, tags] = await Promise.all([
      arrRequest(connection, 'series'),
      arrRequest(connection, 'system/status'),
      connection.useArrQualityDefinitions
        ? arrRequest(connection, 'qualitydefinition').catch((error) => {
          result.warnings.push(`Sonarr quality definitions could not be read; using the Keelhaularr fallback limit: ${error.message}`);
          return [];
        })
        : Promise.resolve([]),
      (connection.sizeRules ?? []).some((rule) => rule.tag)
        ? arrRequest(connection, 'tag').catch((error) => {
          result.warnings.push(`Sonarr tags could not be read, so tag-based size rules were skipped: ${error.message}`);
          return [];
        })
        : Promise.resolve([]),
    ]);
    result.status = 'connected';
    result.version = status?.version ?? null;
    const tagLabels = tagLabelMap(tags);
    let unknownRuntimeFiles = 0;

    const perSeries = await mapLimit(seriesList, 6, async (series) => {
      const [files, episodes] = await Promise.all([
        arrRequest(connection, `episodefile?seriesId=${series.id}`),
        arrRequest(connection, `episode?seriesId=${series.id}`),
      ]);
      return { series, files, episodes };
    });

    for (const { series, files, episodes } of perSeries) {
      const episodesByFile = new Map();
      for (const episode of episodes) {
        const fileId = Number(episode.episodeFileId) || 0;
        if (!fileId) continue;
        if (!episodesByFile.has(fileId)) episodesByFile.set(fileId, []);
        episodesByFile.get(fileId).push(episode);
      }

      for (const mediaFile of files) {
        const arrPath = mediaFile.path || joinArrPath(series.path, mediaFile.relativePath);
        const localPath = mapArrPath(arrPath, connection.pathMaps);
        if (localPath) result.knownPaths.add(localPath);

        const fileEpisodes = episodesByFile.get(Number(mediaFile.id)) ?? [];
        if (!fileEpisodes.length || fileEpisodes.some((episode) => Number(episode.seasonNumber) === 0)) {
          continue;
        }
        if (!connection.includeUnmonitored && (
          !series.monitored || fileEpisodes.some((episode) => !episode.monitored)
        )) continue;

        const fallbackRuntime = Number(series.runtime) || 0;
        const runtimes = fileEpisodes.map((episode) => Number(episode.runtime) || fallbackRuntime);
        if (runtimes.some((runtime) => runtime <= 0)) {
          unknownRuntimeFiles += 1;
          continue;
        }
        const runtimeMinutes = runtimes.reduce((sum, runtime) => sum + runtime, 0);
        const mediaRoot = resolveMediaRoot(localPath, connection.mediaRoots);
        const { maxMbPerMinute, toleranceGib, limitSource, ruleLabel } = resolveLimit(
          connection, mediaFile, definitions,
          { tags: resolveTagNames(series.tags, tagLabels), root: mediaRoot, quality: qualityName(mediaFile) },
        );
        const configuredLimitBytes = Math.round(maxMbPerMinute * MIB) * runtimeMinutes;
        const toleranceBytes = Math.round(toleranceGib * GIB);
        const limitBytes = configuredLimitBytes + toleranceBytes;
        const sizeBytes = safeSizeBytes(mediaFile.size);
        if (sizeBytes === null) continue;
        const exclusionKeys = fileEpisodes.map((episode) => `${result.app}:episode:${episode.id}`);
        const overageBytes = recordOverageObservation(
          result, result.app, exclusionKeys, sizeBytes, limitBytes,
        );
        if (overageBytes === 0) continue;

        const code = episodeCode(fileEpisodes);
        const firstTitle = fileEpisodes.length === 1 ? fileEpisodes[0].title : `${fileEpisodes.length} episodes`;
        result.candidates.push({
          id: stableId(result.app, mediaFile.id, arrPath),
          app: result.app,
          fileId: Number(mediaFile.id),
          searchIds: fileEpisodes.map((episode) => Number(episode.id)),
          exclusionKeys,
          title: `${series.title ?? 'Unknown series'} · ${code}`,
          subtitle: [firstTitle, qualityName(mediaFile)].filter(Boolean).join(' · '),
          path: arrPath,
          localPath,
          root: mediaRoot,
          sizeBytes,
          configuredLimitBytes,
          toleranceBytes,
          limitBytes,
          overageBytes,
          runtimeMinutes,
          maxMbPerMinute,
          limitSource,
          ruleLabel,
        });
      }
    }
    if (unknownRuntimeFiles) {
      result.warnings.push(`${unknownRuntimeFiles} Sonarr file(s) were skipped because runtime was unknown.`);
    }
  } catch (error) {
    result.status = 'error';
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/**
 * Scans every configured instance and returns the results keyed by instance id. The
 * historical `radarr` and `sonarr` keys are always present, because the first instance
 * of each kind keeps those exact ids.
 */
export async function scanArr(config) {
  const instances = arrInstances(config);
  const results = await Promise.all(instances.map((instance) => (
    instance.kind === 'sonarr' ? scanSonarr(instance) : scanRadarr(instance)
  )));
  const byId = Object.fromEntries(results.map((result) => [result.app, result]));
  return {
    radarr: byId.radarr ?? baseResult('radarr', false),
    sonarr: byId.sonarr ?? baseResult('sonarr', false),
    ...byId,
  };
}

// Every scan result, in instance order, without the aliases appearing twice.
export function arrScanResults(scan) {
  const seen = new Set();
  return Object.values(scan ?? {}).filter((result) => {
    if (!result || typeof result !== 'object' || !result.app || seen.has(result.app)) return false;
    seen.add(result.app);
    return true;
  });
}

/**
 * The instance list, falling back to the historical pair so a hand-built config - in a
 * test, or any caller that predates the registry - still resolves correctly.
 */
export function arrInstances(config) {
  if (Array.isArray(config?.instances) && config.instances.length) return config.instances;
  return [config?.radarr, config?.sonarr]
    .filter(Boolean)
    .map((connection, index) => ({ ...connection, id: connection.id ?? (index === 0 ? 'radarr' : 'sonarr') }));
}

// Durable jobs record the URL of every instance so a connection change can be detected
// on resume. Keyed by instance id, which keeps jobs written before multi-instance
// existed readable: they simply carry fewer keys.
export function arrInstanceUrls(config) {
  return Object.fromEntries(arrInstances(config).map((instance) => [instance.id, instance.url]));
}

export function allArrCandidates(scan) {
  return arrScanResults(scan).flatMap((result) => result.candidates);
}

export async function deleteCandidate(connection, candidate) {
  const endpoint = candidate.app === 'radarr' ? 'moviefile' : 'episodefile';
  await arrRequest(connection, `${endpoint}/${candidate.fileId}`, { method: 'DELETE' });
}

export async function queueSearch(connection, kind, ids) {
  if (!ids.length) return null;
  const body = kind === 'radarr'
    ? { name: 'MoviesSearch', movieIds: ids }
    : { name: 'EpisodeSearch', episodeIds: ids };
  return arrRequest(connection, 'command', { method: 'POST', body: JSON.stringify(body) });
}

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function recordsFrom(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.records) ? value.records : [];
}

function reconciliationTimestamp(value, label) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`The Arr ${label} reconciliation timestamp is invalid.`);
  }
  return milliseconds;
}

export async function listArrHistoryByDownloadId(connection, downloadId) {
  const records = [];
  const pageSize = 100;
  const maximumPages = 100;
  let expectedTotalRecords = null;
  for (let page = 1; page <= maximumPages; page += 1) {
    const query = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      sortKey: 'date',
      sortDirection: 'descending',
      downloadId,
    });
    const response = await arrRequest(connection, `history?${query}`);
    const responsePage = response?.page;
    const responsePageSize = response?.pageSize;
    const totalRecords = response?.totalRecords;
    const pageRecords = response?.records;
    if (!Number.isSafeInteger(responsePage) || responsePage !== page
      || !Number.isSafeInteger(responsePageSize) || responsePageSize !== pageSize
      || !Number.isSafeInteger(totalRecords) || totalRecords < 0
      || !Array.isArray(pageRecords) || pageRecords.length > pageSize) {
      throw new Error('Arr returned an invalid history pagination contract.');
    }
    if (expectedTotalRecords === null) expectedTotalRecords = totalRecords;
    if (totalRecords !== expectedTotalRecords || records.length + pageRecords.length > totalRecords) {
      throw new Error('Arr history pagination changed or became inconsistent while it was being read.');
    }
    if (pageRecords.some((record) => normalizedHash(record?.downloadId) !== normalizedHash(downloadId))) {
      throw new Error('Arr history pagination returned a record for a different download id.');
    }
    records.push(...pageRecords);
    if (records.length >= totalRecords) return records;
    if (!pageRecords.length || pageRecords.length < pageSize) {
      throw new Error('Arr history pagination ended before all records were returned.');
    }
  }
  throw new Error('Arr history pagination exceeded the safety cap before all records were returned.');
}

async function arrRecoveryInventory(connection) {
  if (!connection?.configured) return { queue: [], downloadClients: [] };
  const [queueResponse, clientsResponse] = await Promise.all([
    arrRequest(connection, 'queue/details'),
    arrRequest(connection, 'downloadclient'),
  ]);
  return {
    queue: recordsFrom(queueResponse),
    downloadClients: recordsFrom(clientsResponse),
  };
}

function proveQbittorrentClient(record, downloadClients) {
  const matches = downloadClients.filter((client) => client?.enable === true
    && client.name === record.downloadClient
    && String(client.implementation ?? '').toLowerCase() === 'qbittorrent'
    && String(client.protocol ?? '').toLowerCase() === 'torrent');
  return matches.length === 1 ? matches[0] : null;
}

export async function resolveQbittorrentRecoveryOwnership(config, torrent) {
  const hash = normalizedHash(torrent?.hash);
  if (!hash) throw new Error('The qBittorrent torrent hash is missing or malformed.');

  const configuredApps = arrInstances(config).filter((instance) => instance.configured).map((instance) => instance.id);
  if (!configuredApps.length) throw new Error('Neither Radarr nor Sonarr is configured.');
  const inventories = await Promise.all(configuredApps.map(async (app) => ({
    app,
    connection: config[app],
    ...(await arrRecoveryInventory(config[app])),
  })));

  const matches = inventories.flatMap((inventory) => inventory.queue
    .filter((record) => String(record?.protocol ?? '').toLowerCase() === 'torrent'
      && normalizedHash(record?.downloadId) === hash)
    .map((record) => ({ ...inventory, record })));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one Radarr/Sonarr queue match for torrent ${torrent.hash}; found ${matches.length}.`);
  }

  const match = matches[0];
  const queueId = positiveInteger(match.record.id);
  if (!queueId) throw new Error('The matching Arr queue record has an invalid id.');
  const downloadClient = proveQbittorrentClient(match.record, match.downloadClients);
  if (!downloadClient) {
    throw new Error('The matching Arr queue record does not resolve to exactly one enabled qBittorrent download client.');
  }

  const history = (await listArrHistoryByDownloadId(match.connection, match.record.downloadId))
    .filter((record) => String(record?.eventType ?? '').toLowerCase() === 'grabbed');
  if (!history.length) throw new Error('Arr has no grabbed history for the matching torrent, so it cannot be blocklisted safely.');

  let searchIds;
  let seriesId = null;
  if (match.app === 'radarr') {
    const historyMovieIds = history.map((record) => positiveInteger(record.movieId));
    if (historyMovieIds.some((movieId) => movieId === null)) {
      throw new Error('Radarr grabbed history contains a missing or malformed movie id.');
    }
    const movieIds = [...new Set(historyMovieIds)];
    const queueMovieId = positiveInteger(match.record.movieId);
    if (movieIds.length !== 1 || !queueMovieId || movieIds[0] !== queueMovieId) {
      throw new Error('Radarr grabbed history does not identify exactly one movie matching the queue record.');
    }
    searchIds = movieIds;
  } else {
    const historySeriesIds = history.map((record) => positiveInteger(record.seriesId));
    const historyEpisodeIds = history.map((record) => positiveInteger(record.episodeId));
    if (historySeriesIds.some((value) => value === null) || historyEpisodeIds.some((value) => value === null)) {
      throw new Error('Sonarr grabbed history contains a missing or malformed series or episode id.');
    }
    const seriesIds = [...new Set(historySeriesIds)];
    const episodeIds = [...new Set(historyEpisodeIds)]
      .sort((left, right) => left - right);
    const queueSeriesId = positiveInteger(match.record.seriesId);
    const queueEpisodeId = positiveInteger(match.record.episodeId);
    if (seriesIds.length !== 1 || !queueSeriesId || seriesIds[0] !== queueSeriesId || !episodeIds.length
      || (queueEpisodeId && !episodeIds.includes(queueEpisodeId))) {
      throw new Error('Sonarr grabbed history does not identify episodes from exactly one series matching the queue record.');
    }
    seriesId = seriesIds[0];
    searchIds = episodeIds;
  }

  return {
    id: `qbittorrent:${hash}`,
    app: match.app,
    hash,
    downloadId: match.record.downloadId,
    queueId,
    downloadClientName: match.record.downloadClient,
    downloadClientId: positiveInteger(downloadClient.id),
    searchIds,
    seriesId,
    historyIds: history.map((record) => positiveInteger(record.id)).filter(Boolean),
    title: torrent.name,
    subtitle: match.app === 'radarr' ? 'Radarr download' : 'Sonarr download',
    category: torrent.category,
    state: torrent.state,
    downloadSpeedBytesPerSecond: torrent.dlspeed,
  };
}

export async function removeQbittorrentRecoveryFromArr(connection, queueId) {
  const query = new URLSearchParams({
    removeFromClient: 'true',
    blocklist: 'true',
    skipRedownload: 'true',
    changeCategory: 'false',
  });
  return arrRequest(connection, `queue/${queueId}?${query}`, { method: 'DELETE' });
}

export async function hasArrDownloadFailedSince(connection, downloadId, since) {
  const sinceMs = reconciliationTimestamp(since, 'deletion');
  const history = await listArrHistoryByDownloadId(connection, downloadId);
  return history.some((record) => String(record?.eventType ?? '').toLowerCase() === 'downloadfailed'
    && Number.isFinite(Date.parse(record.date))
    && Date.parse(record.date) >= sinceMs);
}

export async function findMatchingSearchCommand(connection, kind, ids, since) {
  const expectedName = kind === 'radarr' ? 'moviessearch' : 'episodesearch';
  const bodyKey = kind === 'radarr' ? 'movieIds' : 'episodeIds';
  const expectedIds = [...new Set(ids.map(Number))].sort((left, right) => left - right);
  const sinceMs = reconciliationTimestamp(since, 'search');
  const commands = recordsFrom(await arrRequest(connection, 'command'));
  return commands.find((command) => {
    const commandIds = [...new Set((command?.body?.[bodyKey] ?? []).map(Number))].sort((left, right) => left - right);
    const queuedMs = Date.parse(command?.queued ?? command?.started ?? '');
    return String(command?.name ?? command?.commandName ?? '').toLowerCase() === expectedName
      && commandIds.length === expectedIds.length
      && commandIds.every((id, index) => id === expectedIds[index])
      && Number.isFinite(queuedMs)
      && queuedMs >= sinceMs;
  }) ?? null;
}

export async function replacementProgress(connection, candidate, commandId) {
  let command;
  try {
    command = await arrRequest(connection, `command/${commandId}`);
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  const commandStatus = String(command?.status ?? '').toLowerCase();
  if (['failed', 'aborted', 'cancelled'].includes(commandStatus)) {
    return { status: 'search_failed', detail: command?.message ?? command?.errorMessage ?? 'Search command failed.' };
  }
  if (command && !['completed', 'complete'].includes(commandStatus)) {
    return { status: 'searching', detail: commandStatus || 'queued' };
  }

  const queue = await arrRequest(connection, 'queue/details?all=true').catch(() => []);
  const records = Array.isArray(queue) ? queue : (queue?.records ?? []);
  const searchIds = new Set(candidate.searchIds.map(Number));
  const queued = records.some((record) => candidate.app === 'radarr'
    ? searchIds.has(Number(record.movieId))
    : searchIds.has(Number(record.episodeId)) || (record.episodeIds ?? []).some((id) => searchIds.has(Number(id))));
  if (queued) return { status: 'download_queued', detail: 'A replacement is in the download queue.' };

  if (candidate.app === 'radarr') {
    const movie = await arrRequest(connection, `movie/${candidate.searchIds[0]}`).catch(() => null);
    if (movie?.hasFile) return { status: 'downloaded', detail: 'A replacement file is present.' };
  } else {
    const episodes = await Promise.all(candidate.searchIds.map((id) => arrRequest(connection, `episode/${id}`).catch(() => null)));
    if (episodes.length && episodes.every((episode) => episode?.hasFile)) {
      return { status: 'downloaded', detail: 'Replacement episode file(s) are present.' };
    }
  }
  return command
    ? { status: 'no_result', detail: 'Search completed with no replacement currently queued.' }
    : { status: 'unknown', detail: 'No replacement is present and the search command is no longer in history.' };
}

export async function applyOversized(config, requestedIds) {
  const current = await scanArr(config);
  const candidates = allArrCandidates(current);
  const requested = new Set(requestedIds);
  const selected = candidates.filter((candidate) => requested.has(candidate.id));
  const results = [];
  const searchIds = new Map();

  for (const candidate of selected) {
    const connection = config[candidate.app];
    try {
      await deleteCandidate(connection, candidate);
      if (!searchIds.has(candidate.app)) searchIds.set(candidate.app, new Set());
      const pending = searchIds.get(candidate.app);
      candidate.searchIds.forEach((id) => pending.add(id));
      results.push({ id: candidate.id, title: candidate.title, app: candidate.app, status: 'deleted' });
    } catch (error) {
      results.push({
        id: candidate.id,
        title: candidate.title,
        app: candidate.app,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const searchCommands = [];
  for (const [app, pending] of searchIds) {
    const ids = [...pending];
    if (!ids.length) continue;
    try {
      const command = await queueSearch(config[app], config[app]?.kind ?? app, ids);
      searchCommands.push({ app, status: 'queued', commandId: command?.id ?? null, count: ids.length });
    } catch (error) {
      searchCommands.push({
        app: kind,
        status: 'failed',
        count: ids.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    requested: requested.size,
    matched: selected.length,
    results,
    searchCommands,
  };
}
