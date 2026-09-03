import { randomUUID } from 'node:crypto';
import { createJsonStore } from './state.mjs';

const store = createJsonStore('history.json', { version: 1, totalReclaimedBytes: 0, runs: [] });

const MAX_RUNS = 200;

function safeBytes(value) {
  const bytes = Number(value);
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
}

/**
 * Records what a completed job actually achieved.
 *
 * `reclaimedBytes` is space that left the disk at that moment: permanent removals.
 * `quarantinedBytes` moved into the Brig and is still occupying the filesystem, so it
 * is deliberately NOT counted as reclaimed until it is purged. Conflating the two is
 * how a tool ends up claiming it freed space that `df` cannot see.
 *
 * Keyed on jobId so a restart that re-finishes a job cannot double count.
 */
export async function recordRun(run) {
  const jobId = typeof run?.jobId === 'string' ? run.jobId : null;
  if (jobId && store.read().runs.some((existing) => existing.jobId === jobId)) return null;

  const entry = {
    id: randomUUID(),
    jobId,
    type: typeof run?.type === 'string' ? run.type : 'unknown',
    action: typeof run?.action === 'string' ? run.action : null,
    title: typeof run?.title === 'string' ? run.title.slice(0, 300) : null,
    completedAt: typeof run?.completedAt === 'string' ? run.completedAt : new Date().toISOString(),
    fileCount: Number.isSafeInteger(run?.fileCount) && run.fileCount >= 0 ? run.fileCount : 0,
    reclaimedBytes: safeBytes(run?.reclaimedBytes),
    quarantinedBytes: safeBytes(run?.quarantinedBytes),
  };
  if (!entry.fileCount && !entry.reclaimedBytes && !entry.quarantinedBytes) return null;

  await store.update((document) => {
    document.runs.push(entry);
    document.runs.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    document.runs = document.runs.slice(0, MAX_RUNS);
    // The cumulative figure is kept separately so trimming old runs never rewrites it.
    document.totalReclaimedBytes = safeBytes(document.totalReclaimedBytes) + entry.reclaimedBytes;
  });
  return entry;
}

// Purging from the Brig is the moment quarantined bytes actually become free space.
export async function recordPurge({ fileCount = 0, bytes = 0, source = 'brig' } = {}) {
  const reclaimedBytes = safeBytes(bytes);
  const count = Number.isSafeInteger(fileCount) && fileCount > 0 ? fileCount : 0;
  if (!reclaimedBytes && !count) return null;

  const entry = {
    id: randomUUID(),
    jobId: null,
    type: source === 'retention' ? 'quarantine-retention' : 'brig-purge',
    action: 'permanent',
    title: source === 'retention'
      ? `Quarantine retention purged ${count} file${count === 1 ? '' : 's'}`
      : `Purged ${count} file${count === 1 ? '' : 's'} from the Brig`,
    completedAt: new Date().toISOString(),
    fileCount: count,
    reclaimedBytes,
    quarantinedBytes: 0,
  };
  await store.update((document) => {
    document.runs.push(entry);
    document.runs.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
    document.runs = document.runs.slice(0, MAX_RUNS);
    document.totalReclaimedBytes = safeBytes(document.totalReclaimedBytes) + reclaimedBytes;
  });
  return entry;
}

/**
 * `pendingPurgeBytes` is computed from the live Brig rather than accumulated, because a
 * running counter drifts the moment a file is restored, purged, or vanishes underneath
 * us. The caller passes the current Brig records in.
 */
export function historySummary(quarantineRecords = [], limit = 20) {
  const document = store.read();
  const pendingPurgeBytes = quarantineRecords.reduce((sum, record) => sum + safeBytes(record?.sizeBytes), 0);
  const runs = document.runs.slice(0, Math.max(0, limit));
  return {
    totalReclaimedBytes: safeBytes(document.totalReclaimedBytes),
    pendingPurgeBytes,
    pendingPurgeCount: quarantineRecords.length,
    runCount: document.runs.length,
    runs,
  };
}

// Splits a finished job's items into what was freed and what merely moved to the Brig.
export function summarizeJobOutcome(job) {
  let reclaimedBytes = 0;
  let quarantinedBytes = 0;
  let fileCount = 0;
  for (const item of job?.items ?? []) {
    const removal = item?.removal ?? (item?.phase === 'quarantined' ? 'quarantined' : null);
    const bytes = safeBytes(item?.candidate?.sizeBytes);
    if (removal === 'quarantined') {
      quarantinedBytes += bytes;
      fileCount += 1;
    } else if (removal === 'deleted') {
      reclaimedBytes += bytes;
      fileCount += 1;
    }
  }
  return { reclaimedBytes, quarantinedBytes, fileCount };
}
