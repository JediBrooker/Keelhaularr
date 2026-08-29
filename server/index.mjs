import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { scanArr } from './arr.mjs';
import { getConfig, publicConfig } from './config.mjs';
import { suggestDirectories } from './directories.mjs';
import {
  addExclusions,
  exclusionSummary,
  filterExcluded,
  listExclusions,
  removeExclusion,
} from './exclusions.mjs';
import {
  activeJobSummary,
  cancelJob,
  createOrphanJob,
  createOversizeJob,
  createQbittorrentRecoveryJob,
  getJob,
  listJobSummaries,
  retryJob,
  startJobWorker,
  stopJobWorker,
} from './jobs.mjs';
import { scanOrphans } from './orphans.mjs';
import { listQuarantine, purgeQuarantine, reconcileQuarantine, restoreQuarantine } from './quarantine.mjs';
import {
  qbittorrentRecoveryStatus,
  startQbittorrentRecovery,
  stopQbittorrentRecovery,
} from './qbittorrent-recovery.mjs';
import { inspectQbittorrent, listQbittorrentCategories } from './qbittorrent.mjs';
import { runScheduledScan, scheduleStatus, startScheduler, stopScheduler } from './scheduler.mjs';
import {
  buildSettingsOverrides,
  buildQbittorrentTestConnection,
  getSettingsOverrides,
  saveSettingsOverrides,
  settingsView,
} from './settings.mjs';
import { storageHealth } from './storage-health.mjs';

const app = express();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distPath = path.join(projectRoot, 'dist');

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use((request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  next();
});

const failedLogins = new Map();
const currentConfig = () => getConfig(getSettingsOverrides());

function safeConnectionText(value, maxLength, secrets = []) {
  if (typeof value !== 'string') return null;
  let text = value.replace(/[\u0000-\u001f\u007f]/g, '�').trim();
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  }
  return text ? text.slice(0, maxLength) : null;
}

async function arrConnectionStatus(connection) {
  if (!connection.configured) {
    return { status: 'not-configured', version: null, error: null };
  }

  const label = connection.kind === 'sonarr' ? 'Sonarr' : 'Radarr';
  try {
    const statusResponse = await fetch(`${connection.url}/api/v3/system/status`, {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json', 'X-Api-Key': connection.apiKey },
    });
    if (!statusResponse.ok) {
      return {
        status: 'error',
        version: null,
        error: safeConnectionText(`${label} returned HTTP ${statusResponse.status}.`, 300),
      };
    }

    let status;
    try {
      status = await statusResponse.json();
    } catch {
      return {
        status: 'error',
        version: null,
        error: `${label} returned an invalid status response.`,
      };
    }
    return {
      status: 'connected',
      version: safeConnectionText(status?.version, 64, [connection.apiKey]),
      error: null,
    };
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      status: 'error',
      version: null,
      error: safeConnectionText(
        timedOut ? `${label} connection timed out.` : `${label} could not be reached.`,
        300,
      ),
    };
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function pathsOverlap(first, second) {
  const relative = path.relative(path.resolve(first), path.resolve(second));
  const reverse = path.relative(path.resolve(second), path.resolve(first));
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
    || (!reverse.startsWith('..') && !path.isAbsolute(reverse));
}

function parseCookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((cookie) => {
    const index = cookie.indexOf('=');
    if (index < 0) return ['', ''];
    return [cookie.slice(0, index).trim(), decodeURIComponent(cookie.slice(index + 1))];
  }).filter(([key]) => key));
}

