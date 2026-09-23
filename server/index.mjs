import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { allArrCandidates, scanArr } from './arr.mjs';
import { getConfig, publicConfig } from './config.mjs';
import { suggestDirectories } from './directories.mjs';
import {
  addExclusions,
  exclusionSummary,
  filterExcluded,
  listExclusions,
  refreshExclusionOverages,
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
import { summarizeDuplicates, verifyDuplicates } from './duplicates.mjs';
import { auditImports } from './hardlink-audit.mjs';
import { historySummary } from './history.mjs';
import { identifyOrphansForCandidates, identifyScanCandidates } from './imports.mjs';
import { createLoginThrottle } from './login-throttle.mjs';
import { discoverMediaServerLibraries, inspectMediaServer } from './mediaserver.mjs';
import { locateReportedPath, quarantineSuggestion, relativeSamples, rootAccessProblem } from './root-access.mjs';
import {
  discoverArrSettings,
  discoverDownloadFolders,
  readArrDownloadClient,
  suggestMediaServerPathMaps,
  urlHost,
} from './discovery.mjs';
import { previewOrphans, previewOversized, summarizePreview } from './preview.mjs';
import { scanOrphans } from './orphans.mjs';
import { verifyPassword } from './passwords.mjs';
import { findReplacementsForCandidates } from './replacements.mjs';
import { listQuarantine, purgeQuarantine, reconcileQuarantine, restoreQuarantine } from './quarantine.mjs';
import {
  qbittorrentRecoveryStatus,
  startQbittorrentRecovery,
  stopQbittorrentRecovery,
} from './qbittorrent-recovery.mjs';
import { categoryList, inspectQbittorrent, listQbittorrentCategories, readQbittorrentLayout } from './qbittorrent.mjs';
import { runScheduledScan, scheduleStatus, startScheduler, stopScheduler } from './scheduler.mjs';
import {
  buildSettingsOverrides,
  buildMediaServerTestConnection,
  buildQbittorrentTestConnection,
  getSettingsOverrides,
  pathMappings,
  migrateStoredPassword,
  saveSettingsOverrides,
  settingsView,
} from './settings.mjs';
import { hardlinkConfigurationWarnings, storageHealth } from './storage-health.mjs';

const app = express();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distPath = path.join(projectRoot, 'dist');

app.disable('x-powered-by');
// Deployment-level and env-only, because trusting X-Forwarded-For when nothing strips
// it lets any caller claim any address. Set TRUST_PROXY only when a reverse proxy in
// front of Keelhaularr sets that header itself: `1` for a single proxy, or a subnet
// list such as `loopback, 172.16.0.0/12`. Without it every request behind a proxy looks
// like it came from the proxy, which is what the login throttle below has to survive.
const trustProxy = (process.env.TRUST_PROXY ?? '').trim();
if (trustProxy && trustProxy !== 'false') {
  if (/^\d+$/.test(trustProxy)) app.set('trust proxy', Number(trustProxy));
  else if (trustProxy === 'true') app.set('trust proxy', true);
  else app.set('trust proxy', trustProxy);
}
app.use(express.json({ limit: '256kb' }));
app.use((request, response, next) => {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  // frame-ancestors matters most here: SameSite=Strict does not stop a page served
  // from another port on the same host from framing this one, cookie attached, and
  // overlaying a decoy control on the permanent-delete confirmation.
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join('; '));
  if (currentConfig().cookieSecure) {
    response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

const loginThrottle = createLoginThrottle();

// One password check at a time. scrypt costs memory and CPU by design, so answering a
// burst of parallel guesses concurrently would turn the login route into a way to
// exhaust the container rather than a way to guess the password.
let verifyQueue = Promise.resolve();
function queuedVerify(password, stored) {
  const run = () => verifyPassword(password, stored);
  verifyQueue = verifyQueue.then(run, run);
  return verifyQueue;
}

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
    const raw = cookie.slice(index + 1);
    let value;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // An invalid percent-escape in ANY cookie - including one set by an unrelated
      // service on the same host - used to throw out of here and surface as a 500 on
      // every single API route, leaving the interface unusable.
      value = raw;
    }
    return [cookie.slice(0, index).trim(), value];
  }).filter(([key]) => key));
}

