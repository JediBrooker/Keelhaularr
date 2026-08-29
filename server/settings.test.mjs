import assert from 'node:assert/strict';
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
