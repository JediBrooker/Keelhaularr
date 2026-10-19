import { createHash } from 'node:crypto';
import { arrInstances, arrRecoveryInventory, resolveQbittorrentRecoveryOwnership } from './arr.mjs';
import { judgeContent, loadBlocklist, revalidateContent, syncExcludedFileNames, blocklistStatus } from './content-blocker.mjs';
import { judgeFailedImport, revalidateFailedImport } from './failed-imports.mjs';
import { withQbittorrent } from './qbittorrent.mjs';
import { judgeSeeding, revalidateSeeding } from './seeding-cleanup.mjs';
import { createJsonStore } from './state.mjs';
import { listStrikes, pruneStrikes, strikeRule } from './strikes.mjs';
import { judgeUnlinked, revalidateUnlinked } from './unlinked-cleanup.mjs';

/**
 * The scheduler for the download automations: failed-import cleanup, the content
 * blocker, seeding cleanup and unlinked-torrent cleanup.
 *
 * Each feature runs on its own interval. A run reads qBittorrent's torrent list and
 * every Arr queue once and judges each torrent; anything a feature decides to act on is
 * handed to a durable `download-cleanup` job, which checks it all again immediately
 * before acting. In dry-run mode the same decisions are recorded with "would" and
 * nothing is handed on. Every decision - acted on, struck, ignored or preserved - is
 * kept with its reason so the status screen can say what happened to a download.
 */
export const FEATURES = {
  failedImports: {
    rule: 'failed-import',
    label: 'Failed-import cleanup',
    needsArr: true,
    judge: judgeFailedImport,
    revalidate: revalidateFailedImport,
    intervalMs: (policy) => policy.intervalMinutes * 60_000,
  },
  contentBlocker: {
    rule: 'content-blocked',
    label: 'Content blocker',
    needsArr: true,
    judge: judgeContent,
    revalidate: revalidateContent,
    intervalMs: (policy) => policy.intervalSeconds * 1000,
  },
  seedingCleanup: {
    rule: 'seeding',
    label: 'Seeding cleanup',
    needsArr: false,
    judge: judgeSeeding,
    revalidate: revalidateSeeding,
    intervalMs: (policy) => policy.intervalMinutes * 60_000,
  },
  unlinkedCleanup: {
    rule: 'unlinked',
    label: 'Unlinked-torrent cleanup',
    needsArr: true,
    judge: judgeUnlinked,
    revalidate: revalidateUnlinked,
    intervalMs: (policy) => policy.intervalMinutes * 60_000,
  },
};

export const FEATURE_BY_RULE = Object.fromEntries(Object.entries(FEATURES).map(([key, feature]) => [feature.rule, { key, ...feature }]));

const MAX_ACTIONS_PER_RUN = 10;
const MAX_DECISIONS = 50;
const DECISION_RETENTION_MS = 7 * 86_400_000;
const TIMER_MS = 10_000;
const store = createJsonStore('automation.json', { version: 1, features: {} });

let timer = null;
let activeRun = null;
const nextRunAt = new Map();
// Hashes the content blocker has already inspected, against which version of its list.
const inspected = new Map();

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function stripIntervals(policy) {
  const { dryRun, intervalMinutes, intervalSeconds, refreshHours, ...rest } = policy ?? {};
  return rest;
}

/**
 * What a job approved under this policy depends on. Intervals and the dry-run switch are
 * left out: neither changes which downloads qualify. Everything else - thresholds, ignore
 * lists, the strike window and which servers are involved - invalidates a pending job,
 * which is then preserved rather than acted on under rules nobody approved.
 */
export function automationPolicyIdentity(config, key) {
  return createHash('sha256').update(JSON.stringify({
    key,
    policy: stripIntervals(config?.[key]),
    globalIgnore: config?.downloadIgnore ?? null,
    inactivityHours: config?.strikes?.inactivityHours ?? 24,
    qbittorrent: [config?.qbittorrent?.url ?? '', config?.qbittorrent?.username ?? '', config?.qbittorrent?.pathMaps ?? []],
    arr: arrInstances(config).map((instance) => [instance.id, instance.url, instance.configured === true]),
  })).digest('hex');
}

