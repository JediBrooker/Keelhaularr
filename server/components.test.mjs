import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { replacementProgress } from './arr.mjs';
import { applyOrphanCandidate, assertCandidateUnchanged, assertQbittorrentSafe, scanOrphans } from './orphans.mjs';

const testRoot = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-components-'));
process.env.CONFIG_DIR = path.join(testRoot, 'config');
const { createJsonStore } = await import('./state.mjs');
const { cleanupExpiredQuarantine, listQuarantine, recordQuarantine, restoreQuarantine } = await import('./quarantine.mjs');
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const operationsSource = await readFile(new URL('../src/OperationsDialog.tsx', import.meta.url), 'utf8');
const settingsSource = await readFile(new URL('../src/SettingsDialog.tsx', import.meta.url), 'utf8');
after(() => rm(testRoot, { recursive: true, force: true }));

function sourceSection(start, end) {
  const startIndex = appSource.indexOf(start);
  assert.notEqual(startIndex, -1, `Expected App.tsx to contain ${start}`);
  const endIndex = appSource.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `Expected App.tsx to contain ${end} after ${start}`);
  return appSource.slice(startIndex, endIndex);
}

test('Radarr and Sonarr connection pills probe immediately without waiting for a scan', () => {
  const pendingConnections = sourceSection(
    'function pendingArrConnections',
    'interface OversizedItem',
  );
  const probeEffect = sourceSection(
    'const requestId = ++arrConnectionsRequestId.current;',
    'const requestId = ++qbittorrentRequestId.current;',
  );

  assert.match(pendingConnections, /config\.radarr\.configured \? 'checking' : 'not-configured'/);
  assert.match(pendingConnections, /config\.sonarr\.configured \? 'checking' : 'not-configured'/);
  assert.match(probeEffect, /setArrConnections\(pendingArrConnections\(config\)\)/);
  assert.match(probeEffect, /['"]\/api\/connections\/status['"]/);
  assert.doesNotMatch(probeEffect, /['"]\/api\/scan['"]/);
  assert.match(probeEffect, /connections\.radarr\.status/);
  assert.match(probeEffect, /connections\.sonarr\.status/);

  const connectionPills = sourceSection(
    '<ConnectionPill\n              name="Radarr"',
    '<ConnectionPill name="qBittorrent"',
  );
  assert.match(connectionPills, /state=\{arrConnections\.radarr\.state\}/);
  assert.match(connectionPills, /error=\{arrConnections\.radarr\.error\}/);
  assert.match(connectionPills, /state=\{arrConnections\.sonarr\.state\}/);
  assert.match(connectionPills, /error=\{arrConnections\.sonarr\.error\}/);
  assert.doesNotMatch(connectionPills, /scan\?\.connections/);
  assert.doesNotMatch(appSource, /state === 'configured'|\| 'configured'/);
});

test('Arr connection probes refresh after settings save and ignore stale responses', () => {
  const probeEffect = sourceSection(
    'const requestId = ++arrConnectionsRequestId.current;',
    'const requestId = ++qbittorrentRequestId.current;',
  );
  const settingsSaved = sourceSection(
    'async function settingsSaved()',
    'async function runScan()',
  );

  assert.match(probeEffect, /new AbortController\(\)/);
  assert.equal(probeEffect.match(/requestId !== arrConnectionsRequestId\.current/g)?.length, 2);
  assert.match(probeEffect, /controller\.signal\.aborted/);
  assert.match(probeEffect, /return \(\) => controller\.abort\(\)/);
  assert.match(probeEffect, /arrConnectionProbeRevision\]\);/);
  assert.match(settingsSaved, /setArrConnectionProbeRevision\(\(current\) => current \+ 1\)/);
});

test('successful connection tests re-probe the saved header connection state', () => {
  const settingsDialogIndex = settingsSource.indexOf('export function SettingsDialog');
  assert.notEqual(settingsDialogIndex, -1);
  const settingsDialog = settingsSource.slice(settingsDialogIndex);
  const arrTestStart = settingsSource.indexOf('async function testConnection(app: AppKind)');
  const arrTestEnd = settingsSource.indexOf('async function testQbittorrent()', arrTestStart);
  assert.notEqual(arrTestStart, -1);
  assert.notEqual(arrTestEnd, -1);
  const arrTest = settingsSource.slice(arrTestStart, arrTestEnd);
  const connectionTested = sourceSection(
    "function connectionTested(app: AppKind | 'qbittorrent')",
    'async function runScan()',
  );

  assert.match(settingsDialog, /onConnectionTested\?: \(app: TestKind\) => void/);
  assert.equal(arrTest.match(/onConnectionTested\?\.\(app\)/g)?.length, 1);
  assert.ok(arrTest.indexOf('onConnectionTested?.(app)') < arrTest.indexOf('} catch'));
  assert.match(settingsDialog, /onConnectionTested\?\.\('qbittorrent'\)/);
  assert.match(connectionTested, /setArrConnectionProbeRevision\(\(current\) => current \+ 1\)/);
  assert.match(connectionTested, /setQbittorrentProbeRevision\(\(current\) => current \+ 1\)/);
  assert.doesNotMatch(connectionTested, /setArrConnections|apiKey|url/);
  assert.match(appSource, /onConnectionTested=\{connectionTested\}/);
});

test('Arr header connection failures recover automatically without pill flicker', () => {
  const probeEffect = sourceSection(
    'const requestId = ++arrConnectionsRequestId.current;',
    'const requestId = ++qbittorrentRequestId.current;',
  );
  const automaticProbeFunctionIndex = appSource.indexOf('function requestAutomaticProbe()');
  assert.notEqual(automaticProbeFunctionIndex, -1);
  const automaticProbeEffectIndex = appSource.lastIndexOf('useEffect(() => {', automaticProbeFunctionIndex);
  assert.notEqual(automaticProbeEffectIndex, -1);
  const automaticProbeEndIndex = appSource.indexOf(
    'const requestId = ++qbittorrentRequestId.current;',
    automaticProbeFunctionIndex,
  );
  assert.notEqual(automaticProbeEndIndex, -1);
  const automaticProbe = appSource.slice(automaticProbeEffectIndex, automaticProbeEndIndex);

  assert.match(appSource, /const arrConnectionRecheckMs = 30_000/);
  assert.match(probeEffect, /const shouldShowChecking = showArrConnectionChecking\.current/);
  assert.match(probeEffect, /if \(shouldShowChecking\) setArrConnections\(pendingArrConnections\(config\)\)/);
  assert.match(automaticProbe, /document\.visibilityState !== 'visible'/);
  assert.match(automaticProbe, /showArrConnectionChecking\.current = false/);
  assert.match(automaticProbe, /setArrConnectionProbeRevision\(\(current\) => current \+ 1\)/);
  assert.match(automaticProbe, /setInterval\(requestAutomaticProbe, arrConnectionRecheckMs\)/);
  assert.match(automaticProbe, /addEventListener\('focus', requestAutomaticProbe\)/);
  assert.match(automaticProbe, /addEventListener\('visibilitychange', requestAutomaticProbe\)/);
  assert.match(automaticProbe, /clearInterval\(interval\)/);
  assert.match(automaticProbe, /removeEventListener\('focus', requestAutomaticProbe\)/);
  assert.match(automaticProbe, /removeEventListener\('visibilitychange', requestAutomaticProbe\)/);
  assert.match(automaticProbe, /!config\.radarr\.configured && !config\.sonarr\.configured/);
});

test('qBittorrent connection status still refreshes when a scan replaces config', () => {
  const qbittorrentProbeEffect = sourceSection(
    'const requestId = ++qbittorrentRequestId.current;',
    'const source = tab ===',
  );

  assert.match(qbittorrentProbeEffect, /['"]\/api\/qbittorrent\/status['"]/);
  assert.match(qbittorrentProbeEffect, /\}, \[auth, config, qbittorrentProbeRevision\]\);/);
});

test('Arr connection probes sign out on 401 and expose ordinary connection failures', () => {
  const probeEffect = sourceSection(
    'const requestId = ++arrConnectionsRequestId.current;',
    'const requestId = ++qbittorrentRequestId.current;',
  );

  assert.match(probeEffect, /connectionError instanceof ApiError && connectionError\.status === 401/);
  assert.match(probeEffect, /setAuth\('signed-out'\)/);
  assert.match(probeEffect, /setConfig\(null\)/);
  assert.match(probeEffect, /setScan\(null\)/);
  assert.match(probeEffect, /state: configured\.radarr \? 'error' : 'not-configured'/);
  assert.match(probeEffect, /state: configured\.sonarr \? 'error' : 'not-configured'/);
  assert.match(probeEffect, /error: configured\.radarr \? connectionErrorMessage : null/);
  assert.match(probeEffect, /error: configured\.sonarr \? connectionErrorMessage : null/);
});

test('untracked-file confirmation offers all actions and adds a second permanent-delete confirmation', () => {
  const dialog = sourceSection('function ConfirmDialog', 'export default function App');
  const cancelIndex = dialog.indexOf('>CANCEL</button>');
  const quarantineIndex = dialog.indexOf("'QUARANTINE'");
  const permanentChoiceIndex = dialog.indexOf('onClick={onChoosePermanent}');

  assert.ok(cancelIndex >= 0);
  assert.ok(quarantineIndex > cancelIndex);
  assert.ok(permanentChoiceIndex > quarantineIndex);
  assert.match(dialog, /stage === 'permanent'/);
  assert.match(dialog, /FINAL DELETION CONFIRMATION/);
  assert.match(dialog, /This cannot be undone/);
  assert.match(dialog, /onClick=\{onConfirmPermanent\}/);
  assert.match(dialog, /DELETE PERMANENTLY/);
});

test('untracked-file requests carry the selected action and explicit permanent confirmation', () => {
  const applySelection = sourceSection('async function applySelection', "if (auth === 'loading')");

  assert.match(applySelection, /if \(tab === 'orphans' && !orphanAction\) return/);
  assert.match(applySelection, /action: orphanAction/);
  assert.match(applySelection, /confirmPermanent: orphanAction === 'permanent'/);
  assert.match(appSource, /onQuarantine=\{\(\) => \{ void applySelection\('quarantine'\); \}\}/);
  assert.match(appSource, /onChoosePermanent=\{\(\) => setConfirmationStage\('permanent'\)\}/);
  assert.match(appSource, /onConfirmPermanent=\{\(\) => \{ void applySelection\('permanent'\); \}\}/);
});

test('untracked-file settings no longer contain a global action or permanent-delete switch', () => {
  assert.doesNotMatch(settingsSource, /form\.orphan\.action|allowPermanentDelete/);
  assert.doesNotMatch(settingsSource, /<label className="field">Action<select/);
  assert.match(settingsSource, /className="field wide-field"><label htmlFor="quarantine-directory"/);
});

test('both result types can be ignored and restored from the ignore list', () => {
  const ignoreSelection = sourceSection(
    'async function ignoreSelection()',
    'async function applySelection',
  );
  const manifestControls = sourceSection(
    '<div className="manifest-tools">',
    '{!scan ? (',
  );

  assert.doesNotMatch(ignoreSelection, /tab !== 'oversized'/);
  assert.match(ignoreSelection, /['"]\/api\/exclusions['"]/);
  assert.match(ignoreSelection, /scope: tab === 'orphans' \? 'orphan' : 'oversized'/);
  assert.match(ignoreSelection, /if \(await runScan\(\)\)/);
  assert.match(ignoreSelection, /Operations → Ignore list/);
  assert.match(manifestControls, /onClick=\{ignoreSelection\}/);
  assert.match(manifestControls, /'Ignore selected'/);
  assert.match(manifestControls, /setOperationsTab\('exclusions'\)/);
  assert.match(manifestControls, />Ignore list<\/button>/);
  assert.match(operationsSource, /exclusions: 'Ignore list'/);
  assert.match(operationsSource, /Untracked file/);
  assert.match(operationsSource, /Size-limit file/);
  assert.match(operationsSource, /Remove from ignore list/);
  assert.doesNotMatch(operationsSource, />Remove exclusion<|<h3>No exclusions<|>Exclusions</);
});

test('atomic state updates are serialized and kept private', async () => {
  const store = createJsonStore('counter.json', { version: 1, counter: 0 });
  await Promise.all(Array.from({ length: 40 }, () => store.update((document) => {
    document.counter += 1;
  })));
  assert.equal(store.read().counter, 40);
  assert.equal(JSON.parse(await readFile(store.filePath, 'utf8')).counter, 40);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
});

test('replacement tracking distinguishes a search, queued download, imported file, and missing result', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let commandStatus = 'started';
  let commandMissing = false;
  let queued = false;
  let hasFile = false;
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v3/command/99') {
      return commandMissing ? Response.json({}, { status: 404 }) : Response.json({ id: 99, status: commandStatus });
    }
    if (endpoint === '/api/v3/queue/details') return Response.json(queued ? [{ movieId: 12 }] : []);
    if (endpoint === '/api/v3/movie/12') return Response.json({ id: 12, hasFile });
    return Response.json({}, { status: 404 });
  };
  const connection = { url: 'http://fixture.invalid', kind: 'radarr', apiKey: 'fixture' };
  const candidate = { app: 'radarr', searchIds: [12] };
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'searching');
  commandStatus = 'completed';
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'no_result');
  queued = true;
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'download_queued');
  queued = false;
  hasFile = true;
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'downloaded');
  commandMissing = true;
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'downloaded');
  hasFile = false;
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'unknown');
  commandMissing = false;
  commandStatus = 'failed';
  assert.equal((await replacementProgress(connection, candidate, 99)).status, 'search_failed');
});

