import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { applyOversized, scanArr } from './arr.mjs';
import { getConfig, publicConfig } from './config.mjs';
import { applyOrphans, scanOrphans } from './orphans.mjs';

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

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
  const config = getConfig();
  response.json({
    authenticated: validSession(request, config),
    setupRequired: !config.password,
  });
});

app.post('/api/auth/login', (request, response) => {
  const config = getConfig();
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
  const config = getConfig();
  response.setHeader('Set-Cookie', sessionCookie(config, '', 0));
  response.json({ authenticated: false });
});

app.use('/api', (request, response, next) => {
  const config = getConfig();
  if (validSession(request, config)) return next();
  response.status(401).json({ error: 'Sign in to access the Keelhaularr deck.' });
});

app.get('/api/status', (request, response) => {
  const config = getConfig();
  response.json({ config: publicConfig(config) });
});

app.post('/api/scan', async (request, response, next) => {
  try {
    const config = getConfig();
    const arr = await scanArr(config);
    const orphans = await scanOrphans(config, arr);
    response.json({
      scannedAt: new Date().toISOString(),
      config: publicConfig(config),
      connections: {
        radarr: { status: arr.radarr.status, version: arr.radarr.version, error: arr.radarr.error },
        sonarr: { status: arr.sonarr.status, version: arr.sonarr.version, error: arr.sonarr.error },
      },
      oversized: [...arr.radarr.candidates, ...arr.sonarr.candidates]
        .sort((a, b) => b.overageBytes - a.overageBytes),
      orphans: orphans.candidates.sort((a, b) => b.sizeBytes - a.sizeBytes),
      roots: orphans.roots,
      warnings: [...arr.radarr.warnings, ...arr.sonarr.warnings, ...orphans.warnings],
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
    const config = getConfig();
    response.json(await applyOversized(config, ids));
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
    const config = getConfig();
    const arr = await scanArr(config);
    response.json(await applyOrphans(config, arr, ids));
  } catch (error) {
    next(error);
  }
});

if (existsSync(distPath)) {
  app.use(express.static(distPath, { index: false, maxAge: '1h' }));
  app.get('*splat', (request, response) => response.sendFile(path.join(distPath, 'index.html')));
}

app.use((error, request, response, next) => {
  console.error(error);
  if (response.headersSent) return next(error);
  response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

const config = getConfig();
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Keelhaularr API listening on http://0.0.0.0:${config.port}`);
  if (!config.password) console.warn('Setup required: set APP_PASSWORD in .env before signing in.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
