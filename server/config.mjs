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

const MAX_SIZE_RULES = 50;

/**
 * Ordered size rules. Each rule narrows by tag, media root and/or quality, and carries
 * its own MB/min and tolerance. The first rule that matches a file wins; a file that
 * matches nothing falls through to the connection's own limit, so adding rules can
 * never change how an unmatched file is judged.
 *
 * Validated exactly as strictly as the connection defaults: a rule that would produce a
 * zero, negative or non-finite limit is rejected at load rather than silently flagging
 * an entire library.
 */
function readSizeRules(name, overrides) {
  const raw = envValue(name, overrides);
  if (raw === undefined || raw.trim() === '') return [];
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of size rules`);
  }
  if (!Array.isArray(values)) throw new Error(`${name} must be a JSON array of size rules`);
  if (values.length > MAX_SIZE_RULES) {
    throw new Error(`${name} must contain at most ${MAX_SIZE_RULES} rules`);
  }

  return values.map((value, index) => {
    const position = `${name}[${index}]`;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${position} must be an object`);
    }
    const text = (field) => {
      const candidate = value[field];
      if (candidate === undefined || candidate === null || candidate === '') return null;
      if (typeof candidate !== 'string' || candidate.length > 256) {
        throw new Error(`${position}.${field} must be a string of at most 256 characters`);
      }
      return candidate.trim().toLowerCase() || null;
    };
    const tag = text('tag');
    const root = value.root === undefined || value.root === null || value.root === ''
      ? null
      : path.resolve(String(value.root));
    const quality = text('quality');
    if (!tag && !root && !quality) {
      throw new Error(`${position} must match on at least one of tag, root or quality`);
    }

    const maxMbPerMinute = Number(value.maxMbPerMinute);
    if (!Number.isFinite(maxMbPerMinute) || maxMbPerMinute <= 0) {
      throw new Error(`${position}.maxMbPerMinute must be a number greater than zero`);
    }
    const toleranceGib = value.toleranceGib === undefined ? 0 : Number(value.toleranceGib);
    if (!Number.isFinite(toleranceGib) || toleranceGib < 0) {
      throw new Error(`${position}.toleranceGib cannot be negative`);
    }
    const label = typeof value.label === 'string' && value.label.trim()
      ? value.label.trim().slice(0, 120)
      : [tag && `tag ${tag}`, root && `root ${root}`, quality && `quality ${quality}`]
        .filter(Boolean).join(' + ');

    return { label, tag, root, quality, maxMbPerMinute, toleranceGib };
  });
}

/**
 * First match wins. A rule matches only when EVERY criterion it specifies matches, so a
 * narrower rule placed first can carve an exception out of a broader one below it.
 */
export function matchSizeRule(rules, { tags = [], root = null, quality = null } = {}) {
  const tagSet = new Set(tags.filter(Boolean).map((tag) => String(tag).toLowerCase()));
  const resolvedRoot = root ? path.resolve(root) : null;
  const qualityName = quality ? String(quality).toLowerCase() : null;
  return rules.find((rule) => {
    if (rule.tag && !tagSet.has(rule.tag)) return false;
    if (rule.root && rule.root !== resolvedRoot) return false;
    if (rule.quality && rule.quality !== qualityName) return false;
    return true;
  }) ?? null;
}

const INSTANCE_KINDS = ['radarr', 'sonarr'];
const MAX_INSTANCES = 12;
// Ids become properties on the config object, so they must not shadow anything real.
const RESERVED_INSTANCE_IDS = new Set([
  'instances', 'port', 'username', 'password', 'sessionSecret', 'sessionDays',
  'cookieSecure', 'defaults', 'qbittorrent', 'mediaServer', 'schedule', 'protected',
  'orphanAction', 'orphanTrashDir', 'allowPermanentOrphanDelete', 'mediaExtensions',
  'extensions', 'customIgnoreDirectories', 'ignoreDirectories', 'maxFiles',
  'hardlinkMinAgeHours', 'quarantineRetentionDays', 'oversizeRequireReplacement',
  'orphanAutoIdentify', 'orphanAutoIdentifyLimit',
  'storageRoots',
]);

function defaultInstanceLabel(id, kind) {
  if (id === 'radarr') return 'Radarr';
  if (id === 'sonarr') return 'Sonarr';
  return `${kind === 'sonarr' ? 'Sonarr' : 'Radarr'} (${id})`;
}

/**
 * ARR_INSTANCES is a comma-separated list of `id:kind`, defaulting to the historical
 * pair. Each instance reads its own `${ID}_*` environment, so the default list reads
 * exactly the RADARR_* and SONARR_* variables it always did.
 */
function readInstances(defaults, overrides) {
  const raw = (envValue('ARR_INSTANCES', overrides) ?? '').trim();
  const entries = raw
    ? raw.split(',').map((entry) => entry.trim()).filter(Boolean)
    : ['radarr:radarr', 'sonarr:sonarr'];
  if (entries.length > MAX_INSTANCES) {
    throw new Error(`ARR_INSTANCES may list at most ${MAX_INSTANCES} instances`);
  }

  const seen = new Set();
  const instances = entries.map((entry) => {
    const [id, kind = id] = entry.split(':').map((part) => part.trim().toLowerCase());
    if (!/^[a-z][a-z0-9]{0,31}$/.test(id)) {
      throw new Error(`ARR_INSTANCES id "${id}" must be 1-32 letters and digits starting with a letter`);
    }
    if (!INSTANCE_KINDS.includes(kind)) {
      throw new Error(`ARR_INSTANCES entry "${entry}" must declare kind radarr or sonarr`);
    }
    if (RESERVED_INSTANCE_IDS.has(id)) throw new Error(`ARR_INSTANCES id "${id}" is reserved`);
    if (seen.has(id)) throw new Error(`ARR_INSTANCES id "${id}" is duplicated`);
    seen.add(id);
    return connection(id, kind, defaults, overrides);
  });

  if (!instances.some((instance) => instance.kind === 'radarr')
    && !instances.some((instance) => instance.kind === 'sonarr')) {
    throw new Error('ARR_INSTANCES must include at least one Radarr or Sonarr instance');
  }
  return instances;
}