test('an orphan that gains a hardlink after scanning is preserved', async () => {
  const mediaRoot = path.join(testRoot, 'media');
  const downloadRoot = path.join(testRoot, 'downloads');
  await mkdir(mediaRoot);
  await mkdir(downloadRoot);
  const source = path.join(downloadRoot, 'movie.mkv');
  await writeFile(source, 'fixture media');
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
    orphanAction: 'permanent',
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const scan = await scanOrphans(config, arr);
  assert.equal(scan.candidates.length, 1);
  await link(source, path.join(mediaRoot, 'imported.mkv'));
  await assert.rejects(applyOrphanCandidate(config, scan.candidates[0]), /changed after revalidation/);
  assert.equal((await stat(source)).nlink, 2);
});

test('orphan ignore identity follows the exact path across Arr ownership', async () => {
  const sharedRoot = path.join(testRoot, 'shared-ignore-root');
  await mkdir(sharedRoot);
  const sharedPath = path.join(sharedRoot, 'shared-orphan.mkv');
  await writeFile(sharedPath, 'shared orphan fixture');
  const config = {
    radarr: { mediaRoots: [sharedRoot], downloadRoots: [] },
    sonarr: { mediaRoots: [sharedRoot], downloadRoots: [] },
    qbittorrent: { configured: false },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'connected', knownPaths: new Set() },
  };

  const scan = await scanOrphans(config, arr);
  const candidates = scan.candidates.filter((candidate) => candidate.path === sharedPath);
  assert.deepEqual(candidates.map((candidate) => candidate.app).sort(), ['radarr', 'sonarr']);
  assert.equal(new Set(candidates.flatMap((candidate) => candidate.exclusionKeys)).size, 1);
  assert.match(candidates[0].exclusionKeys[0], /^orphan:path:/);
});

