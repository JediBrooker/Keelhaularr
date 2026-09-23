import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publicConfig } from './config.mjs';
import { buildSettingsOverrides, settingsView } from './settings.mjs';

function connectionSettings() {
  return {
    url: '',
    apiKey: '',
    clearApiKey: false,
    maxMbPerMinuteOverride: null,
    toleranceGibOverride: null,
    useArrQualityDefinitions: false,
    includeUnmonitored: false,
    mediaRoots: [],
    downloadRoots: [],
    pathMaps: [],
  };
}

test('settings no longer require orphan actions and preserve stored legacy controls', () => {
  const current = {
    ORPHAN_ACTION: 'permanent',
    ALLOW_PERMANENT_ORPHAN_DELETE: 'true',
  };
  const output = buildSettingsOverrides({
    account: {
      username: 'captain',
      newPassword: '',
      sessionDays: 30,
      cookieSecure: false,
      rotateSessions: false,
    },
    defaults: { maxMbPerMinute: 85, toleranceGib: 1 },
    radarr: connectionSettings(),
    sonarr: connectionSettings(),
    orphan: {
      trashDir: '/quarantine',
      ignoreDirectories: [],
      maxFiles: 100000,
      mediaExtensions: ['mkv'],
      hardlinkMinAgeHours: 24,
      retentionDays: 0,
    },
    schedule: {
      enabled: false,
      intervalHours: 24,
      notificationType: 'generic',
      webhookUrl: '',
      clearWebhook: false,
      notifyWhenClear: false,
    },
  }, current);

  assert.equal(output.ORPHAN_ACTION, 'permanent');
  assert.equal(output.ALLOW_PERMANENT_ORPHAN_DELETE, 'true');
  assert.equal(output.ORPHAN_TRASH_DIR, '/quarantine');
});

test('public configuration no longer exposes the legacy orphan action', () => {
  const connection = {
    maxMbPerMinute: 85,
    toleranceGib: 1,
    useArrQualityDefinitions: false,
    includeUnmonitored: false,
    mediaRoots: [],
    downloadRoots: [],
  };
  const output = publicConfig({
    radarr: connection,
    sonarr: connection,
    qbittorrent: {
      configured: false,
      recovery: { enabled: false },
    },
    orphanAction: 'permanent',
    hardlinkMinAgeHours: 24,
    quarantineRetentionDays: 0,
    schedule: {
      enabled: false,
      intervalHours: 24,
      notificationType: 'generic',
      webhookUrl: '',
    },
    password: 'secret',
  });

  assert.equal(Object.hasOwn(output, 'orphanAction'), false);
});

test('settings view omits legacy orphan action controls', () => {
  const connection = {
    url: '',
    apiKey: '',
    maxMbPerMinuteOverride: null,
    toleranceGibOverride: null,
    useArrQualityDefinitions: false,
    includeUnmonitored: false,
    mediaRoots: [],
    downloadRoots: [],
    pathMaps: [],
  };
  const output = settingsView({
    username: 'captain',
    password: 'secret',
    sessionDays: 30,
    cookieSecure: false,
    defaults: { maxMbPerMinute: 85, toleranceGib: 1 },
    radarr: connection,
    sonarr: connection,
    qbittorrent: {
      url: '',
      username: '',
      password: '',
      pathMaps: [],
      recovery: { enabled: false },
    },
    orphanAction: 'permanent',
    allowPermanentOrphanDelete: true,
    orphanTrashDir: '/quarantine',
    customIgnoreDirectories: [],
    maxFiles: 100000,
    mediaExtensions: ['mkv'],
    hardlinkMinAgeHours: 24,
    quarantineRetentionDays: 0,
    schedule: {
      enabled: false,
      intervalHours: 24,
      notificationType: 'generic',
      webhookUrl: '',
      notifyWhenClear: false,
    },
    port: 8787,
    storageRoots: [],
  });

  assert.equal(Object.hasOwn(output.orphan, 'action'), false);
  assert.equal(Object.hasOwn(output.orphan, 'allowPermanentDelete'), false);
  assert.equal(output.orphan.trashDir, '/quarantine');
});

function accountSettings() {
  return { username: 'captain', newPassword: '', sessionDays: 30, cookieSecure: false, rotateSessions: false };
}

function orphanSettings(trashDir) {
  return {
    trashDir,
    ignoreDirectories: [],
    maxFiles: 100000,
    mediaExtensions: ['mkv'],
    hardlinkMinAgeHours: 24,
    retentionDays: 0,
  };
}

function scheduleSettings() {
  return {
    enabled: false,
    intervalHours: 24,
    notificationType: 'generic',
    webhookUrl: '',
    clearWebhook: false,
    notifyWhenClear: false,
  };
}

function withRoots(trashDir, { mediaRoots = [], downloadRoots = [] } = {}) {
  return buildSettingsOverrides({
    account: accountSettings(),
    defaults: { maxMbPerMinute: 85, toleranceGib: 1 },
    radarr: { ...connectionSettings(), mediaRoots, downloadRoots },
    sonarr: connectionSettings(),
    orphan: orphanSettings(trashDir),
    schedule: scheduleSettings(),
  }, {});
}

