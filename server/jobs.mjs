import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat, unlink } from 'node:fs/promises';
import {
  deleteCandidate,
  findMatchingSearchCommand,
  hasArrDownloadFailedSince,
  queueSearch,
  removeQbittorrentRecoveryFromArr,
  replacementProgress,
  resolveQbittorrentRecoveryOwnership,
  scanArr,
} from './arr.mjs';
import { filterExcluded } from './exclusions.mjs';
import {
  applyOrphanCandidate,
  assertCandidateUnchanged,
  assertQbittorrentSafe,
  quarantineDestination,
  scanOrphans,
} from './orphans.mjs';
import { recordQuarantine } from './quarantine.mjs';
import {
  classifyQbittorrentRecoveryTorrent,
  qbittorrentRecoveryPolicyIdentity,
} from './qbittorrent-recovery.mjs';
import { listQbittorrentTorrents } from './qbittorrent.mjs';
import { createJsonStore } from './state.mjs';

const store = createJsonStore('jobs.json', { version: 1, jobs: [] });
const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
const POST_MUTATION_RECOVERY_PHASES = new Set([
  'delete_requested',
  'arr_removed',
  'removed_confirmed',
  'search_requested',
]);
let configProvider = null;
let workerRunning = false;
let monitorRunning = false;
let workerTimer = null;
let monitorTimer = null;

function inputError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function recoveryItemNeedsPermanentResolution(item) {
  return POST_MUTATION_RECOVERY_PHASES.has(item.phase);
}

function recoveryItemBlocksNewJob(job, item, policyIdentity) {
  if (recoveryItemNeedsPermanentResolution(item)) return true;
  return job.policyIdentity === policyIdentity
    && ACTIVE_STATUSES.has(job.status)
    && !['complete', 'cancelled'].includes(item.status);
}