function blockedBy(config, key) {
  const policy = config?.[key];
  if (policy?.enabled !== true) return 'off';
  if (config?.qbittorrent?.configured !== true) return 'qbittorrent';
  if (FEATURES[key].needsArr && !arrInstances(config).some((instance) => instance.configured)) return 'arr';
  return null;
}

/** Every configured Arr queue, keyed by torrent hash. Any failure fails the whole read. */
export async function loadQueues(config, { inventory = arrRecoveryInventory } = {}) {
  const queueByHash = new Map();
  for (const instance of arrInstances(config).filter((value) => value.configured)) {
    const { queue, downloadClients } = await inventory(config[instance.id] ?? instance);
    for (const record of queue) {
      if (String(record?.protocol ?? '').toLowerCase() !== 'torrent') continue;
      const hash = normalizedHash(record?.downloadId);
      if (!hash) continue;
      if (!queueByHash.has(hash)) queueByHash.set(hash, []);
      queueByHash.get(hash).push({ app: instance.id, record, downloadClients });
    }
  }
  return queueByHash;
}

async function recordRun(key, nowIso, { decisions = [], error = null, extra = {} }) {
  const nowMs = Date.parse(nowIso);
  await store.update((document) => {
    document.features ??= {};
    const previous = document.features[key] ?? {};
    const byHash = new Map((previous.decisions ?? [])
      .filter((decision) => nowMs - Date.parse(decision.at) < DECISION_RETENTION_MS)
      .map((decision) => [`${decision.hash}:${decision.action ?? decision.verdict}`, decision]));
    for (const decision of decisions) {
      byHash.set(`${decision.hash}:${decision.action ?? decision.verdict}`, { ...decision, at: nowIso });
    }
    document.features[key] = {
      ...previous,
      ...extra,
      lastRunAt: nowIso,
      lastError: error,
      decisions: [...byHash.values()]
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, MAX_DECISIONS),
    };
  });
}

function publicDecision(decision) {
  const {
    rule, hash, title, category, app, verdict, action, detail, strikes, maxStrikes, attempts, at, blockedFiles,
  } = decision;
  return { rule, hash, title, category, app, verdict, action, detail, strikes, maxStrikes, attempts, at, blockedFiles };
}

function toCandidate(config, key, decision, ownership, nowIso) {
  const candidate = {
    id: `cleanup:${decision.rule}:${decision.hash}`,
    rule: decision.rule,
    action: decision.action,
    hash: decision.hash,
    title: decision.title,
    category: decision.category,
    reason: decision.reason,
    detail: decision.detail,
    strikes: decision.strikes ?? null,
    maxStrikes: decision.maxStrikes ?? null,
    detectedAt: nowIso,
    policyIdentity: automationPolicyIdentity(config, key),
    app: decision.app ?? 'qbittorrent',
    subtitle: FEATURES[key].label,
  };
  if (decision.action === 'arr-remove') {
    Object.assign(candidate, {
      app: ownership.app,
      downloadId: ownership.downloadId,
      queueId: ownership.queueId,
      downloadClientName: ownership.downloadClientName,
      downloadClientId: ownership.downloadClientId,
      searchIds: ownership.searchIds,
      seriesId: ownership.seriesId,
      keepInClient: decision.keepInClient === true,
      isPrivate: decision.isPrivate === true,
    });
  } else if (decision.action === 'skip-files') {
    Object.assign(candidate, { fileIndexes: decision.fileIndexes, blockedFiles: decision.blockedFiles });
  } else if (decision.action === 'client-remove') {
    // Counted in Reclaimed history only when the files really were the last copy.
    Object.assign(candidate, { deleteFiles: decision.deleteFiles, sizeBytes: decision.freedBytes ?? 0 });
  }
  return candidate;
}