function connection(id, kind, defaults, overrides) {
  const prefix = id.toUpperCase();
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
    id,
    kind,
    label: envValue(`${prefix}_LABEL`, overrides) || defaultInstanceLabel(id, kind),
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
    sizeRules: readSizeRules(`${prefix}_SIZE_RULES_JSON`, overrides),
  };
}

const MEDIA_SERVER_KINDS = ['plex', 'jellyfin', 'emby'];

function mediaServerConnection(overrides) {
  const url = (envValue('MEDIA_SERVER_URL', overrides) ?? '').replace(/\/+$/, '');
  const rawKind = (envValue('MEDIA_SERVER_TYPE', overrides) ?? 'jellyfin').toLowerCase();
  if (url && !MEDIA_SERVER_KINDS.includes(rawKind)) {
    throw new Error(`MEDIA_SERVER_TYPE must be one of ${MEDIA_SERVER_KINDS.join(', ')}`);
  }
  const token = envValue('MEDIA_SERVER_TOKEN', overrides) ?? '';
  return {
    kind: MEDIA_SERVER_KINDS.includes(rawKind) ? rawKind : 'jellyfin',
    url,
    token,
    // Both a URL and a token are required: querying watch history without credentials
    // would silently return nothing, which would look like "nothing was watched".
    configured: Boolean(url && token),
    pathMaps: readPathMaps('MEDIA_SERVER_PATH_MAPS', overrides),
    watchedWithinDays: readBoundedInteger('MEDIA_SERVER_WATCHED_WITHIN_DAYS', 30, 1, 3650, overrides),
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
  // Opt-in so existing installations keep their current behaviour on upgrade.
  const oversizeRequireReplacement = readBoolean('OVERSIZE_REQUIRE_REPLACEMENT', false, overrides);
  // On by default: it costs one string-parse request per newly seen name, cached
  // afterwards, and answers the question the untracked list otherwise leaves open.
  const orphanAutoIdentify = readBoolean('ORPHAN_AUTO_IDENTIFY', true, overrides);
  // A ceiling so a misconfigured root that finds thousands of untracked files cannot
  // turn every scheduled scan into thousands of requests at the applications.
  const orphanAutoIdentifyLimit = readNumber('ORPHAN_AUTO_IDENTIFY_LIMIT', 300, overrides);
  const mediaServer = mediaServerConnection(overrides);
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

  const instances = readInstances(defaults, overrides);
  // The first instance of each kind keeps the ids `radarr` and `sonarr`, which is what
  // makes this change safe: candidate ids, exclusion keys, quarantine records and job
  // connection identities all embed the instance id, and every existing one of those
  // was written with those exact literals.
  const radarr = instances.find((instance) => instance.kind === 'radarr') ?? connection('radarr', 'radarr', defaults, {});
  const sonarr = instances.find((instance) => instance.kind === 'sonarr') ?? connection('sonarr', 'sonarr', defaults, {});
  const qbittorrent = qbittorrentConnection(overrides);
  if (qbittorrent.recovery.enabled && !qbittorrent.configured) {
    throw new Error('qBittorrent automatic recovery requires a configured qBittorrent connection');
  }
  if (qbittorrent.recovery.enabled && !instances.some((instance) => instance.configured)) {
    throw new Error('qBittorrent automatic recovery requires at least one configured Arr connection');
  }

  return {
    instances,
    // Every instance is also exposed under its own id, so the long-standing
    // `config[candidate.app]` lookup keeps resolving the right connection without a
    // single call site changing.
    ...Object.fromEntries(instances.map((instance) => [instance.id, instance])),
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
    oversizeRequireReplacement,
    orphanAutoIdentify,
    orphanAutoIdentifyLimit,
    mediaServer,
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
    sizeRules: connectionConfig.sizeRules ?? [],
  });

  return {
    radarr: expose(config.radarr),
    sonarr: expose(config.sonarr),
    instances: (config.instances ?? []).map((instance) => ({
      id: instance.id,
      kind: instance.kind,
      label: instance.label,
      ...expose(instance),
    })),
    qbittorrent: {
      configured: config.qbittorrent.configured,
      recovery: { ...config.qbittorrent.recovery },
    },
    hardlinkMinAgeHours: config.hardlinkMinAgeHours,
    quarantineRetentionDays: config.quarantineRetentionDays,
    oversizeRequireReplacement: config.oversizeRequireReplacement,
    orphanAutoIdentify: config.orphanAutoIdentify,
    mediaServer: {
      configured: config.mediaServer?.configured === true,
      kind: config.mediaServer?.kind ?? 'jellyfin',
      watchedWithinDays: config.mediaServer?.watchedWithinDays ?? 30,
    },
    schedule: {
      enabled: config.schedule.enabled,
      intervalHours: config.schedule.intervalHours,
      notificationType: config.schedule.notificationType,
      webhookConfigured: Boolean(config.schedule.webhookUrl),
    },
    protected: Boolean(config.password),
  };
}
