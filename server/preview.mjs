import path from 'node:path';
import { DISTINCT, DUPLICATE, LINKED, verifyDuplicate } from './duplicates.mjs';
import { identifyOrphans } from './imports.mjs';
import { localOversizeCandidate } from './jobs.mjs';
import { assertNotRecentlyWatched } from './mediaserver.mjs';
import { assertCandidateUnchanged, assertQbittorrentSafe, quarantineDestination } from './orphans.mjs';
import { REPLACEMENT_AVAILABLE, findReplacements } from './replacements.mjs';

/**
 * Dry run. Evaluates the same gates a real job would, in the same order, and reports
 * each verdict without moving, deleting or downloading anything.
 *
 * Every helper used here is read-only: assertQbittorrentSafe and
 * assertCandidateUnchanged only stat and query, quarantineDestination is pure, and the
 * replacement check is an ordinary search. Nothing is written.
 *
 * A gate that throws is reported as a failure with its message, which is exactly what
 * the job would surface. A file is eligible only when no gate failed, so an unexpected
 * error reads as "would be preserved" rather than "would be removed".
 */

function gate(name, status, detail = null) {
  return { name, status, detail };
}

async function runGate(name, check) {
  try {
    const detail = await check();
    return gate(name, 'pass', typeof detail === 'string' ? detail : null);
  } catch (error) {
    return gate(name, 'fail', error instanceof Error ? error.message : String(error));
  }
}

// A real job names its quarantine subfolder after the job and item ids, which do not
// exist until the job is created. Showing an invented one would make the dry run lie
// about the path, so the segment is rendered as an explicit placeholder.
const RUN_PLACEHOLDER = '<run>';

function formatGib(bytes) {
  return `${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB`;
}

export async function previewOversized(config, candidates, {
  action = 'permanent',
  eligibleIds = null,
  checkReplacements = false,
} = {}) {
  const results = [];
  for (const candidate of candidates) {
    const gates = [];
    let destination = null;

    const connection = config[candidate.app];
    gates.push(connection?.configured
      ? gate('Application connected', 'pass', `${candidate.app} is configured.`)
      : gate('Application connected', 'fail', `${candidate.app} is not configured.`));

    if (eligibleIds) {
      gates.push(eligibleIds.has(candidate.id)
        ? gate('Still over its limit', 'pass', 'Confirmed by a fresh scan just now.')
        : gate('Still over its limit', 'fail', 'A fresh scan no longer reports this file as oversized.'));
    }

    if (action === 'quarantine') {
      const resolved = await runGate('Reachable inside a media root', async () => {
        const local = await localOversizeCandidate(candidate);
        destination = quarantineDestination(
          { ...config, orphanTrashDir: config.orphanTrashDir },
          local,
          RUN_PLACEHOLDER,
        );
        return `Would move to ${destination}`;
      });
      gates.push(resolved);
    } else {
      gates.push(gate('Recoverable afterwards', 'fail', 'Permanent removal cannot be undone from the Brig.'));
    }

    if (checkReplacements && connection?.configured) {
      const verdict = await findReplacements(connection, candidate);
      gates.push(verdict.status === REPLACEMENT_AVAILABLE
        ? gate('Compliant replacement available', 'pass',
          verdict.best ? `${verdict.best.title} (${formatGib(verdict.best.sizeBytes)})` : null)
        : gate('Compliant replacement available', config.oversizeRequireReplacement ? 'fail' : 'warn',
          verdict.reason));
    } else if (config.oversizeRequireReplacement) {
      gates.push(gate('Compliant replacement available', 'unknown',
        'Will be checked against your indexers immediately before removal. No compliant replacement means the file is preserved.'));
    }


    gates.push(config.mediaServer?.configured
      ? await runGate('Not recently watched', async () => {
        await assertNotRecentlyWatched(config, candidate);
        return `No play recorded in the last ${config.mediaServer.watchedWithinDays} day(s).`;
      })
      : gate('Not recently watched', 'warn', 'No media server is configured, so recent viewing cannot be ruled out.'));

    // 'warn' is advisory; only an outright failure makes a file ineligible.
    const blocking = gates.filter((entry) => entry.status === 'fail'
      && entry.name !== 'Recoverable afterwards');
    results.push({
      id: candidate.id,
      title: candidate.title,
      path: candidate.path,
      sizeBytes: candidate.sizeBytes,
      action,
      destination,
      eligible: blocking.length === 0,
      gates,
    });
  }
  return results;
}