async function runFeature(config, key, context, { enqueue, commit, resolveOwnership }) {
  const feature = FEATURES[key];
  const decisions = [];
  for (const torrent of context.torrents) {
    if (!normalizedHash(torrent?.hash)) continue;
    try {
      const decision = await feature.judge(config, torrent, context);
      if (decision) decisions.push(decision);
    } catch (error) {
      decisions.push({
        rule: feature.rule, hash: normalizedHash(torrent.hash), title: torrent.name, category: torrent.category,
        verdict: 'preserved', detail: `Could not be judged: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  const candidates = [];
  for (const decision of decisions.filter((value) => value.verdict === 'act')) {
    if (candidates.length >= MAX_ACTIONS_PER_RUN) {
      decision.verdict = 'waiting';
      decision.detail = `${decision.detail} Waiting: at most ${MAX_ACTIONS_PER_RUN} actions are started per run.`;
      continue;
    }
    let ownership = null;
    if (decision.action === 'arr-remove') {
      try {
        ownership = await resolveOwnership(config, context.byHash.get(decision.hash));
      } catch (error) {
        decision.verdict = 'preserved';
        decision.detail = `${decision.reason ?? decision.detail} Not removed: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }
    }
    candidates.push(toCandidate(config, key, decision, ownership, context.nowIso));
  }
  if (commit && candidates.length && typeof enqueue === 'function') {
    const job = await enqueue(config, candidates);
    const accepted = new Set((job?.items ?? []).map((item) => item.candidate?.hash));
    for (const decision of decisions.filter((value) => value.verdict === 'act')) {
      if (!accepted.has(decision.hash)) {
        decision.verdict = 'waiting';
        decision.detail = `${decision.detail} Already being handled by an earlier job.`;
      }
    }
  }
  return decisions;
}

async function evaluate(config, keys, options) {
  const now = Number(options.now ?? Date.now());
  const nowIso = new Date(now).toISOString();
  const results = {};
  const open = options.withClient ?? ((work) => withQbittorrent(config.qbittorrent, work));
  await open(async (client) => {
    const torrents = await client.torrents();
    const queueByHash = await (options.loadQueues ?? loadQueues)(config);
    const context = {
      client,
      torrents,
      byHash: new Map(torrents.map((torrent) => [normalizedHash(torrent.hash), torrent])),
      queueByHash,
      now,
      nowIso,
      commit: options.commit,
      inspected: options.commit ? inspected : null,
      importedCheck: options.importedCheck,
    };
    for (const key of keys) {
      const extra = {};
      try {
        if (key === 'contentBlocker') {
          context.blocklist = await loadBlocklist(config.contentBlocker, { now, fetcher: options.fetchBlocklist });
          extra.patternCount = context.blocklist.patterns.length;
          extra.invalidPatternCount = context.blocklist.invalid;
          if (config.contentBlocker.syncExcludedFileNames) {
            const sync = await syncExcludedFileNames(client, context.blocklist, {
              dryRun: !options.commit || config.contentBlocker.dryRun,
            });
            extra.sync = { ...sync, at: nowIso };
          }
        }
        const decisions = await runFeature(config, key, context, {
          enqueue: options.enqueue,
          commit: options.commit,
          resolveOwnership: options.resolveOwnership ?? resolveQbittorrentRecoveryOwnership,
        });
        results[key] = { decisions, error: null, extra };
      } catch (error) {
        results[key] = { decisions: [], error: error instanceof Error ? error.message : String(error), extra };
      }
    }
  });
  return { nowIso, results };
}

/**
 * One run of the due features. `options.features` limits which run; tests inject the
 * qBittorrent client, queues, clock and ownership proof the same way recovery's do.
 */
export async function tickAutomation(config, enqueue, options = {}) {
  const keys = (options.features ?? Object.keys(FEATURES)).filter((key) => !blockedBy(config, key));
  if (!keys.length) return {};
  const now = Number(options.now ?? Date.now());
  const nowIso = new Date(now).toISOString();
  let outcome;
  try {
    outcome = await evaluate(config, keys, { ...options, enqueue, commit: true, now });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const key of keys) await recordRun(key, nowIso, { error: message });
    return Object.fromEntries(keys.map((key) => [key, { decisions: [], error: message }]));
  }
  for (const [key, result] of Object.entries(outcome.results)) {
    await recordRun(key, outcome.nowIso, {
      decisions: result.decisions.map(publicDecision),
      error: result.error,
      extra: { ...result.extra, policyIdentity: automationPolicyIdentity(config, key) },
    });
  }
  await pruneStrikes({ now, inactivityHours: config.strikes.inactivityHours });
  return outcome.results;
}

