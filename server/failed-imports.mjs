import { arrRequest } from './arr.mjs';
import { ignoredReason } from './download-ignore.mjs';
import { buildImportCommand } from './imports.mjs';
import { torrentIsComplete } from './qbittorrent.mjs';
import { addAttempt, addStrike, readStrikes, strikeRule } from './strikes.mjs';

/**
 * Failed-import cleanup.
 *
 * Radarr and Sonarr leave a finished download in their queue with a warning when they
 * cannot import it: no eligible files, a sample, an unparseable name, a release that
 * turned out not to be an upgrade. Left alone it sits there for ever and nothing else
 * gets grabbed. This rule judges each such download every few minutes. It first tries
 * a forced import of whatever the application could import, then strikes the download
 * on each check it is still stuck, and once it reaches its limit hands it to the same
 * remove-blocklist-search pipeline recovery uses.
 */
export const RULE = 'failed-import';
const STUCK_STATES = new Set(['importpending', 'importblocked', 'failedpending']);
const STUCK_STATUSES = new Set(['warning', 'error']);

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isStuckImport(record) {
  return String(record?.protocol ?? '').toLowerCase() === 'torrent'
    && STUCK_STATES.has(String(record?.trackedDownloadState ?? '').toLowerCase())
    && STUCK_STATUSES.has(String(record?.trackedDownloadStatus ?? '').toLowerCase());
}

/** The application's own explanation, flattened into one line for the job and status. */
export function stuckImportMessage(records) {
  const lines = [];
  for (const record of records) {
    for (const status of Array.isArray(record?.statusMessages) ? record.statusMessages : []) {
      for (const message of Array.isArray(status?.messages) ? status.messages : []) {
        if (typeof message === 'string' && message.trim()) lines.push(message.trim());
      }
      if (!status?.messages?.length && typeof status?.title === 'string' && status.title.trim()) lines.push(status.title.trim());
    }
    if (typeof record?.errorMessage === 'string' && record.errorMessage.trim()) lines.push(record.errorMessage.trim());
  }
  return [...new Set(lines)].join(' ').slice(0, 400) || 'The application reported the import as stuck without saying why.';
}

/**
 * Files the application identified and rejected only for temporary reasons, as a
 * ManualImport command. A permanent rejection - not an upgrade, wrong episode, sample -
 * is the application's considered answer and is never overridden.
 */
export async function forcedImportCommand(connection, app, downloadId) {
  const items = await arrRequest(
    connection,
    `manualimport?downloadId=${encodeURIComponent(downloadId)}&filterExistingFiles=true`,
    { timeoutMs: 60000 },
  );
  if (!Array.isArray(items)) return null;
  const files = [];
  for (const item of items) {
    const rejections = Array.isArray(item?.rejections) ? item.rejections : [];
    if (rejections.some((rejection) => String(rejection?.type ?? 'permanent').toLowerCase() !== 'temporary')) continue;
    if (typeof item?.path !== 'string' || !item.path) continue;
    const shared = {
      quality: item.quality ?? null,
      languages: Array.isArray(item.languages) ? item.languages : [],
      releaseGroup: typeof item.releaseGroup === 'string' ? item.releaseGroup : null,
      indexerFlags: Number.isInteger(item.indexerFlags) ? item.indexerFlags : 0,
      downloadId,
    };
    let target;
    if (app === 'radarr') {
      if (!Number.isSafeInteger(item?.movie?.id) || item.movie.id <= 0) continue;
      target = { ...shared, movieId: item.movie.id };
    } else {
      const episodeIds = (Array.isArray(item?.episodes) ? item.episodes : [])
        .map((episode) => episode?.id).filter((id) => Number.isSafeInteger(id) && id > 0);
      if (!Number.isSafeInteger(item?.series?.id) || !episodeIds.length) continue;
      target = { ...shared, seriesId: item.series.id, episodeIds, releaseType: item.releaseType ?? null };
    }
    files.push(...buildImportCommand(app, item.path, target).files);
  }
  return files.length ? { name: 'ManualImport', importMode: 'auto', files } : null;
}

function recordsFor(context, hash) {
  return context.queueByHash.get(normalizedHash(hash)) ?? [];
}

/**
 * Judges one torrent. With `commit`, strikes and forced imports really happen; without,
 * the verdict says what the next check would do, which is what the preview shows.
 */
