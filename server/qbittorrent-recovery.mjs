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

function observationThresholdMs(reason, recovery) {
  const minutes = finiteNumber(reason === 'slow' ? recovery.slowMinutes : recovery.stalledMinutes);
  return minutes === null ? null : minutes * 60_000;
}

export function classifyQbittorrentRecoveryTorrent(torrent, recovery) {
  const excludedCategories = Array.isArray(recovery?.excludedCategories) ? recovery.excludedCategories : [];
  if (typeof torrent?.category === 'string' && excludedCategories.includes(torrent.category)) return null;
  if (torrent?.recoveryFieldsValid !== true) return null;
  if (!normalizedHash(torrent.hash) || typeof torrent.name !== 'string' || typeof torrent.category !== 'string') return null;
  if (!(torrent.amount_left > 0 || torrent.progress < 1)) return null;

  let reason = null;
  if (torrent.state === 'stalledDL') {
    reason = 'stalled';
  } else if (torrent.state === 'downloading') {
    const slowSpeedKibPerSecond = finiteNumber(recovery?.slowSpeedKibPerSecond);
    if (slowSpeedKibPerSecond !== null && torrent.dlspeed < slowSpeedKibPerSecond * 1024) reason = 'slow';
  }
  if (!reason || observationThresholdMs(reason, recovery) === null) return null;
  return { hash: normalizedHash(torrent.hash), reason, category: torrent.category };
}

function publicStatus(config) {
  const document = store.read();
  const observations = Object.values(document.observations ?? {});
  return {
    enabled: recoveryConfig(config).enabled === true && config?.qbittorrent?.configured === true,
    running: schedulerRunning,
    tickRunning: Boolean(activeTick),
    nextPollAt,
    lastPollAt: document.lastPollAt,
    lastSuccessfulPollAt: document.lastSuccessfulPollAt,
    lastError: document.lastError,
    observedCount: observations.length,
    queuedCount: observations.filter((observation) => observation.queuedAt).length,
  };
}

export function qbittorrentRecoveryStatus(config = {}) {
  return publicStatus(config);
}

async function recordOutage(config, nowIso, error) {
  await store.update((document) => {
    document.policyIdentity = qbittorrentRecoveryPolicyIdentity(config);
    document.lastPollAt = nowIso;
    document.lastError = error instanceof Error ? error.message : String(error);
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
    return publicStatus(config);
  }

  const listTorrents = options.listTorrents ?? listQbittorrentTorrents;
  let torrents;
  try {
    torrents = await listTorrents(config.qbittorrent);
    if (!Array.isArray(torrents)) throw new Error('qBittorrent returned an invalid torrent inventory.');
  } catch (error) {
    await recordOutage(config, nowIso, error);
    return publicStatus(config);
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
        if (document.observations?.[observation.hash]) document.observations[observation.hash].ownershipError = null;
      });
    } catch (error) {
      await store.update((document) => {
        if (document.observations?.[observation.hash]) {
          document.observations[observation.hash].ownershipError = error instanceof Error ? error.message : String(error);
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
  return publicStatus(config);
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
