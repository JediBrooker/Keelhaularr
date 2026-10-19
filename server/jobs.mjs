import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  deleteCandidate,
  findMatchingSearchCommand,
  hasArrDownloadFailedSince,
  queueSearch,
  removeQbittorrentRecoveryFromArr,
  replacementProgress,
  resolveQbittorrentRecoveryOwnership,
  resolveMediaRoot,
  scanArr,
  allArrCandidates,
  arrInstanceUrls,
} from './arr.mjs';
import { libraryTwinPath } from './duplicates.mjs';
import { filterExcluded } from './exclusions.mjs';
import { relinkDuplicate } from './hardlinks.mjs';
import { recordRun, summarizeJobOutcome } from './history.mjs';
import { assertNotRecentlyWatched } from './mediaserver.mjs';
import {
  applyOrphanCandidate,
  assertCandidateUnchanged,
  assertQbittorrentSafe,
  quarantineDestination,
  quarantineFile,
  scanOrphans,
} from './orphans.mjs';
import { recordQuarantine } from './quarantine.mjs';
import {
  IMPORTABLE,
  OCCUPIED,
  identifyOrphans,
  importCommandStatus,
  requestImport,
  targetHasFile,
} from './imports.mjs';
import { REPLACEMENT_AVAILABLE, findReplacements } from './replacements.mjs';
import {
  classifyQbittorrentRecoveryTorrent,
  observationThresholdMs,
  qbittorrentRecoveryPolicyIdentity,
} from './qbittorrent-recovery.mjs';
import { listQbittorrentTorrents, withQbittorrent } from './qbittorrent.mjs';
import { FEATURE_BY_RULE, automationPolicyIdentity, loadQueues } from './automation.mjs';
import { notifyDownloadEvent } from './notify.mjs';
import { createJsonStore } from './state.mjs';

const store = createJsonStore('jobs.json', { version: 1, jobs: [] });
const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
// Job types that act on qBittorrent downloads. A hash with an unresolved item in any of
// them is never handed to another job, whichever feature noticed it.
const DOWNLOAD_JOB_TYPES = new Set(['qbittorrent-recovery', 'download-cleanup']);
const POST_MUTATION_RECOVERY_PHASES = new Set([
  'delete_requested',
  'arr_removed',
  'removed_confirmed',
  'search_requested',
]);
let configProvider = null;
let stopping = false;
let workerFinished = Promise.resolve();
let monitorFinished = Promise.resolve();
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
    || (DOWNLOAD_JOB_TYPES.has(job.type) && job.items.some(recoveryItemNeedsPermanentResolution)));
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

/**
 * What automatic qBittorrent recovery has done lately, for the settings screen: how
 * many stuck downloads it replaced, how many attempts failed and why the latest did,
 * and how many are still being worked on.
 */
export function summarizeRecoveryJobs(jobs, { now = Date.now(), days = 7 } = {}) {
  const since = now - days * 86_400_000;
  const items = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.type === 'qbittorrent-recovery' && Date.parse(job.createdAt) >= since)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .flatMap((job) => (Array.isArray(job.items) ? job.items : []).map((item) => ({ job, item })));
  const failed = items.filter(({ item }) => item?.status === 'failed');
  const latest = failed[0];
  return {
    days,
    replacedCount: items.filter(({ item }) => item?.status === 'complete').length,
    failedCount: failed.length,
    inProgressCount: items.filter(({ item }) => !['complete', 'failed', 'cancelled'].includes(item?.status)).length,
    latestFailure: latest ? {
      title: latest.item.candidate?.title ?? null,
      error: String(latest.item.error ?? '').slice(0, 500) || null,
      at: latest.job.updatedAt ?? latest.job.createdAt ?? null,
    } : null,
  };
}

export function recoveryJobSummary(options) {
  return summarizeRecoveryJobs(store.read().jobs, options);
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

export async function createOversizeJob(config, requestedIds, action = 'permanent') {
  if (action !== 'quarantine' && action !== 'permanent') {
    inputError('Oversized jobs require either quarantine or permanent action.');
  }
  const current = await scanArr(config);
  const requested = new Set(requestedIds);
  const candidates = filterExcluded(allArrCandidates(current))
    .filter((candidate) => requested.has(candidate.id));
  if (!candidates.length) inputError('None of the selected files are still oversized.', 409);
  if (action === 'quarantine' && candidates.every((candidate) => !candidate.localPath || !candidate.root)) {
    inputError('None of the selected files can be quarantined because Keelhaularr cannot reach them inside a configured media root. Add a path mapping, or use permanent deletion.', 409);
  }
  const now = new Date().toISOString();
  return saveNewJob({
    id: randomUUID(),
    type: 'oversized',
    title: `${action === 'quarantine' ? 'Quarantine' : 'Replace'} ${candidates.length} oversized file${candidates.length === 1 ? '' : 's'}`,
    action,
    trashDir: config.orphanTrashDir,
    requireReplacement: config.oversizeRequireReplacement === true,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    connectionUrls: arrInstanceUrls(config),
    items: makeItems(candidates),
  });
}

const ORPHAN_ACTION_TITLES = {
  permanent: 'Delete', quarantine: 'Quarantine', import: 'Import', relink: 'Re-link',
};

export async function createOrphanJob(config, requestedIds, action) {
  if (!Object.hasOwn(ORPHAN_ACTION_TITLES, action)) {
    inputError('Orphan jobs require quarantine, permanent, import or relink as the action.');
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
    title: `${ORPHAN_ACTION_TITLES[action]} ${candidates.length} untracked file${candidates.length === 1 ? '' : 's'}`,
    action,
    trashDir: config.orphanTrashDir,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelRequested: false,
    connectionUrls: arrInstanceUrls(config),
    qbittorrentSafetyIdentity: qbittorrentSafetyIdentity(config),
    items: makeItems(candidates),
  });
}

