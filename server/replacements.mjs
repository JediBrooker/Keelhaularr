import { arrRequest } from './arr.mjs';

// Interactive search asks the configured indexers in real time, so it is far slower
// than the ordinary library endpoints and needs its own budget.
export const REPLACEMENT_SEARCH_TIMEOUT_MS = 90000;

const MAX_RELEASES_INSPECTED = 400;
const MAX_CANDIDATES_RETURNED = 5;
const MAX_TEXT_LENGTH = 300;

// 'available' is the only status that may ever permit a delete. Everything else -
// including 'error' and 'unsupported' - has to withhold the file.
export const REPLACEMENT_AVAILABLE = 'available';

function safeText(value, maximumLength = MAX_TEXT_LENGTH) {
  if (typeof value !== 'string') return null;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '\ufffd').trim();
  return sanitized ? sanitized.slice(0, maximumLength) : null;
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function releaseSizeBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || !Number.isSafeInteger(size) || size <= 0) return null;
  return size;
}

function releaseQualityName(raw) {
  return safeText(raw?.quality?.quality?.name, 64);
}

// Arr marks a release `rejected` when it fails the profile, custom formats or other
// checks, which means an automatic search would not grab it either. Treating those as
// unusable keeps the gate conservative: we only ever claim a replacement exists when
// Arr would actually accept it.
export function normalizeRelease(raw) {
  const sizeBytes = releaseSizeBytes(raw?.size);
  if (sizeBytes === null) return null;
  const guid = safeText(raw?.guid, 512);
  if (!guid) return null;
  return {
    guid,
    title: safeText(raw?.title) ?? 'Unknown release',
    sizeBytes,
    quality: releaseQualityName(raw),
    indexer: safeText(raw?.indexer, 128),
    seeders: safeCount(raw?.seeders),
    protocol: safeText(raw?.protocol, 32),
    rejected: raw?.rejected === true || raw?.temporarilyRejected === true,
    rejections: Array.isArray(raw?.rejections)
      ? raw.rejections.map((reason) => safeText(reason, 200)).filter(Boolean).slice(0, 5)
      : [],
  };
}

// A release only counts as a replacement when it fits the same effective limit that
// flagged the file AND is actually smaller than what is already on disk. Without the
// second test a "replacement" could be the very file being deleted.
export function evaluateReplacements(candidate, releases) {
  const limitBytes = Number(candidate?.limitBytes);
  const currentBytes = Number(candidate?.sizeBytes);
  if (!Number.isFinite(limitBytes) || limitBytes <= 0
    || !Number.isFinite(currentBytes) || currentBytes <= 0) {
    return {
      status: 'unsupported',
      reason: 'This file has no usable size limit, so a replacement cannot be judged.',
      inspected: 0,
      compliantCount: 0,
      candidates: [],
      best: null,
    };
  }

  const normalized = releases
    .slice(0, MAX_RELEASES_INSPECTED)
    .map(normalizeRelease)
    .filter(Boolean);
  const compliant = normalized
    .filter((release) => !release.rejected
      && release.sizeBytes <= limitBytes
      && release.sizeBytes < currentBytes)
    .sort((left, right) => right.sizeBytes - left.sizeBytes);

  return {
    status: compliant.length ? REPLACEMENT_AVAILABLE : 'none',
    reason: compliant.length
      ? null
      : normalized.length
        ? `${normalized.length} release(s) were offered but none fit the ${formatLimit(limitBytes)} limit while also being smaller than the current file.`
        : 'No releases were offered by the configured indexers.',
    inspected: normalized.length,
    compliantCount: compliant.length,
    // Largest compliant release first: it is the highest quality that still fits.
    candidates: compliant.slice(0, MAX_CANDIDATES_RETURNED),
    best: compliant[0] ?? null,
  };
}

function formatLimit(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function releaseEndpoint(candidate) {
  const ids = Array.isArray(candidate?.searchIds) ? candidate.searchIds.filter(Number.isInteger) : [];
  if (!ids.length) return null;
  if (candidate.app === 'radarr') return { endpoint: `release?movieId=${ids[0]}`, multiEpisode: false };
  return { endpoint: `release?episodeId=${ids[0]}`, multiEpisode: ids.length > 1 };
}

// Never throws: a failure is reported as status 'error' so every caller has to decide
// explicitly, and the destructive gate can treat it as "withhold".
export async function findReplacements(connection, candidate) {
  const checkedAt = new Date().toISOString();
  if (!connection?.configured) {
    return {
      status: 'error', reason: `${candidate?.app ?? 'The application'} is not configured.`,
      inspected: 0, compliantCount: 0, candidates: [], best: null, multiEpisode: false, checkedAt,
    };
  }
  const target = releaseEndpoint(candidate);
  if (!target) {
    return {
      status: 'unsupported', reason: 'This file has no search target, so no replacement can be found.',
      inspected: 0, compliantCount: 0, candidates: [], best: null, multiEpisode: false, checkedAt,
    };
  }

  let releases;
  try {
    releases = await arrRequest(connection, target.endpoint, {
      timeoutMs: REPLACEMENT_SEARCH_TIMEOUT_MS,
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      status: 'error',
      reason: safeText(timedOut
        ? 'The interactive search timed out before the indexers answered.'
        : `The interactive search failed: ${error instanceof Error ? error.message : String(error)}`),
      inspected: 0, compliantCount: 0, candidates: [], best: null, multiEpisode: target.multiEpisode, checkedAt,
    };
  }
  if (!Array.isArray(releases)) {
    return {
      status: 'error', reason: 'The application returned an invalid interactive-search response.',
      inspected: 0, compliantCount: 0, candidates: [], best: null, multiEpisode: target.multiEpisode, checkedAt,
    };
  }

  return { ...evaluateReplacements(candidate, releases), multiEpisode: target.multiEpisode, checkedAt };
}

export async function findReplacementsForCandidates(config, candidates, concurrency = 3) {
  const results = new Map();
  const queue = [...candidates];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (;;) {
      const candidate = queue.shift();
      if (!candidate) return;
      results.set(candidate.id, await findReplacements(config[candidate.app], candidate));
    }
  });
  await Promise.all(workers);
  return candidates.map((candidate) => ({ id: candidate.id, ...results.get(candidate.id) }));
}
