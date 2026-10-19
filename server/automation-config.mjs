import path from 'node:path';

/**
 * Validation and defaults for the download-cleanup automations.
 *
 * Each policy is persisted as one JSON setting and parsed here both when settings are
 * saved and when they are loaded, so the GUI and a hand-edited settings.json are held to
 * exactly the same rules. Every policy is off by default and starts in dry-run mode, so
 * turning one on shows what it would do before it does anything.
 */

// The list Cleanuparr shipped as its default "blacklist": file-name globs for
// executables, scripts, archives, samples and other content no media release needs.
export const CLEANUPARR_BLOCKLIST_URL = 'https://cleanuparr.pages.dev/static/blacklist';

function policyError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function objectValue(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw policyError(`${label} must be an object.`);
  return value;
}

function booleanValue(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw policyError(`${label} must be true or false.`);
  return value;
}

function numberValue(value, label, fallback, { min, max, integer = false }) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw policyError(`${label} must be a number.`);
  if (integer && !Number.isInteger(value)) throw policyError(`${label} must be a whole number.`);
  if (value < min || value > max) throw policyError(`${label} must be between ${min} and ${max}.`);
  return value;
}

// -1 is how Cleanuparr spelled "this limit is off", and keeping it lets a rule be
// switched off without forgetting its other values.
function limitValue(value, label, { min, max, integer = false }) {
  if (value === undefined || value === -1) return -1;
  return numberValue(value, label, -1, { min, max, integer });
}

function stringList(value, label, { maxItems = 100, maxLength = 256, allowEmpty = false, lower = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw policyError(`${label} must be a list of at most ${maxItems} entries.`);
  }
  const output = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || entry.length > maxLength || /[\r\n]/.test(entry)) {
      throw policyError(`${label} entry ${index + 1} must be a single line of at most ${maxLength} characters.`);
    }
    if (!allowEmpty && !entry.trim()) throw policyError(`${label} entry ${index + 1} cannot be empty.`);
    output.push(lower ? entry.trim().toLowerCase() : entry);
  }
  return [...new Set(output)];
}