/**
 * The signing key is bound to the stored credential, so changing the password
 * invalidates every session that was issued under the old one. Without this a stolen
 * cookie kept working for the rest of its lifetime - up to a year - and changing the
 * password, the one thing anyone does after suspecting a compromise, did nothing.
 */
function sessionKey(config) {
  return createHmac('sha256', config.sessionSecret).update(String(config.password)).digest();
}

function signSession(config) {
  const payload = Buffer.from(JSON.stringify({
    username: config.username,
    expiresAt: Date.now() + config.sessionDays * 86400000,
  })).toString('base64url');
  const signature = createHmac('sha256', sessionKey(config)).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validSession(request, config) {
  try {
    return checkSession(request, config);
  } catch {
    return false;
  }
}

function checkSession(request, config) {
  if (!config.password || !config.sessionSecret) return false;
  const token = parseCookies(request).keelhaularr_session;
  if (!token) return false;
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length) return false;
  const expected = createHmac('sha256', sessionKey(config)).update(payload).digest('base64url');
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

app.post('/api/auth/login', async (request, response) => {
  const config = currentConfig();
  if (!config.password) {
    response.status(503).json({ error: 'Set APP_PASSWORD in .env before signing in.' });
    return;
  }
  const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
  if (loginThrottle.refuses(key)) {
    // Refused without hashing, so a sustained attack cannot keep spending scrypt.
    response.status(429).json({ error: 'Too many failed logins. Try again later.' });
    return;
  }
  const username = typeof request.body?.username === 'string' ? request.body.username : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  // Both halves are always evaluated so a wrong username costs the same as a wrong
  // password, and the credential may be stored either hashed or - from .env - plain.
  const usernameMatches = safeEqual(username, config.username);
  const passwordMatches = await queuedVerify(password, config.password);
  if (!usernameMatches || !passwordMatches) {
    const delay = loginThrottle.fail(key);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    response.status(401).json({ error: 'Incorrect username or password.' });
    return;
  }
  loginThrottle.succeed(key);
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
    reclaimed: historySummary(listQuarantine(), 0),
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

app.get('/api/mediaserver/status', async (request, response, next) => {
  try {
    const connection = currentConfig().mediaServer;
    if (!connection.configured) {
      const error = new Error('No media server is configured.');
      error.statusCode = 400;
      throw error;
    }
    const snapshot = await inspectMediaServer(connection);
    response.json({
      status: snapshot.status,
      kind: connection.kind,
      watchedWithinDays: connection.watchedWithinDays,
      protectedCount: snapshot.protectedCount,
      unmappedCount: snapshot.unmappedCount,
      inProgressCount: snapshot.inProgressCount,
      accountCount: snapshot.accountCount,
      samples: snapshot.samples,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/mediaserver/test', async (request, response, next) => {
  try {
    const config = currentConfig();
    const connection = buildMediaServerTestConnection(request.body, config.mediaServer);
    const libraryRoots = pathHints(request.body?.libraryRoots)
      ?? [...config.radarr.mediaRoots, ...config.sonarr.mediaRoots];
    let suggestions = [];
    let unresolved = [];
    try {
      const libraries = await discoverMediaServerLibraries(connection);
      ({ suggestions, unresolved } = suggestMediaServerPathMaps(libraries, {
        pathMaps: connection.pathMaps,
        storageRoots: config.storageRoots,
        libraryRoots,
      }));
    } catch (error) {
      // An unreachable server or a rejected token would fail the check below in the
      // same way, so it is reported once; anything else only means nothing to suggest.
      if (error?.connectionFailure) throw error;
    }
    // Counted with the suggested mappings in place, because those are what the form
    // will hold once they are filled in.
    const snapshot = await inspectMediaServer({
      ...connection,
      pathMaps: longestFirst([...connection.pathMaps, ...suggestions]),
    });
    response.json({
      status: snapshot.status,
      kind: connection.kind,
      watchedWithinDays: connection.watchedWithinDays,
      protectedCount: snapshot.protectedCount,
      unmappedCount: snapshot.unmappedCount,
      inProgressCount: snapshot.inProgressCount,
      accountCount: snapshot.accountCount,
      samples: snapshot.samples,
      suggestedPathMaps: suggestions,
      unresolvedLocations: unresolved
        .map((location) => safeConnectionText(location, 4096, [connection.token]))
        .filter(Boolean),
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/qbittorrent/recovery/status', (request, response) => {
  response.json(qbittorrentRecoveryStatus(currentConfig()));
});

function longestFirst(mappings) {
  return [...mappings].sort((first, second) => String(second.from).length - String(first.from).length);
}

// Folders sent along with a test only as hints for what to look for. A half-typed or
// relative entry in some other field is skipped rather than failing this test: the
// save checks every field properly, and a test that cannot run until everything else
// on the page is right is not much of a test.
function pathHints(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 100)
    .filter((entry) => typeof entry === 'string' && entry.length <= 4096
      && !/[\u0000-\u001f\u007f]/.test(entry) && path.isAbsolute(entry.trim()))
    .map((entry) => path.resolve(entry.trim()));
}

function pathMapHints(value, label) {
  try {
    return pathMappings(value, label);
  } catch {
    return null;
  }
}

function httpUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/**
 * The qBittorrent categories and remote path mappings Radarr and Sonarr use, read from
 * the applications themselves using what is in the form. A saved API key is only sent
 * to the URL it was saved for. Failures become notes, never a failed qBittorrent test,
 * and name only the status code so this cannot be used to read other services' pages.
 */
async function arrDownloadSettings(input, config) {
  const apps = {};
  const notes = [];
  const secrets = [];
  const libraryRoots = [];
  for (const kind of ['radarr', 'sonarr']) {
    const label = kind === 'radarr' ? 'Radarr' : 'Sonarr';
    const entry = input && typeof input === 'object' && !Array.isArray(input) ? input[kind] : undefined;
    const saved = config[kind];
    const url = typeof entry?.url === 'string' ? entry.url.trim().replace(/\/+$/, '') : saved?.url ?? '';
    libraryRoots.push(...(pathHints(entry?.mediaRoots) ?? saved?.mediaRoots ?? []));
    const downloadRoots = pathHints(entry?.downloadRoots) ?? saved?.downloadRoots ?? [];
    const pathMaps = pathMapHints(entry?.pathMaps, `${label} path maps`) ?? saved?.pathMaps ?? [];
    if (!url) continue;
    if (!httpUrl(url)) {
      notes.push(`${label}'s URL is not a valid http(s) address, so its download settings were not read.`);
      continue;
    }
    const enteredKey = typeof entry?.apiKey === 'string' ? entry.apiKey.trim() : '';
    const apiKey = enteredKey || (saved?.apiKey && url === saved.url ? saved.apiKey : '');
    if (!apiKey) {
      notes.push(`Enter ${label}'s API key to find its completed-download folder.`);
      continue;
    }
    secrets.push(apiKey);
    try {
      const { client, remotePathMappings } = await readArrDownloadClient({ kind, url, apiKey }, kind);
      if (!client) {
        notes.push(`${label} has no enabled qBittorrent download client, so it has no qBittorrent folder to fill in.`);
        continue;
      }
      const categories = [client.category, client.importedCategory].filter(Boolean);
      if (!categories.length) {
        notes.push(`${label}'s qBittorrent download client has no category, so its downloads cannot be told apart from anything else in qBittorrent. Set one in ${label} → Settings → Download Clients.`);
        continue;
      }
      apps[kind] = { categories, remotePathMappings, pathMaps, downloadRoots };
    } catch (error) {
      notes.push(`${label}'s download client settings could not be read (${error?.statusCode ? `HTTP ${error.statusCode}` : 'no answer'}).`);
    }
  }
  return { apps, notes, secrets, libraryRoots };
}

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
      const layout = await readQbittorrentLayout(connection);
      const arr = await arrDownloadSettings(request.body?.arr, config);
      const discovery = discoverDownloadFolders(layout, arr.apps, {
        qbittorrentPathMaps: connection.pathMaps,
        storageRoots: config.storageRoots,
        libraryRoots: arr.libraryRoots,
      });
      // Checked with the discovered folders and mappings in place, because those are
      // what the form will hold once they are filled in: an application whose folders
      // were typed in keeps them, and one left empty gets what was found.
      const snapshot = await inspectQbittorrent({
        ...connection,
        pathMaps: longestFirst([...connection.pathMaps, ...discovery.qbittorrentPathMaps]),
      });
      const effectiveRoots = [
        ...downloadRoots,
        ...Object.entries(discovery.folders).flatMap(([app, found]) => (
          arr.apps[app]?.downloadRoots.length ? arr.apps[app].downloadRoots : found.localPaths
        )),
      ];
      const outsideDownloadRootCount = effectiveRoots.length
        ? snapshot.incompletePaths.filter((candidatePath) => (
          !effectiveRoots.some((root) => pathsOverlap(root, candidatePath))
        )).length
        : 0;
      // Notes hold paths and category names. The API keys used to read them are
      // redacted anyway; the qBittorrent password is not, because a short one would
      // blank out ordinary words in every path it happens to appear in.
      const safe = (value) => safeConnectionText(value, 1000, arr.secrets);
      response.json({
        connected: true,
        version: snapshot.version,
        totalTorrentCount: snapshot.totalTorrentCount,
        incompleteTorrentCount: snapshot.incompleteTorrentCount,
        unmappedIncompleteCount: snapshot.unmappedIncompleteCount,
        outsideDownloadRootCount,
        categories: categoryList(layout.categories),
        discovered: {
          downloadFolders: Object.fromEntries(Object.entries(discovery.folders).map(([app, found]) => [app, {
            localPaths: found.localPaths,
            problems: found.problems.map(safe).filter(Boolean),
          }])),
          qbittorrentPathMaps: discovery.qbittorrentPathMaps,
          arrPathMaps: discovery.arrPathMaps,
          notes: arr.notes.map(safe).filter(Boolean),
        },
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
    // redirect: 'error' so the API key is never replayed to a redirect target.
    const [arrResponse, rootResponse] = await Promise.all([
      fetch(`${rawUrl}/api/v3/system/status`, { signal: AbortSignal.timeout(10000), redirect: 'error', headers }),
      fetch(`${rawUrl}/api/v3/rootfolder`, { signal: AbortSignal.timeout(10000), redirect: 'error', headers }),
    ]);
    if (!arrResponse.ok || !rootResponse.ok) {
      const failed = !arrResponse.ok ? arrResponse : rootResponse;
      // The status code is enough to diagnose a connection problem. Returning the
      // remote body made this endpoint read back 300 bytes of any HTTP service the
      // container can reach, since the error message is sent to the caller verbatim.
      const error = new Error(`${kind} returned HTTP ${failed.status}. Check the URL and API key.`);
      error.statusCode = 502;
      throw error;
    }
    const status = await arrResponse.json();
    const roots = await rootResponse.json();
    const rootFolders = Array.isArray(roots)
      ? roots.map((root) => root?.path).filter((root) => typeof root === 'string' && root)
      : [];
    // Everything else the application knows that the form asks for. Best effort: the
    // connection itself has already passed, and that is what this test reports.
    const discovery = await discoverArrSettings({ kind, url: rawUrl, apiKey }, { kind, arrHost: urlHost(rawUrl) })
      .catch(() => ({ qbittorrent: null, mediaServer: null, remotePathMappings: [], importedPaths: [] }));
    const text = (value, maximumLength) => safeConnectionText(value, maximumLength, [apiKey]) ?? '';
    // Radarr and Sonarr report paths from inside their own containers. Saying which of
    // them Keelhaularr can actually open, and where it sees the others, turns a
    // save-time "does not exist" into a filled-in folder and path mapping. Recent
    // imports are the evidence that a folder found under another name is the same.
    const rootFolderChecks = rootFolders.map((reported) => {
      const problem = rootAccessProblem(reported, { label: 'Folder', storageRoots: config.storageRoots });
      const localPath = problem && !existsSync(reported)
        ? locateReportedPath(reported, config.storageRoots, {
          samples: relativeSamples(reported, discovery.importedPaths),
        })
        : null;
      return { reported, usable: !problem, localPath, problem };
    });
    const libraryRoot = rootFolderChecks.map((check) => (check.usable ? check.reported : check.localPath)).find(Boolean);
    const trashDir = typeof request.body?.trashDir === 'string' ? request.body.trashDir.trim() : '';
    const suggestedTrashDir = libraryRoot && path.isAbsolute(trashDir) ? quarantineSuggestion(libraryRoot, trashDir) : null;
    response.json({
      connected: true,
      version: safeConnectionText(status?.version, 64, [apiKey]),
      rootFolders,
      rootFolderChecks,
      discovered: {
        qbittorrent: discovery.qbittorrent ? {
          url: text(discovery.qbittorrent.url, 2048),
          reachable: discovery.qbittorrent.reachable === true,
          username: text(discovery.qbittorrent.username, 256),
          category: text(discovery.qbittorrent.category, 256),
          clientName: text(discovery.qbittorrent.clientName, 128),
        } : null,
        mediaServer: discovery.mediaServer ? {
          kind: discovery.mediaServer.kind,
          url: text(discovery.mediaServer.url, 2048),
          reachable: discovery.mediaServer.reachable === true,
        } : null,
        quarantine: suggestedTrashDir ? { current: trashDir, suggested: suggestedTrashDir } : null,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/scan', async (request, response, next) => {
  try {
    const config = currentConfig();
    const arr = await scanArr(config);
    await refreshExclusionOverages(arr);
    const orphans = await scanOrphans(config, arr);
    const oversized = filterExcluded(allArrCandidates(arr));
    const orphanCandidates = filterExcluded(orphans.candidates);
    // Identification runs as part of every scan, because "nothing tracks this" is only
    // half an answer and the other half decides whether deleting the file is safe. It
    // is a string match against the library rather than a folder read, and repeated
    // names are cached, so a scan costs one request per newly seen name.
    const identifications = config.orphanAutoIdentify
      ? await identifyScanCandidates(config, arr, orphanCandidates, config.orphanAutoIdentifyLimit)
      : [];
    // Two stats per spare copy, which is cheap enough to run on every row of every
    // scan. It only ever separates "different sizes, so definitely not the same file"
    // from "worth a closer look"; reading contents is left to an explicit check.
    const duplicates = await verifyDuplicates(orphanCandidates, identifications, { mode: 'size' });
    // Both of these explain why untracked files keep appearing, so they belong on the
    // scan rather than on a page nobody opens. Neither is allowed to fail a scan: a
    // diagnostic that breaks the tool it is diagnosing is worse than no diagnostic.
    const [hardlinkWarnings, importAudit] = await Promise.all([
      hardlinkConfigurationWarnings(config).catch(() => []),
      auditImports(config).catch(() => ({ checkedAt: null, instances: [], warnings: [] })),
    ]);
    response.json({
      scannedAt: new Date().toISOString(),
      config: publicConfig(config),
      connections: {
        radarr: { status: arr.radarr.status, version: arr.radarr.version, error: arr.radarr.error },
        sonarr: { status: arr.sonarr.status, version: arr.sonarr.version, error: arr.sonarr.error },
      },
      oversized: oversized.sort((a, b) => b.overageBytes - a.overageBytes),
      orphans: orphanCandidates.sort((a, b) => b.sizeBytes - a.sizeBytes),
      identifications,
      duplicates,
      duplicateSummary: summarizeDuplicates(duplicates),
      importAudit,
      roots: orphans.roots,
      qbittorrentSafety: orphans.qbittorrentSafety,
      warnings: [...arr.radarr.warnings, ...arr.sonarr.warnings, ...orphans.warnings],
      // Deliberately not folded into `warnings`. A warning there means the scan could
      // not see everything, so its results may be incomplete. These say the opposite:
      // the results are accurate, and here is why they keep looking like this.
      advisories: [...hardlinkWarnings, ...importAudit.warnings],
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
    const action = request.body?.action ?? 'permanent';
    if (action !== 'quarantine' && action !== 'permanent') {
      response.status(400).json({ error: 'Choose either quarantine or permanent for the selected oversized files.' });
      return;
    }
    if (action === 'permanent' && request.body?.confirmPermanent !== true) {
      response.status(400).json({ error: 'Permanent removal of a tracked file requires explicit confirmation.' });
      return;
    }
    const config = currentConfig();
    const job = await createOversizeJob(config, ids, action);
    response.status(202).json({ job });
  } catch (error) {
    next(error);
  }
});

// Dry run. Evaluates the very gates a real job would and reports each verdict without
// moving, deleting or downloading anything.
app.post('/api/preview', async (request, response, next) => {
  try {
    const tab = request.body?.tab;
    if (tab !== 'oversized' && tab !== 'orphans') {
      response.status(400).json({ error: 'Preview requires either oversized or orphans.' });
      return;
    }
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter((id) => typeof id === 'string') : [];
    if (!ids.length || ids.length > 500) {
      response.status(400).json({ error: 'Preview between 1 and 500 files at a time.' });
      return;
    }
    const action = request.body?.action;
    // Relink only exists for untracked files: there is no tracked-file equivalent of
    // "this is a second copy of something the library already holds".
    const allowed = tab === 'orphans'
      ? ['quarantine', 'permanent', 'relink']
      : ['quarantine', 'permanent'];
    if (!allowed.includes(action)) {
      response.status(400).json({ error: `Preview requires ${allowed.slice(0, -1).join(', ')} or ${allowed.at(-1)}.` });
      return;
    }
    const checkReplacements = request.body?.checkReplacements === true;

    const config = currentConfig();
    const arr = await scanArr(config);
    const requested = new Set(ids);

    let rows;
    if (tab === 'oversized') {
      const all = filterExcluded(allArrCandidates(arr));
      const eligibleIds = new Set(all.map((candidate) => candidate.id));
      const candidates = all.filter((candidate) => requested.has(candidate.id));
      if (!candidates.length) {
        response.status(409).json({ error: 'None of the selected files are still oversized.' });
        return;
      }
      rows = await previewOversized(config, candidates, { action, eligibleIds, checkReplacements });
    } else {
      const orphans = await scanOrphans(config, arr);
      const all = filterExcluded(orphans.candidates);
      const eligibleIds = new Set(all.map((candidate) => candidate.id));
      const candidates = all.filter((candidate) => requested.has(candidate.id));
      if (!candidates.length) {
        response.status(409).json({ error: 'None of the selected files are still eligible.' });
        return;
      }
      rows = await previewOrphans(config, candidates, { action, eligibleIds });
    }

    response.json({ preview: { rows, summary: summarizePreview(rows) } });
  } catch (error) {
    next(error);
  }
});

// Read-only: asks each application's interactive search whether a release exists that
// would satisfy the same size limit that flagged the file. Never mutates anything.
app.post('/api/oversized/replacements', async (request, response, next) => {
  try {
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter((id) => typeof id === 'string') : [];
    if (!ids.length || ids.length > 50) {
      response.status(400).json({ error: 'Check between 1 and 50 files at a time. Interactive search queries live indexers.' });
      return;
    }
    const config = currentConfig();
    const scan = await scanArr(config);
    const requested = new Set(ids);
    const candidates = filterExcluded(allArrCandidates(scan))
      .filter((candidate) => requested.has(candidate.id));
    if (!candidates.length) {
      response.status(409).json({ error: 'None of the selected files are still oversized.' });
      return;
    }
    response.json({ replacements: await findReplacementsForCandidates(config, candidates) });
  } catch (error) {
    next(error);
  }
});

// Read-only: asks each application what an untracked file actually is, and whether the
// movie or episode it belongs to already has a tracked file. Never mutates anything.
app.post('/api/orphans/identify', async (request, response, next) => {
  try {
    const ids = Array.isArray(request.body?.ids) ? request.body.ids.filter((id) => typeof id === 'string') : [];
    if (!ids.length || ids.length > 200) {
      response.status(400).json({ error: 'Identify between 1 and 200 files at a time. Each folder is read from disk by Radarr or Sonarr.' });
      return;
    }
    const config = currentConfig();
    const arr = await scanArr(config);
    const scan = await scanOrphans(config, arr);
    const requested = new Set(ids);
    const candidates = filterExcluded(scan.candidates).filter((candidate) => requested.has(candidate.id));
    if (!candidates.length) {
      response.status(409).json({ error: 'None of the selected files are still untracked.' });
      return;
    }
    const identifications = await identifyOrphansForCandidates(config, candidates);
    // Asked for explicitly and bounded to 200 rows, so this one reads the files: the
    // sampled windows separate "the library has this film" from "the library has these
    // exact bytes", which is the difference between deleting and relinking.
    const duplicates = await verifyDuplicates(candidates, identifications, { mode: 'sampled' });
    response.json({ identifications, duplicates, duplicateSummary: summarizeDuplicates(duplicates) });
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
    if (!['quarantine', 'permanent', 'import', 'relink'].includes(action)) {
      response.status(400).json({ error: 'Choose quarantine, permanent, import or relink for the selected files.' });
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

app.post('/api/exclusions/refresh', async (request, response, next) => {
  try {
    const arr = await scanArr(currentConfig());
    const exclusions = await refreshExclusionOverages(arr);
    response.json({ exclusions, ignoreSummary: exclusionSummary(exclusions) });
  } catch (error) {
    next(error);
  }
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
    await refreshExclusionOverages(arr);
    const requested = new Set(ids);
    const currentCandidates = scope === 'oversized'
      ? allArrCandidates(arr)
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

app.get('/api/history', (request, response) => {
  response.json({ history: historySummary(listQuarantine(), 50) });
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

migrateStoredPassword()
  .then((migrated) => {
    if (migrated) console.log('Rehashed the stored login password; existing sessions were signed out.');
  })
  .catch((error) => console.error('Could not rehash the stored login password:', error));

startJobWorker(currentConfig);
startScheduler(currentConfig);
startQbittorrentRecovery(currentConfig, createQbittorrentRecoveryJob);
reconcileQuarantine().catch((error) => console.error('Quarantine reconciliation failed:', error));

// A file action is not interruptible, so shutdown stops taking new work and then waits
// for whatever is in flight to reach a point where stopping is safe. Jobs are durable
// and resume on the next start, so anything not reached is left untouched rather than
// being reported as a failure it never had.
const SHUTDOWN_GRACE_MS = 8000;
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // A second signal means whoever sent it has stopped waiting.
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    stopQbittorrentRecovery();
    stopScheduler();
    server.close();
    const forced = setTimeout(() => {
      console.warn('Shutting down with a file action still running; it will resume on the next start.');
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    forced.unref?.();
    stopJobWorker()
      .catch((error) => console.error('Job worker shutdown failed:', error))
      .finally(() => process.exit(0));
  });
}
