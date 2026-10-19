import path from 'node:path';
import { ignoredReason } from './download-ignore.mjs';
import { pathIsProtected, torrentIsComplete } from './qbittorrent.mjs';
import { fileDeletionPlan, fileDeletionProblem } from './torrent-files.mjs';

/**
 * Unlinked-torrent cleanup.
 *
 * A finished torrent whose media files have no other hardlink is no longer feeding the
 * library: Radarr or Sonarr upgraded the file, or it was deleted from the library. The
 * torrent is then only taking space. This rule removes such torrents with their files.
 *
 * Link counts alone cannot tell "replaced in the library" from "never imported", and
 * the second may be the only copy of something. So a torrent is removed only when
 * Radarr or Sonarr recorded importing it, which is the same proof seeding cleanup uses
 * before deleting a last copy.
 */
export const RULE = 'unlinked';

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function inScope(policy, torrent) {
  if (policy.categories.length && !policy.categories.includes(torrent.category)) return false;
  if (policy.tags.length) {
    const tags = new Set(torrent.tags.map((tag) => tag.toLowerCase()));
    if (!policy.tags.some((tag) => tags.has(tag))) return false;
  }
  return true;
}

export async function judgeUnlinked(config, torrent, context) {
  const policy = config.unlinkedCleanup;
  if (!torrentIsComplete(torrent) || !inScope(policy, torrent)) return null;
  const completedMs = (torrent.completionOn ?? 0) * 1000;
  if (!(completedMs > 0) || context.now - completedMs < policy.minCompletedHours * 3_600_000) return null;
  const hash = normalizedHash(torrent.hash);
  if ((context.queueByHash.get(hash) ?? []).length) return null;
  const plan = await fileDeletionPlan(config, context.client, torrent);
  if (!plan.media.length) return null;
  if (plan.media.some((entry) => entry.links > 1)) return null;
  const base = { rule: RULE, hash, title: torrent.name, category: torrent.category };
  if (policy.ignoredRoots.length && plan.files.some((entry) => pathIsProtected(entry.path, policy.ignoredRoots))) {
    return { ...base, verdict: 'ignored', detail: `It is inside an ignored folder (${policy.ignoredRoots.find((root) => plan.files.some((entry) => pathIsProtected(entry.path, [root])))}).` };
  }
  const ignored = ignoredReason(config, torrent, policy.ignore, 'unlinked cleanup ignore list');
  if (ignored) return { ...base, verdict: 'ignored', detail: ignored };
  const problem = await fileDeletionProblem(config, torrent, plan, context);
  if (problem) return { ...base, verdict: 'preserved', detail: `No longer hardlinked into a library, but kept: ${problem}` };
  const sample = path.basename(plan.media[0].path);
  const reason = `No longer hardlinked into any library: ${sample}${plan.media.length > 1 ? ` and ${plan.media.length - 1} more media file${plan.media.length === 2 ? '' : 's'}` : ''} ha${plan.media.length === 1 ? 's' : 've'} a single link, and Radarr/Sonarr recorded importing it.`;
  return {
    ...base,
    verdict: policy.dryRun ? 'would-act' : 'act',
    action: 'client-remove',
    deleteFiles: policy.deleteFiles,
    freedBytes: policy.deleteFiles ? plan.lastCopyBytes : 0,
    reason,
    detail: `${reason} ${policy.dryRun ? 'Would be' : 'Will be'} removed from qBittorrent${policy.deleteFiles ? ' with its files' : ', files kept'}.`,
  };
}

export async function revalidateUnlinked(config, candidate, torrent, context) {
  if (!torrent) throw new Error('The torrent is no longer in qBittorrent; nothing was removed.');
  const verdict = await judgeUnlinked(config, torrent, { ...context, commit: false });
  if (!verdict || !['act', 'would-act'].includes(verdict.verdict) || verdict.deleteFiles !== candidate.deleteFiles) {
    throw new Error(verdict?.detail ?? 'The torrent is linked into a library again or no longer qualifies, so it was preserved.');
  }
  return verdict;
}
