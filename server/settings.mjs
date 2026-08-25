import { randomBytes, randomUUID } from 'node:crypto';
import { constants, accessSync, readFileSync, statSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SETTINGS_KEYS = new Set([
  'APP_USERNAME', 'APP_PASSWORD', 'APP_SESSION_SECRET', 'APP_SESSION_DAYS', 'APP_COOKIE_SECURE',
  'MAX_MB_PER_MIN', 'OVERSIZE_TOLERANCE_GIB',
  'RADARR_URL', 'RADARR_API_KEY', 'RADARR_MAX_MB_PER_MIN', 'RADARR_OVERSIZE_TOLERANCE_GIB',
  'RADARR_INCLUDE_UNMONITORED', 'RADARR_MEDIA_ROOTS', 'RADARR_PATH_MAPS',
  'SONARR_URL', 'SONARR_API_KEY', 'SONARR_MAX_MB_PER_MIN', 'SONARR_OVERSIZE_TOLERANCE_GIB',
  'SONARR_INCLUDE_UNMONITORED', 'SONARR_MEDIA_ROOTS', 'SONARR_PATH_MAPS',
  'ORPHAN_ACTION', 'ORPHAN_TRASH_DIR', 'ALLOW_PERMANENT_ORPHAN_DELETE',
  'ORPHAN_IGNORE_DIRECTORIES', 'ORPHAN_MAX_FILES', 'MEDIA_EXTENSIONS',
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

function connectionOverrides(kind, input, output) {
  const label = kind === 'radarr' ? 'Radarr' : 'Sonarr';
  const prefix = kind.toUpperCase();
  const settings = requiredObject(input, label);
  const roots = mediaRoots(settings.mediaRoots, `${label} media roots`);
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
  output[`${prefix}_MEDIA_ROOTS`] = roots.join(',');
  output[`${prefix}_PATH_MAPS`] = mappings.map(({ from, to }) => `${from}=>${to}`).join(';');
  if (apiKey) output[`${prefix}_API_KEY`] = apiKey;
  if (clearApiKey) output[`${prefix}_API_KEY`] = '';
}

export function getSettingsOverrides() {
  return { ...settingsOverrides };
}

export function settingsView(config) {
  const connection = (value) => ({
    url: value.url,
    apiKeyConfigured: Boolean(value.apiKey),
    maxMbPerMinuteOverride: value.maxMbPerMinuteOverride,
    toleranceGibOverride: value.toleranceGibOverride,
    includeUnmonitored: value.includeUnmonitored,
    mediaRoots: value.mediaRoots,
    pathMaps: value.pathMaps,
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
    orphan: {
      action: config.orphanAction,
      trashDir: config.orphanTrashDir ?? '',
      allowPermanentDelete: config.allowPermanentOrphanDelete,
      ignoreDirectories: config.customIgnoreDirectories,
      maxFiles: config.maxFiles,
      mediaExtensions: config.mediaExtensions,
    },
    server: {
      port: config.port,
      portManagedByDocker: Boolean(process.env.CONFIG_DIR),
    },
  };
}

export function buildSettingsOverrides(input, currentOverrides) {
  const root = requiredObject(input, 'Settings');
  const account = requiredObject(root.account, 'Account');
  const defaults = requiredObject(root.defaults, 'Default size');
  const orphan = requiredObject(root.orphan, 'Orphan');
  const output = { ...currentOverrides };

  output.APP_USERNAME = stringValue(account.username, 'Login username', { max: 128 });
  output.APP_SESSION_DAYS = numberValue(account.sessionDays, 'Session lifetime', { min: 1, max: 365, integer: true }).toString();
  output.APP_COOKIE_SECURE = String(booleanValue(account.cookieSecure, 'Secure cookie'));
  const newPassword = secretValue(account.newPassword ?? '', 'New password', { allowEmpty: true, max: 1024 });
  if (newPassword) output.APP_PASSWORD = newPassword;
  if (booleanValue(account.rotateSessions ?? false, 'Rotate sessions')) {
    output.APP_SESSION_SECRET = randomBytes(32).toString('hex');
  }

  output.MAX_MB_PER_MIN = numberValue(defaults.maxMbPerMinute, 'Default maximum MB/min', { min: 0.01, max: 10000 }).toString();
  output.OVERSIZE_TOLERANCE_GIB = numberValue(defaults.toleranceGib, 'Default oversize tolerance', { min: 0, max: 1000 }).toString();
  connectionOverrides('radarr', root.radarr, output);
  connectionOverrides('sonarr', root.sonarr, output);

  const action = stringValue(orphan.action, 'Orphan action');
  if (!['quarantine', 'permanent'].includes(action)) inputError('Orphan action must be quarantine or permanent.');
  const allowPermanent = booleanValue(orphan.allowPermanentDelete, 'Allow permanent deletion');
  if (action === 'permanent' && !allowPermanent) inputError('Permanent orphan deletion requires its explicit safety switch.');
  const trashDir = stringValue(orphan.trashDir, 'Quarantine directory', { allowEmpty: true });
  if (trashDir && !path.isAbsolute(trashDir)) inputError('Quarantine directory must be an absolute container path.');
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
  output.ORPHAN_ACTION = action;
  output.ALLOW_PERMANENT_ORPHAN_DELETE = String(allowPermanent);
  output.ORPHAN_TRASH_DIR = trashDir;
  output.ORPHAN_IGNORE_DIRECTORIES = ignoreDirectories.join(',');
  output.ORPHAN_MAX_FILES = numberValue(orphan.maxFiles, 'Maximum orphan scan files', { min: 1, max: 1000000, integer: true }).toString();
  output.MEDIA_EXTENSIONS = extensions.join(',');
  return output;
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
