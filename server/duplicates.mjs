import { DIFFERENT, IDENTICAL, SAME_INODE, compareFiles } from './hardlinks.mjs';
import { OCCUPIED } from './imports.mjs';

/**
 * Turns "the library already has this" into "the library already has these exact bytes".
 *
 * Identification answers the question by name: the release parses to a movie, and that
 * movie has a tracked file. That is enough to know the untracked copy is spare, but not
 * enough to know it is the *same* copy - a 1080p WEBRip and a 2160p remux of one film
 * both report as spare. The difference decides what can be done about it: a genuinely
 * identical pair can be collapsed into one inode and the space handed back, while a
 * different release can only be deleted or kept.
 */

export const DUPLICATE = 'duplicate';
export const DISTINCT = 'distinct';
export const LINKED = 'linked';
export const UNVERIFIED = 'unverified';
export const NOT_APPLICABLE = 'not-applicable';

/** The library file an identification points at, or null when it cannot be reached. */
export function libraryTwinPath(identification) {
  if (identification?.status !== OCCUPIED) return null;
  const localPath = identification?.existing?.localPath;
  return typeof localPath === 'string' && localPath ? localPath : null;
}

function result(candidateId, status, reason, extra = {}) {
  return {
    id: candidateId,
    status,
    reason,
    libraryPath: null,
    mode: null,
    reclaimableBytes: 0,
    relinkable: false,
    ...extra,
  };
}

/**
 * Compares one untracked file with the library file that occupies its slot.
 *
 * `mode` is passed straight through to the comparison, so a scan can afford the size
 * check on every row while a deliberate check on a handful of rows can afford to read
 * them. Nothing here is ever strong enough to authorise a replacement on its own: the
 * relink re-hashes both files in full at the moment it acts.
 */
export async function verifyDuplicate(candidate, identification, { mode = 'size', signal } = {}) {
  if (identification?.status !== OCCUPIED) {
    return result(candidate.id, NOT_APPLICABLE, 'The library has no tracked file for this, so there is nothing to compare it with.');
  }
  const libraryPath = libraryTwinPath(identification);
  if (!libraryPath) {
    return result(candidate.id, UNVERIFIED, 'The library file could not be located on disk; check path mappings for this application.');
  }

  const comparison = await compareFiles(candidate.path, libraryPath, { mode, signal });
  const shared = { libraryPath, mode: comparison.mode };

  if (comparison.status === SAME_INODE) {
    return result(candidate.id, LINKED, 'This file and the library file are already one inode, so it is costing no extra space.', shared);
  }
  if (comparison.status === DIFFERENT) {
    return result(candidate.id, DISTINCT, comparison.reason, shared);
  }
  if (comparison.status === IDENTICAL) {
    return result(candidate.id, DUPLICATE, comparison.reason, {
      ...shared,
      // Only the blocks this file alone is holding come back, and only if the two sit on
      // one filesystem - otherwise they cannot be collapsed into one inode at all.
      reclaimableBytes: comparison.first.linkCount === 1 ? comparison.first.sizeBytes : 0,
      relinkable: comparison.sameDevice === true,
      sameDevice: comparison.sameDevice === true,
    });
  }
  return result(candidate.id, UNVERIFIED, comparison.reason, shared);
}

/**
 * The scan-wide pass. Bounded by `limit` because reading file contents is the one part
 * of a scan whose cost scales with the size of the library rather than its length.
 */
export async function verifyDuplicates(candidates, identifications, { mode = 'size', limit = 0, signal } = {}) {
  if (!candidates?.length) return [];
  const byId = new Map((identifications ?? []).map((entry) => [entry.id, entry]));
  const eligible = candidates.filter((candidate) => byId.get(candidate.id)?.status === OCCUPIED);
  const queue = limit > 0 ? eligible.slice(0, limit) : eligible;

  const verdicts = [];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const candidate = queue.shift();
      if (!candidate) return;
      verdicts.push(await verifyDuplicate(candidate, byId.get(candidate.id), { mode, signal }));
    }
  });
  await Promise.all(workers);
  return verdicts;
}

export function summarizeDuplicates(verdicts) {
  const duplicates = (verdicts ?? []).filter((verdict) => verdict.status === DUPLICATE);
  return {
    checked: verdicts?.length ?? 0,
    duplicates: duplicates.length,
    relinkable: duplicates.filter((verdict) => verdict.relinkable).length,
    reclaimableBytes: duplicates.reduce((total, verdict) => total + (verdict.reclaimableBytes ?? 0), 0),
  };
}
