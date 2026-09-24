import { createHash } from 'node:crypto';
import { resolveQbittorrentRecoveryOwnership } from './arr.mjs';
import { listQbittorrentTorrents } from './qbittorrent.mjs';
import { createJsonStore } from './state.mjs';

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MAX_POLL_GAP_MS = 150_000;
const MAX_ENQUEUES_PER_TICK = 3;
const store = createJsonStore('qbittorrent-recovery.json', {
  version: 1,
  policyIdentity: null,
  lastPollAt: null,
  lastSuccessfulPollAt: null,
  lastError: null,
  observations: {},
});

let schedulerTimer = null;
let schedulerRunning = false;
let nextPollAt = null;
let activeTick = null;

function recoveryConfig(config) {
  return config?.qbittorrent?.recovery ?? {};
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function policyDocument(config) {
  const recovery = recoveryConfig(config);
  return {
    qbittorrentConfigured: Boolean(config?.qbittorrent?.configured),
    qbittorrentUrl: config?.qbittorrent?.url ?? '',
    qbittorrentUsername: config?.qbittorrent?.username ?? '',
    radarrConfigured: Boolean(config?.radarr?.configured),
    radarrUrl: config?.radarr?.url ?? '',
    sonarrConfigured: Boolean(config?.sonarr?.configured),
    sonarrUrl: config?.sonarr?.url ?? '',
    enabled: recovery.enabled === true,
    slowSpeedKibPerSecond: finiteNumber(recovery.slowSpeedKibPerSecond),
    slowMinutes: finiteNumber(recovery.slowMinutes),
    stalledMinutes: finiteNumber(recovery.stalledMinutes),
    metadataMinutes: finiteNumber(recovery.metadataMinutes ?? 15),
    excludedCategories: Array.isArray(recovery.excludedCategories)
      ? [...new Set(recovery.excludedCategories.filter((category) => typeof category === 'string'))].sort()
      : [],
  };
}

export function qbittorrentRecoveryPolicyIdentity(config) {
  return createHash('sha256').update(JSON.stringify(policyDocument(config))).digest('hex');
}

function timestamp(value = Date.now()) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return Number(value);
}

export function observationThresholdMs(reason, recovery) {
  const minutes = finiteNumber(reason === 'metadata' ? (recovery.metadataMinutes ?? 15)
    : reason === 'slow' ? recovery.slowMinutes : reason === 'stalled' ? recovery.stalledMinutes : undefined);
  return minutes === null ? null : minutes * 60_000;
}

export function classifyQbittorrentRecoveryTorrent(torrent, recovery) {
  const excludedCategories = Array.isArray(recovery?.excludedCategories) ? recovery.excludedCategories : [];
  if (typeof torrent?.category === 'string' && excludedCategories.includes(torrent.category)) return null;
  if (torrent?.recoveryFieldsValid !== true) return null;
  if (!normalizedHash(torrent.hash) || typeof torrent.name !== 'string' || typeof torrent.category !== 'string') return null;
  if (!(torrent.amount_left > 0 || torrent.progress < 1)) return null;

  let reason = null;
  if (['metaDL', 'forcedMetaDL'].includes(torrent.state)) {
    reason = 'metadata';
  } else if (torrent.state === 'stalledDL') {
    reason = 'stalled';
  } else if (torrent.state === 'downloading') {
    const slowSpeedKibPerSecond = finiteNumber(recovery?.slowSpeedKibPerSecond);
    if (slowSpeedKibPerSecond !== null && torrent.dlspeed < slowSpeedKibPerSecond * 1024) reason = 'slow';
  }
  if (!reason || observationThresholdMs(reason, recovery) === null) return null;
  return { hash: normalizedHash(torrent.hash), reason, category: torrent.category };
}

const SKIP_EXPLANATIONS = {
  'not-in-queue': 'Not in Radarr\'s or Sonarr\'s queue, so it was probably added by hand. Only downloads they grabbed are replaced.',
  'several-queue-matches': 'Listed in more than one Radarr/Sonarr queue, so which one owns it is unclear.',
  'not-qbittorrent-client': 'Its queue entry is not tied to exactly one enabled qBittorrent download client in Radarr/Sonarr.',
  'no-grab-history': 'Radarr/Sonarr has no record of grabbing it, so it cannot be blocklisted safely.',
  'no-arr': 'Neither Radarr nor Sonarr is connected.',
};

// Why a torrent past its time limit is being left alone, in words; anything without a
// known reason keeps the underlying message rather than being hidden.
function skipExplanation(code, message) {
  return SKIP_EXPLANATIONS[code] ?? String(message ?? '').slice(0, 500);
}