test('qBittorrent excludes incomplete torrent content but leaves completed downloads eligible', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-media');
  const downloadRoot = path.join(testRoot, 'qbit-downloads');
  const activeRoot = path.join(downloadRoot, 'active-release');
  await mkdir(mediaRoot);
  await mkdir(activeRoot, { recursive: true });
  const libraryOrphan = path.join(mediaRoot, 'unknown.mkv');
  const activeDownload = path.join(activeRoot, 'active.mkv');
  const completedDownload = path.join(downloadRoot, 'completed.mkv');
  await Promise.all([
    writeFile(libraryOrphan, 'unknown library file'),
    writeFile(activeDownload, 'active torrent file'),
    writeFile(completedDownload, 'completed torrent file'),
  ]);
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test-session; Path=/' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.2.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json([
      { content_path: activeRoot, progress: 0.4, amount_left: 100 },
      { content_path: completedDownload, progress: 1, amount_left: 0 },
    ]);
    if (endpoint === '/api/v2/auth/logout') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const scan = await scanOrphans(config, arr);
  assert.deepEqual(scan.candidates.map((candidate) => candidate.path).sort(), [completedDownload, libraryOrphan].sort());
  assert.equal(scan.warnings.length, 0);
});

test('qBittorrent failure withholds download roots while library orphan scanning continues', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-outage-media');
  const downloadRoot = path.join(testRoot, 'qbit-outage-downloads');
  await mkdir(mediaRoot);
  await mkdir(downloadRoot);
  const libraryOrphan = path.join(mediaRoot, 'unknown.mkv');
  await writeFile(libraryOrphan, 'unknown library file');
  await writeFile(path.join(downloadRoot, 'unsafe.mkv'), 'download file');
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const scan = await scanOrphans(config, arr);
  assert.deepEqual(scan.candidates.map((candidate) => candidate.path), [libraryOrphan]);
  assert.match(scan.warnings.join(' '), /safety check failed.*withheld/i);
});