function cleanupItemBlocksNewJob(job, item) {
  if (recoveryItemNeedsPermanentResolution(item)) return true;
  return ACTIVE_STATUSES.has(job.status) && !['complete', 'cancelled'].includes(item.status);
}

function unresolvedRecoveryHashes(jobs, policyIdentity) {
  return new Set(jobs
    .filter((job) => DOWNLOAD_JOB_TYPES.has(job.type))
    .flatMap((job) => job.items
      .filter((item) => (job.type === 'qbittorrent-recovery'
        ? recoveryItemBlocksNewJob(job, item, policyIdentity)
        : cleanupItemBlocksNewJob(job, item)))
      .map((item) => String(item.candidate?.hash ?? '').trim().toLowerCase()))
    .filter(Boolean));
}

const CLEANUP_TITLES = {
  'failed-import': (count) => `Remove ${count} stuck import${count === 1 ? '' : 's'}`,
  'content-blocked': (count) => `Block unwanted content in ${count} torrent${count === 1 ? '' : 's'}`,
  seeding: (count) => `Remove ${count} torrent${count === 1 ? '' : 's'} that finished seeding`,
  unlinked: (count) => `Remove ${count} torrent${count === 1 ? '' : 's'} no longer in the library`,
};

/**
 * Queues downloads the automations decided to act on. Each candidate must have been
 * judged under the policy that is in force now, by a feature that is on and out of dry
 * run, and no hash already being handled by another job is taken twice.
 */