function publicStatus(config, nowMs = Date.now()) {
  const document = store.read();
  const recovery = recoveryConfig(config);
  const observations = Object.values(document.observations ?? {});
  const pending = observations.filter((observation) => !observation.queuedAt);
  const watching = { metadata: 0, stalled: 0, slow: 0 };
  for (const observation of pending) {
    if (Object.hasOwn(watching, observation.reason)) watching[observation.reason] += 1;
  }
  const overdue = pending.filter((observation) => {
    const threshold = observationThresholdMs(observation.reason, recovery);
    return threshold !== null && nowMs - Date.parse(observation.observedSince) >= threshold;
  });
  const skipped = overdue.filter((observation) => observation.ownershipError);
  const arrConfigured = Boolean(config?.radarr?.configured || config?.sonarr?.configured
    || (Array.isArray(config?.instances) && config.instances.some((instance) => instance?.configured)));
  let blockedBy = null;
  if (recovery.enabled !== true) blockedBy = 'off';
  else if (config?.qbittorrent?.configured !== true) blockedBy = 'qbittorrent';
  else if (!arrConfigured) blockedBy = 'arr';
  return {
    enabled: recovery.enabled === true && config?.qbittorrent?.configured === true,
    blockedBy,
    running: schedulerRunning,
    tickRunning: Boolean(activeTick),
    nextPollAt,
    lastPollAt: document.lastPollAt,
    lastSuccessfulPollAt: document.lastSuccessfulPollAt,
    lastError: document.lastError,
    observedCount: observations.length,
    queuedCount: observations.filter((observation) => observation.queuedAt).length,
    watching,
    overdueCount: overdue.length,
    skippedCount: skipped.length,
    skipped: skipped
      .sort((left, right) => left.observedSince.localeCompare(right.observedSince))
      .slice(0, 20)
      .map((observation) => ({
        name: observation.name,
        category: observation.category,
        reason: observation.reason,
        code: observation.ownershipCode ?? null,
        detail: skipExplanation(observation.ownershipCode, observation.ownershipError),
      })),
    thresholds: {
      metadataMinutes: finiteNumber(recovery.metadataMinutes ?? 15),
      stalledMinutes: finiteNumber(recovery.stalledMinutes),
      slowMinutes: finiteNumber(recovery.slowMinutes),
      slowSpeedKibPerSecond: finiteNumber(recovery.slowSpeedKibPerSecond),
    },
    perPoll: MAX_ENQUEUES_PER_TICK,
  };
}

export function qbittorrentRecoveryStatus(config = {}, { now = Date.now() } = {}) {
  return publicStatus(config, timestamp(now));
}

// Node reports every network failure as "fetch failed"; the reason is in `cause`.
function outageMessage(error) {
  const code = error?.cause?.code ?? error?.code;
  if (error?.message === 'fetch failed' || (typeof code === 'string' && /^E[A-Z]+$/.test(code))) {
    return `qBittorrent could not be reached${typeof code === 'string' ? ` (${code})` : ''}. Check its Web UI address under Connections.`;
  }
  if (error?.name === 'TimeoutError') return 'qBittorrent did not answer in time.';
  return error instanceof Error ? error.message : String(error);
}

async function recordOutage(config, nowIso, error) {
  await store.update((document) => {
    document.policyIdentity = qbittorrentRecoveryPolicyIdentity(config);
    document.lastPollAt = nowIso;
    document.lastError = outageMessage(error);
    document.observations = {};
  });
}