test('the quarantine directory cannot sit inside or around a scanned root', async (context) => {
  // Scan roots have to exist and be writable, so this needs real directories.
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-settings-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const movies = path.join(root, 'movies');
  const downloads = path.join(root, 'downloads');
  const complete = path.join(downloads, 'complete');
  await mkdir(movies, { recursive: true });
  await mkdir(complete, { recursive: true });

  // A Brig inside the library means every quarantined file is found again by the next
  // scan and offered as a fresh orphan, because nothing tracks it any more.
  assert.throws(
    () => withRoots(path.join(movies, 'Brig'), { mediaRoots: [movies] }),
    /Quarantine directory and radarr media root must be separate/,
  );
  // And the other way round, quarantining would move the file inside the library it was
  // just taken from.
  assert.throws(
    () => withRoots(root, { mediaRoots: [movies] }),
    /Quarantine directory and radarr media root must be separate/,
  );
  assert.throws(
    () => withRoots(downloads, { downloadRoots: [complete] }),
    /Quarantine directory and radarr completed-download root must be separate/,
  );
  assert.throws(
    () => withRoots(movies, { mediaRoots: [movies] }),
    /must be separate/,
  );

  // A Brig of its own is fine, and so is no Brig at all.
  const brig = path.join(root, 'brig');
  assert.equal(withRoots(brig, { mediaRoots: [movies] }).ORPHAN_TRASH_DIR, brig);
  assert.equal(withRoots('', { mediaRoots: [movies] }).ORPHAN_TRASH_DIR, '');
});

test('metadata recovery timeout defaults, round trips, and rejects unsafe values', async () => {
  const { getConfig } = await import('./config.mjs');
  const config = getConfig();
  assert.equal(config.qbittorrent.recovery.metadataMinutes, 15);
  const input = settingsView(config);
  input.qbittorrent.recovery.metadataMinutes = 7;
  const saved = buildSettingsOverrides(input, {});
  assert.equal(saved.QBITTORRENT_RECOVERY_METADATA_MINUTES, '7');
  assert.equal(getConfig(saved).qbittorrent.recovery.metadataMinutes, 7);
  delete input.qbittorrent.recovery.metadataMinutes;
  assert.equal(buildSettingsOverrides(input, saved).QBITTORRENT_RECOVERY_METADATA_MINUTES, '7');
  for (const invalid of [0, -1, 1.5, 10081, 'invalid']) {
    input.qbittorrent.recovery.metadataMinutes = invalid;
    assert.throws(() => buildSettingsOverrides(input, {}), /metadata duration/);
    assert.throws(() => getConfig({ QBITTORRENT_RECOVERY_METADATA_MINUTES: String(invalid) }), /METADATA_MINUTES/);
  }
});

test('media-server connection tests use the form and never replay a token to a new URL', async () => {
  const { buildMediaServerTestConnection } = await import('./settings.mjs');
  const saved = { url: 'http://192.168.1.20:32400', token: 'saved-token', pathMaps: [], watchedWithinDays: 30 };

  const same = buildMediaServerTestConnection({ kind: 'plex', url: 'http://192.168.1.20:32400/', token: '' }, saved);
  assert.equal(same.token, 'saved-token');
  assert.equal(same.kind, 'plex');

  const entered = buildMediaServerTestConnection({ kind: 'plex', url: 'http://10.0.0.5:32400', token: 'new-token', watchedWithinDays: 7 }, saved);
  assert.equal(entered.token, 'new-token');
  assert.equal(entered.watchedWithinDays, 7);

  assert.throws(() => buildMediaServerTestConnection({ kind: 'plex', url: 'http://10.0.0.5:32400', token: '' }, saved), /token again/);
  assert.throws(() => buildMediaServerTestConnection({ kind: 'plex', url: 'http://10.0.0.5:32400', token: '' }, {}), /X-Plex-Token/);
  assert.throws(() => buildMediaServerTestConnection({ kind: 'plex', url: '', token: 'x' }, {}), /cannot be empty/);
});

test('a scan root that cannot be used says why, and where the files actually are', async (context) => {
  const { locateReportedPath, rootAccessProblem } = await import('./root-access.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-roots-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const lxcMovies = path.join(root, 'mnt', 'data', 'media', 'movies');
  await mkdir(lxcMovies, { recursive: true });
  const storage = path.join(root, 'mnt');

  // Radarr's own path, seen by Keelhaularr under a different mount point.
  assert.equal(locateReportedPath('/data/media/movies', [storage]), lxcMovies);
  assert.match(
    rootAccessProblem('/kh-test-missing/data/media/movies', { label: 'Radarr library folder', storageRoots: [storage] }),
    new RegExp(`does not exist inside Keelhaularr, but ${lxcMovies} does.*path mapping /kh-test-missing/data/media/movies=>${lxcMovies}`),
  );
  // One shared folder name is not evidence of the same library.
  await mkdir(path.join(storage, 'films'), { recursive: true });
  assert.equal(locateReportedPath('/elsewhere/films', [storage]), null);
  assert.match(rootAccessProblem('/kh-test-missing/films', { label: 'Radarr library folder', storageRoots: [storage] }), /does not exist inside Keelhaularr\. If this is the path/);

  const file = path.join(root, 'file.mkv');
  await writeFile(file, '');
  assert.match(rootAccessProblem(file, { label: 'Radarr library folder' }), /is a file, not a folder/);
  assert.equal(rootAccessProblem(lxcMovies, { label: 'Radarr library folder' }), null);

  // Root bypasses permission bits, so read-only can only be exercised as a normal user.
  if (process.getuid?.() !== 0) {
    const readOnly = path.join(root, 'read-only');
    await mkdir(readOnly);
    await chmod(readOnly, 0o555);
    context.after(() => chmod(readOnly, 0o755));
    assert.match(rootAccessProblem(readOnly, { label: 'Radarr library folder' }), /is read-only inside Keelhaularr.*owned by UID/);
  }
});
