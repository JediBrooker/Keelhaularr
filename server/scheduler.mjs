import { randomUUID } from 'node:crypto';
import { scanArr } from './arr.mjs';
import { filterExcluded, refreshExclusionOverages } from './exclusions.mjs';
import { scanOrphans } from './orphans.mjs';
import { cleanupExpiredQuarantine } from './quarantine.mjs';
import { createJsonStore } from './state.mjs';

const store = createJsonStore('schedule.json', { version: 1, lastRunAt: null, nextRunAt: null, lastReport: null });
let configProvider = null;
let timer = null;
let running = false;

function bytes(values) {
  return values.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);
}

function messageFor(report) {
  return `Keelhaularr scan: ${report.oversizedCount} oversized file(s) (${report.oversizedBytes} bytes), ${report.orphanCount} orphan file(s) (${report.orphanBytes} bytes).${report.warnings.length ? ` ${report.warnings.length} warning(s): ${report.warnings.join(' | ')}` : ''}`;
}

async function sendNotification(config, report) {
  if (!config.schedule.webhookUrl) return { status: 'not-configured' };
  if (!config.schedule.notifyWhenClear && report.oversizedCount === 0 && report.orphanCount === 0 && !report.warnings.length) return { status: 'skipped-clear' };
  const message = messageFor(report);
  let body;
  if (config.schedule.notificationType === 'discord') body = { content: message };
  else if (config.schedule.notificationType === 'gotify') body = { title: 'Keelhaularr scan', message, priority: 5 };
  else body = { event: 'keelhaularr.scan.completed', message, report };
  const response = await fetch(config.schedule.webhookUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Notification webhook returned HTTP ${response.status}`);
  return { status: 'sent' };
}

export function scheduleStatus(config) {
  const state = store.read();
  if (config) {
    state.nextRunAt = config.schedule.enabled && state.lastRunAt
      ? new Date(new Date(state.lastRunAt).getTime() + config.schedule.intervalHours * 3600000).toISOString()
      : null;
  }
  return state;
}

export async function runScheduledScan(config, trigger = 'manual') {
  if (running) {
    const error = new Error('A scheduled scan is already running.');
    error.statusCode = 409;
    throw error;
  }
  running = true;
  try {
    const arr = await scanArr(config);
    await refreshExclusionOverages(arr);
    const orphans = await scanOrphans(config, arr);
    const oversized = filterExcluded([...arr.radarr.candidates, ...arr.sonarr.candidates]);
    const orphanCandidates = filterExcluded(orphans.candidates);
    const purged = await cleanupExpiredQuarantine(config.quarantineRetentionDays);
    const report = {
      id: randomUUID(),
      trigger,
      scannedAt: new Date().toISOString(),
      oversizedCount: oversized.length,
      oversizedBytes: bytes(oversized),
      orphanCount: orphanCandidates.length,
      orphanBytes: bytes(orphanCandidates),
      purgedQuarantineCount: purged.length,
      warnings: [
        ...arr.radarr.warnings, ...arr.sonarr.warnings, ...orphans.warnings,
        ...Object.values(arr).filter((result) => result.status === 'error').map((result) => `${result.kind}: ${result.error}`),
      ],
      notification: { status: 'pending' },
    };
    try {
      report.notification = await sendNotification(config, report);
    } catch (error) {
      report.notification = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    const nextRunAt = config.schedule.enabled
      ? new Date(Date.now() + config.schedule.intervalHours * 3600000).toISOString()
      : null;
    await store.update((document) => {
      document.lastRunAt = report.scannedAt;
      document.nextRunAt = nextRunAt;
      document.lastReport = report;
    });
    return report;
  } finally {
    running = false;
  }
}

async function tick() {
  if (!configProvider || running) return;
  const config = configProvider();
  await cleanupExpiredQuarantine(config.quarantineRetentionDays);
  if (!config.schedule.enabled) return;
  const state = scheduleStatus(config);
  const dueAt = state.nextRunAt;
  if (dueAt && new Date(dueAt).getTime() > Date.now()) return;
  await runScheduledScan(config, 'scheduled');
}

export function startScheduler(getConfig) {
  configProvider = getConfig;
  clearInterval(timer);
  timer = setInterval(() => tick().catch((error) => console.error('Scheduled scan failed:', error)), 60000);
  timer.unref?.();
  setTimeout(() => tick().catch((error) => console.error('Scheduled scan failed:', error)), 1000).unref?.();
}

export function stopScheduler() {
  clearInterval(timer);
}