test('metadata-pending qBittorrent torrents do not block scans but are rechecked before a file change', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-metadata-media');
  const downloadRoot = path.join(testRoot, 'qbit-metadata-downloads');
  await mkdir(mediaRoot);
  await mkdir(downloadRoot);
  const libraryOrphan = path.join(mediaRoot, 'library-orphan.mkv');
  const downloadOrphan = path.join(downloadRoot, 'completed-download.mkv');
  await writeFile(libraryOrphan, 'unknown library file');
  await writeFile(downloadOrphan, 'completed download file');
  let torrentState = 'metadata';
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test-session' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.2.0');
    if (endpoint === '/api/v2/torrents/info') {
      if (torrentState === 'metadata') return Response.json([
        { hash: 'metadata-hash', name: 'Metadata release', state: 'metaDL', progress: 0, amount_left: 1 },
        { hash: 'forced-metadata-hash', name: 'Forced metadata release', state: 'forcedMetaDL', progress: 0, amount_left: 1 },
      ]);
      return Response.json([{
        hash: 'metadata-hash',
        name: 'Metadata release',
        state: 'downloading',
        progress: 0.1,
        amount_left: 90,
        ...(torrentState === 'mapped' ? { content_path: downloadOrphan } : {}),
      }]);
    }
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };

  const scan = await scanOrphans(config, arr);

  assert.deepEqual(scan.candidates.map((candidate) => candidate.path).sort(), [downloadOrphan, libraryOrphan].sort());
  assert.deepEqual(scan.warnings, []);
  assert.equal(scan.qbittorrentSafety.checked, true);
  assert.equal(scan.qbittorrentSafety.metadataPendingCount, 2);
  assert.deepEqual(scan.qbittorrentSafety.metadataPendingTorrents.map(({ name, hash, state, reason }) => ({ name, hash, state, reason })), [
    { name: 'Metadata release', hash: 'metadata-hash', state: 'metaDL', reason: 'metadata-pending' },
    { name: 'Forced metadata release', hash: 'forced-metadata-hash', state: 'forcedMetaDL', reason: 'metadata-pending' },
  ]);
  assert.equal(scan.qbittorrentSafety.unresolvedIncompleteCount, 0);
  const downloadCandidate = scan.candidates.find((candidate) => candidate.path === downloadOrphan);
  assert.ok(downloadCandidate);
  await assert.doesNotReject(assertQbittorrentSafe(config, downloadCandidate));

  torrentState = 'mapped';
  await assert.rejects(assertQbittorrentSafe(config, downloadCandidate), /part of an incomplete torrent/i);
  torrentState = 'missing';
  await assert.rejects(assertQbittorrentSafe(config, downloadCandidate), /incomplete torrent path that could not be mapped/i);
});