function trimJobs(document) {
  if (document.jobs.length <= 100) return;
  const retained = document.jobs.filter((job) => ACTIVE_STATUSES.has(job.status)
    || (job.type === 'qbittorrent-recovery' && job.items.some(recoveryItemNeedsPermanentResolution)));
  const retainedIds = new Set(retained.map((job) => job.id));
  const finished = document.jobs.filter((job) => !retainedIds.has(job.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(0, 100 - retained.length));
  document.jobs = [...retained, ...finished];
}

async function updateJob(jobId, mutator) {
  await store.update((document) => {
    const job = document.jobs.find((item) => item.id === jobId);
    if (job) mutator(job);
    trimJobs(document);
  });
  return getJob(jobId);
}

async function updateItem(jobId, itemId, mutator) {
  return updateJob(jobId, (job) => {
    const item = job.items.find((value) => value.id === itemId);
    if (item) mutator(item, job);
    job.updatedAt = new Date().toISOString();
  });
}

export function listJobs() {
  return store.read().jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listJobSummaries() {
  return listJobs().map((job) => ({
    id: job.id,
    type: job.type,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    itemCount: job.items.length,
    settledCount: job.items.filter((item) => ['complete', 'failed', 'cancelled'].includes(item.status)).length,
    failedCount: job.items.filter((item) => item.status === 'failed').length,
  }));
}

export function getJob(id) {
  return store.read().jobs.find((job) => job.id === id) ?? null;
}

export function activeJobSummary() {
  const jobs = listJobs().filter((job) => ACTIVE_STATUSES.has(job.status));
  return { active: jobs.length > 0, jobs: jobs.map((job) => ({ id: job.id, type: job.type, status: job.status, title: job.title })) };
}

async function saveNewJob(job) {
  await store.update((document) => {
    document.jobs.push(job);
    trimJobs(document);
  });
  kickWorker();
  return getJob(job.id);
}

function makeItems(candidates) {
  return candidates.map((candidate) => ({
    id: randomUUID(),
    candidate,
    status: 'waiting',
    phase: 'waiting',
    error: null,
    outcome: null,
    replacement: candidate.searchIds ? { status: 'pending', commandId: null, detail: null, checkedAt: null } : null,
  }));
}

function qbittorrentSafetyIdentity(config) {
  const connection = config.qbittorrent ?? {};
  return JSON.stringify({
    configured: Boolean(connection.configured),
    url: connection.url ?? '',
    username: connection.username ?? '',
    pathMaps: connection.pathMaps ?? [],
  });
}

function recoveryConnectionIdentity(connection, kind) {
  const identity = kind === 'qbittorrent'
    ? {
      kind,
      configured: connection?.configured === true,
      url: connection?.url ?? '',
      username: connection?.username ?? '',
      password: connection?.password ?? '',
    }
    : {
      kind,
      configured: connection?.configured === true,
      url: connection?.url ?? '',
      apiKey: connection?.apiKey ?? '',
      apiKind: connection?.kind ?? kind,
    };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function recoveryConnectionIdentities(config) {
  return {
    qbittorrent: recoveryConnectionIdentity(config?.qbittorrent, 'qbittorrent'),
    radarr: recoveryConnectionIdentity(config?.radarr, 'radarr'),
    sonarr: recoveryConnectionIdentity(config?.sonarr, 'sonarr'),
  };
}

function freshRecoveryMutationConfig(job, candidate) {
  const freshConfig = configProvider?.();
  if (!freshConfig || freshConfig.qbittorrent?.configured !== true
    || freshConfig.qbittorrent?.recovery?.enabled !== true) {
    throw new Error('qBittorrent recovery was disabled during final revalidation. The torrent was preserved.');
  }
  if (qbittorrentRecoveryPolicyIdentity(freshConfig) !== job.policyIdentity) {
    throw new Error('The qBittorrent recovery policy changed during final revalidation. The torrent was preserved.');
  }
  const expectedIdentities = job.connectionIdentities;
  const freshIdentities = recoveryConnectionIdentities(freshConfig);
  if (!expectedIdentities
    || job.connectionUrls?.qbittorrent !== freshConfig.qbittorrent.url
    || expectedIdentities.qbittorrent !== freshIdentities.qbittorrent) {
    throw new Error('The qBittorrent connection changed during final revalidation. The torrent was preserved.');
  }
  if (!freshConfig[candidate.app]?.configured
    || job.connectionUrls?.[candidate.app] !== freshConfig[candidate.app].url
    || expectedIdentities[candidate.app] !== freshIdentities[candidate.app]) {
    throw new Error(`The ${candidate.app} API connection changed during final revalidation. The torrent was preserved.`);
  }
  return freshConfig;
}

export async function createOversizeJob(config, requestedIds) {
  const current = await scanArr(config);
  const requested = new Set(requestedIds);
  const candidates = filterExcluded([...current.radarr.candidates, ...current.sonarr.candidates])
    .filter((candidate) => requested.has(candidate.id));
  if (!candidates.length) inputError('None of the selected files are still oversized.', 409);
  const now = new Date().toISOString();
  return saveNewJob({
    id: randomUUID(),
    type: 'oversized',
    title: `Replace ${candidates.length} oversized file${candidates.length === 1 ? '' : 's'}`,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    connectionUrls: { radarr: config.radarr.url, sonarr: config.sonarr.url },
    items: makeItems(candidates),
  });
}

export async function createOrphanJob(config, requestedIds, action) {
  if (action !== 'quarantine' && action !== 'permanent') {
    inputError('Orphan jobs require either quarantine or permanent action.');
  }
  const arr = await scanArr(config);
  const current = await scanOrphans(config, arr);
  const requested = new Set(requestedIds);
  const candidates = filterExcluded(current.candidates).filter((candidate) => requested.has(candidate.id));
  if (!candidates.length) inputError('None of the selected orphan files are still eligible.', 409);
  const now = new Date().toISOString();
  return saveNewJob({
    id: randomUUID(),
    type: 'orphans',
    title: `${action === 'permanent' ? 'Delete' : 'Quarantine'} ${candidates.length} orphan file${candidates.length === 1 ? '' : 's'}`,
    action,
    trashDir: config.orphanTrashDir,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    connectionUrls: { radarr: config.radarr.url, sonarr: config.sonarr.url },
    qbittorrentSafetyIdentity: qbittorrentSafetyIdentity(config),
    items: makeItems(candidates),
  });
}

function unresolvedRecoveryHashes(jobs, policyIdentity) {
  return new Set(jobs
    .filter((job) => job.type === 'qbittorrent-recovery')
    .flatMap((job) => job.items
      .filter((item) => recoveryItemBlocksNewJob(job, item, policyIdentity))
      .map((item) => String(item.candidate?.hash ?? '').trim().toLowerCase()))
    .filter(Boolean));
}

export async function createQbittorrentRecoveryJob(config, candidates) {
  if (config?.qbittorrent?.recovery?.enabled !== true || config?.qbittorrent?.configured !== true) return null;
  const policyIdentity = qbittorrentRecoveryPolicyIdentity(config);
  let createdJob = null;
  await store.update((document) => {
    const alreadyQueued = unresolvedRecoveryHashes(document.jobs, policyIdentity);
    const seen = new Set();
    const selected = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const hash = String(candidate?.hash ?? '').trim().toLowerCase();
      if (!hash || seen.has(hash) || alreadyQueued.has(hash) || candidate.policyIdentity !== policyIdentity) continue;
      seen.add(hash);
      selected.push({ ...candidate, hash, policyIdentity });
      if (selected.length >= 3) break;
    }
    if (!selected.length) return;

    const now = new Date().toISOString();
    createdJob = {
      id: randomUUID(),
      type: 'qbittorrent-recovery',
      title: `Recover ${selected.length} slow or stalled torrent${selected.length === 1 ? '' : 's'}`,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      cancelRequested: false,
      connectionUrls: {
        qbittorrent: config.qbittorrent?.url,
        radarr: config.radarr?.url,
        sonarr: config.sonarr?.url,
      },
      connectionIdentities: recoveryConnectionIdentities(config),
      policyIdentity,
      items: makeItems(selected),
    };
    document.jobs.push(createdJob);
    trimJobs(document);
  });
  if (!createdJob) return null;
  kickWorker();
  return getJob(createdJob.id);
}

export async function cancelJob(id) {
  const job = getJob(id);
  if (!job) inputError('Job not found.', 404);
  if (!ACTIVE_STATUSES.has(job.status)) inputError('Only an active job can be cancelled.', 409);
  return updateJob(id, (value) => {
    value.cancelRequested = true;
    value.status = 'cancelling';
    value.updatedAt = new Date().toISOString();
  });
}

export async function retryJob(id) {
  const job = getJob(id);
  if (!job) inputError('Job not found.', 404);
  if (ACTIVE_STATUSES.has(job.status)) inputError('The job is already active.', 409);
  if (!job.items.some((item) => item.status === 'failed')) inputError('The job has no failed items to retry.', 409);
  const updated = await updateJob(id, (value) => {
    value.cancelRequested = false;
    value.status = 'queued';
    value.completedAt = null;
    value.items.forEach((item) => {
      if (item.status !== 'failed') return;
      item.status = item.phase === 'deleted' ? 'deleted' : 'waiting';
      item.error = null;
    });
    value.updatedAt = new Date().toISOString();
  });
  kickWorker();
  return updated;
}

async function processOversizeItem(job, item, config) {
  const connection = config[item.candidate.app];
  if (!connection?.configured) throw new Error(`${item.candidate.app} is no longer configured.`);
  if (!['deleted', 'search_queued', 'complete'].includes(item.status)) {
    await updateItem(job.id, item.id, (value) => {
      value.status = 'deleting';
      value.phase = 'deleting';
      value.error = null;
    });
    try {
      await deleteCandidate(connection, item.candidate);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
    }
    await updateItem(job.id, item.id, (value) => {
      value.status = 'deleted';
      value.phase = 'deleted';
      value.outcome = 'File removed through its application.';
    });
  }

  const latest = getJob(job.id)?.items.find((value) => value.id === item.id);
  if (!latest || ['search_queued', 'complete'].includes(latest.status)) return;
  const command = await queueSearch(connection, item.candidate.app, item.candidate.searchIds);
  await updateItem(job.id, item.id, (value) => {
    value.status = 'complete';
    value.phase = 'search_queued';
    value.outcome = 'Replacement search queued.';
    value.replacement = {
      status: 'searching',
      commandId: command?.id ?? null,
      detail: 'Search accepted by the application.',
      checkedAt: new Date().toISOString(),
    };
  });
}

async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathHasSize(filePath, expectedSize) {
  try {
    const value = await stat(filePath);
    return value.isFile() && value.size === expectedSize;
  } catch {
    return false;
  }
}

async function processOrphanItem(job, item, config) {
  const jobConfig = { ...config, orphanAction: job.action, orphanTrashDir: job.trashDir };
  let destination = item.plannedDestination ?? null;
  if (job.action === 'quarantine' && !destination) {
    destination = quarantineDestination(jobConfig, item.candidate, `job-${job.id}-${item.id}`);
    await updateItem(job.id, item.id, (value) => {
      value.plannedDestination = destination;
    });
  }
  await updateItem(job.id, item.id, (value) => {
    value.status = 'processing';
    value.phase = 'processing';
    value.error = null;
  });

  let result;
  const sourceExists = await pathExists(item.candidate.path);
  const destinationExists = Boolean(destination && await pathExists(destination));
  if (!sourceExists && destinationExists && await pathHasSize(destination, item.candidate.sizeBytes)) {
    result = { status: 'quarantined', destination };
  } else if (sourceExists && destinationExists && await pathHasSize(destination, item.candidate.sizeBytes)) {
    await assertQbittorrentSafe(jobConfig, item.candidate);
    await assertCandidateUnchanged(item.candidate);
    await unlink(item.candidate.path);
    result = { status: 'quarantined', destination };
  } else if (destinationExists) {
    throw new Error('The planned quarantine destination already exists with an unexpected size. Both files were preserved.');
  } else if (!sourceExists && job.action === 'permanent') {
    result = { status: 'deleted', destination: null };
  } else {
    result = await applyOrphanCandidate(jobConfig, item.candidate, destination);
  }
  if (result.status === 'quarantined') await recordQuarantine(item.candidate, result.destination);
  await updateItem(job.id, item.id, (value) => {
    value.status = 'complete';
    value.phase = result.status;
    value.outcome = result.status === 'quarantined' ? 'Moved to the Brig.' : 'Permanently deleted.';
    value.destination = result.destination;
  });
}

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sortedIds(values) {
  return [...new Set((values ?? []).map(Number))].sort((left, right) => left - right);
}

function sameIds(left, right) {
  const first = sortedIds(left);
  const second = sortedIds(right);
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function assertRecoveryObservationMature(config, candidate) {
  const recovery = config.qbittorrent.recovery;
  const minutes = Number(candidate.reason === 'slow' ? recovery.slowMinutes : recovery.stalledMinutes);
  const observedSince = Date.parse(candidate.observedSince);
  if (!Number.isFinite(minutes) || minutes < 0 || !Number.isFinite(observedSince)
    || Date.now() - observedSince < minutes * 60_000) {
    throw new Error('The saved slow/stalled observation window is missing, malformed, or no longer satisfies the policy.');
  }
}

function assertRecoveryTorrentEligible(config, candidate, torrent) {
  const classification = classifyQbittorrentRecoveryTorrent(torrent, config.qbittorrent.recovery);
  if (!classification || classification.reason !== candidate.reason || torrent.category !== candidate.category) {
    throw new Error('The torrent recovered, changed category, or no longer matches the approved slow/stalled policy.');
  }
  assertRecoveryObservationMature(config, candidate);
}

async function currentRecoveryTorrent(config, candidate) {
  const torrents = await listQbittorrentTorrents(config.qbittorrent);
  const matches = torrents.filter((torrent) => normalizedHash(torrent.hash) === normalizedHash(candidate.hash));
  if (matches.length > 1) throw new Error('qBittorrent returned duplicate torrents for the recovery hash.');
  return matches[0] ?? null;
}

async function revalidateRecoveryCandidate(config, candidate, torrent) {
  assertRecoveryTorrentEligible(config, candidate, torrent);
  const ownership = await resolveQbittorrentRecoveryOwnership(config, torrent);
  if (ownership.app !== candidate.app
    || Number(ownership.queueId) !== Number(candidate.queueId)
    || normalizedHash(ownership.downloadId) !== normalizedHash(candidate.downloadId)
    || ownership.downloadClientName !== candidate.downloadClientName
    || Number(ownership.downloadClientId ?? 0) !== Number(candidate.downloadClientId ?? 0)
    || !sameIds(ownership.searchIds, candidate.searchIds)
    || Number(ownership.seriesId ?? 0) !== Number(candidate.seriesId ?? 0)) {
    throw new Error('The torrent ownership changed after detection; it was preserved.');
  }
  const immediateTorrent = await currentRecoveryTorrent(config, candidate);
  if (!immediateTorrent) {
    throw new Error('The torrent disappeared during final ownership revalidation; it was preserved for manual review.');
  }
  assertRecoveryTorrentEligible(config, candidate, immediateTorrent);
  return ownership;
}

async function finishRecoverySearch(job, item, config) {
  let latest = getJob(job.id)?.items.find((value) => value.id === item.id);
  if (!latest) return;
  const connection = config[latest.candidate.app];

  if (latest.phase === 'search_requested') {
    const existing = await findMatchingSearchCommand(
      connection,
      latest.candidate.app,
      latest.candidate.searchIds,
      latest.searchStartedAt,
    );
    if (!existing) {
      throw new Error('The replacement-search result is ambiguous after interruption; no duplicate search was queued.');
    }
    await updateItem(job.id, item.id, (value) => {
      value.status = 'complete';
      value.phase = 'search_queued';
      value.outcome = 'Slow/stalled torrent removed, blocklisted, and replacement search queued.';
      value.replacement = {
        status: 'searching',
        commandId: existing.id ?? null,
        detail: 'Recovered the replacement command after interruption.',
        checkedAt: new Date().toISOString(),
      };
    });
    return;
  }

  if (latest.phase !== 'removed_confirmed') {
    throw new Error(`Cannot queue a replacement search from recovery phase ${latest.phase}.`);
  }
  const searchStartedAt = new Date().toISOString();
  await updateItem(job.id, item.id, (value) => {
    value.status = 'searching';
    value.phase = 'search_requested';
    value.searchStartedAt = searchStartedAt;
    value.error = null;
  });
  const command = await queueSearch(connection, latest.candidate.app, latest.candidate.searchIds);
  await updateItem(job.id, item.id, (value) => {
    value.status = 'complete';
    value.phase = 'search_queued';
    value.outcome = 'Slow/stalled torrent removed, blocklisted, and replacement search queued.';
    value.replacement = {
      status: 'searching',
      commandId: command?.id ?? null,
      detail: 'Search accepted by the application.',
      checkedAt: new Date().toISOString(),
    };
  });
}

async function processQbittorrentRecoveryItem(job, item, config) {
  let latest = getJob(job.id)?.items.find((value) => value.id === item.id);
  let continuationConfig = config;
  if (!latest || ['complete', 'search_queued'].includes(latest.phase)) return;
  if (job.policyIdentity !== qbittorrentRecoveryPolicyIdentity(config)
    || latest.candidate.policyIdentity !== job.policyIdentity) {
    throw new Error('The qBittorrent recovery policy changed after detection. A fresh observation window is required.');
  }
  const connection = config[latest.candidate.app];
  if (!connection?.configured) throw new Error(`${latest.candidate.app} is no longer configured.`);

  if (latest.phase === 'search_requested' || latest.phase === 'removed_confirmed') {
    await finishRecoverySearch(job, latest, config);
    return;
  }

  if (latest.phase === 'delete_requested') {
    if (!latest.deleteStartedAt) {
      throw new Error('The interrupted Arr deletion has no valid reconciliation timestamp. It was not repeated.');
    }
    if (await currentRecoveryTorrent(config, latest.candidate)) {
      throw new Error('The interrupted Arr deletion is unresolved and qBittorrent still lists the torrent. The deletion was not repeated.');
    }
    if (!await hasArrDownloadFailedSince(connection, latest.candidate.downloadId, latest.deleteStartedAt)) {
      throw new Error('The interrupted Arr deletion has no matching DownloadFailed/blocklist evidence. The deletion was not repeated.');
    }
    await updateItem(job.id, item.id, (value) => {
      value.status = 'removed';
      value.phase = 'arr_removed';
      value.outcome = 'Reconciled the completed Arr removal after interruption.';
    });
    latest = getJob(job.id)?.items.find((value) => value.id === item.id);
  }

  if (latest.phase === 'arr_removed') {
    if (await currentRecoveryTorrent(config, latest.candidate)) {
      throw new Error('Arr accepted removal, but qBittorrent still lists the torrent. No replacement search was queued.');
    }
    await updateItem(job.id, item.id, (value) => {
      value.status = 'removed';
      value.phase = 'removed_confirmed';
      value.outcome = 'Torrent removal confirmed; preparing replacement search.';
    });
    latest = getJob(job.id)?.items.find((value) => value.id === item.id);
    await finishRecoverySearch(job, latest, config);
    return;
  }

  let torrent = await currentRecoveryTorrent(config, latest.candidate);
  if (!torrent) {
    throw new Error('The torrent disappeared before its Arr removal and blocklist operation could be proven. No search was queued.');
  } else {
    await revalidateRecoveryCandidate(config, latest.candidate, torrent);
    const freshConfig = freshRecoveryMutationConfig(job, latest.candidate);
    const freshConnection = freshConfig[latest.candidate.app];
    continuationConfig = freshConfig;
    const deleteStartedAt = latest.deleteStartedAt ?? new Date().toISOString();
    await updateItem(job.id, item.id, (value) => {
      value.status = 'deleting';
      value.phase = 'delete_requested';
      value.deleteStartedAt = deleteStartedAt;
    });
    try {
      await removeQbittorrentRecoveryFromArr(freshConnection, latest.candidate.queueId);
    } catch (error) {
      if (error.statusCode !== 404) throw error;
      torrent = await currentRecoveryTorrent(freshConfig, latest.candidate);
      const failedRecorded = !torrent
        && await hasArrDownloadFailedSince(freshConnection, latest.candidate.downloadId, deleteStartedAt);
      if (!failedRecorded) throw error;
    }
    await updateItem(job.id, item.id, (value) => {
      value.status = 'removed';
      value.phase = 'arr_removed';
      value.outcome = 'Arr removed and blocklisted the torrent.';
    });
  }

  latest = getJob(job.id)?.items.find((value) => value.id === item.id);
  if (await currentRecoveryTorrent(continuationConfig, latest.candidate)) {
    throw new Error('Arr accepted removal, but qBittorrent still lists the torrent. No replacement search was queued.');
  }
  await updateItem(job.id, item.id, (value) => {
    value.status = 'removed';
    value.phase = 'removed_confirmed';
    value.outcome = 'Torrent removal confirmed; preparing replacement search.';
  });
  latest = getJob(job.id)?.items.find((value) => value.id === item.id);
  await finishRecoverySearch(job, latest, continuationConfig);
}

async function processJob(job) {
  await updateJob(job.id, (value) => {
    value.status = value.cancelRequested ? 'cancelling' : 'running';
    value.startedAt ||= new Date().toISOString();
    value.updatedAt = new Date().toISOString();
  });
  let eligibleIds = new Set();
  let validationError = null;
  try {
    const config = configProvider();
    switch (job.type) {
      case 'oversized': {
        const arr = await scanArr(config);
        const candidates = filterExcluded([...arr.radarr.candidates, ...arr.sonarr.candidates]);
        eligibleIds = new Set(candidates.map((candidate) => candidate.id));
        break;
      }
      case 'orphans': {
        if (job.qbittorrentSafetyIdentity !== qbittorrentSafetyIdentity(config)) {
          throw new Error('qBittorrent safety settings changed after this job was approved. Start a fresh orphan scan and job.');
        }
        const arr = await scanArr(config);
        const candidates = filterExcluded((await scanOrphans(config, arr)).candidates);
        eligibleIds = new Set(candidates.map((candidate) => candidate.id));
        break;
      }
      case 'qbittorrent-recovery':
        if (job.policyIdentity !== qbittorrentRecoveryPolicyIdentity(config)) {
          throw new Error('The qBittorrent recovery policy changed after detection. A fresh observation window is required.');
        }
        eligibleIds = new Set(job.items.map((item) => item.candidate.id));
        break;
      default:
        throw new Error(`Unsupported job type: ${job.type}`);
    }
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }
  for (const originalItem of job.items) {
    const currentJob = getJob(job.id);
    const item = currentJob?.items.find((value) => value.id === originalItem.id);
    if (!item || ['complete', 'cancelled'].includes(item.status)) continue;
    if (currentJob.cancelRequested && item.phase === 'waiting') {
      await updateItem(job.id, item.id, (value) => {
        value.status = 'cancelled';
        value.outcome = 'Cancelled before any file change.';
      });
      continue;
    }
    try {
      const config = configProvider();
      if (currentJob.type === 'orphans'
        && currentJob.qbittorrentSafetyIdentity !== qbittorrentSafetyIdentity(config)) {
        throw new Error('qBittorrent safety settings changed after this job was approved. Start a fresh orphan scan and job.');
      }
      if (currentJob.type === 'qbittorrent-recovery'
        && currentJob.policyIdentity !== qbittorrentRecoveryPolicyIdentity(config)) {
        throw new Error('The qBittorrent recovery policy changed after detection. A fresh observation window is required.');
      }
      if (currentJob.connectionUrls?.[item.candidate.app] !== undefined
        && currentJob.connectionUrls[item.candidate.app] !== config[item.candidate.app]?.url) {
        throw new Error('The application URL changed after this job was approved. Restore the original connection before retrying.');
      }
      const needsValidation = currentJob.type === 'oversized' && item.phase === 'waiting'
        || currentJob.type === 'orphans' && (item.phase === 'waiting' || await pathExists(item.candidate.path));
      if (needsValidation && !eligibleIds.has(item.candidate.id)) {
        throw new Error(validationError ?? 'The file is no longer eligible after a fresh scan and was preserved.');
      }
      switch (currentJob.type) {
        case 'oversized':
          await processOversizeItem(currentJob, item, config);
          break;
        case 'orphans':
          await processOrphanItem(currentJob, item, config);
          break;
        case 'qbittorrent-recovery':
          if (validationError) throw new Error(validationError);
          await processQbittorrentRecoveryItem(currentJob, item, config);
          break;
        default:
          throw new Error(`Unsupported job type: ${currentJob.type}`);
      }
    } catch (error) {
      await updateItem(job.id, item.id, (value) => {
        value.status = 'failed';
        value.error = error instanceof Error ? error.message : String(error);
      });
    }
  }
  await updateJob(job.id, (value) => {
    const failed = value.items.some((item) => item.status === 'failed');
    const cancelled = value.items.some((item) => item.status === 'cancelled');
    value.status = failed ? 'completed_with_errors' : cancelled ? 'cancelled' : 'completed';
    value.completedAt = new Date().toISOString();
    value.updatedAt = value.completedAt;
  });
}

async function runWorker() {
  if (workerRunning || !configProvider) return;
  workerRunning = true;
  try {
    while (true) {
      const job = listJobs().reverse().find((value) => ACTIVE_STATUSES.has(value.status));
      if (!job) break;
      await processJob(job);
    }
  } finally {
    workerRunning = false;
  }
}

function kickWorker() {
  clearTimeout(workerTimer);
  workerTimer = setTimeout(() => runWorker().catch((error) => console.error('Job worker failed:', error)), 20);
  workerTimer.unref?.();
}

async function monitorReplacements() {
  if (monitorRunning || !configProvider) return;
  monitorRunning = true;
  try {
    const candidates = listJobs().flatMap((job) => job.items
      .filter((item) => item.replacement?.commandId && ['searching', 'download_queued', 'unknown'].includes(item.replacement.status))
      .map((item) => ({ jobId: job.id, item })))
      .sort((left, right) => String(left.item.replacement.checkedAt ?? '').localeCompare(String(right.item.replacement.checkedAt ?? '')))
      .slice(0, 25);
    for (const { jobId, item } of candidates) {
      try {
        const config = configProvider();
        const progress = await replacementProgress(config[item.candidate.app], item.candidate, item.replacement.commandId);
        await updateItem(jobId, item.id, (value) => {
          value.replacement = { ...value.replacement, ...progress, checkedAt: new Date().toISOString() };
        });
      } catch (error) {
        await updateItem(jobId, item.id, (value) => {
          value.replacement.detail = error instanceof Error ? error.message : String(error);
          value.replacement.checkedAt = new Date().toISOString();
        });
      }
    }
  } finally {
    monitorRunning = false;
  }
}

export function startJobWorker(getConfig) {
  configProvider = getConfig;
  kickWorker();
  clearInterval(monitorTimer);
  monitorTimer = setInterval(() => monitorReplacements().catch((error) => console.error('Replacement monitor failed:', error)), 15000);
  monitorTimer.unref?.();
}

export function stopJobWorker() {
  clearTimeout(workerTimer);
  clearInterval(monitorTimer);
  configProvider = null;
}