async function runTick(config, enqueue, options) {
  const nowMs = timestamp(options.now ?? Date.now());
  if (!Number.isFinite(nowMs)) throw new Error('The qBittorrent recovery clock is invalid.');
  const nowIso = new Date(nowMs).toISOString();
  const identity = qbittorrentRecoveryPolicyIdentity(config);
  const recovery = recoveryConfig(config);
  const enabled = recovery.enabled === true && config?.qbittorrent?.configured === true;

  if (!enabled) {
    await store.update((document) => {
      document.policyIdentity = identity;
      document.lastPollAt = nowIso;
      document.lastSuccessfulPollAt = null;
      document.lastError = null;
      document.observations = {};
    });
    return publicStatus(config, nowMs);
  }

  const listTorrents = options.listTorrents ?? listQbittorrentTorrents;
  let torrents;
  try {
    torrents = await listTorrents(config.qbittorrent);
    if (!Array.isArray(torrents)) throw new Error('qBittorrent returned an invalid torrent inventory.');
  } catch (error) {
    await recordOutage(config, nowIso, error);
    return publicStatus(config, nowMs);
  }

  const eligible = new Map();
  for (const torrent of torrents) {
    const classification = classifyQbittorrentRecoveryTorrent(torrent, recovery);
    if (!classification || eligible.has(classification.hash)) continue;
    eligible.set(classification.hash, { torrent, ...classification });
  }

  const maxPollGapMs = finiteNumber(options.maxPollGapMs) ?? DEFAULT_MAX_POLL_GAP_MS;
  await store.update((document) => {
    const previousSuccessMs = Date.parse(document.lastSuccessfulPollAt ?? '');
    const continuityBroken = document.policyIdentity !== identity
      || (Number.isFinite(previousSuccessMs) && nowMs - previousSuccessMs > maxPollGapMs);
    if (continuityBroken) document.observations = {};

    const nextObservations = {};
    for (const [hash, value] of eligible) {
      const previous = document.observations?.[hash];
      const sameWindow = previous
        && previous.reason === value.reason
        && previous.category === value.category;
      nextObservations[hash] = {
        hash,
        name: value.torrent.name,
        category: value.category,
        reason: value.reason,
        observedSince: sameWindow ? previous.observedSince : nowIso,
        lastObservedAt: nowIso,
        queuedAt: sameWindow ? previous.queuedAt ?? null : null,
        ownershipError: sameWindow ? previous.ownershipError ?? null : null,
        ownershipCode: sameWindow ? previous.ownershipCode ?? null : null,
      };
    }
    document.policyIdentity = identity;
    document.lastPollAt = nowIso;
    document.lastSuccessfulPollAt = nowIso;
    document.lastError = null;
    document.observations = nextObservations;
  });

  const current = store.read();
  const matured = Object.values(current.observations)
    .filter((observation) => !observation.queuedAt
      && nowMs - Date.parse(observation.observedSince) >= observationThresholdMs(observation.reason, recovery))
    .sort((left, right) => left.observedSince.localeCompare(right.observedSince) || left.hash.localeCompare(right.hash));
  const resolveOwnership = options.resolveOwnership ?? resolveQbittorrentRecoveryOwnership;
  const ready = [];
  for (const observation of matured) {
    if (ready.length >= MAX_ENQUEUES_PER_TICK) break;
    const torrent = eligible.get(observation.hash)?.torrent;
    if (!torrent) continue;
    try {
      const ownership = await resolveOwnership(config, torrent);
      ready.push({
        ...ownership,
        hash: observation.hash,
        title: torrent.name,
        category: torrent.category,
        state: torrent.state,
        reason: observation.reason,
        observedSince: observation.observedSince,
        detectedAt: nowIso,
        policyIdentity: identity,
      });
      await store.update((document) => {
        if (document.observations?.[observation.hash]) {
          document.observations[observation.hash].ownershipError = null;
          document.observations[observation.hash].ownershipCode = null;
        }
      });
    } catch (error) {
      await store.update((document) => {
        if (document.observations?.[observation.hash]) {
          document.observations[observation.hash].ownershipError = error instanceof Error ? error.message : String(error);
          document.observations[observation.hash].ownershipCode = typeof error?.code === 'string' ? error.code : null;
        }
      });
    }
  }

  if (ready.length && typeof enqueue === 'function') {
    try {
      const job = await enqueue(config, ready);
      const acceptedHashes = new Set((job?.items ?? []).map((item) => normalizedHash(item?.candidate?.hash)));
      const acceptedAll = job === true;
      await store.update((document) => {
        for (const candidate of ready) {
          if (!acceptedAll && !acceptedHashes.has(candidate.hash)) continue;
          if (document.observations?.[candidate.hash]) document.observations[candidate.hash].queuedAt = nowIso;
        }
      });
    } catch (error) {
      await store.update((document) => {
        document.lastError = error instanceof Error ? error.message : String(error);
      });
    }
  }
  return publicStatus(config, nowMs);
}

export async function tickQbittorrentRecovery(config, enqueue, options = {}) {
  if (activeTick) return activeTick;
  activeTick = runTick(config, enqueue, options);
  try {
    return await activeTick;
  } finally {
    activeTick = null;
  }
}

export function startQbittorrentRecovery(getConfig, enqueue, options = {}) {
  stopQbittorrentRecovery();
  schedulerRunning = true;
  const intervalMs = finiteNumber(options.pollIntervalMs) || DEFAULT_POLL_INTERVAL_MS;
  const run = () => {
    const config = getConfig();
    nextPollAt = new Date(Date.now() + intervalMs).toISOString();
    return tickQbittorrentRecovery(config, enqueue, { ...options, pollIntervalMs: intervalMs })
      .catch((error) => console.error('qBittorrent recovery tick failed:', error));
  };
  void run();
  schedulerTimer = setInterval(run, intervalMs);
  schedulerTimer.unref?.();
}

export function stopQbittorrentRecovery() {
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerRunning = false;
  nextPollAt = null;
}
