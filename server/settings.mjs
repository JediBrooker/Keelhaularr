import { randomBytes, randomUUID } from 'node:crypto';
import { constants, accessSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { hashPassword, isHashedPassword } from './passwords.mjs';

const SETTINGS_KEYS = new Set([
  'APP_USERNAME', 'APP_PASSWORD', 'APP_SESSION_SECRET', 'APP_SESSION_DAYS', 'APP_COOKIE_SECURE',
  'MAX_MB_PER_MIN', 'OVERSIZE_TOLERANCE_GIB',
  'RADARR_URL', 'RADARR_API_KEY', 'RADARR_MAX_MB_PER_MIN', 'RADARR_OVERSIZE_TOLERANCE_GIB',
  'RADARR_USE_ARR_QUALITY_DEFINITIONS', 'RADARR_INCLUDE_UNMONITORED', 'RADARR_MEDIA_ROOTS', 'RADARR_DOWNLOAD_ROOTS', 'RADARR_PATH_MAPS',
  'SONARR_URL', 'SONARR_API_KEY', 'SONARR_MAX_MB_PER_MIN', 'SONARR_OVERSIZE_TOLERANCE_GIB',
  'SONARR_USE_ARR_QUALITY_DEFINITIONS', 'SONARR_INCLUDE_UNMONITORED', 'SONARR_MEDIA_ROOTS', 'SONARR_DOWNLOAD_ROOTS', 'SONARR_PATH_MAPS',
  'QBITTORRENT_URL', 'QBITTORRENT_USERNAME', 'QBITTORRENT_PASSWORD', 'QBITTORRENT_PATH_MAPS',
  'MEDIA_SERVER_TYPE', 'MEDIA_SERVER_URL', 'MEDIA_SERVER_TOKEN', 'MEDIA_SERVER_PATH_MAPS',
  'MEDIA_SERVER_WATCHED_WITHIN_DAYS',
  'RADARR_SIZE_RULES_JSON', 'SONARR_SIZE_RULES_JSON',
  'QBITTORRENT_RECOVERY_ENABLED', 'QBITTORRENT_RECOVERY_SLOW_KIB_PER_SECOND',
  'QBITTORRENT_RECOVERY_SLOW_MINUTES', 'QBITTORRENT_RECOVERY_STALLED_MINUTES',
  'QBITTORRENT_RECOVERY_EXCLUDED_CATEGORIES_JSON',
  'ORPHAN_ACTION', 'ORPHAN_TRASH_DIR', 'ALLOW_PERMANENT_ORPHAN_DELETE',
  'ORPHAN_IGNORE_DIRECTORIES', 'ORPHAN_MAX_FILES', 'MEDIA_EXTENSIONS', 'HARDLINK_MIN_AGE_HOURS',
  'QUARANTINE_RETENTION_DAYS', 'OVERSIZE_REQUIRE_REPLACEMENT',
  'SCHEDULE_ENABLED', 'SCHEDULE_INTERVAL_HOURS',
  'NOTIFICATION_TYPE', 'NOTIFICATION_WEBHOOK_URL', 'NOTIFICATION_WHEN_CLEAR',
]);

const configDirectory = path.resolve(process.env.CONFIG_DIR || path.join(process.cwd(), 'config'));
const settingsPath = path.join(configDirectory, 'settings.json');
let settingsOverrides = loadStoredSettings();
let writeQueue = Promise.resolve();

function inputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

function loadStoredSettings() {
  let document;
  try {
    document = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read persisted settings at ${settingsPath}: ${error.message}`);
  }
  if (!document || document.version !== 1 || !document.values || typeof document.values !== 'object' || Array.isArray(document.values)) {
    throw new Error(`Persisted settings at ${settingsPath} have an unsupported format.`);
  }
  const values = {};
  for (const [key, value] of Object.entries(document.values)) {
    if (!SETTINGS_KEYS.has(key) || typeof value !== 'string') {
      throw new Error(`Persisted setting ${key} is not supported.`);
    }
    values[key] = value;
  }
  return values;
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) inputError(`${label} settings are required.`);
  return value;
}

function stringValue(value, label, { allowEmpty = false, max = 4096 } = {}) {
  if (typeof value !== 'string') inputError(`${label} must be text.`);
  const output = value.trim();
  if (!allowEmpty && !output) inputError(`${label} cannot be empty.`);
  if (output.length > max) inputError(`${label} is too long.`);
  if (output.includes('\n') || output.includes('\r')) inputError(`${label} cannot contain line breaks.`);
  return output;
}

function secretValue(value, label, { allowEmpty = false, max = 4096 } = {}) {
  if (typeof value !== 'string') inputError(`${label} must be text.`);
  if (!allowEmpty && !value) inputError(`${label} cannot be empty.`);
  if (value.length > max) inputError(`${label} is too long.`);
  if (value.includes('\n') || value.includes('\r')) inputError(`${label} cannot contain line breaks.`);
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== 'boolean') inputError(`${label} must be on or off.`);
  return value;
}

function configuredBoolean(key, values, fallback = false) {
  const raw = Object.hasOwn(values, key) ? values[key] : process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function configuredNumber(key, values, fallback) {
  const raw = Object.hasOwn(values, key) ? values[key] : process.env[key];
  const value = Number(raw);
  return raw === undefined || raw === '' || !Number.isFinite(value) ? fallback : value;
}

function configuredString(key, values, fallback = '') {
  return Object.hasOwn(values, key) ? values[key] : process.env[key] ?? fallback;
}

function numberValue(value, label, { min, max, integer = false }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) inputError(`${label} must be a number.`);
  if (integer && !Number.isInteger(value)) inputError(`${label} must be a whole number.`);
  if (value < min || value > max) inputError(`${label} must be between ${min} and ${max}.`);
  return value;
}

function optionalNumber(value, label, options) {
  if (value === null) return null;
  return numberValue(value, label, options);
}

function urlValue(value, label) {
  const output = stringValue(value, label, { allowEmpty: true, max: 2048 }).replace(/\/+$/, '');
  if (!output) return '';
  let parsed;
  try {
    parsed = new URL(output);
  } catch {
    inputError(`${label} must be a valid URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) inputError(`${label} must use http:// or https://.`);
  if (parsed.username || parsed.password) inputError(`${label} cannot contain embedded credentials.`);
  return output;
}

function stringArray(value, label, { maxItems = 100 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) inputError(`${label} must contain at most ${maxItems} entries.`);
  return [...new Set(value.map((item, index) => stringValue(item, `${label} entry ${index + 1}`, { max: 4096 })) )];
}

function exactCategoryArray(value, label) {
  if (!Array.isArray(value) || value.length > 100) {
    inputError(`${label} must contain at most 100 entries.`);
  }
  for (const [index, category] of value.entries()) {
    if (typeof category !== 'string' || category.length > 256) {
      inputError(`${label} entry ${index + 1} must be a string of at most 256 characters.`);
    }
  }
  if (new Set(value).size !== value.length) inputError(`${label} cannot contain duplicate categories.`);
  return [...value];
}

function mediaRoots(value, label) {
  const roots = stringArray(value, label, { maxItems: 50 });
  for (const root of roots) {
    if (!path.isAbsolute(root)) inputError(`${label} entries must be absolute container paths.`);
    if (root.includes(',')) inputError(`${label} entries cannot contain commas.`);
    try {
      if (!statSync(root).isDirectory()) inputError(`${root} is not a directory.`);
      accessSync(root, constants.R_OK | constants.W_OK);
    } catch (error) {
      if (error.statusCode) throw error;
      inputError(`${root} is not a readable and writable directory inside Keelhaularr.`);
    }
  }
  return roots;
}

function pathMappings(value, label) {
  if (!Array.isArray(value) || value.length > 50) inputError(`${label} must contain at most 50 mappings.`);
  return value.map((entry, index) => {
    const item = requiredObject(entry, `${label} mapping ${index + 1}`);
    const from = stringValue(item.from, `${label} source ${index + 1}`);
    const to = stringValue(item.to, `${label} destination ${index + 1}`);
    if (from.includes(';') || from.includes('=>') || to.includes(';') || to.includes('=>')) {
      inputError(`${label} mappings cannot contain semicolons or =>.`);
    }
    if (!path.isAbsolute(to)) inputError(`${label} destinations must be absolute container paths.`);
    return { from, to: path.resolve(to) };
  });
}

function pathsOverlap(first, second) {
  const relative = path.relative(first, second);
  const reverse = path.relative(second, first);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
    || (!reverse.startsWith('..') && !path.isAbsolute(reverse));
}

function connectionOverrides(kind, input, output) {
  const label = kind === 'radarr' ? 'Radarr' : 'Sonarr';
  const prefix = kind.toUpperCase();
  const settings = requiredObject(input, label);
  const roots = mediaRoots(settings.mediaRoots, `${label} media roots`);
  const downloadRoots = mediaRoots(settings.downloadRoots, `${label} completed-download roots`);
  const mappings = pathMappings(settings.pathMaps, `${label} path maps`);
  const apiKey = stringValue(settings.apiKey ?? '', `${label} API key`, { allowEmpty: true, max: 1024 });
  const clearApiKey = booleanValue(settings.clearApiKey ?? false, `${label} clear API key`);
  if (apiKey && clearApiKey) inputError(`${label} API key cannot be replaced and cleared at the same time.`);

  output[`${prefix}_URL`] = urlValue(settings.url, `${label} URL`);
  output[`${prefix}_MAX_MB_PER_MIN`] = optionalNumber(
    settings.maxMbPerMinuteOverride,
    `${label} MB/min override`,
    { min: 0.01, max: 10000 },
  )?.toString() ?? '';
  output[`${prefix}_OVERSIZE_TOLERANCE_GIB`] = optionalNumber(
    settings.toleranceGibOverride,
    `${label} tolerance override`,
    { min: 0, max: 1000 },
  )?.toString() ?? '';
  output[`${prefix}_INCLUDE_UNMONITORED`] = String(booleanValue(settings.includeUnmonitored, `${label} include unmonitored`));
  output[`${prefix}_USE_ARR_QUALITY_DEFINITIONS`] = String(booleanValue(
    settings.useArrQualityDefinitions ?? configuredBoolean(`${prefix}_USE_ARR_QUALITY_DEFINITIONS`, output),
    `${label} use quality definitions`,
  ));
  output[`${prefix}_MEDIA_ROOTS`] = roots.join(',');
  output[`${prefix}_DOWNLOAD_ROOTS`] = downloadRoots.join(',');
  output[`${prefix}_PATH_MAPS`] = mappings.map(({ from, to }) => `${from}=>${to}`).join(';');
  output[`${prefix}_SIZE_RULES_JSON`] = sizeRulesValue(settings.sizeRules, label);
  if (apiKey) output[`${prefix}_API_KEY`] = apiKey;
  if (clearApiKey) output[`${prefix}_API_KEY`] = '';
  return { mediaRoots: roots, downloadRoots };
}

function mediaServerOverrides(input, output) {
  if (input === undefined) return;
  const settings = requiredObject(input, 'Media server');
  const kind = stringValue(settings.kind ?? 'jellyfin', 'Media server type', { max: 32 }).toLowerCase();
  if (!['plex', 'jellyfin', 'emby'].includes(kind)) {
    inputError('Media server type must be Plex, Jellyfin, or Emby.');
  }
  const token = secretValue(settings.token ?? '', 'Media server token', { allowEmpty: true, max: 1024 });
  const clearToken = booleanValue(settings.clearToken ?? false, 'Media server clear token');
  if (token && clearToken) inputError('The media-server token cannot be replaced and cleared at the same time.');
  const nextUrl = urlValue(settings.url, 'Media server URL');
  const currentUrl = configuredString('MEDIA_SERVER_URL', output).replace(/\/+$/, '');
  const currentToken = configuredString('MEDIA_SERVER_TOKEN', output);
  // Re-authenticate when the target changes, so a token is never replayed at a
  // different server than the one it was entered for.
  if (nextUrl !== currentUrl && currentToken && !token && !clearToken) {
    inputError('Enter the media-server token again when changing its URL.');
  }

  output.MEDIA_SERVER_TYPE = kind;
  output.MEDIA_SERVER_URL = nextUrl;
  output.MEDIA_SERVER_PATH_MAPS = pathMappings(settings.pathMaps, 'Media server path maps')
    .map(({ from, to }) => `${from}=>${to}`).join(';');
  output.MEDIA_SERVER_WATCHED_WITHIN_DAYS = numberValue(
    settings.watchedWithinDays ?? 30,
    'Recently-watched window',
    { min: 1, max: 3650, integer: true },
  ).toString();
  if (token) output.MEDIA_SERVER_TOKEN = token;
  if (clearToken) output.MEDIA_SERVER_TOKEN = '';
}

function qbittorrentOverrides(input, output) {
  if (input === undefined) return;
  const settings = requiredObject(input, 'qBittorrent');
  const password = secretValue(settings.password ?? '', 'qBittorrent password', { allowEmpty: true, max: 1024 });
  const clearPassword = booleanValue(settings.clearPassword ?? false, 'qBittorrent clear password');
  if (password && clearPassword) inputError('qBittorrent password cannot be replaced and cleared at the same time.');
  const mappings = pathMappings(settings.pathMaps, 'qBittorrent path maps');
  const nextUrl = urlValue(settings.url, 'qBittorrent URL');
  const nextUsername = stringValue(settings.username ?? '', 'qBittorrent username', { allowEmpty: true, max: 1024 });
  const currentUrl = configuredString('QBITTORRENT_URL', output).replace(/\/+$/, '');
  const currentUsername = configuredString('QBITTORRENT_USERNAME', output);
  const currentPassword = configuredString('QBITTORRENT_PASSWORD', output);
  if ((nextUrl !== currentUrl || nextUsername !== currentUsername)
    && currentPassword && !password && !clearPassword) {
    inputError('Enter the qBittorrent password again when changing its URL or username.');
  }

  output.QBITTORRENT_URL = nextUrl;
  output.QBITTORRENT_USERNAME = nextUsername;
  output.QBITTORRENT_PATH_MAPS = mappings.map(({ from, to }) => `${from}=>${to}`).join(';');
  if (password) output.QBITTORRENT_PASSWORD = password;
  if (clearPassword) output.QBITTORRENT_PASSWORD = '';

  if (settings.recovery !== undefined) {
    const recovery = requiredObject(settings.recovery, 'qBittorrent automatic recovery');
    output.QBITTORRENT_RECOVERY_ENABLED = String(booleanValue(
      recovery.enabled, 'qBittorrent automatic recovery',
    ));
    output.QBITTORRENT_RECOVERY_SLOW_KIB_PER_SECOND = numberValue(
      recovery.slowSpeedKibPerSecond,
      'qBittorrent slow-speed threshold',
      { min: 0, max: 1048576, integer: true },
    ).toString();
    output.QBITTORRENT_RECOVERY_SLOW_MINUTES = numberValue(
      recovery.slowMinutes,
      'qBittorrent slow duration',
      { min: 1, max: 10080, integer: true },
    ).toString();
    output.QBITTORRENT_RECOVERY_STALLED_MINUTES = numberValue(
      recovery.stalledMinutes,
      'qBittorrent stalled duration',
      { min: 1, max: 10080, integer: true },
    ).toString();
    output.QBITTORRENT_RECOVERY_EXCLUDED_CATEGORIES_JSON = JSON.stringify(exactCategoryArray(
      recovery.excludedCategories,
      'qBittorrent recovery excluded categories',
    ));
  }
}

export function getSettingsOverrides() {
  return { ...settingsOverrides };
}

export function buildQbittorrentTestConnection(input, currentConfig) {
  const settings = requiredObject(input, 'qBittorrent');
  const url = urlValue(settings.url, 'qBittorrent URL');
  if (!url) inputError('qBittorrent URL cannot be empty.');
  const username = stringValue(settings.username ?? '', 'qBittorrent username', { allowEmpty: true, max: 1024 });
  const enteredPassword = secretValue(settings.password ?? '', 'qBittorrent password', { allowEmpty: true, max: 1024 });
  let password = enteredPassword;
  if (!password && currentConfig.password) {
    if (url !== currentConfig.url || username !== currentConfig.username) {
      inputError('Enter the qBittorrent password to test a different URL or username.');
    }
    password = currentConfig.password;
  }
  const mappings = settings.pathMaps === undefined
    ? currentConfig.pathMaps
    : pathMappings(settings.pathMaps, 'qBittorrent path maps');
  return { url, username, password, configured: true, pathMaps: mappings };
}

const MAX_SIZE_RULES = 50;

function sizeRulesValue(value, label) {
  if (value === undefined || value === null || value === '') return '';
  if (!Array.isArray(value)) inputError(`${label} size rules must be a list.`);
  if (!value.length) return '';
  if (value.length > MAX_SIZE_RULES) inputError(`${label} allows at most ${MAX_SIZE_RULES} size rules.`);

  const rules = value.map((entry, index) => {
    const position = `${label} size rule ${index + 1}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) inputError(`${position} must be an object.`);
    const optionalText = (field, name) => {
      const candidate = entry[field];
      if (candidate === undefined || candidate === null || candidate === '') return undefined;
      return stringValue(candidate, `${position} ${name}`, { max: 256 });
    };
    const tag = optionalText('tag', 'tag');
    const root = optionalText('root', 'root');
    const quality = optionalText('quality', 'quality');
    if (!tag && !root && !quality) {
      inputError(`${position} must match on at least one of tag, folder or quality.`);
    }
    if (root && !path.isAbsolute(root)) inputError(`${position} folder must be an absolute container path.`);
    const rule = {
      maxMbPerMinute: numberValue(entry.maxMbPerMinute, `${position} MB/min`, { min: 0.01, max: 10000 }),
      toleranceGib: numberValue(entry.toleranceGib ?? 0, `${position} tolerance`, { min: 0, max: 1000 }),
    };
    if (entry.label) rule.label = stringValue(entry.label, `${position} name`, { max: 120 });
    if (tag) rule.tag = tag;
    if (root) rule.root = root;
    if (quality) rule.quality = quality;
    return rule;
  });
  return JSON.stringify(rules);
}

export function settingsView(config) {
  const connection = (value) => ({
    url: value.url,
    apiKeyConfigured: Boolean(value.apiKey),
    maxMbPerMinuteOverride: value.maxMbPerMinuteOverride,
    toleranceGibOverride: value.toleranceGibOverride,
    useArrQualityDefinitions: value.useArrQualityDefinitions,
    includeUnmonitored: value.includeUnmonitored,
    mediaRoots: value.mediaRoots,
    downloadRoots: value.downloadRoots,
    pathMaps: value.pathMaps,
    sizeRules: (value.sizeRules ?? []).map((rule) => ({
      label: rule.label,
      tag: rule.tag,
      root: rule.root,
      quality: rule.quality,
      maxMbPerMinute: rule.maxMbPerMinute,
      toleranceGib: rule.toleranceGib,
    })),
  });
  return {
    account: {
      username: config.username,
      passwordConfigured: Boolean(config.password),
      sessionDays: config.sessionDays,
      cookieSecure: config.cookieSecure,
    },
    defaults: config.defaults,
    radarr: connection(config.radarr),
    sonarr: connection(config.sonarr),
    qbittorrent: {
      url: config.qbittorrent.url,
      username: config.qbittorrent.username,
      passwordConfigured: Boolean(config.qbittorrent.password),
      pathMaps: config.qbittorrent.pathMaps,
      recovery: { ...config.qbittorrent.recovery },
    },
    mediaServer: {
      kind: config.mediaServer?.kind ?? 'jellyfin',
      url: config.mediaServer?.url ?? '',
      tokenConfigured: Boolean(config.mediaServer?.token),
      pathMaps: config.mediaServer?.pathMaps ?? [],
      watchedWithinDays: config.mediaServer?.watchedWithinDays ?? 30,
    },
    orphan: {
      trashDir: config.orphanTrashDir ?? '',
      ignoreDirectories: config.customIgnoreDirectories,
      maxFiles: config.maxFiles,
      mediaExtensions: config.mediaExtensions,
      hardlinkMinAgeHours: config.hardlinkMinAgeHours,
      retentionDays: config.quarantineRetentionDays,
      requireReplacement: config.oversizeRequireReplacement,
    },
    schedule: {
      enabled: config.schedule.enabled,
      intervalHours: config.schedule.intervalHours,
      notificationType: config.schedule.notificationType,
      webhookConfigured: Boolean(config.schedule.webhookUrl),
      notifyWhenClear: config.schedule.notifyWhenClear,
    },
    server: {
      port: config.port,
      portManagedByDocker: Boolean(process.env.CONFIG_DIR),
      storageRoots: config.storageRoots,
    },
  };
}

export function buildSettingsOverrides(input, currentOverrides) {
  const root = requiredObject(input, 'Settings');
  const account = requiredObject(root.account, 'Account');
  const defaults = requiredObject(root.defaults, 'Default size');
  const orphan = requiredObject(root.orphan, 'Orphan');
  const output = { ...currentOverrides };
  const schedule = root.schedule === undefined ? {
    enabled: configuredBoolean('SCHEDULE_ENABLED', output),
    intervalHours: configuredNumber('SCHEDULE_INTERVAL_HOURS', output, 24),
    notificationType: output.NOTIFICATION_TYPE ?? process.env.NOTIFICATION_TYPE ?? 'generic',
    webhookUrl: '',
    clearWebhook: false,
    notifyWhenClear: configuredBoolean('NOTIFICATION_WHEN_CLEAR', output),
  } : requiredObject(root.schedule, 'Schedule');

  output.APP_USERNAME = stringValue(account.username, 'Login username', { max: 128 });
  output.APP_SESSION_DAYS = numberValue(account.sessionDays, 'Session lifetime', { min: 1, max: 365, integer: true }).toString();
  output.APP_COOKIE_SECURE = String(booleanValue(account.cookieSecure, 'Secure cookie'));
  const newPassword = secretValue(account.newPassword ?? '', 'New password', { allowEmpty: true, max: 1024 });
  // Persisted hashed, never in the clear. config/settings.json is 0600 in a 0700
  // directory, but it also lands in every backup and bind mount of the config
  // volume, and people reuse this password elsewhere.
  if (newPassword) output.APP_PASSWORD = hashPassword(newPassword);
  if (booleanValue(account.rotateSessions ?? false, 'Rotate sessions')) {
    output.APP_SESSION_SECRET = randomBytes(32).toString('hex');
  }

  output.MAX_MB_PER_MIN = numberValue(defaults.maxMbPerMinute, 'Default maximum MB/min', { min: 0.01, max: 10000 }).toString();
  output.OVERSIZE_TOLERANCE_GIB = numberValue(defaults.toleranceGib, 'Default oversize tolerance', { min: 0, max: 1000 }).toString();
  const radarrPaths = connectionOverrides('radarr', root.radarr, output);
  const sonarrPaths = connectionOverrides('sonarr', root.sonarr, output);
  qbittorrentOverrides(root.qbittorrent, output);
  mediaServerOverrides(root.mediaServer, output);
  if (configuredBoolean('QBITTORRENT_RECOVERY_ENABLED', output)) {
    if (!configuredString('QBITTORRENT_URL', output).trim()) {
      inputError('qBittorrent automatic recovery requires a configured qBittorrent connection.');
    }
    const radarrConfigured = Boolean(
      configuredString('RADARR_URL', output).trim() && configuredString('RADARR_API_KEY', output).trim(),
    );
    const sonarrConfigured = Boolean(
      configuredString('SONARR_URL', output).trim() && configuredString('SONARR_API_KEY', output).trim(),
    );
    if (!radarrConfigured && !sonarrConfigured) {
      inputError('qBittorrent automatic recovery requires at least one configured Arr connection.');
    }
  }
  const scanRoots = [
    ...radarrPaths.mediaRoots.map((value) => ({ label: 'Radarr media root', value })),
    ...radarrPaths.downloadRoots.map((value) => ({ label: 'Radarr completed-download root', value })),
    ...sonarrPaths.mediaRoots.map((value) => ({ label: 'Sonarr media root', value })),
    ...sonarrPaths.downloadRoots.map((value) => ({ label: 'Sonarr completed-download root', value })),
  ];
  for (let first = 0; first < scanRoots.length; first += 1) {
    for (let second = first + 1; second < scanRoots.length; second += 1) {
      if (pathsOverlap(scanRoots[first].value, scanRoots[second].value)) {
        inputError(`${scanRoots[first].label} and ${scanRoots[second].label} must be separate and cannot contain one another.`);
      }
    }
  }

  const trashDir = stringValue(orphan.trashDir, 'Quarantine directory', { allowEmpty: true });
  if (trashDir && !path.isAbsolute(trashDir)) inputError('Quarantine directory must be an absolute container path.');
  // The folder browser will happily offer a folder inside the library, and a Brig there
  // means every quarantined file is found again by the next scan and offered as a fresh
  // orphan - because nothing tracks it any more. Scans skip it defensively, but the
  // configuration itself is wrong and is refused here, the same way two scan roots
  // cannot contain one another.
  for (const scanRoot of trashDir ? scanRoots : []) {
    if (pathsOverlap(trashDir, scanRoot.value)) {
      inputError(`Quarantine directory and ${scanRoot.label.toLowerCase()} must be separate and cannot contain one another.`);
    }
  }
  const ignoreDirectories = stringArray(orphan.ignoreDirectories, 'Ignored directories');
  for (const directory of ignoreDirectories) {
    if (directory.includes('/') || directory.includes('\\') || directory.includes(',')) {
      inputError('Ignored directory names cannot contain slashes or commas.');
    }
  }
  const extensions = stringArray(orphan.mediaExtensions, 'Media extensions')
    .map((extension) => extension.toLowerCase().replace(/^\./, ''));
  for (const extension of extensions) {
    if (!/^[a-z0-9]+$/i.test(extension)) inputError('Media extensions may contain only letters and numbers.');
  }
  output.ORPHAN_TRASH_DIR = trashDir;
  output.ORPHAN_IGNORE_DIRECTORIES = ignoreDirectories.join(',');
  output.ORPHAN_MAX_FILES = numberValue(orphan.maxFiles, 'Maximum orphan scan files', { min: 1, max: 1000000, integer: true }).toString();
  output.HARDLINK_MIN_AGE_HOURS = numberValue(orphan.hardlinkMinAgeHours, 'Minimum unlinked age', { min: 0, max: 8760 }).toString();
  output.MEDIA_EXTENSIONS = extensions.join(',');
  output.QUARANTINE_RETENTION_DAYS = numberValue(
    orphan.retentionDays ?? configuredNumber('QUARANTINE_RETENTION_DAYS', output, 0),
    'Quarantine retention',
    { min: 0, max: 3650, integer: true },
  ).toString();
  output.OVERSIZE_REQUIRE_REPLACEMENT = String(booleanValue(
    orphan.requireReplacement ?? configuredBoolean('OVERSIZE_REQUIRE_REPLACEMENT', output, false),
    'Require a compliant replacement',
  ));

  output.SCHEDULE_ENABLED = String(booleanValue(schedule.enabled, 'Scheduled scans'));
  output.SCHEDULE_INTERVAL_HOURS = numberValue(schedule.intervalHours, 'Scheduled scan interval', { min: 1, max: 8760, integer: true }).toString();
  const notificationType = stringValue(schedule.notificationType, 'Notification type');
  if (!['generic', 'discord', 'gotify'].includes(notificationType)) inputError('Notification type must be generic, Discord, or Gotify.');
  output.NOTIFICATION_TYPE = notificationType;
  output.NOTIFICATION_WHEN_CLEAR = String(booleanValue(schedule.notifyWhenClear, 'Notify when clear'));
  const webhookUrl = urlValue(schedule.webhookUrl ?? '', 'Notification webhook URL');
  const clearWebhook = booleanValue(schedule.clearWebhook ?? false, 'Clear notification webhook');
  if (webhookUrl && clearWebhook) inputError('Notification webhook cannot be replaced and cleared at the same time.');
  if (webhookUrl) output.NOTIFICATION_WEBHOOK_URL = webhookUrl;
  if (clearWebhook) output.NOTIFICATION_WEBHOOK_URL = '';
  return output;
}

/**
 * Replaces a password an earlier version of this application persisted in the clear.
 *
 * Only the stored settings are touched: an APP_PASSWORD supplied through .env belongs
 * to the operator, is not ours to rewrite, and is still accepted as-is at login.
 */
export async function migrateStoredPassword() {
  const stored = settingsOverrides.APP_PASSWORD;
  if (!stored || isHashedPassword(stored)) return false;
  await saveSettingsOverrides({ ...settingsOverrides, APP_PASSWORD: hashPassword(stored) });
  return true;
}

export function saveSettingsOverrides(nextOverrides) {
  const document = `${JSON.stringify({ version: 1, values: nextOverrides }, null, 2)}\n`;
  const operation = async () => {
    await mkdir(configDirectory, { recursive: true, mode: 0o700 });
    await chmod(configDirectory, 0o700);
    const temporaryPath = path.join(configDirectory, `.settings-${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, document, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, settingsPath);
      settingsOverrides = { ...nextOverrides };
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  };
  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}
