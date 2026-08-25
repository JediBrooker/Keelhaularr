import { createHash } from 'node:crypto';
import path from 'node:path';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

function stableId(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

function qualityName(mediaFile) {
  return mediaFile?.quality?.quality?.name ?? mediaFile?.quality?.name ?? 'Unknown quality';
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

async function arrRequest(connection, endpoint, init = {}) {
  const response = await fetch(`${connection.url}/api/v3/${endpoint.replace(/^\//, '')}`, {
    ...init,
    signal: AbortSignal.timeout(30000),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': connection.apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`${connection.kind} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
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

function baseResult(kind, configured) {
  return {
    kind,
    status: configured ? 'connecting' : 'not-configured',
    version: null,
    candidates: [],
    knownPaths: new Set(),
    warnings: [],
    error: null,
  };
}

export async function scanRadarr(connection) {
  const result = baseResult('radarr', connection.configured);
  if (!connection.configured) return result;

  try {
    const [movies, status] = await Promise.all([
      arrRequest(connection, 'movie'),
      arrRequest(connection, 'system/status'),
    ]);
    result.status = 'connected';
    result.version = status?.version ?? null;

    for (const movie of movies) {
      const mediaFile = movie.movieFile;
      if (!movie.hasFile || !mediaFile) continue;
      const arrPath = mediaFile.path || joinArrPath(movie.path, mediaFile.relativePath);
      const localPath = mapArrPath(arrPath, connection.pathMaps);
      if (localPath) result.knownPaths.add(localPath);

      if (!connection.includeUnmonitored && !movie.monitored) continue;
      const runtimeMinutes = Number(movie.runtime) || 110;
      const configuredLimitBytes = Math.round(connection.maxMbPerMinute * MIB) * runtimeMinutes;
      const toleranceBytes = Math.round(connection.toleranceGib * GIB);
      const limitBytes = configuredLimitBytes + toleranceBytes;
      const sizeBytes = Number(mediaFile.size) || 0;
      if (sizeBytes <= limitBytes) continue;

      result.candidates.push({
        id: stableId('radarr', mediaFile.id, arrPath),
        app: 'radarr',
        fileId: Number(mediaFile.id),
        searchIds: [Number(movie.id)],
        title: movie.title ?? 'Unknown movie',
        subtitle: [movie.year, qualityName(mediaFile)].filter(Boolean).join(' · '),
        path: arrPath,
        sizeBytes,
        configuredLimitBytes,
        toleranceBytes,
        limitBytes,
        overageBytes: sizeBytes - limitBytes,
        runtimeMinutes,
        maxMbPerMinute: connection.maxMbPerMinute,
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
  const result = baseResult('sonarr', connection.configured);
  if (!connection.configured) return result;

  try {
    const [seriesList, status] = await Promise.all([
      arrRequest(connection, 'series'),
      arrRequest(connection, 'system/status'),
    ]);
    result.status = 'connected';
    result.version = status?.version ?? null;
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
        const configuredLimitBytes = Math.round(connection.maxMbPerMinute * MIB) * runtimeMinutes;
        const toleranceBytes = Math.round(connection.toleranceGib * GIB);
        const limitBytes = configuredLimitBytes + toleranceBytes;
        const sizeBytes = Number(mediaFile.size) || 0;
        if (sizeBytes <= limitBytes) continue;

        const code = episodeCode(fileEpisodes);
        const firstTitle = fileEpisodes.length === 1 ? fileEpisodes[0].title : `${fileEpisodes.length} episodes`;
        result.candidates.push({
          id: stableId('sonarr', mediaFile.id, arrPath),
          app: 'sonarr',
          fileId: Number(mediaFile.id),
          searchIds: fileEpisodes.map((episode) => Number(episode.id)),
          title: `${series.title ?? 'Unknown series'} · ${code}`,
          subtitle: [firstTitle, qualityName(mediaFile)].filter(Boolean).join(' · '),
          path: arrPath,
          sizeBytes,
          configuredLimitBytes,
          toleranceBytes,
          limitBytes,
          overageBytes: sizeBytes - limitBytes,
          runtimeMinutes,
          maxMbPerMinute: connection.maxMbPerMinute,
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

export async function scanArr(config) {
  const [radarr, sonarr] = await Promise.all([
    scanRadarr(config.radarr),
    scanSonarr(config.sonarr),
  ]);
  return { radarr, sonarr };
}

async function deleteOne(connection, candidate) {
  const endpoint = candidate.app === 'radarr' ? 'moviefile' : 'episodefile';
  await arrRequest(connection, `${endpoint}/${candidate.fileId}`, { method: 'DELETE' });
}

async function queueSearch(connection, kind, ids) {
  if (!ids.length) return null;
  const body = kind === 'radarr'
    ? { name: 'MoviesSearch', movieIds: ids }
    : { name: 'EpisodeSearch', episodeIds: ids };
  return arrRequest(connection, 'command', { method: 'POST', body: JSON.stringify(body) });
}

export async function applyOversized(config, requestedIds) {
  const current = await scanArr(config);
  const candidates = [...current.radarr.candidates, ...current.sonarr.candidates];
  const requested = new Set(requestedIds);
  const selected = candidates.filter((candidate) => requested.has(candidate.id));
  const results = [];
  const searchIds = { radarr: new Set(), sonarr: new Set() };

  for (const candidate of selected) {
    const connection = config[candidate.app];
    try {
      await deleteOne(connection, candidate);
      candidate.searchIds.forEach((id) => searchIds[candidate.app].add(id));
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
  for (const kind of ['radarr', 'sonarr']) {
    const ids = [...searchIds[kind]];
    if (!ids.length) continue;
    try {
      const command = await queueSearch(config[kind], kind, ids);
      searchCommands.push({ app: kind, status: 'queued', commandId: command?.id ?? null, count: ids.length });
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