export async function judgeFailedImport(config, torrent, context) {
  const policy = config.failedImports;
  const entries = recordsFor(context, torrent.hash);
  const stuck = entries.filter((entry) => isStuckImport(entry.record));
  if (!stuck.length) return null;
  const base = { rule: RULE, hash: normalizedHash(torrent.hash), title: torrent.name, category: torrent.category };
  // A season pack is one download listed once per episode; it is stuck only when every
  // record still in the queue is, and only when one application owns all of them.
  if (stuck.length !== entries.length) return null;
  if (new Set(entries.map((entry) => entry.app)).size !== 1) {
    return { ...base, verdict: 'preserved', detail: 'More than one Radarr/Sonarr app lists this download, so which one owns it is unclear.' };
  }
  const app = entries[0].app;
  const message = stuckImportMessage(stuck.map((entry) => entry.record));
  const ignored = ignoredReason(config, torrent, policy.ignore, 'failed-import ignore list');
  if (ignored) return { ...base, app, verdict: 'ignored', detail: ignored };
  const lowered = message.toLowerCase();
  const ignoredMessage = policy.ignoredMessages.find((value) => lowered.includes(value.toLowerCase()));
  if (ignoredMessage) return { ...base, app, verdict: 'ignored', detail: `Its message matches the ignored text "${ignoredMessage}".` };
  if (!torrentIsComplete(torrent)) {
    return { ...base, app, verdict: 'preserved', detail: 'qBittorrent has not finished it, so it is not an import problem yet.' };
  }
  // Unknown counts as private: the safe answer when the flag cannot be read.
  const isPrivate = await context.client.isPrivate(torrent) !== false;
  if (isPrivate && policy.ignorePrivate) {
    return { ...base, app, verdict: 'ignored', detail: 'It is from a private tracker (or its private flag could not be read), and private torrents are ignored.' };
  }

  const rule = strikeRule(RULE, policy.dryRun);
  const strikeOptions = { now: context.now, inactivityHours: config.strikes.inactivityHours };
  const record = readStrikes(rule, torrent.hash, strikeOptions);
  const strikes = record?.count ?? 0;
  const attempts = record?.attempts ?? 0;
  const reason = `Import stuck: ${message}`;

  if (attempts < policy.forceImportAttempts) {
    const connection = config[app];
    let command = null;
    try {
      command = await forcedImportCommand(connection, app, stuck[0].record.downloadId);
    } catch (error) {
      command = null;
      base.importError = error instanceof Error ? error.message : String(error);
    }
    if (command) {
      const attempt = attempts + 1;
      const detail = `${reason} ${policy.dryRun ? 'Would try' : 'Trying'} a forced import of ${command.files.length} file${command.files.length === 1 ? '' : 's'} (attempt ${attempt} of ${policy.forceImportAttempts}) before any strike.`;
      if (context.commit) {
        if (!policy.dryRun) await arrRequest(connection, 'command', { method: 'POST', body: JSON.stringify(command), timeoutMs: 60000 });
        await addAttempt(rule, torrent.hash, { ...strikeOptions, reason });
      }
      return { ...base, app, verdict: 'attempt', detail, strikes, maxStrikes: policy.maxStrikes, attempts: attempt };
    }
  }

  const next = context.commit
    ? (await addStrike(rule, torrent.hash, { ...strikeOptions, reason })).count
    : strikes + 1;
  const strikeText = `strike ${Math.min(next, policy.maxStrikes)} of ${policy.maxStrikes}`;
  const attemptText = attempts ? ` after ${attempts} forced import attempt${attempts === 1 ? '' : 's'}` : '';
  if (next < policy.maxStrikes) {
    return {
      ...base, app, verdict: 'strike', strikes: next, maxStrikes: policy.maxStrikes,
      detail: `${reason} ${context.commit ? 'Struck' : 'Next check strikes it'}: ${strikeText}${attemptText}.`,
    };
  }
  return {
    ...base,
    app,
    verdict: policy.dryRun ? 'would-act' : 'act',
    action: 'arr-remove',
    strikes: next,
    maxStrikes: policy.maxStrikes,
    keepInClient: isPrivate && !policy.deletePrivate,
    isPrivate,
    reason: `${reason} Reached ${strikeText}${attemptText}.`,
    detail: `${reason} Reached ${strikeText}${attemptText}; ${policy.dryRun ? 'would be' : 'will be'} removed${isPrivate && !policy.deletePrivate ? ' from Arr (kept seeding in qBittorrent)' : ''}, blocklisted, and searched for again.`,
  };
}

/** Final check before acting: still stuck, still owned the same way, still struck out. */
export async function revalidateFailedImport(config, candidate, torrent, context) {
  const policy = config.failedImports;
  if (!torrent) throw new Error('The torrent is no longer in qBittorrent; nothing was removed.');
  const entries = recordsFor(context, candidate.hash);
  if (!entries.length || !entries.every((entry) => isStuckImport(entry.record) && entry.app === candidate.app)) {
    throw new Error('Radarr/Sonarr no longer reports this import as stuck, so it was preserved.');
  }
  if (ignoredReason(config, torrent, policy.ignore, 'failed-import ignore list')) {
    throw new Error('The download is now on an ignore list, so it was preserved.');
  }
  if (!torrentIsComplete(torrent)) throw new Error('qBittorrent no longer reports the torrent as complete; it was preserved.');
  const isPrivate = await context.client.isPrivate(torrent) !== false;
  if (isPrivate && policy.ignorePrivate) throw new Error('The torrent is private and private torrents are ignored; it was preserved.');
  if (isPrivate !== Boolean(candidate.isPrivate)) throw new Error('The torrent\'s private flag changed after detection; it was preserved.');
  const record = readStrikes(RULE, candidate.hash, { now: Date.now(), inactivityHours: config.strikes.inactivityHours });
  if (!record || record.count < policy.maxStrikes) {
    throw new Error('The download no longer has enough strikes (they expired or were reset), so it was preserved.');
  }
}