export async function createDownloadCleanupJob(config, candidates) {
  if (config?.qbittorrent?.configured !== true) return null;
  let createdJob = null;
  await store.update((document) => {
    const alreadyQueued = unresolvedRecoveryHashes(document.jobs, qbittorrentRecoveryPolicyIdentity(config));
    const seen = new Set();
    const selected = [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const feature = FEATURE_BY_RULE[candidate?.rule];
      const hash = String(candidate?.hash ?? '').trim().toLowerCase();
      if (!feature || !hash || seen.has(hash) || alreadyQueued.has(hash)) continue;
      const policy = config[feature.key];
      if (policy?.enabled !== true || policy.dryRun !== false) continue;
      if (candidate.policyIdentity !== automationPolicyIdentity(config, feature.key)) continue;
      seen.add(hash);
      selected.push({ ...candidate, hash });
      if (selected.length >= 10) break;
    }
    if (!selected.length) return;
    const counts = new Map();
    for (const candidate of selected) counts.set(candidate.rule, (counts.get(candidate.rule) ?? 0) + 1);
    const title = [...counts].map(([rule, count]) => CLEANUP_TITLES[rule](count)).join('; ');
    const now = new Date().toISOString();
    createdJob = {
      id: randomUUID(),
      type: 'download-cleanup',
      title,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      cancelRequested: false,
      connectionUrls: {
        qbittorrent: config.qbittorrent?.url,
        ...arrInstanceUrls(config),
      },
      connectionIdentities: recoveryConnectionIdentities(config),
      items: makeItems(selected),
    };
    document.jobs.push(createdJob);
    trimJobs(document);
  });
  if (!createdJob) return null;
  kickWorker();
  return getJob(createdJob.id);
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
      title: `Recover ${selected.length} slow, stalled, or metadata-stuck torrent${selected.length === 1 ? '' : 's'}`,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      cancelRequested: false,
      connectionUrls: {
        qbittorrent: config.qbittorrent?.url,
        ...arrInstanceUrls(config),
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

const OVERSIZE_REMOVED_STATUSES = ['deleted', 'search_queued', 'complete'];

function summarizeReplacementVerdict(verdict) {
  return {
    status: verdict.status,
    reason: verdict.reason,
    inspected: verdict.inspected,
    compliantCount: verdict.compliantCount,
    multiEpisode: verdict.multiEpisode ?? false,
    checkedAt: verdict.checkedAt,
    best: verdict.best
      ? { title: verdict.best.title, sizeBytes: verdict.best.sizeBytes, quality: verdict.best.quality }
      : null,
  };
}

// Builds a filesystem view of a tracked oversized file so it can go through the same
// revalidation the orphan path uses. Refuses when the file cannot be located inside a
// configured media root, or when what is on disk no longer matches what Arr reported -
// a size mismatch means the Arr record is stale and the file may already be compliant.
export async function localOversizeCandidate(candidate) {
  const localPath = candidate.localPath ? path.resolve(candidate.localPath) : null;
  const root = candidate.root ? path.resolve(candidate.root) : null;
  if (!localPath || !root) {
    throw new Error('The Brig needs this file inside a configured media root that Keelhaularr can reach. Add a path mapping for this application, or choose permanent deletion.');
  }
  let stats;
  try {
    stats = await stat(localPath, { bigint: true });
  } catch (error) {
    throw new Error(`The file could not be read at ${localPath}, so it was not quarantined: ${error.code ?? error.message}`);
  }
  if (!stats.isFile()) throw new Error(`The quarantine source at ${localPath} is not a regular file.`);
  if (Number(stats.size) !== candidate.sizeBytes) {
    throw new Error('The file on disk no longer matches the size its application reported, so it was preserved. Run a fresh scan.');
  }
  return {
    app: candidate.app,
    title: candidate.title,
    sizeBytes: candidate.sizeBytes,
    path: localPath,
    root,
    relativePath: path.relative(root, localPath),
    identity: `${stats.dev}:${stats.ino}`,
    linkCount: Number(stats.nlink),
    modifiedAt: new Date(Number(stats.mtimeMs)).toISOString(),
  };
}

// Moves a tracked oversized file into the Brig BEFORE its Arr record is removed, so a
// failure at any point leaves the file recoverable rather than gone.
async function quarantineOversizeItem(job, item, config) {
  const local = await localOversizeCandidate(item.candidate);
  const quarantineConfig = { ...config, orphanAction: 'quarantine', orphanTrashDir: job.trashDir };

  let destination = item.plannedDestination ?? null;
  if (!destination) {
    destination = quarantineDestination(quarantineConfig, local, `job-${job.id}-${item.id}`);
    await updateItem(job.id, item.id, (value) => {
      value.plannedDestination = destination;
    });
  }

  const sourceExists = await pathExists(local.path);
  const destinationSettled = await pathHasSize(destination, local.sizeBytes);
  if (!sourceExists && destinationSettled) return { local, destination };
  if (!sourceExists) {
    throw new Error('The file is no longer at its expected path, so it was not quarantined.');
  }
  if (await pathExists(destination) && !destinationSettled) {
    throw new Error('The planned quarantine destination already exists with an unexpected size. Both files were preserved.');
  }
  return { local, destination: await quarantineFile(quarantineConfig, local, destination) };
}

async function processOversizeItem(job, item, config) {
  const connection = config[item.candidate.app];
  if (!connection?.configured) throw new Error(`${item.candidate.app} is no longer configured.`);
  const alreadyRemoved = OVERSIZE_REMOVED_STATUSES.includes(item.status);

  // Replacement gate. Re-checked here, immediately before the destructive step, rather
  // than trusting whatever the browser saw when the job was approved. Anything other
  // than an explicitly available replacement preserves the file.
  if (job.requireReplacement && !alreadyRemoved) {
    await updateItem(job.id, item.id, (value) => {
      value.status = 'verifying';
      value.phase = 'verifying_replacement';
      value.error = null;
    });
    const verdict = await findReplacements(connection, item.candidate);
    await updateItem(job.id, item.id, (value) => {
      value.replacementCheck = summarizeReplacementVerdict(verdict);
    });
    if (verdict.status !== REPLACEMENT_AVAILABLE) {
      throw new Error(`No compliant replacement is available, so the file was preserved. ${verdict.reason ?? ''}`.trim());
    }
  }

  // Withhold anything someone is watching, or has watched inside the window. Fails
  // closed: a configured-but-unreachable media server preserves the file.
  if (!alreadyRemoved) await assertNotRecentlyWatched(config, item.candidate);

  if (!alreadyRemoved) {
    const quarantining = job.action === 'quarantine';
    await updateItem(job.id, item.id, (value) => {
      value.status = quarantining ? 'quarantining' : 'deleting';
      value.phase = quarantining ? 'quarantining' : 'deleting';
      value.error = null;
    });

    let destination = null;
    if (quarantining) {
      const moved = await quarantineOversizeItem(job, item, config);
      destination = moved.destination;
      // `moved.local` carries the real on-disk path and media root, which is what the
      // Brig needs in order to restore the file to where it came from.
      await recordQuarantine(moved.local, destination);
      await updateItem(job.id, item.id, (value) => {
        value.phase = 'quarantined';
        value.destination = destination;
      });
    }

    // The file is already safe in the Brig at this point, so a failure removing the Arr
    // record leaves a recoverable state rather than a lost file.
    try {
      await deleteCandidate(connection, item.candidate);
    } catch (error) {
      if (error.statusCode !== 404) {
        if (quarantining) {
          throw new Error(`The file is in the Brig, but its ${item.candidate.app} record could not be removed: ${error.message}. Restore it from the Brig or remove the record manually.`);
        }
        throw error;
      }
    }
    await updateItem(job.id, item.id, (value) => {
      value.status = 'deleted';
      value.phase = quarantining ? 'quarantined' : 'deleted';
      value.removal = quarantining ? 'quarantined' : 'deleted';
      value.outcome = quarantining
        ? 'Moved to the Brig and removed from its application.'
        : 'File removed through its application.';
    });
  }

  const latest = getJob(job.id)?.items.find((value) => value.id === item.id);
  if (!latest || ['search_queued', 'complete'].includes(latest.status)) return;
  const command = await queueSearch(connection, item.candidate.app, item.candidate.searchIds);
  await updateItem(job.id, item.id, (value) => {
    value.status = 'complete';
    value.phase = 'search_queued';
    const removedTo = value.removal === 'quarantined'
      ? 'Moved to the Brig'
      : value.removal === 'deleted' ? 'File removed through its application' : null;
    value.outcome = removedTo
      ? `${removedTo}. Replacement search queued.`
      : 'Replacement search queued.';
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

// How long to follow a ManualImport command before giving up on watching it. The
// import itself continues inside the application regardless; this only bounds how long
// the job waits for proof, and an unproven import is reported as unproven, never as
// done.
const IMPORT_POLL_TIMEOUT_MS = 120000;
const IMPORT_POLL_INTERVAL_MS = 2000;

/**
 * Hands an untracked file back to the application that should own it.
 *
 * Nothing here deletes or moves anything itself: the application performs the file
 * operation, hardlinking or moving according to its own settings, which is the point.
 * The job's part is to prove the file is still what was scanned, prove the target still
 * has no file, and then prove afterwards that the library actually gained one.
 */
async function processOrphanImportItem(job, item, config) {
  const connection = config[item.candidate.app];
  await updateItem(job.id, item.id, (value) => {
    value.status = 'processing';
    value.phase = 'identifying';
    value.error = null;
  });

  // An incomplete torrent is a partial file; importing it would put a broken copy into
  // the library under a name that says it is fine.
  await assertQbittorrentSafe(config, item.candidate);
  await assertCandidateUnchanged(item.candidate);

  // Re-identified now rather than trusted from the scan: the target may have gained a
  // file in the meantime, and importing over one is the outcome this must never cause.
  const identified = (await identifyOrphans(connection, [item.candidate])).get(item.candidate.id);
  if (identified?.status !== IMPORTABLE || !identified.target || !identified.arrPath) {
    throw new Error(identified?.reason
      ?? 'This file could not be identified immediately before importing, so it was left alone.');
  }

  await updateItem(job.id, item.id, (value) => {
    value.phase = 'importing';
    value.importTitle = identified.title;
  });

  const commandId = await requestImport(connection, item.candidate.app, identified.arrPath, identified.target);
  await updateItem(job.id, item.id, (value) => {
    value.importCommandId = commandId;
  });

  const deadline = Date.now() + IMPORT_POLL_TIMEOUT_MS;
  let command = null;
  while (Date.now() < deadline) {
    command = await importCommandStatus(connection, commandId);
    if (command.finished) break;
    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_INTERVAL_MS));
  }
  if (!command?.finished) {
    throw new Error(`${item.candidate.app} is still importing this file. It will finish on its own; rescan to confirm.`);
  }
  if (!command.succeeded) {
    throw new Error(`${item.candidate.app} reported the import as ${command.status}${command.message ? `: ${command.message}` : '.'}`);
  }

  // A completed command is not proof. Radarr and Sonarr report ManualImport as
  // completed even when the file was rejected during the import itself, so the library
  // is asked whether it actually gained the file.
  if (!await targetHasFile(connection, item.candidate.app, identified.target)) {
    throw new Error(`${item.candidate.app} finished the import but ${identified.title} still has no tracked file. The file was left where it is.`);
  }

  // Which of the two it did is the application's decision, and the source file is the
  // evidence: gone means moved, still there means hardlinked or copied.
  const sourceRemains = await pathExists(item.candidate.path);
  await updateItem(job.id, item.id, (value) => {
    value.status = 'complete';
    value.phase = 'imported';
    value.removal = null;
    value.outcome = sourceRemains
      ? `Linked into ${identified.title}. The file stays where it is, so any torrent keeps seeding.`
      : `Moved into the library as ${identified.title}.`;
  });
}

function formatGib(bytes) {
  return `${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * Collapses a proven duplicate back into a single inode.
 *
 * This is the only action here that reclaims space without anything leaving the disk.
 * The untracked copy keeps its path, its name and its exact contents - so a torrent
 * seeding it carries on seeding - but stops being a second copy of the data, and the
 * blocks it was holding go back to the filesystem.
 *
 * The library file is the one kept, always. Its inode, path and timestamps are never
 * touched, so Radarr and Sonarr see nothing change at all.
 *
 * Three things are re-established here rather than trusted from the scan, because each
 * one would be a way to destroy a file if it were wrong:
 *   - the application still reports this slot as occupied, and names the file holding it
 *   - that file is inside a configured media root, so an odd path mapping cannot make
 *     an arbitrary location the link source
 *   - every byte of both files hashes the same, which relinkDuplicate proves for itself
 *     immediately before it acts
 */
async function processOrphanRelinkItem(job, item, config) {
  const connection = config[item.candidate.app];
  await updateItem(job.id, item.id, (value) => {
    value.status = 'processing';
    value.phase = 'identifying';
    value.error = null;
  });

  // A partial file would hash differently anyway, but failing here gives the honest
  // reason instead of "the files are not identical".
  await assertQbittorrentSafe(config, item.candidate);
  await assertCandidateUnchanged(item.candidate);

  const identified = (await identifyOrphans(connection, [item.candidate])).get(item.candidate.id);
  if (identified?.status !== OCCUPIED) {
    throw new Error(identified?.reason
      ?? 'The library no longer reports a tracked file for this, so there is nothing to link it to.');
  }
  const libraryPath = libraryTwinPath(identified);
  if (!libraryPath) {
    throw new Error('The library file could not be located on disk, so nothing was linked. Check this application\'s path mappings.');
  }
  if (!resolveMediaRoot(libraryPath, connection?.mediaRoots ?? [])) {
    throw new Error(`The library file at ${libraryPath} is outside every configured media root, so it was not used as a link source.`);
  }

  await updateItem(job.id, item.id, (value) => {
    value.phase = 'verifying';
    value.libraryPath = libraryPath;
    value.importTitle = identified.title ?? null;
  });

  const outcome = await relinkDuplicate(item.candidate.path, libraryPath);
  await updateItem(job.id, item.id, (value) => {
    value.status = 'complete';
    value.phase = outcome.status;
    // Counted as reclaimed rather than quarantined: these blocks are back, and unlike a
    // deletion nothing needs to be restorable, because the file is still there.
    value.removal = outcome.status === 'relinked' ? 'relinked' : null;
    value.reclaimedBytes = outcome.reclaimedBytes;
    value.destination = libraryPath;
    value.outcome = outcome.status === 'already-linked'
      ? 'Already one inode with the library file; nothing needed changing.'
      : outcome.reclaimedBytes
        // "Frees" rather than "freed": a client still holding the old copy open keeps
        // its blocks alive until it lets go, so the space can arrive a moment later.
        ? `Linked to the library file. The file is still in place and still seedable, and this frees ${formatGib(outcome.reclaimedBytes)} once any client holding the old copy open releases it.`
        : 'Linked to the library file. Another name still held the old copy, so no space was freed.';
  });
}

async function processOrphanItem(job, item, config) {
  if (job.action === 'import') return processOrphanImportItem(job, item, config);
  if (job.action === 'relink') return processOrphanRelinkItem(job, item, config);
  const jobConfig = { ...config, orphanAction: job.action, orphanTrashDir: job.trashDir };
  await assertNotRecentlyWatched(config, item.candidate);
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
    value.removal = result.status === 'quarantined' ? 'quarantined' : 'deleted';
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
  const thresholdMs = observationThresholdMs(candidate.reason, recovery);
  const observedSince = Date.parse(candidate.observedSince);
  if (thresholdMs === null || !Number.isFinite(thresholdMs) || thresholdMs < 0 || !Number.isFinite(observedSince)
    || Date.now() - observedSince < thresholdMs) {
    throw new Error('The saved slow/stalled/metadata observation window is missing, malformed, or no longer satisfies the policy.');
  }
}

function assertRecoveryTorrentEligible(config, candidate, torrent) {
  const classification = classifyQbittorrentRecoveryTorrent(torrent, config.qbittorrent.recovery, { ignore: config.downloadIgnore });
  if (!classification || classification.reason !== candidate.reason || torrent.category !== candidate.category) {
    throw new Error('The torrent recovered, changed category, or no longer matches the approved slow/stalled/metadata policy.');
  }
  assertRecoveryObservationMature(config, candidate);
}

async function currentRecoveryTorrent(config, candidate) {
  const torrents = await listQbittorrentTorrents(config.qbittorrent);
  const matches = torrents.filter((torrent) => normalizedHash(torrent.hash) === normalizedHash(candidate.hash));
  if (matches.length > 1) throw new Error('qBittorrent returned duplicate torrents for the recovery hash.');
  return matches[0] ?? null;
}

function assertSameOwnership(ownership, candidate) {
  if (ownership.app !== candidate.app
    || Number(ownership.queueId) !== Number(candidate.queueId)
    || normalizedHash(ownership.downloadId) !== normalizedHash(candidate.downloadId)
    || ownership.downloadClientName !== candidate.downloadClientName
    || Number(ownership.downloadClientId ?? 0) !== Number(candidate.downloadClientId ?? 0)
    || !sameIds(ownership.searchIds, candidate.searchIds)
    || Number(ownership.seriesId ?? 0) !== Number(candidate.seriesId ?? 0)) {
    throw new Error('The torrent ownership changed after detection; it was preserved.');
  }
}

async function revalidateRecoveryCandidate(config, candidate, torrent) {
  assertRecoveryTorrentEligible(config, candidate, torrent);
  if (candidate.reason === 'slow' && config.qbittorrent.recovery.ignoreSlowWhenAltSpeed === true
    && await withQbittorrent(config.qbittorrent, (client) => client.alternativeSpeedActive())) {
    throw new Error('qBittorrent\'s alternative speed limits are on, so a slow torrent is not judged; it was preserved.');
  }
  const ownership = await resolveQbittorrentRecoveryOwnership(config, torrent);
  assertSameOwnership(ownership, candidate);
  const immediateTorrent = await currentRecoveryTorrent(config, candidate);
  if (!immediateTorrent) {
    throw new Error('The torrent disappeared during final ownership revalidation; it was preserved for manual review.');
  }
  assertRecoveryTorrentEligible(config, candidate, immediateTorrent);
  return ownership;
}

function removedEvent(candidate, extra = {}) {
  return {
    kind: 'removed',
    rule: candidate.rule ?? candidate.reason,
    title: candidate.title,
    app: candidate.app,
    reason: candidate.rule ? candidate.reason : null,
    blocklisted: true,
    searched: true,
    ...extra,
  };
}

async function finishRecoverySearch(job, item, config,
  outcome = 'Unhealthy torrent removed, blocklisted, and replacement search queued.') {
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
      value.outcome = outcome;
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
    value.outcome = outcome;
    value.replacement = {
      status: 'searching',
      commandId: command?.id ?? null,
      detail: 'Search accepted by the application.',
      checkedAt: new Date().toISOString(),
    };
  });
  await notifyDownloadEvent(config, removedEvent(latest.candidate));
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

function currentItem(job, item) {
  return getJob(job.id)?.items.find((value) => value.id === item.id) ?? null;
}

/**
 * The settings a cleanup item was approved under must still hold before anything
 * destructive happens: the feature on, out of dry run, and its rules unchanged.
 * After the destructive step only the replacement search remains, which is finished
 * whatever the settings say now.
 */
function assertCleanupPolicyCurrent(config, candidate) {
  const feature = FEATURE_BY_RULE[candidate.rule];
  if (!feature) throw new Error(`Unknown download cleanup rule ${candidate.rule}.`);
  const policy = config[feature.key];
  if (policy?.enabled !== true) throw new Error(`${feature.label} was turned off before this download was acted on, so it was preserved.`);
  if (policy.dryRun !== false) throw new Error(`${feature.label} was switched to dry run before this download was acted on, so it was preserved.`);
  if (automationPolicyIdentity(config, feature.key) !== candidate.policyIdentity) {
    throw new Error(`${feature.label}'s settings changed after this download was judged, so it was preserved. The next check decides again.`);
  }
  return feature;
}

function assertCleanupConnectionsUnchanged(job, config, app) {
  const expected = job.connectionIdentities;
  const fresh = recoveryConnectionIdentities(config);
  if (!expected || expected.qbittorrent !== fresh.qbittorrent) {
    throw new Error('The qBittorrent connection changed after detection, so the download was preserved.');
  }
  if (app !== 'qbittorrent' && (!config[app]?.configured || job.connectionUrls?.[app] !== config[app].url
    || (expected[app] !== undefined && expected[app] !== fresh[app]))) {
    throw new Error(`The ${app} API connection changed after detection, so the download was preserved.`);
  }
}

async function cleanupContext(config, client) {
  return { client, queueByHash: await loadQueues(config), now: Date.now(), commit: false, inspected: null };
}

async function freshTorrent(client, hash) {
  const matches = (await client.torrents([hash])).filter((torrent) => normalizedHash(torrent.hash) === normalizedHash(hash));
  if (matches.length > 1) throw new Error('qBittorrent returned duplicate torrents for one hash.');
  return matches[0] ?? null;
}

function removalOutcome(candidate) {
  return candidate.keepInClient
    ? `${candidate.reason} Removed from ${candidate.app} and blocklisted (still seeding in qBittorrent); replacement search queued.`
    : `${candidate.reason} Removed, blocklisted, and replacement search queued.`;
}

async function cleanupStillListed(config, candidate) {
  if (candidate.keepInClient) return (await loadQueues(config)).has(normalizedHash(candidate.hash));
  return Boolean(await currentRecoveryTorrent(config, candidate));
}

// Removal through Arr, for failed imports and fully blocked torrents. The phases and
// their crash reconciliation are recovery's, so an interrupted removal is proven from
// Arr's history and never simply repeated.
async function processCleanupArrRemoval(job, item, config, feature) {
  let latest = item;
  const { candidate } = latest;
  const connection = config[candidate.app];
  if (!connection?.configured) throw new Error(`${candidate.app} is no longer configured.`);
  const outcome = removalOutcome(candidate);
  const where = candidate.keepInClient ? `${candidate.app}'s queue` : 'qBittorrent';

  if (latest.phase === 'search_requested' || latest.phase === 'removed_confirmed') {
    await finishRecoverySearch(job, latest, config, outcome);
    return;
  }
  if (latest.phase === 'delete_requested') {
    if (!latest.deleteStartedAt) throw new Error('The interrupted Arr removal has no reconciliation timestamp. It was not repeated.');
    if (await cleanupStillListed(config, candidate)) {
      throw new Error(`The interrupted Arr removal is unresolved and ${where} still lists the download. It was not repeated.`);
    }
    if (!await hasArrDownloadFailedSince(connection, candidate.downloadId, latest.deleteStartedAt)) {
      throw new Error('The interrupted Arr removal has no matching blocklist evidence. It was not repeated.');
    }
    latest = await updateItem(job.id, item.id, (value) => {
      value.status = 'removed';
      value.phase = 'arr_removed';
    }).then((value) => value.items.find((entry) => entry.id === item.id));
  }

  if (latest.phase !== 'arr_removed') {
    const torrent = await currentRecoveryTorrent(config, candidate);
    if (!torrent) throw new Error('The torrent disappeared before Keelhaularr acted on it, so nothing was removed or searched.');
    await withQbittorrent(config.qbittorrent, async (client) => {
      await feature.revalidate(config, candidate, torrent, await cleanupContext(config, client));
    });
    assertSameOwnership(await resolveQbittorrentRecoveryOwnership(config, torrent), candidate);
    const freshConfig = configProvider?.() ?? config;
    assertCleanupPolicyCurrent(freshConfig, candidate);
    assertCleanupConnectionsUnchanged(job, freshConfig, candidate.app);
    const deleteStartedAt = new Date().toISOString();
    await updateItem(job.id, item.id, (value) => {
      value.status = 'deleting';
      value.phase = 'delete_requested';
      value.deleteStartedAt = deleteStartedAt;
      value.error = null;
    });
    try {
      await removeQbittorrentRecoveryFromArr(freshConfig[candidate.app], candidate.queueId, {
        removeFromClient: !candidate.keepInClient,
      });
    } catch (error) {
      if (error.statusCode !== 404) throw error;
      const settled = !await cleanupStillListed(freshConfig, candidate)
        && await hasArrDownloadFailedSince(freshConfig[candidate.app], candidate.downloadId, deleteStartedAt);
      if (!settled) throw error;
    }
    await updateItem(job.id, item.id, (value) => {
      value.status = 'removed';
      value.phase = 'arr_removed';
      value.outcome = 'Arr removed and blocklisted the download.';
    });
  }

  if (await cleanupStillListed(config, candidate)) {
    throw new Error(`Arr accepted the removal, but ${where} still lists the download. No replacement search was queued.`);
  }
  await updateItem(job.id, item.id, (value) => {
    value.status = 'removed';
    value.phase = 'removed_confirmed';
    value.outcome = 'Removal confirmed; preparing replacement search.';
  });
  await finishRecoverySearch(job, currentItem(job, item), config, outcome);
}

// Sets blocked files to "do not download". Repeating it is harmless, so an interrupted
// item simply runs again from the start.
async function processCleanupSkipFiles(job, item, config, feature, client) {
  const { candidate } = item;
  const torrent = await freshTorrent(client, candidate.hash);
  await feature.revalidate(config, candidate, torrent, await cleanupContext(config, client));
  await updateItem(job.id, item.id, (value) => {
    value.status = 'processing';
    value.phase = 'skipping_files';
    value.error = null;
  });
  await client.setFilePriority(candidate.hash, candidate.fileIndexes, 0);
  const files = await client.files(candidate.hash);
  const missed = candidate.fileIndexes.filter((index) => files.find((file) => file.index === index)?.priority !== 0);
  if (missed.length) throw new Error(`qBittorrent did not apply "do not download" to ${missed.length} blocked file(s).`);
  const names = (candidate.blockedFiles ?? []).slice(0, 3).map((file) => `${file.name.split('/').pop()} (${file.pattern})`);
  await updateItem(job.id, item.id, (value) => {
    value.status = 'complete';
    value.phase = 'files_skipped';
    value.outcome = `${candidate.reason} Set to do not download: ${names.join(', ')}${candidate.fileIndexes.length > names.length ? ` and ${candidate.fileIndexes.length - names.length} more` : ''}.`;
  });
  await notifyDownloadEvent(config, {
    kind: 'files-skipped', rule: candidate.rule, title: candidate.title, reason: candidate.reason, fileCount: candidate.fileIndexes.length,
  });
}

const CLIENT_REMOVAL_CONFIRM_ATTEMPTS = 5;

// Removes a finished torrent from qBittorrent. Re-judged on the spot - including whether
// deleting its files could lose a last copy - and confirmed gone afterwards.
async function processCleanupClientRemoval(job, item, config, feature, client) {
  const { candidate } = item;
  let torrent = await freshTorrent(client, candidate.hash);
  if (!torrent) {
    if (item.phase === 'delete_requested') {
      await updateItem(job.id, item.id, (value) => {
        value.status = 'complete';
        value.phase = 'removed_confirmed';
        value.outcome = `${candidate.reason} Removal confirmed after interruption.`;
      });
      return;
    }
    throw new Error('The torrent disappeared before Keelhaularr acted on it, so nothing was removed.');
  }
  const verdict = await feature.revalidate(config, candidate, torrent, await cleanupContext(config, client));
  const freshConfig = configProvider?.() ?? config;
  assertCleanupPolicyCurrent(freshConfig, candidate);
  assertCleanupConnectionsUnchanged(job, freshConfig, 'qbittorrent');
  await updateItem(job.id, item.id, (value) => {
    value.status = 'deleting';
    value.phase = 'delete_requested';
    value.deleteStartedAt = new Date().toISOString();
    value.candidate.sizeBytes = verdict.freedBytes ?? 0;
    value.error = null;
  });
  await client.deleteTorrent(candidate.hash, candidate.deleteFiles);
  for (let attempt = 0; attempt < CLIENT_REMOVAL_CONFIRM_ATTEMPTS; attempt += 1) {
    torrent = await freshTorrent(client, candidate.hash);
    if (!torrent) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (torrent) throw new Error('qBittorrent accepted the removal but still lists the torrent.');
  const freed = candidate.deleteFiles ? verdict.freedBytes ?? 0 : 0;
  await updateItem(job.id, item.id, (value) => {
    value.status = 'complete';
    value.phase = 'removed_confirmed';
    value.removal = freed > 0 ? 'deleted' : null;
    value.outcome = `${candidate.reason} Removed from qBittorrent${candidate.deleteFiles
      ? ` with its files${freed > 0 ? `, freeing ${formatGib(freed)}` : '; the library keeps its own hardlinks, so no space changed hands'}`
      : ', files kept'}.`;
  });
  await notifyDownloadEvent(config, removedEvent(candidate, { blocklisted: false, searched: false }));
}

async function processDownloadCleanupItem(job, item, config) {
  const latest = currentItem(job, item);
  if (!latest || latest.status === 'complete') return;
  const { candidate } = latest;
  const feature = POST_MUTATION_RECOVERY_PHASES.has(latest.phase)
    ? FEATURE_BY_RULE[candidate.rule]
    : assertCleanupPolicyCurrent(config, candidate);
  if (!feature) throw new Error(`Unknown download cleanup rule ${candidate.rule}.`);
  if (candidate.action === 'arr-remove') {
    await processCleanupArrRemoval(job, latest, config, feature);
    return;
  }
  await withQbittorrent(config.qbittorrent, async (client) => {
    if (candidate.action === 'skip-files') await processCleanupSkipFiles(job, latest, config, feature, client);
    else if (candidate.action === 'client-remove') await processCleanupClientRemoval(job, latest, config, feature, client);
    else throw new Error(`Unsupported download cleanup action ${candidate.action}.`);
  });
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
        const candidates = filterExcluded(allArrCandidates(arr));
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
      case 'download-cleanup':
        // Every item is judged again on its own, immediately before it is acted on.
        eligibleIds = new Set(job.items.map((item) => item.candidate.id));
        break;
      default:
        throw new Error(`Unsupported job type: ${job.type}`);
    }
  } catch (error) {
    validationError = error instanceof Error ? error.message : String(error);
  }
  for (const originalItem of job.items) {
    // Between items is the only safe place to stop: the file operation itself is not
    // interruptible, and the job is durable, so leaving it active resumes it on the
    // next start rather than failing files that were never touched.
    if (stopping) return;
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
        case 'download-cleanup':
          await processDownloadCleanupItem(currentJob, item, config);
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
  // Record the run in history BEFORE the job reads as settled: anyone who sees the
  // job finish (the UI polling /api/jobs, then /api/history) must also see its
  // reclaimed bytes. recordRun ignores a jobId it already holds, so a restart that
  // settles this job again can't count it twice.
  const current = getJob(job.id);
  if (!current) return;
  const failed = current.items.some((item) => item.status === 'failed');
  const cancelled = current.items.some((item) => item.status === 'cancelled');
  const status = failed ? 'completed_with_errors' : cancelled ? 'cancelled' : 'completed';
  const completedAt = new Date().toISOString();
  const settled = { ...current, status, completedAt, updatedAt: completedAt };
  await recordRun({
    jobId: settled.id,
    type: settled.type,
    action: settled.action ?? null,
    title: settled.title,
    completedAt,
    ...summarizeJobOutcome(settled),
  }).catch((error) => console.error('Could not record job history:', error));
  await updateJob(job.id, (value) => {
    value.status = status;
    value.completedAt = completedAt;
    value.updatedAt = completedAt;
  });
}

async function runWorker() {
  if (workerRunning || !configProvider || stopping) return;
  workerRunning = true;
  try {
    while (!stopping) {
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
  workerTimer = setTimeout(() => {
    workerFinished = runWorker().catch((error) => console.error('Job worker failed:', error));
  }, 20);
  workerTimer.unref?.();
}

async function monitorReplacements() {
  if (monitorRunning || !configProvider || stopping) return;
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
  stopping = false;
  kickWorker();
  clearInterval(monitorTimer);
  monitorTimer = setInterval(() => {
    monitorFinished = monitorReplacements().catch((error) => console.error('Replacement monitor failed:', error));
  }, 15000);
  monitorTimer.unref?.();
}

/**
 * Stops taking new work and resolves once whatever was in flight has stopped.
 *
 * configProvider is deliberately left in place. Clearing it used to make the very next
 * `configProvider()` inside the running item loop throw, so shutting the server down
 * during a job marked every remaining file as failed with `configProvider is not a
 * function` - a job that had done nothing wrong, reported in a way nobody could act on,
 * and needing a manual retry afterwards. Items that were never attempted are now simply
 * left as they were, and the job stays active so it resumes on the next start.
 */
export function stopJobWorker() {
  stopping = true;
  clearTimeout(workerTimer);
  clearInterval(monitorTimer);
  return Promise.allSettled([workerFinished, monitorFinished]).then(() => undefined);
}