test('unresolved incomplete qBittorrent paths explain that download roots were withheld while library scanning continues', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-unresolved-media');
  const downloadRoot = path.join(testRoot, 'qbit-unresolved-downloads');
  await mkdir(mediaRoot);
  await mkdir(downloadRoot);
  const libraryOrphan = path.join(mediaRoot, 'library-orphan.mkv');
  const unsafeDownload = path.join(downloadRoot, 'active-download.mkv');
  await writeFile(libraryOrphan, 'unknown library file');
  await writeFile(unsafeDownload, 'active download file');
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test-session' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.2.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json([
      { hash: 'empty-path-hash', name: 'Empty path', state: 'downloading', content_path: '', progress: 0.5, amount_left: 50 },
      { hash: 'missing-path-hash', name: 'Missing path', state: 'queuedDL', progress: 0.25, amount_left: 75 },
    ]);
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };

  const scan = await scanOrphans(config, arr);

  assert.deepEqual(scan.candidates.map((candidate) => candidate.path), [libraryOrphan]);
  assert.deepEqual(scan.roots.map(({ kind, path: rootPath }) => ({ kind, path: rootPath })), [
    { kind: 'library', path: mediaRoot },
  ]);
  assert.deepEqual(scan.warnings, [
    'qBittorrent is connected, but 2 incomplete torrent paths could not be resolved. Completed-download folders were skipped to protect active downloads; this qBittorrent issue did not block library-folder scanning. Check Settings → Connections → qBittorrent → Path mapping.',
  ]);
  assert.equal(scan.qbittorrentSafety.checked, true);
  assert.equal(scan.qbittorrentSafety.metadataPendingCount, 0);
  assert.equal(scan.qbittorrentSafety.unresolvedIncompleteCount, 2);
  assert.equal(scan.qbittorrentSafety.warning, scan.warnings[0]);
  assert.deepEqual(scan.qbittorrentSafety.unresolvedIncompleteTorrents.map(({ name, hash, state, reason, rawPath }) => ({ name, hash, state, reason, rawPath })), [
    { name: 'Empty path', hash: 'empty-path-hash', state: 'downloading', reason: 'missing-content-path', rawPath: null },
    { name: 'Missing path', hash: 'missing-path-hash', state: 'queuedDL', reason: 'missing-content-path', rawPath: null },
  ]);

  const disconnectedScan = await scanOrphans(config, {
    ...arr,
    radarr: { status: 'error', knownPaths: new Set() },
  });
  assert.match(disconnectedScan.qbittorrentSafety.warning, /did not block library-folder scanning/i);
  assert.doesNotMatch(disconnectedScan.qbittorrentSafety.warning, /library folders were still scanned/i);
});

