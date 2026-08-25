import path from 'node:path';

const DEFAULT_MEDIA_EXTENSIONS = [
  '.avi', '.divx', '.iso', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4',
  '.mpeg', '.mpg', '.ts', '.webm', '.wmv',
];

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function readBoolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function readList(name) {
  return (process.env[name] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function readRoots(name) {
  return readList(name).map((root) => path.resolve(root));
}

function readPathMaps(name) {
  const raw = process.env[name] ?? '';
  if (!raw.trim()) return [];
  return raw.split(';').map((entry) => {
    const [from, to, ...rest] = entry.split('=>');
    if (!from?.trim() || !to?.trim() || rest.length) {
      throw new Error(`${name} entries must use /arr/path=>/local/path`);
    }
    return { from: from.trim(), to: path.resolve(to.trim()) };
  }).sort((a, b) => b.from.length - a.from.length);
}

function connection(kind) {
  const prefix = kind.toUpperCase();
  const commonMax = readNumber('MAX_MB_PER_MIN', 85);
  const commonTolerance = readNumber('OVERSIZE_TOLERANCE_GIB', 1);
  const url = (process.env[`${prefix}_URL`] ?? '').replace(/\/+$/, '');
  const apiKey = process.env[`${prefix}_API_KEY`] ?? '';
  const maxMbPerMinute = readNumber(`${prefix}_MAX_MB_PER_MIN`, commonMax);
  const toleranceGib = readNumber(
    `${prefix}_OVERSIZE_TOLERANCE_GIB`,
    commonTolerance,
  );

  if (maxMbPerMinute <= 0) {
    throw new Error(`${prefix}_MAX_MB_PER_MIN must be greater than zero`);
  }
  if (toleranceGib < 0) {
    throw new Error(`${prefix}_OVERSIZE_TOLERANCE_GIB cannot be negative`);
  }

  return {
    kind,
    url,
    apiKey,
    configured: Boolean(url && apiKey),
    maxMbPerMinute,
    toleranceGib,
    includeUnmonitored: readBoolean(`${prefix}_INCLUDE_UNMONITORED`, false),
    mediaRoots: readRoots(`${prefix}_MEDIA_ROOTS`),
    pathMaps: readPathMaps(`${prefix}_PATH_MAPS`),
  };
}

export function getConfig() {
  const orphanAction = (process.env.ORPHAN_ACTION ?? 'quarantine').toLowerCase();
  if (!['quarantine', 'permanent'].includes(orphanAction)) {
    throw new Error('ORPHAN_ACTION must be quarantine or permanent');
  }
  if (orphanAction === 'permanent' && !readBoolean('ALLOW_PERMANENT_ORPHAN_DELETE')) {
    throw new Error(
      'Set ALLOW_PERMANENT_ORPHAN_DELETE=true before using ORPHAN_ACTION=permanent',
    );
  }

  const extensions = readList('MEDIA_EXTENSIONS');
  const ignoreDirectories = new Set([
    '.keelhaularr-trash',
    '.recycle',
    '.recycle.bin',
    '$recycle.bin',
    '#recycle',
    '@eadir',
    ...readList('ORPHAN_IGNORE_DIRECTORIES').map((item) => item.toLowerCase()),
  ]);

  return {
    port: readNumber('PORT', 8787),
    username: process.env.APP_USERNAME ?? 'captain',
    password: process.env.APP_PASSWORD ?? '',
    sessionSecret: process.env.APP_SESSION_SECRET || process.env.APP_PASSWORD || '',
    sessionDays: readNumber('APP_SESSION_DAYS', 30),
    cookieSecure: readBoolean('APP_COOKIE_SECURE', false),
    radarr: connection('radarr'),
    sonarr: connection('sonarr'),
    orphanAction,
    orphanTrashDir: process.env.ORPHAN_TRASH_DIR
      ? path.resolve(process.env.ORPHAN_TRASH_DIR)
      : null,
    extensions: new Set(
      (extensions.length ? extensions : DEFAULT_MEDIA_EXTENSIONS)
        .map((extension) => extension.startsWith('.') ? extension : `.${extension}`)
        .map((extension) => extension.toLowerCase()),
    ),
    ignoreDirectories,
    maxFiles: readNumber('ORPHAN_MAX_FILES', 100000),
  };
}

export function publicConfig(config) {
  const expose = (connectionConfig) => ({
    configured: connectionConfig.configured,
    maxMbPerMinute: connectionConfig.maxMbPerMinute,
    toleranceGib: connectionConfig.toleranceGib,
    includeUnmonitored: connectionConfig.includeUnmonitored,
    mediaRoots: connectionConfig.mediaRoots,
  });

  return {
    radarr: expose(config.radarr),
    sonarr: expose(config.sonarr),
    orphanAction: config.orphanAction,
    protected: Boolean(config.password),
  };
}
