import { ignoredReason } from './download-ignore.mjs';
import { torrentIsComplete } from './qbittorrent.mjs';
import { fileDeletionPlan, fileDeletionProblem } from './torrent-files.mjs';

/**
 * Seeding cleanup.
 *
 * A finished torrent is removed from qBittorrent once its category's rule says it has
 * seeded enough: a ratio, a maximum seeding time, or a number of days without upload
 * activity, each only after a minimum seeding time. A maximum ratio of 0 removes a
 * torrent as soon as it is finished and imported; -1 turns a limit off, the way
 * Cleanuparr spelled it.
 *
 * Never an incomplete torrent, and never one Radarr or Sonarr still lists in its queue,
 * because that means the import has not happened yet. Deleting the files as well is
 * normally free - the library holds its own hardlink - and is refused for any media
 * file that turns out to be the last copy of something never imported.
 */
export const RULE = 'seeding';

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function hours(value) {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} h`;
}

/** Which limit a finished torrent has reached under its rule, in words, or null. */
export function seedingLimitReached(rule, torrent, nowMs) {
  const seedHours = (torrent.seedingTime ?? 0) / 3600;
  if (seedHours < rule.minSeedHours) return null;
  if (rule.maxRatio >= 0 && Number.isFinite(torrent.ratio) && torrent.ratio >= rule.maxRatio) {
    return `ratio ${torrent.ratio.toFixed(2)} reached the ${rule.maxRatio} limit`;
  }
  if (rule.maxSeedHours >= 0 && seedHours >= rule.maxSeedHours) {
    return `seeded ${hours(seedHours)}, past the ${hours(rule.maxSeedHours)} limit`;
  }
  if (rule.maxInactiveDays >= 0) {
    const lastActive = torrent.lastActivity > 0 ? torrent.lastActivity : torrent.completionOn;
    if (Number.isFinite(lastActive) && lastActive > 0) {
      const inactiveDays = (nowMs / 1000 - lastActive) / 86400;
      if (inactiveDays >= rule.maxInactiveDays) {
        return `no upload activity for ${inactiveDays.toFixed(1)} days, past the ${rule.maxInactiveDays}-day limit`;
      }
    }
  }
  return null;
}

export async function judgeSeeding(config, torrent, context) {
  const policy = config.seedingCleanup;
  const rule = policy.rules.find((value) => value.category === torrent.category);
  if (!rule || !torrentIsComplete(torrent)) return null;
  const reached = seedingLimitReached(rule, torrent, context.now);
  if (!reached) return null;
  const hash = normalizedHash(torrent.hash);
  const base = { rule: RULE, hash, title: torrent.name, category: torrent.category };
  const ignored = ignoredReason(config, torrent, policy.ignore, 'seeding cleanup ignore list');
  if (ignored) return { ...base, verdict: 'ignored', detail: ignored };
  if ((context.queueByHash.get(hash) ?? []).length) {
    return { ...base, verdict: 'preserved', detail: `It ${reached}, but Radarr/Sonarr still lists it in the queue, so its import has not finished.` };
  }
  if (rule.minSeeders > 0 && !(torrent.numComplete >= rule.minSeeders)) {
    return { ...base, verdict: 'preserved', detail: `It ${reached}, but the swarm has ${torrent.numComplete ?? 'an unknown number of'} seeders, fewer than the ${rule.minSeeders} this rule requires.` };
  }
  let freedBytes = 0;
  if (rule.deleteFiles) {
    const plan = await fileDeletionPlan(config, context.client, torrent);
    const problem = await fileDeletionProblem(config, torrent, plan, context);
    if (problem) return { ...base, verdict: 'preserved', detail: `It ${reached}, but its files were kept: ${problem}` };
    freedBytes = plan.lastCopyBytes;
  }
  const reason = `Category ${torrent.category === '' ? 'Uncategorized' : `"${torrent.category}"`} seeding rule: ${reached}.`;
  return {
    ...base,
    verdict: policy.dryRun ? 'would-act' : 'act',
    action: 'client-remove',
    deleteFiles: rule.deleteFiles,
    freedBytes,
    reason,
    detail: `${reason} ${policy.dryRun ? 'Would be' : 'Will be'} removed from qBittorrent${rule.deleteFiles ? ' with its files' : ', files kept'}.`,
  };
}

export async function revalidateSeeding(config, candidate, torrent, context) {
  if (!torrent) throw new Error('The torrent is no longer in qBittorrent; nothing was removed.');
  const verdict = await judgeSeeding(config, torrent, { ...context, commit: false });
  if (!verdict || !['act', 'would-act'].includes(verdict.verdict) || verdict.deleteFiles !== candidate.deleteFiles) {
    throw new Error(verdict?.detail ?? 'The torrent no longer meets its seeding rule, so it was preserved.');
  }
  return verdict;
}