function signSession(config) {
  const payload = Buffer.from(JSON.stringify({
    username: config.username,
    expiresAt: Date.now() + config.sessionDays * 86400000,
  })).toString('base64url');
  const signature = createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSession(request, config) {
  if (!config.password || !config.sessionSecret) return false;
  const token = parseCookies(request).keelhaularr_session;
  if (!token) return false;
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length) return false;
  const expected = createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.username === config.username && Number(data.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

function sessionCookie(config, token, maxAge) {
  return [
    `keelhaularr_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${maxAge}`,
    config.cookieSecure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

app.get('/api/auth/status', (request, response) => {
  const config = currentConfig();
  response.json({
    authenticated: validSession(request, config),
    setupRequired: !config.password,
  });
});

app.post('/api/auth/login', (request, response) => {
  const config = currentConfig();
  if (!config.password) {
    response.status(503).json({ error: 'Set APP_PASSWORD in .env before signing in.' });
    return;
  }
  const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const recent = (failedLogins.get(key) ?? []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (recent.length >= 10) {
    response.status(429).json({ error: 'Too many failed logins. Try again later.' });
    return;
  }
  const username = typeof request.body?.username === 'string' ? request.body.username : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (!safeEqual(username, config.username) || !safeEqual(password, config.password)) {
    recent.push(now);
    failedLogins.set(key, recent);
    response.status(401).json({ error: 'Incorrect username or password.' });
    return;
  }
  failedLogins.delete(key);
  const maxAge = Math.round(config.sessionDays * 86400);
  response.setHeader('Set-Cookie', sessionCookie(config, signSession(config), maxAge));
  response.json({ authenticated: true });
});

app.post('/api/auth/logout', (request, response) => {
  const config = currentConfig();
  response.setHeader('Set-Cookie', sessionCookie(config, '', 0));
  response.json({ authenticated: false });
});

app.use('/api', (request, response, next) => {
  const config = currentConfig();
  if (validSession(request, config)) return next();
  response.status(401).json({ error: 'Sign in to access the Keelhaularr deck.' });
});

app.get('/api/status', (request, response) => {
  const config = currentConfig();
  response.json({
    config: publicConfig(config),
    jobs: activeJobSummary(),
    schedule: scheduleStatus(config),
    ignoreSummary: exclusionSummary(),
  });
});

app.get('/api/connections/status', async (request, response) => {
  const config = currentConfig();
  const [radarr, sonarr] = await Promise.all([
    arrConnectionStatus(config.radarr),
    arrConnectionStatus(config.sonarr),
  ]);
  response.json({ connections: { radarr, sonarr } });
});

app.get('/api/settings', (request, response) => {
  response.json({ settings: settingsView(currentConfig()) });
});

app.put('/api/settings', async (request, response, next) => {
  try {
    const nextOverrides = buildSettingsOverrides(request.body, getSettingsOverrides());
    const nextConfig = getConfig(nextOverrides);
    const forwardedProtocol = (request.get('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase();
    if (nextConfig.cookieSecure && !request.secure && forwardedProtocol !== 'https') {
      const error = new Error('Secure cookies can only be enabled while accessing Keelhaularr through HTTPS.');
      error.statusCode = 400;
      throw error;
    }
    await saveSettingsOverrides(nextOverrides);
    const maxAge = Math.round(nextConfig.sessionDays * 86400);
    response.setHeader('Set-Cookie', sessionCookie(nextConfig, signSession(nextConfig), maxAge));
    response.json({
      settings: settingsView(nextConfig),
      config: publicConfig(nextConfig),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/settings/qbittorrent/categories', async (request, response, next) => {
  try {
    const connection = currentConfig().qbittorrent;
    if (!connection.configured) {
      const error = new Error('qBittorrent is not configured.');
      error.statusCode = 400;
      throw error;
    }
    response.json({ categories: await listQbittorrentCategories(connection) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/qbittorrent/status', async (request, response, next) => {
  try {
    const connection = currentConfig().qbittorrent;
    if (!connection.configured) {
      const error = new Error('qBittorrent is not configured.');
      error.statusCode = 400;
      throw error;
    }
    const snapshot = await inspectQbittorrent(connection);
    const version = typeof snapshot.version === 'string'
      ? snapshot.version.replace(/[\u0000-\u001f\u007f]/g, '�').slice(0, 64)
      : null;
    response.json({
      status: snapshot.status,
      version,
      totalTorrentCount: snapshot.totalTorrentCount,
      incompleteTorrentCount: snapshot.incompleteTorrentCount,
      metadataPendingCount: snapshot.metadataPendingCount,
      unresolvedIncompleteCount: snapshot.unmappedIncompleteCount,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/qbittorrent/recovery/status', (request, response) => {
  response.json(qbittorrentRecoveryStatus(currentConfig()));
});

app.post('/api/settings/test', async (request, response, next) => {
  try {
    const kind = request.body?.app;
    if (!['radarr', 'sonarr', 'qbittorrent'].includes(kind)) {
      const error = new Error('Choose Radarr, Sonarr, or qBittorrent to test.');
      error.statusCode = 400;
      throw error;
    }
    const config = currentConfig();
    if (kind === 'qbittorrent') {
      const connection = buildQbittorrentTestConnection(request.body, config.qbittorrent);
      const suppliedRoots = request.body?.downloadRoots ?? [
        ...config.radarr.downloadRoots,
        ...config.sonarr.downloadRoots,
      ];
      if (!Array.isArray(suppliedRoots) || suppliedRoots.length > 100
        || suppliedRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root.trim()))) {
        const error = new Error('qBittorrent connection-test download roots must be absolute container paths.');
        error.statusCode = 400;
        throw error;
      }
      const downloadRoots = suppliedRoots.map((root) => path.resolve(root.trim()));
      const [snapshot, categories] = await Promise.all([
        inspectQbittorrent(connection),
        listQbittorrentCategories(connection),
      ]);
      const outsideDownloadRootCount = downloadRoots.length
        ? snapshot.incompletePaths.filter((candidatePath) => (
          !downloadRoots.some((root) => pathsOverlap(root, candidatePath))
        )).length
        : 0;
      response.json({
        connected: true,
        version: snapshot.version,
        totalTorrentCount: snapshot.totalTorrentCount,
        incompleteTorrentCount: snapshot.incompleteTorrentCount,
        unmappedIncompleteCount: snapshot.unmappedIncompleteCount,
        outsideDownloadRootCount,
        categories,
      });
      return;
    }
    const rawUrl = typeof request.body?.url === 'string' ? request.body.url.trim().replace(/\/+$/, '') : '';
    const apiKey = typeof request.body?.apiKey === 'string' && request.body.apiKey.trim()
      ? request.body.apiKey.trim()
      : config[kind].apiKey;
    let parsedUrl;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      const error = new Error(`${kind} URL must be valid.`);
      error.statusCode = 400;
      throw error;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      const error = new Error(`${kind} URL must use HTTP(S) without embedded credentials.`);
      error.statusCode = 400;
      throw error;
    }
    if (!apiKey) {
      const error = new Error(`${kind} API key is required for a connection test.`);
      error.statusCode = 400;
      throw error;
    }
    const headers = { Accept: 'application/json', 'X-Api-Key': apiKey };
    const [arrResponse, rootResponse] = await Promise.all([
      fetch(`${rawUrl}/api/v3/system/status`, { signal: AbortSignal.timeout(10000), headers }),
      fetch(`${rawUrl}/api/v3/rootfolder`, { signal: AbortSignal.timeout(10000), headers }),
    ]);
    if (!arrResponse.ok || !rootResponse.ok) {
      const failed = !arrResponse.ok ? arrResponse : rootResponse;
      const detail = (await failed.text()).slice(0, 300);
      throw new Error(`${kind} returned HTTP ${failed.status}${detail ? `: ${detail}` : ''}`);
    }
    const status = await arrResponse.json();
    const roots = await rootResponse.json();
    response.json({
      connected: true,
      version: status?.version ?? null,
      rootFolders: Array.isArray(roots)
        ? roots.map((root) => root?.path).filter((root) => typeof root === 'string' && root)
        : [],
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/scan', async (request, response, next) => {
  try {
    const config = currentConfig();
    const arr = await scanArr(config);
    const orphans = await scanOrphans(config, arr);
    const oversized = filterExcluded([...arr.radarr.candidates, ...arr.sonarr.candidates]);
    const orphanCandidates = filterExcluded(orphans.candidates);
    response.json({
      scannedAt: new Date().toISOString(),
      config: publicConfig(config),
      connections: {
        radarr: { status: arr.radarr.status, version: arr.radarr.version, error: arr.radarr.error },
        sonarr: { status: arr.sonarr.status, version: arr.sonarr.version, error: arr.sonarr.error },
      },
      oversized: oversized.sort((a, b) => b.overageBytes - a.overageBytes),
      orphans: orphanCandidates.sort((a, b) => b.sizeBytes - a.sizeBytes),
      roots: orphans.roots,
      qbittorrentSafety: orphans.qbittorrentSafety,
      warnings: [...arr.radarr.warnings, ...arr.sonarr.warnings, ...orphans.warnings],
      ignoreSummary: exclusionSummary(),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/oversized/apply', async (request, response, next) => {
  try {
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter((id) => typeof id === 'string') : [];
    if (!ids.length || ids.length > 10000) {
      response.status(400).json({ error: 'Select between 1 and 10,000 oversized files.' });
      return;
    }
    const config = currentConfig();
    const job = await createOversizeJob(config, ids);
    response.status(202).json({ job });
  } catch (error) {
    next(error);
  }
});

app.post('/api/orphans/apply', async (request, response, next) => {
  try {
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter((id) => typeof id === 'string') : [];
    if (!ids.length || ids.length > 10000) {
      response.status(400).json({ error: 'Select between 1 and 10,000 orphan files.' });
      return;
    }
    const action = request.body?.action;
    if (action !== 'quarantine' && action !== 'permanent') {
      response.status(400).json({ error: 'Choose either quarantine or permanent for the selected orphan files.' });
      return;
    }
    if (action === 'permanent' && request.body?.confirmPermanent !== true) {
      response.status(400).json({ error: 'Permanent deletion requires explicit confirmation.' });
      return;
    }
    const job = await createOrphanJob(currentConfig(), ids, action);
    response.status(202).json({ job });
  } catch (error) {
    next(error);
  }
});

app.get('/api/jobs', (request, response) => {
  response.json({ jobs: listJobSummaries() });
});

app.get('/api/jobs/:id', (request, response) => {
  const job = getJob(request.params.id);
  if (!job) return response.status(404).json({ error: 'Job not found.' });
  response.json({ job });
});

app.post('/api/jobs/:id/cancel', async (request, response, next) => {
  try {
    response.json({ job: await cancelJob(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/jobs/:id/retry', async (request, response, next) => {
  try {
    response.json({ job: await retryJob(request.params.id) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/exclusions', (request, response) => {
  const exclusions = listExclusions();
  response.json({ exclusions, ignoreSummary: exclusionSummary(exclusions) });
});

app.post('/api/exclusions', async (request, response, next) => {
  try {
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter((id) => typeof id === 'string') : [];
    if (!ids.length || ids.length > 10000) return response.status(400).json({ error: 'Select between 1 and 10,000 files to ignore.' });
    const scope = request.body?.scope ?? 'oversized';
    if (scope !== 'oversized' && scope !== 'orphan') {
      return response.status(400).json({ error: 'Choose either oversized or orphan ignore scope.' });
    }
    const config = currentConfig();
    const arr = await scanArr(config);
    const requested = new Set(ids);
    const currentCandidates = scope === 'oversized'
      ? [...arr.radarr.candidates, ...arr.sonarr.candidates]
      : (await scanOrphans(config, arr)).candidates;
    const candidates = currentCandidates
      .filter((candidate) => requested.has(candidate.id))
      .map((candidate) => ({ ...candidate, scope }));
    if (!candidates.length) return response.status(409).json({ error: 'None of the selected files are still eligible to ignore.' });
    const exclusions = await addExclusions(candidates);
    response.json({ exclusions, ignoreSummary: exclusionSummary(exclusions) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/exclusions/:id', async (request, response, next) => {
  try {
    if (!await removeExclusion(request.params.id)) return response.status(404).json({ error: 'Exclusion not found.' });
    const exclusions = listExclusions();
    response.json({ exclusions, ignoreSummary: exclusionSummary(exclusions) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/quarantine', (request, response) => {
  response.json({ records: listQuarantine() });
});

app.post('/api/quarantine/:id/restore', async (request, response, next) => {
  try {
    const record = await restoreQuarantine(request.params.id);
    if (!record) return response.status(404).json({ error: 'Quarantine record not found.' });
    response.json({ record, records: listQuarantine() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/quarantine/:id', async (request, response, next) => {
  try {
    const record = await purgeQuarantine(request.params.id);
    if (!record) return response.status(404).json({ error: 'Quarantine record not found.' });
    response.json({ record, records: listQuarantine() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/storage/health', async (request, response, next) => {
  try {
    response.json(await storageHealth(currentConfig()));
  } catch (error) {
    next(error);
  }
});

app.get('/api/storage/directories', async (request, response, next) => {
  try {
    response.json(await suggestDirectories(request.query.path ?? '', currentConfig()));
  } catch (error) {
    next(error);
  }
});

app.get('/api/schedule', (request, response) => {
  response.json(scheduleStatus(currentConfig()));
});

app.post('/api/schedule/run', async (request, response, next) => {
  try {
    response.json({ report: await runScheduledScan(currentConfig(), 'manual') });
  } catch (error) {
    next(error);
  }
});

app.use('/api', (request, response) => {
  response.status(404).json({ error: 'API endpoint not found.' });
});

if (existsSync(distPath)) {
  app.use(express.static(distPath, { index: false, maxAge: '1h' }));
  app.get('*splat', (request, response) => response.sendFile(path.join(distPath, 'index.html')));
}

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
});

const config = currentConfig();
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Keelhaularr API listening on http://0.0.0.0:${config.port}`);
  if (!config.password) console.warn('Setup required: set APP_PASSWORD in .env before signing in.');
});

startJobWorker(currentConfig);
startScheduler(currentConfig);
startQbittorrentRecovery(currentConfig, createQbittorrentRecoveryJob);
reconcileQuarantine().catch((error) => console.error('Quarantine reconciliation failed:', error));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopQbittorrentRecovery();
    stopScheduler();
    stopJobWorker();
    server.close(() => process.exit(0));
  });
}
