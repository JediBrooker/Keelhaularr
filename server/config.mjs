import path from 'node:path';

const DEFAULT_MEDIA_EXTENSIONS = [
  '.avi', '.divx', '.iso', '.m2ts', '.m4v', '.mkv', '.mov', '.mp4',
  '.mpeg', '.mpg', '.ts', '.webm', '.wmv',
];

function envValue(name, overrides) {
  return Object.hasOwn(overrides, name) ? overrides[name] : process.env[name];
}

function readNumber(name, fallback, overrides) {
  const raw = envValue(name, overrides);
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function readOptionalNumber(name, overrides) {
  const raw = envValue(name, overrides);
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

function readBoolean(name, fallback, overrides) {
  const raw = envValue(name, overrides);
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function readStrictBoolean(name, fallback, overrides) {
  const raw = envValue(name, overrides);
  if (raw === undefined || raw.trim() === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function readBoundedInteger(name, fallback, min, max, overrides) {
  const value = readNumber(name, fallback, overrides);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function readExactStringArray(name, overrides) {
  const raw = envValue(name, overrides);
  if (raw === undefined || raw.trim() === '') return [];
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON string array`);
  }
  if (!Array.isArray(values) || values.length > 100
    || values.some((value) => typeof value !== 'string' || value.length > 256)) {
    throw new Error(`${name} must contain at most 100 strings of at most 256 characters each`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} must not contain duplicate categories`);
  }
  return values;
}

function readList(name, overrides) {
  return (envValue(name, overrides) ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function readRoots(name, overrides) {
  return readList(name, overrides).map((root) => path.resolve(root));
}

function readPathMaps(name, overrides) {
  const raw = envValue(name, overrides) ?? '';
  if (!raw.trim()) return [];
  return raw.split(';').map((entry) => {
    const [from, to, ...rest] = entry.split('=>');
    if (!from?.trim() || !to?.trim() || rest.length) {
      throw new Error(`${name} entries must use /remote/path=>/local/path`);
    }
    return { from: from.trim(), to: path.resolve(to.trim()) };
  }).sort((a, b) => b.from.length - a.from.length);
}

function connection(kind, defaults, overrides) {
  const prefix = kind.toUpperCase();
  const url = (envValue(`${prefix}_URL`, overrides) ?? '').replace(/\/+$/, '');
  const apiKey = envValue(`${prefix}_API_KEY`, overrides) ?? '';
  const maxMbPerMinuteOverride = readOptionalNumber(`${prefix}_MAX_MB_PER_MIN`, overrides);
  const toleranceGibOverride = readOptionalNumber(`${prefix}_OVERSIZE_TOLERANCE_GIB`, overrides);
  const maxMbPerMinute = maxMbPerMinuteOverride ?? defaults.maxMbPerMinute;
  const toleranceGib = toleranceGibOverride ?? defaults.toleranceGib;

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
    maxMbPerMinuteOverride,
    toleranceGib,
    toleranceGibOverride,
    useArrQualityDefinitions: readBoolean(`${prefix}_USE_ARR_QUALITY_DEFINITIONS`, false, overrides),
    includeUnmonitored: readBoolean(`${prefix}_INCLUDE_UNMONITORED`, false, overrides),
    mediaRoots: readRoots(`${prefix}_MEDIA_ROOTS`, overrides),
    downloadRoots: readRoots(`${prefix}_DOWNLOAD_ROOTS`, overrides),
    pathMaps: readPathMaps(`${prefix}_PATH_MAPS`, overrides),
  };
}

function qbittorrentConnection(overrides) {
  const url = (envValue('QBITTORRENT_URL', overrides) ?? '').replace(/\/+$/, '');
  return {
    url,
    username: envValue('QBITTORRENT_USERNAME', overrides) ?? '',
    password: envValue('QBITTORRENT_PASSWORD', overrides) ?? '',
    configured: Boolean(url),
    pathMaps: readPathMaps('QBITTORRENT_PATH_MAPS', overrides),
    recovery: {
      enabled: readStrictBoolean('QBITTORRENT_RECOVERY_ENABLED', false, overrides),
      slowSpeedKibPerSecond: readBoundedInteger(
        'QBITTORRENT_RECOVERY_SLOW_KIB_PER_SECOND', 100, 0, 1048576, overrides,
      ),
      slowMinutes: readBoundedInteger(
        'QBITTORRENT_RECOVERY_SLOW_MINUTES', 30, 1, 10080, overrides,
      ),
      stalledMinutes: readBoundedInteger(
        'QBITTORRENT_RECOVERY_STALLED_MINUTES', 30, 1, 10080, overrides,
      ),
      excludedCategories: readExactStringArray(
        'QBITTORRENT_RECOVERY_EXCLUDED_CATEGORIES_JSON', overrides,
      ),
    },
  };
}

export function getConfig(overrides = {}) {
  const defaults = {
    maxMbPerMinute: readNumber('MAX_MB_PER_MIN', 85, overrides),
    toleranceGib: readNumber('OVERSIZE_TOLERANCE_GIB', 1, overrides),
  };
  const orphanAction = (envValue('ORPHAN_ACTION', overrides) ?? 'quarantine').toLowerCase();
  if (!['quarantine', 'permanent'].includes(orphanAction)) {
    throw new Error('ORPHAN_ACTION must be quarantine or permanent');
  }
  const allowPermanentOrphanDelete = readBoolean('ALLOW_PERMANENT_ORPHAN_DELETE', false, overrides);
  if (orphanAction === 'permanent' && !allowPermanentOrphanDelete) {
    throw new Error(
      'Set ALLOW_PERMANENT_ORPHAN_DELETE=true before using ORPHAN_ACTION=permanent',
    );
  }

  const configuredExtensions = readList('MEDIA_EXTENSIONS', overrides);
  const customIgnoreDirectories = readList('ORPHAN_IGNORE_DIRECTORIES', overrides)
    .map((item) => item.toLowerCase());
  const mediaExtensions = (configuredExtensions.length ? configuredExtensions : DEFAULT_MEDIA_EXTENSIONS)
    .map((extension) => extension.startsWith('.') ? extension : `.${extension}`)
    .map((extension) => extension.toLowerCase());
  const ignoreDirectories = new Set([
    '.keelhaularr-trash',
    '.recycle',
    '.recycle.bin',
    '$recycle.bin',
    '#recycle',
    '@eadir',
    ...customIgnoreDirectories,
  ]);
  const hardlinkMinAgeHours = readNumber('HARDLINK_MIN_AGE_HOURS', 24, overrides);
  if (hardlinkMinAgeHours < 0) {
    throw new Error('HARDLINK_MIN_AGE_HOURS cannot be negative');
  }
  const quarantineRetentionDays = readNumber('QUARANTINE_RETENTION_DAYS', 0, overrides);
  if (quarantineRetentionDays < 0 || !Number.isInteger(quarantineRetentionDays)) {
    throw new Error('QUARANTINE_RETENTION_DAYS must be a whole number of zero or more');
  }
  const scheduleIntervalHours = readNumber('SCHEDULE_INTERVAL_HOURS', 24, overrides);
  if (scheduleIntervalHours < 1) throw new Error('SCHEDULE_INTERVAL_HOURS must be at least one hour');
  const notificationType = (envValue('NOTIFICATION_TYPE', overrides) ?? 'generic').toLowerCase();
  if (!['generic', 'discord', 'gotify'].includes(notificationType)) {
    throw new Error('NOTIFICATION_TYPE must be generic, discord, or gotify');
  }

  const radarr = connection('radarr', defaults, overrides);
  const sonarr = connection('sonarr', defaults, overrides);
  const qbittorrent = qbittorrentConnection(overrides);
  if (qbittorrent.recovery.enabled && !qbittorrent.configured) {
    throw new Error('qBittorrent automatic recovery requires a configured qBittorrent connection');
  }
  if (qbittorrent.recovery.enabled && !radarr.configured && !sonarr.configured) {
    throw new Error('qBittorrent automatic recovery requires at least one configured Arr connection');
  }

  return {
    port: readNumber('PORT', 8787, overrides),
    username: envValue('APP_USERNAME', overrides) ?? 'captain',
    password: envValue('APP_PASSWORD', overrides) ?? '',
    sessionSecret: envValue('APP_SESSION_SECRET', overrides) || envValue('APP_PASSWORD', overrides) || '',
    sessionDays: readNumber('APP_SESSION_DAYS', 30, overrides),
    cookieSecure: readBoolean('APP_COOKIE_SECURE', false, overrides),
    defaults,
    radarr,
    sonarr,
    qbittorrent,
    orphanAction,
    orphanTrashDir: envValue('ORPHAN_TRASH_DIR', overrides)
      ? path.resolve(envValue('ORPHAN_TRASH_DIR', overrides))
      : null,
    allowPermanentOrphanDelete,
    mediaExtensions,
    extensions: new Set(mediaExtensions),
    customIgnoreDirectories,
    ignoreDirectories,
    maxFiles: readNumber('ORPHAN_MAX_FILES', 100000, overrides),
    hardlinkMinAgeHours,
    quarantineRetentionDays,
    schedule: {
      enabled: readBoolean('SCHEDULE_ENABLED', false, overrides),
      intervalHours: scheduleIntervalHours,
      notificationType,
      webhookUrl: envValue('NOTIFICATION_WEBHOOK_URL', overrides) ?? '',
      notifyWhenClear: readBoolean('NOTIFICATION_WHEN_CLEAR', false, overrides),
    },
    storageRoots: readRoots('STORAGE_ROOTS', overrides),
  };
}

export function publicConfig(config) {
  const expose = (connectionConfig) => ({
    configured: connectionConfig.configured,
    maxMbPerMinute: connectionConfig.maxMbPerMinute,
    toleranceGib: connectionConfig.toleranceGib,
    useArrQualityDefinitions: connectionConfig.useArrQualityDefinitions,
    includeUnmonitored: connectionConfig.includeUnmonitored,
    mediaRoots: connectionConfig.mediaRoots,
    downloadRoots: connectionConfig.downloadRoots,
  });

  return {
    radarr: expose(config.radarr),
    sonarr: expose(config.sonarr),
    qbittorrent: {
      configured: config.qbittorrent.configured,
      recovery: { ...config.qbittorrent.recovery },
    },
    hardlinkMinAgeHours: config.hardlinkMinAgeHours,
    quarantineRetentionDays: config.quarantineRetentionDays,
    schedule: {
      enabled: config.schedule.enabled,
      intervalHours: config.schedule.intervalHours,
      notificationType: config.schedule.notificationType,
      webhookConfigured: Boolean(config.schedule.webhookUrl),
    },
    protected: Boolean(config.password),
  };
}
