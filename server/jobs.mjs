import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, stat, unlink } from 'node:fs/promises';
import { deleteCandidate, queueSearch, replacementProgress, scanArr } from './arr.mjs';
import { filterExcluded } from './exclusions.mjs';
import { applyOrphanCandidate, quarantineDestination, scanOrphans } from './orphans.mjs';
import { recordQuarantine } from './quarantine.mjs';
import { createJsonStore } from './state.mjs';

const store = createJsonStore('jobs.json', { version: 1, jobs: [] });
const ACTIVE_STATUSES = new Set(['queued', 'running', 'cancelling']);
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

function trimJobs(document) {
  if (document.jobs.length <= 100) return;
  const active = document.jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  const finished = document.jobs.filter((job) => !ACTIVE_STATUSES.has(job.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.max(0, 100 - active.length));
  document.jobs = [...active, ...finished];
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

export async function createOrphanJob(config, requestedIds) {
  const arr = await scanArr(config);
  const current = await scanOrphans(config, arr);
  const requested = new Set(requestedIds);
  const candidates = current.candidates.filter((candidate) => requested.has(candidate.id));
  if (!candidates.length) inputError('None of the selected orphan files are still eligible.', 409);
  const now = new Date().toISOString();
  return saveNewJob({
    id: randomUUID(),
    type: 'orphans',
    title: `${config.orphanAction === 'permanent' ? 'Delete' : 'Quarantine'} ${candidates.length} orphan file${candidates.length === 1 ? '' : 's'}`,
    action: config.orphanAction,
    trashDir: config.orphanTrashDir,
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
    const source = await stat(item.candidate.path, { bigint: true });
    if (`${source.dev}:${source.ino}` !== item.candidate.identity || Number(source.size) !== item.candidate.sizeBytes) {
      throw new Error('The source changed during quarantine recovery. Both files were preserved.');
    }
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
    const arr = await scanArr(config);
    const candidates = job.type === 'orphans'
      ? (await scanOrphans(config, arr)).candidates
      : filterExcluded([...arr.radarr.candidates, ...arr.sonarr.candidates]);
    eligibleIds = new Set(candidates.map((candidate) => candidate.id));
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
      if (currentJob.connectionUrls?.[item.candidate.app] !== undefined
        && currentJob.connectionUrls[item.candidate.app] !== config[item.candidate.app].url) {
        throw new Error('The application URL changed after this job was approved. Restore the original connection before retrying.');
      }
      const needsValidation = item.phase === 'waiting'
        || (currentJob.type === 'orphans' && await pathExists(item.candidate.path));
      if (needsValidation && !eligibleIds.has(item.candidate.id)) {
        throw new Error(validationError ?? 'The file is no longer eligible after a fresh scan and was preserved.');
      }
      if (currentJob.type === 'oversized') await processOversizeItem(currentJob, item, config);
      else await processOrphanItem(currentJob, item, config);
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
}