/**
 * Evaluates every feature, enabled or not, as if each were in dry-run mode, and records
 * nothing: no strike, no forced import, no job. This is how to see what turning a
 * feature on would do before turning it on.
 */
export async function previewAutomation(config, options = {}) {
  if (config?.qbittorrent?.configured !== true) {
    const error = new Error('Connect qBittorrent before previewing the download automations.');
    error.statusCode = 400;
    throw error;
  }
  const previewConfig = { ...config };
  for (const key of Object.keys(FEATURES)) previewConfig[key] = { ...config[key], dryRun: true };
  const keys = (options.features ?? Object.keys(FEATURES))
    .filter((key) => !FEATURES[key].needsArr || arrInstances(config).some((instance) => instance.configured));
  const { nowIso, results } = await evaluate(previewConfig, keys, { ...options, commit: false });
  return {
    previewedAt: nowIso,
    features: Object.fromEntries(Object.entries(results).map(([key, result]) => [key, {
      error: result.error,
      decisions: result.decisions.map(publicDecision),
    }])),
  };
}

export function automationStatus(config, { now = Date.now(), jobs = [] } = {}) {
  const document = store.read();
  const since = now - DECISION_RETENTION_MS;
  return Object.fromEntries(Object.entries(FEATURES).map(([key, feature]) => {
    const state = document.features?.[key] ?? {};
    const policy = config?.[key] ?? {};
    const items = jobs
      .filter((job) => job?.type === 'download-cleanup' && Date.parse(job.createdAt) >= since)
      .flatMap((job) => job.items ?? [])
      .filter((item) => item?.candidate?.rule === feature.rule);
    const status = {
      label: feature.label,
      enabled: policy.enabled === true,
      dryRun: policy.dryRun !== false,
      blockedBy: blockedBy(config, key),
      nextRunAt: nextRunAt.has(key) ? new Date(nextRunAt.get(key)).toISOString() : null,
      lastRunAt: state.lastRunAt ?? null,
      lastError: state.lastError ?? null,
      decisions: (state.decisions ?? []).slice(0, 25),
      history: {
        days: 7,
        doneCount: items.filter((item) => item.status === 'complete').length,
        failedCount: items.filter((item) => item.status === 'failed').length,
        inProgressCount: items.filter((item) => !['complete', 'failed', 'cancelled'].includes(item.status)).length,
      },
    };
    if (key === 'failedImports') {
      status.strikes = listStrikes(strikeRule(feature.rule, policy.dryRun !== false), {
        now, inactivityHours: config?.strikes?.inactivityHours ?? 24,
      }).map((record) => ({ hash: record.hash, count: record.count, attempts: record.attempts ?? 0, lastStrikeAt: record.lastStrikeAt, reason: record.reason }));
    }
    if (key === 'contentBlocker') {
      status.blocklist = { ...blocklistStatus(), patternCount: state.patternCount ?? null, invalidPatternCount: state.invalidPatternCount ?? null };
      status.sync = state.sync ?? null;
    }
    return [key, status];
  }));
}

function due(config, nowMs) {
  const keys = [];
  for (const [key, feature] of Object.entries(FEATURES)) {
    if (blockedBy(config, key)) {
      nextRunAt.delete(key);
      continue;
    }
    const at = nextRunAt.get(key);
    if (at === undefined || nowMs >= at) {
      keys.push(key);
      nextRunAt.set(key, nowMs + feature.intervalMs(config[key]));
    }
  }
  return keys;
}

export function startAutomation(getConfig, enqueue, options = {}) {
  stopAutomation();
  const run = () => {
    if (activeRun) return activeRun;
    const config = getConfig();
    const keys = due(config, Date.now());
    if (!keys.length) return Promise.resolve();
    activeRun = tickAutomation(config, enqueue, { ...options, features: keys })
      .catch((error) => console.error('Download automation run failed:', error))
      .finally(() => { activeRun = null; });
    return activeRun;
  };
  void run();
  timer = setInterval(run, options.timerMs ?? TIMER_MS);
  timer.unref?.();
}

export function stopAutomation() {
  clearInterval(timer);
  timer = null;
  nextRunAt.clear();
}
