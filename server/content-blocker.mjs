import { createHash } from 'node:crypto';
import { ignoredReason } from './download-ignore.mjs';
import { createJsonStore } from './state.mjs';

/**
 * The content blocker.
 *
 * New torrents are inspected as soon as qBittorrent knows their file list, and any file
 * whose name matches the blocklist - executables, shortcuts, scripts, archives, samples -
 * is set to "do not download". A torrent whose every file is blocked has nothing worth
 * keeping, so Radarr/Sonarr removes and blocklists it and searches again, through the
 * same pipeline as recovery. Names are all that can be checked: what is inside an
 * archive is unknowable until it has downloaded, which is why the default list blocks
 * archive types outright.
 */
export const RULE = 'content-blocked';
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const MAX_LIST_LINES = 20000;
const listStore = createJsonStore('content-blocklist.json', {
  version: 1, url: null, fetchedAt: null, lines: [], error: null,
});

function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function globToRegExp(glob) {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${source}$`, 'i');
}

/**
 * One pattern per line, the format Cleanuparr's list uses: `*` and `?` wildcards matched
 * against the file name without its folders and without case, or `regex:` followed by
 * a regular expression. Blank lines and `#` comments are skipped, and a regular
 * expression that does not compile is counted rather than allowed to break the list.
 */
export function compilePatterns(lines) {
  const patterns = [];
  let invalid = 0;
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line || line.startsWith('#')) continue;
    try {
      const expression = line.toLowerCase().startsWith('regex:')
        ? new RegExp(line.slice(6), 'i')
        : globToRegExp(line);
      patterns.push({ source: line, expression });
    } catch {
      invalid += 1;
    }
  }
  return { patterns, invalid };
}

function baseName(name) {
  return String(name).replaceAll('\\', '/').split('/').pop();
}

/** Which pattern blocks a file, or null. In allowlist mode, anything unmatched is blocked. */
export function blockingPattern(name, compiled, mode = 'blocklist') {
  const file = baseName(name);
  const match = compiled.patterns.find((pattern) => pattern.expression.test(file));
  if (mode === 'allowlist') return match ? null : 'not on the allowlist';
  return match ? match.source : null;
}

export function blocklistStatus() {
  const document = listStore.read();
  return { url: document.url, fetchedAt: document.fetchedAt, lineCount: document.lines.length, error: document.error };
}