export async function previewOrphans(config, candidates, { action = 'quarantine', eligibleIds = null } = {}) {
  const results = [];
  for (const candidate of candidates) {
    const gates = [];
    let destination = null;

    if (eligibleIds) {
      gates.push(eligibleIds.has(candidate.id)
        ? gate('Still untracked', 'pass', 'Confirmed by a fresh scan just now.')
        : gate('Still untracked', 'fail', 'A fresh scan no longer reports this file as untracked.'));
    }

    gates.push(await runGate('Unchanged since the scan', async () => {
      await assertCandidateUnchanged(candidate);
      return 'Inode, size, link count and modification time all still match.';
    }));

    gates.push(candidate.source === 'download' && config.qbittorrent?.configured
      ? await runGate('Not part of an incomplete torrent', async () => {
        await assertQbittorrentSafe(config, candidate);
        return 'qBittorrent reports no incomplete torrent covering this path.';
      })
      : gate('Not part of an incomplete torrent',
        candidate.source === 'download' ? 'warn' : 'pass',
        candidate.source === 'download'
          ? 'qBittorrent is not configured, so incomplete torrents cannot be ruled out.'
          : 'Library file, not a completed download.'));


    // A relink removes nothing, so what somebody watched last week has no bearing on it.
    gates.push(action === 'relink'
      ? gate('Not recently watched', 'pass', 'A relink removes nothing, so recent viewing does not matter.')
      : config.mediaServer?.configured
        ? await runGate('Not recently watched', async () => {
          await assertNotRecentlyWatched(config, candidate);
          return `No play recorded in the last ${config.mediaServer.watchedWithinDays} day(s).`;
        })
        : gate('Not recently watched', 'warn', 'No media server is configured, so recent viewing cannot be ruled out.'));

    if (action === 'relink') {
      // Read-only, like every other gate here: the pair is sampled, never rewritten. The
      // job itself hashes both files in full before it touches anything, so a pass here
      // is an invitation to try rather than a promise it will succeed.
      gates.push(await runGate('Identical to the library file', async () => {
        const identified = (await identifyOrphans(config[candidate.app], [candidate])).get(candidate.id);
        const verdict = await verifyDuplicate(candidate, identified, { mode: 'sampled' });
        if (verdict.status === LINKED) {
          throw new Error('This file already shares the library file\'s inode, so there is nothing to reclaim.');
        }
        if (verdict.status === DISTINCT) {
          throw new Error(`${verdict.reason} Relinking would replace this file with different data, so it was refused.`);
        }
        if (verdict.status !== DUPLICATE) throw new Error(verdict.reason);
        if (!verdict.relinkable) {
          throw new Error('The two files are on different filesystems, so they cannot share an inode.');
        }
        destination = verdict.libraryPath;
        return `Sampled contents match ${verdict.libraryPath}. The job re-hashes both files in full before acting.`;
      }));
      gates.push(gate('Recoverable afterwards', 'pass', 'Nothing is removed. The file keeps its path and contents and simply stops being a second copy.'));
    } else if (action === 'quarantine') {
      destination = quarantineDestination(config, candidate, RUN_PLACEHOLDER);
      gates.push(gate('Recoverable afterwards', 'pass', `Would move to ${destination}`));
    } else {
      gates.push(gate('Recoverable afterwards', 'fail', 'Permanent deletion cannot be undone from the Brig.'));
    }

    const blocking = gates.filter((entry) => entry.status === 'fail'
      && entry.name !== 'Recoverable afterwards');
    results.push({
      id: candidate.id,
      title: candidate.title,
      path: candidate.path,
      sizeBytes: candidate.sizeBytes,
      action,
      destination,
      eligible: blocking.length === 0,
      gates,
    });
  }
  return results;
}

export function summarizePreview(rows) {
  const eligible = rows.filter((row) => row.eligible);
  return {
    total: rows.length,
    eligibleCount: eligible.length,
    withheldCount: rows.length - eligible.length,
    eligibleBytes: eligible.reduce((sum, row) => sum + (Number(row.sizeBytes) || 0), 0),
    // "Nothing is irreversibly lost", which quarantine satisfies by keeping the file in
    // the Brig and a relink satisfies by not removing anything in the first place.
    recoverable: rows.length > 0 && rows.every((row) => row.action === 'quarantine' || row.action === 'relink'),
  };
}

export function previewDestinationRoot(config) {
  return config.orphanTrashDir ? path.resolve(config.orphanTrashDir) : null;
}