test('one incomplete qBittorrent path outside monitored roots withholds all download candidates', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-outside-media');
  const downloadRoot = path.join(testRoot, 'qbit-outside-downloads');
  const activeRoot = path.join(downloadRoot, 'active');
  await mkdir(mediaRoot);
  await mkdir(activeRoot, { recursive: true });
  await writeFile(path.join(activeRoot, 'active.mkv'), 'active');
  await writeFile(path.join(downloadRoot, 'otherwise-eligible.mkv'), 'eligible');
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test-session' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.0.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json([
      { content_path: activeRoot, progress: 0.5, amount_left: 50 },
      { content_path: '/unrelated/download', progress: 0.5, amount_left: 50 },
    ]);
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const scan = await scanOrphans(config, arr);
  assert.equal(scan.candidates.length, 0);
  assert.match(scan.warnings.join(' '), /outside the configured completed-download roots.*withheld/i);
});

test('a metadata-pending torrent that gains a content path is preserved by the immediate pre-change check', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const mediaRoot = path.join(testRoot, 'qbit-race-media');
  const downloadRoot = path.join(testRoot, 'qbit-race-downloads');
  await mkdir(mediaRoot);
  await mkdir(downloadRoot);
  const source = path.join(downloadRoot, 'started-later.mkv');
  await writeFile(source, 'torrent file');
  let fetchingMetadata = true;
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response(null, { status: 204, headers: { 'Set-Cookie': 'QBT_SID_8080=test-session; Path=/' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.2.0');
    if (endpoint === '/api/v2/torrents/info') return Response.json(fetchingMetadata ? [{
      hash: 'metadata-race-hash',
      name: 'Metadata race release',
      state: 'metaDL',
      progress: 0,
      amount_left: 1,
    }] : [{
      hash: 'metadata-race-hash',
      name: 'Metadata race release',
      state: 'downloading',
      content_path: source,
      progress: 0.2,
      amount_left: 100,
    }]);
    if (endpoint === '/api/v2/auth/logout') return new Response(null, { status: 204 });
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { mediaRoots: [mediaRoot], downloadRoots: [downloadRoot] },
    sonarr: { mediaRoots: [], downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    ignoreDirectories: new Set(),
    extensions: new Set(['.mkv']),
    maxFiles: 100,
    hardlinkMinAgeHours: 0,
    orphanAction: 'permanent',
  };
  const arr = {
    radarr: { status: 'connected', knownPaths: new Set() },
    sonarr: { status: 'not-configured', knownPaths: new Set() },
  };
  const candidate = (await scanOrphans(config, arr)).candidates[0];
  assert.equal(candidate.path, source);
  fetchingMetadata = false;
  await assert.rejects(applyOrphanCandidate(config, candidate), /incomplete torrent.*preserved/i);
  assert.equal(await readFile(source, 'utf8'), 'torrent file');
});

test('same-size source changes are rejected during recovery revalidation', async () => {
  const source = path.join(testRoot, 'recovery-revalidation.mkv');
  await writeFile(source, 'original');
  const before = await stat(source, { bigint: true });
  const candidate = {
    path: source,
    sizeBytes: Number(before.size),
    identity: `${before.dev}:${before.ino}`,
    linkCount: Number(before.nlink),
    modifiedAt: new Date(Number(before.mtimeMs)).toISOString(),
  };
  await writeFile(source, 'modified');
  const future = new Date(Date.now() + 60000);
  await utimes(source, future, future);
  await assert.rejects(assertCandidateUnchanged(candidate), /changed after revalidation/i);
});

test('a source changed during the remote safety request is preserved', async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const downloadRoot = path.join(testRoot, 'remote-check-race');
  await mkdir(downloadRoot);
  const source = path.join(downloadRoot, 'race.mkv');
  await writeFile(source, 'original');
  const before = await stat(source, { bigint: true });
  const candidate = {
    app: 'radarr',
    source: 'download',
    path: source,
    root: downloadRoot,
    relativePath: 'race.mkv',
    sizeBytes: Number(before.size),
    identity: `${before.dev}:${before.ino}`,
    linkCount: Number(before.nlink),
    modifiedAt: new Date(Number(before.mtimeMs)).toISOString(),
  };
  let changed = false;
  globalThis.fetch = async (input) => {
    const endpoint = new URL(input).pathname;
    if (endpoint === '/api/v2/auth/login') return new Response('Ok.', { headers: { 'Set-Cookie': 'SID=test-session' } });
    if (endpoint === '/api/v2/app/version') return new Response('5.0.0');
    if (endpoint === '/api/v2/torrents/info') {
      if (!changed) {
        changed = true;
        await writeFile(source, 'modified');
        const future = new Date(Date.now() + 60000);
        await utimes(source, future, future);
      }
      return Response.json([]);
    }
    if (endpoint === '/api/v2/auth/logout') return new Response('');
    return new Response(null, { status: 404 });
  };
  const config = {
    radarr: { downloadRoots: [downloadRoot] },
    sonarr: { downloadRoots: [] },
    qbittorrent: { configured: true, url: 'http://qbit.test', username: 'admin', password: 'secret', pathMaps: [] },
    orphanAction: 'permanent',
  };
  await assert.rejects(applyOrphanCandidate(config, candidate), /changed after revalidation/i);
  assert.equal(await readFile(source, 'utf8'), 'modified');
});

test('Brig restore refuses collisions and retention remains opt-in', async (context) => {
  const original = path.join(testRoot, 'original', 'movie.mkv');
  const quarantined = path.join(testRoot, 'brig', 'movie.mkv');
  await mkdir(path.dirname(original));
  await mkdir(path.dirname(quarantined));
  await writeFile(original, 'a replacement that must be kept');
  await writeFile(quarantined, 'old media');
  const record = await recordQuarantine({
    app: 'radarr', title: 'movie.mkv', sizeBytes: 9, path: original, root: path.dirname(original),
  }, quarantined);
  await assert.rejects(restoreQuarantine(record.id), /already exists/);
  assert.equal(await readFile(original, 'utf8'), 'a replacement that must be kept');
  assert.equal(await readFile(quarantined, 'utf8'), 'old media');
  await unlink(original);
  await restoreQuarantine(record.id);
  assert.equal(await readFile(original, 'utf8'), 'old media');
  assert.equal(listQuarantine().length, 0);

  await writeFile(quarantined, 'expired media');
  await recordQuarantine({ app: 'radarr', title: 'movie.mkv', sizeBytes: 13, path: original, root: path.dirname(original) }, quarantined);
  const realNow = Date.now;
  context.after(() => { Date.now = realNow; });
  const future = realNow() + 2 * 86400000;
  Date.now = () => future;
  assert.deepEqual(await cleanupExpiredQuarantine(0), []);
  assert.equal(listQuarantine().length, 1);
  assert.equal((await cleanupExpiredQuarantine(1)).length, 1);
  assert.equal(listQuarantine().length, 0);
  await assert.rejects(stat(quarantined), { code: 'ENOENT' });
  assert.equal(await readFile(original, 'utf8'), 'old media');
});