async function fetchList(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`The blocklist URL returned HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_LIST_BYTES) throw new Error('The blocklist is larger than 2 MB, so it was not used.');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > MAX_LIST_LINES) throw new Error(`The blocklist has more than ${MAX_LIST_LINES} lines, so it was not used.`);
  return lines;
}

/**
 * The remote list, refreshed on its interval, plus any patterns typed into Settings.
 * A refresh that fails keeps the last good copy; with no copy at all the blocker has
 * nothing it can safely judge by and says so instead of blocking on half a list.
 */
export async function loadBlocklist(policy, { now = Date.now(), fetcher = fetchList } = {}) {
  let document = listStore.read();
  if (policy.listUrl) {
    const fetchedMs = Date.parse(document.fetchedAt ?? '');
    const stale = document.url !== policy.listUrl || !Number.isFinite(fetchedMs)
      || now - fetchedMs >= policy.refreshHours * 3_600_000;
    if (stale) {
      try {
        const lines = await fetcher(policy.listUrl);
        document = await listStore.update((next) => {
          next.url = policy.listUrl;
          next.fetchedAt = new Date(now).toISOString();
          next.lines = lines;
          next.error = null;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        document = await listStore.update((next) => {
          next.error = message;
        });
      }
    }
    if (document.url !== policy.listUrl) {
      throw new Error(`The blocklist at ${policy.listUrl} has not been downloaded yet${document.error ? `: ${document.error}` : '.'}`);
    }
  }
  const lines = [...(policy.listUrl ? document.lines : []), ...policy.patterns];
  const compiled = compilePatterns(lines);
  if (!compiled.patterns.length) throw new Error('The content blocker has no patterns to match against.');
  compiled.identity = createHash('sha256').update(JSON.stringify([policy.mode, lines])).digest('hex');
  return compiled;
}

/**
 * Judges one torrent's files. The file list is fetched only for torrents Arr is
 * downloading that are not yet finished, and each torrent is only inspected once per
 * version of the list; `inspected` remembers which.
 */
export async function judgeContent(config, torrent, context) {
  const policy = config.contentBlocker;
  const hash = normalizedHash(torrent.hash);
  const entries = context.queueByHash.get(hash) ?? [];
  if (!entries.length) return null;
  if (torrent.recoveryFieldsValid !== true || !(torrent.amount_left > 0 || torrent.progress < 1)) return null;
  if (['metaDL', 'forcedMetaDL'].includes(torrent.state)) return null;
  if (context.inspected?.get(hash) === context.blocklist.identity) return null;
  const base = { rule: RULE, hash, title: torrent.name, category: torrent.category, app: entries[0].app };
  const ignored = ignoredReason(config, torrent, policy.ignore, 'content blocker ignore list');
  if (ignored) return { ...base, verdict: 'ignored', detail: ignored };
  const isPrivate = await context.client.isPrivate(torrent) !== false;
  if (isPrivate && policy.ignorePrivate) {
    context.inspected?.set(hash, context.blocklist.identity);
    return { ...base, verdict: 'ignored', detail: 'It is from a private tracker (or its private flag could not be read), and private torrents are ignored.' };
  }

  const files = await context.client.files(torrent.hash);
  if (!files.length) return null;
  const blocked = files
    .map((file) => ({ ...file, pattern: blockingPattern(file.name, context.blocklist, policy.mode) }))
    .filter((file) => file.pattern);
  // Clean, or already handled: nothing more to look at until the list changes.
  const toSkip = blocked.filter((file) => file.priority !== 0);
  if (blocked.length < files.length && !toSkip.length) {
    if (context.commit) context.inspected?.set(hash, context.blocklist.identity);
    return null;
  }
  const example = `${baseName(blocked[0].name)} matches ${blocked[0].pattern}`;
  if (blocked.length === files.length && policy.removeWhenAllBlocked) {
    if (new Set(entries.map((entry) => entry.app)).size !== 1) {
      return { ...base, verdict: 'preserved', detail: 'Every file is blocked, but more than one Radarr/Sonarr app lists this download, so which one owns it is unclear.' };
    }
    const reason = `Every one of its ${files.length} file${files.length === 1 ? ' is' : 's are'} blocked (${example}).`;
    return {
      ...base,
      verdict: policy.dryRun ? 'would-act' : 'act',
      action: 'arr-remove',
      keepInClient: false,
      isPrivate,
      blockedFiles: blocked.slice(0, 20).map((file) => ({ name: file.name, pattern: file.pattern })),
      reason,
      detail: `${reason} ${policy.dryRun ? 'Would be' : 'Will be'} removed, blocklisted, and searched for again.`,
    };
  }
  if (!toSkip.length) {
    if (context.commit) context.inspected?.set(hash, context.blocklist.identity);
    return null;
  }
  const reason = `${toSkip.length} of its ${files.length} files ${toSkip.length === 1 ? 'is' : 'are'} blocked (${example}).`;
  return {
    ...base,
    verdict: policy.dryRun ? 'would-act' : 'act',
    action: 'skip-files',
    fileIndexes: toSkip.map((file) => file.index),
    blockedFiles: toSkip.slice(0, 20).map((file) => ({ name: file.name, pattern: file.pattern })),
    reason,
    detail: `${reason} ${policy.dryRun ? 'Would be' : 'Will be'} set to do not download; the rest of the torrent carries on.`,
  };
}

export async function revalidateContent(config, candidate, torrent, context) {
  if (!torrent) throw new Error('The torrent is no longer in qBittorrent; nothing was changed.');
  if (ignoredReason(config, torrent, config.contentBlocker.ignore, 'content blocker ignore list')) {
    throw new Error('The download is now on an ignore list, so it was preserved.');
  }
  // Re-judged from scratch against the current list and files, ignoring the cache. The
  // list itself comes from the stored copy unless it is due a refresh anyway.
  const blocklist = context.blocklist ?? await loadBlocklist(config.contentBlocker);
  const verdict = await judgeContent(config, torrent, { ...context, blocklist, inspected: null, commit: false });
  if (!verdict || verdict.action !== candidate.action) {
    throw new Error('The torrent\'s files no longer match what was blocked, so nothing was changed.');
  }
  if (candidate.action === 'skip-files') {
    const current = new Set(verdict.fileIndexes);
    if (!candidate.fileIndexes.every((index) => current.has(index))) {
      throw new Error('The blocked files changed after detection, so nothing was changed.');
    }
  }
  return verdict;
}

/**
 * Blocklist sync: qBittorrent's own "excluded file names" skips matching files in every
 * new torrent before a byte is downloaded. Only wildcard patterns carry over, because
 * qBittorrent does not understand `regex:` lines. Returns what changed, or would.
 */
export async function syncExcludedFileNames(client, compiled, { dryRun }) {
  const wanted = compiled.patterns
    .map((pattern) => pattern.source)
    .filter((source) => !source.toLowerCase().startsWith('regex:'))
    .join('\n');
  const preferences = await client.preferences();
  const current = typeof preferences?.excluded_file_names === 'string' ? preferences.excluded_file_names : '';
  if (preferences?.excluded_file_names_enabled === true && current.trim() === wanted) return { changed: false };
  if (!dryRun) await client.setPreferences({ excluded_file_names_enabled: true, excluded_file_names: wanted });
  return { changed: true, count: wanted ? wanted.split('\n').length : 0 };
}
