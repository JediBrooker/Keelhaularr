import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function startApp(context, extraEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-security-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      CONFIG_DIR: path.join(root, 'config'),
      PORT: String(port),
      APP_USERNAME: 'captain',
      APP_PASSWORD: 'test-password',
      APP_SESSION_SECRET: 'test-session-secret',
      RADARR_URL: '', RADARR_API_KEY: '', RADARR_MEDIA_ROOTS: '', RADARR_DOWNLOAD_ROOTS: '',
      SONARR_URL: '', SONARR_API_KEY: '', SONARR_MEDIA_ROOTS: '', SONARR_DOWNLOAD_ROOTS: '',
      QBITTORRENT_URL: '', QBITTORRENT_RECOVERY_ENABLED: 'false', SCHEDULE_ENABLED: 'false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  context.after(async () => {
    child.kill('SIGTERM');
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
    try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const login = async (password) => fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'captain', password }),
  });
  return { base, root, login };
}

test('a malformed cookie from any other service does not break the API', async (context) => {
  const app = await startApp(context);

  // An invalid percent-escape in an UNRELATED cookie - trivially set by any page on the
  // same host - used to throw URIError out of the cookie parser and turn every single
  // API route into a 500, leaving the interface unusable until the cookie was cleared.
  for (const cookie of ['other=%zz', 'other=%', 'a=%E0%A4%A', 'keelhaularr_session=%zz']) {
    const status = await fetch(`${app.base}/api/auth/status`, { headers: { Cookie: cookie } });
    assert.equal(status.status, 200, `auth status with cookie ${cookie}`);
    assert.equal((await status.json()).authenticated, false);

    // Protected routes answer 401, not 500.
    const guarded = await fetch(`${app.base}/api/status`, { headers: { Cookie: cookie } });
    assert.equal(guarded.status, 401, `guarded route with cookie ${cookie}`);
  }
});

test('a valid session still works alongside a malformed unrelated cookie', async (context) => {
  const app = await startApp(context);
  const cookie = (await app.login('test-password')).headers.get('set-cookie').split(';', 1)[0];

  const response = await fetch(`${app.base}/api/status`, {
    headers: { Cookie: `broken=%zz; ${cookie}; alsobroken=%` },
  });
  assert.equal(response.status, 200);
});

test('responses carry the security headers, and the policy permits the app itself', async (context) => {
  const app = await startApp(context);
  const response = await fetch(`${app.base}/api/auth/status`);

  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');

  const policy = response.headers.get('content-security-policy');
  // Framing is the one with teeth here: SameSite=Strict does not stop a page on
  // another port of the same host from framing the deck with the cookie attached and
  // overlaying a decoy control on the permanent-delete confirmation.
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /base-uri 'none'/);
  assert.match(policy, /object-src 'none'/);
  // The interface pulls its webfont stylesheet from Google, so the policy has to name
  // those hosts or the UI breaks.
  assert.match(policy, /style-src[^;]*https:\/\/fonts\.googleapis\.com/);
  assert.match(policy, /font-src[^;]*https:\/\/fonts\.gstatic\.com/);

  // HSTS only once the deployment actually claims to be HTTPS.
  assert.equal(response.headers.get('strict-transport-security'), null);
});

test('HSTS is sent when secure cookies are enabled', async (context) => {
  const app = await startApp(context, { APP_COOKIE_SECURE: 'true' });
  const response = await fetch(`${app.base}/api/auth/status`);
  assert.match(response.headers.get('strict-transport-security') ?? '', /max-age=/);
});

test('the connection test reports a status code without echoing the remote body', async (context) => {
  // Stands in for any HTTP service the container can reach that is not an Arr app.
  const secret = 'SECRET-INTERNAL-BODY-CONTENT';
  const internal = createServer((request, response) => {
    response.writeHead(403, { 'Content-Type': 'text/plain' }).end(secret);
  });
  internal.listen(0, '127.0.0.1');
  await once(internal, 'listening');
  context.after(() => internal.close());
  const internalUrl = `http://127.0.0.1:${internal.address().port}`;

  const app = await startApp(context);
  const cookie = (await app.login('test-password')).headers.get('set-cookie').split(';', 1)[0];

  const response = await fetch(`${app.base}/api/settings/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ app: 'radarr', url: internalUrl, apiKey: 'irrelevant' }),
  });
  const body = await response.text();

  // The error message is returned to the caller verbatim, so echoing the upstream body
  // turned this endpoint into an unfiltered read of anything reachable from the host.
  assert.equal(body.includes(secret), false, 'remote body must not be echoed back');
  assert.match(body, /returned HTTP 403/);
  assert.equal(response.status, 502);
});
