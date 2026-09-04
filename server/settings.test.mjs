import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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