function urlValue(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw policyError(`${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw policyError(`${label} must be a valid URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw policyError(`${label} must use http:// or https://.`);
  if (parsed.username || parsed.password) throw policyError(`${label} cannot contain embedded credentials.`);
  return trimmed;
}

/**
 * Categories match exactly, including case and spaces, the same way recovery's category
 * exclusions always have; `""` is Uncategorized. Tags are compared without case because
 * qBittorrent itself treats them that way. Hashes are lowercased.
 */
export function ignoreListPolicy(value, label = 'Ignore list') {
  const input = objectValue(value, label);
  const hashes = stringList(input.hashes, `${label} hashes`, { maxItems: 500, maxLength: 128, lower: true });
  if (hashes.some((hash) => !/^[0-9a-f]{32,64}$/.test(hash))) {
    throw policyError(`${label} hashes must be 32 to 64 hexadecimal characters.`);
  }
  return {
    categories: stringList(input.categories, `${label} categories`, { allowEmpty: true }),
    tags: stringList(input.tags, `${label} tags`, { lower: true }),
    hashes,
  };
}

export function failedImportPolicy(value) {
  const input = objectValue(value, 'Failed-import cleanup');
  return {
    enabled: booleanValue(input.enabled, 'Failed-import cleanup', false),
    dryRun: booleanValue(input.dryRun, 'Failed-import dry run', true),
    intervalMinutes: numberValue(input.intervalMinutes, 'Failed-import check interval', 5, { min: 1, max: 1440, integer: true }),
    maxStrikes: numberValue(input.maxStrikes, 'Failed-import strikes', 3, { min: 1, max: 100, integer: true }),
    forceImportAttempts: numberValue(input.forceImportAttempts, 'Forced import attempts', 3, { min: 0, max: 10, integer: true }),
    ignorePrivate: booleanValue(input.ignorePrivate, 'Ignore private torrents', true),
    deletePrivate: booleanValue(input.deletePrivate, 'Delete private torrents from qBittorrent', false),
    ignoredMessages: stringList(input.ignoredMessages, 'Ignored failed-import messages', { maxItems: 50, maxLength: 200 }),
    ignore: ignoreListPolicy(input.ignore, 'Failed-import ignore list'),
  };
}

export function contentBlockerPolicy(value) {
  const input = objectValue(value, 'Content blocker');
  const mode = input.mode ?? 'blocklist';
  if (!['blocklist', 'allowlist'].includes(mode)) throw policyError('Content blocker mode must be blocklist or allowlist.');
  return {
    enabled: booleanValue(input.enabled, 'Content blocker', false),
    dryRun: booleanValue(input.dryRun, 'Content blocker dry run', true),
    intervalSeconds: numberValue(input.intervalSeconds, 'Content blocker check interval', 60, { min: 10, max: 86400, integer: true }),
    mode,
    listUrl: urlValue(input.listUrl, 'Content blocker list URL', CLEANUPARR_BLOCKLIST_URL),
    refreshHours: numberValue(input.refreshHours, 'Content blocker list refresh', 6, { min: 1, max: 168, integer: true }),
    patterns: stringList(input.patterns, 'Content blocker patterns', { maxItems: 2000 }),
    ignorePrivate: booleanValue(input.ignorePrivate, 'Ignore private torrents', true),
    removeWhenAllBlocked: booleanValue(input.removeWhenAllBlocked, 'Remove torrents whose every file is blocked', true),
    syncExcludedFileNames: booleanValue(input.syncExcludedFileNames, 'Blocklist sync', false),
    ignore: ignoreListPolicy(input.ignore, 'Content blocker ignore list'),
  };
}

const MAX_SEEDING_RULES = 50;

export function seedingCleanupPolicy(value) {
  const input = objectValue(value, 'Seeding cleanup');
  const rawRules = input.rules ?? [];
  if (!Array.isArray(rawRules) || rawRules.length > MAX_SEEDING_RULES) {
    throw policyError(`Seeding cleanup must have at most ${MAX_SEEDING_RULES} category rules.`);
  }
  const seen = new Set();
  const rules = rawRules.map((raw, index) => {
    const label = `Seeding rule ${index + 1}`;
    const rule = objectValue(raw, label);
    if (typeof rule.category !== 'string' || rule.category.length > 256) {
      throw policyError(`${label} needs a category of at most 256 characters ("" is Uncategorized).`);
    }
    if (seen.has(rule.category)) throw policyError(`Seeding cleanup has two rules for category "${rule.category}".`);
    seen.add(rule.category);
    const maxSeedHours = limitValue(rule.maxSeedHours, `${label} maximum seed time`, { min: 0.1, max: 87600 });
    const minSeedHours = numberValue(rule.minSeedHours, `${label} minimum seed time`, 0, { min: 0, max: 87600 });
    if (maxSeedHours !== -1 && maxSeedHours < minSeedHours) {
      throw policyError(`${label} maximum seed time cannot be shorter than its minimum.`);
    }
    return {
      category: rule.category,
      maxRatio: limitValue(rule.maxRatio, `${label} maximum ratio`, { min: 0, max: 1000 }),
      minSeedHours,
      maxSeedHours,
      maxInactiveDays: limitValue(rule.maxInactiveDays, `${label} maximum inactive days`, { min: 0.1, max: 3650 }),
      minSeeders: numberValue(rule.minSeeders, `${label} minimum seeders`, 0, { min: 0, max: 10000, integer: true }),
      deleteFiles: booleanValue(rule.deleteFiles, `${label} delete files`, true),
    };
  });
  return {
    enabled: booleanValue(input.enabled, 'Seeding cleanup', false),
    dryRun: booleanValue(input.dryRun, 'Seeding cleanup dry run', true),
    intervalMinutes: numberValue(input.intervalMinutes, 'Seeding cleanup interval', 15, { min: 1, max: 1440, integer: true }),
    rules,
    ignore: ignoreListPolicy(input.ignore, 'Seeding cleanup ignore list'),
  };
}

export function unlinkedCleanupPolicy(value) {
  const input = objectValue(value, 'Unlinked-torrent cleanup');
  const ignoredRoots = stringList(input.ignoredRoots, 'Unlinked cleanup ignored folders', { maxItems: 50, maxLength: 4096 });
  for (const root of ignoredRoots) {
    if (!path.isAbsolute(root)) throw policyError('Unlinked cleanup ignored folders must be absolute paths.');
  }
  return {
    enabled: booleanValue(input.enabled, 'Unlinked-torrent cleanup', false),
    dryRun: booleanValue(input.dryRun, 'Unlinked cleanup dry run', true),
    intervalMinutes: numberValue(input.intervalMinutes, 'Unlinked cleanup interval', 60, { min: 5, max: 10080, integer: true }),
    categories: stringList(input.categories, 'Unlinked cleanup categories', { allowEmpty: true }),
    tags: stringList(input.tags, 'Unlinked cleanup tags', { lower: true }),
    ignoredRoots: ignoredRoots.map((root) => path.resolve(root)),
    minCompletedHours: numberValue(input.minCompletedHours, 'Unlinked cleanup minimum age', 24, { min: 0, max: 8760 }),
    deleteFiles: booleanValue(input.deleteFiles, 'Unlinked cleanup delete files', true),
    ignore: ignoreListPolicy(input.ignore, 'Unlinked cleanup ignore list'),
  };
}

/** Parses one persisted JSON policy, naming the setting in any error. */
export function parsePolicyJson(name, raw, parser) {
  if (raw === undefined || raw.trim() === '') return parser({});
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
  try {
    return parser(value);
  } catch (error) {
    throw new Error(`${name}: ${error.message}`);
  }
}
