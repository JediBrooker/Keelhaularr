import { createJsonStore } from './state.mjs';

/**
 * Strikes shared by every rule that judges a download repeatedly before acting on it.
 *
 * A strike is one failing check. A rule acts once a download has collected its limit,
 * which keeps a single bad reading - an Arr that was mid-import, a tracker that blinked -
 * from removing anything. Strikes are durable so a restart does not reset the count, and
 * they expire once a download has gone a whole inactivity window without a new one, the
 * way Cleanuparr's did, so a problem that cleared itself does not count against the same
 * download days later.
 *
 * Records are keyed by rule and hash. A rule in dry-run mode keeps its own records, so
 * switching dry run off starts every count from zero instead of acting at once on
 * strikes nobody was watching.
 */
const store = createJsonStore('strikes.json', { version: 1, records: {} });
const HOUR_MS = 3_600_000;

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function strikeRule(rule, dryRun) {
  return dryRun ? `${rule}~dry-run` : rule;
}

function key(rule, hash) {
  return `${rule}:${normalizedHash(hash)}`;
}

function expired(record, nowMs, inactivityHours) {
  const last = Date.parse(record?.lastStrikeAt ?? '');
  return !Number.isFinite(last) || nowMs - last > inactivityHours * HOUR_MS;
}

function current(document, rule, hash, nowMs, inactivityHours) {
  const record = document.records?.[key(rule, hash)];
  return record && !expired(record, nowMs, inactivityHours) ? record : null;
}

/** The live record for a download, or null when it has none or it has expired. */
export function readStrikes(rule, hash, { now = Date.now(), inactivityHours = 24 } = {}) {
  return current(store.read(), rule, hash, now, inactivityHours);
}

/**
 * Adds one strike and returns the updated record.
 *
 * With `resetOnProgress`, a download that has moved forward since its last strike starts
 * again from this one: it is failing now, but it was not stuck in between.
 */
export async function addStrike(rule, hash, {
  now = Date.now(),
  inactivityHours = 24,
  progress = null,
  resetOnProgress = false,
  reason = null,
} = {}) {
  const nowIso = new Date(now).toISOString();
  let saved = null;
  await store.update((document) => {
    document.records ??= {};
    const previous = current(document, rule, hash, now, inactivityHours);
    const progressed = resetOnProgress && previous && Number.isFinite(progress)
      && Number.isFinite(previous.lastProgress) && progress > previous.lastProgress;
    const base = previous && !progressed ? previous : {
      rule,
      hash: normalizedHash(hash),
      count: 0,
      attempts: 0,
      firstStrikeAt: nowIso,
    };
    saved = {
      ...base,
      count: base.count + 1,
      lastStrikeAt: nowIso,
      lastProgress: Number.isFinite(progress) ? progress : base.lastProgress ?? null,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : base.reason ?? null,
    };
    document.records[key(rule, hash)] = saved;
  });
  return saved;
}

/**
 * Counts one corrective attempt, such as a forced import, against a download without
 * striking it. Attempts share the record so they expire with it.
 */
export async function addAttempt(rule, hash, { now = Date.now(), inactivityHours = 24, reason = null } = {}) {
  const nowIso = new Date(now).toISOString();
  let saved = null;
  await store.update((document) => {
    document.records ??= {};
    const previous = current(document, rule, hash, now, inactivityHours);
    saved = {
      rule,
      hash: normalizedHash(hash),
      count: previous?.count ?? 0,
      firstStrikeAt: previous?.firstStrikeAt ?? nowIso,
      lastProgress: previous?.lastProgress ?? null,
      ...previous,
      attempts: (previous?.attempts ?? 0) + 1,
      // An attempt keeps the record alive like a strike does.
      lastStrikeAt: nowIso,
      reason: typeof reason === 'string' ? reason.slice(0, 500) : previous?.reason ?? null,
    };
    document.records[key(rule, hash)] = saved;
  });
  return saved;
}

export async function clearStrikes(rule, hash) {
  await store.update((document) => {
    delete document.records?.[key(rule, hash)];
  });
}

/** Drops every expired record, so the file holds only downloads still being judged. */
export async function pruneStrikes({ now = Date.now(), inactivityHours = 24 } = {}) {
  const document = store.read();
  const stale = Object.entries(document.records ?? {})
    .filter(([, record]) => expired(record, now, inactivityHours))
    .map(([recordKey]) => recordKey);
  if (!stale.length) return 0;
  await store.update((next) => {
    for (const recordKey of stale) delete next.records?.[recordKey];
  });
  return stale.length;
}

export function listStrikes(rule, { now = Date.now(), inactivityHours = 24 } = {}) {
  return Object.values(store.read().records ?? {})
    .filter((record) => record.rule === rule && !expired(record, now, inactivityHours));
}
