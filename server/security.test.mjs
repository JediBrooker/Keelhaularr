import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { hashPassword, isHashedPassword, verifyPassword } from './passwords.mjs';

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

test('a stored password is salted, hashed, and verifiable in both forms', async () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(isHashedPassword(hash), true);
  assert.equal(hash.includes('correct horse'), false);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('Correct horse battery staple', hash), false);
  assert.equal(await verifyPassword('', hash), false);

  // Salted, so the same password never produces the same stored value twice and a
  // leaked file cannot be attacked with one precomputed table.
  assert.notEqual(hashPassword('same'), hashPassword('same'));

  // A plaintext credential is still honoured: APP_PASSWORD may come from a .env file
  // this application does not own.
  assert.equal(await verifyPassword('plain', 'plain'), true);
  assert.equal(await verifyPassword('plain', 'other'), false);

  // Nothing unparseable is ever treated as a match.
  for (const broken of ['scrypt$', 'scrypt$0$8$1$AAAA$AAAA', 'scrypt$16384$8$1$$', 'scrypt$99999999$8$1$AAAA$AAAA']) {
    assert.equal(await verifyPassword('anything', broken), false, broken);
  }
  assert.equal(await verifyPassword('anything', ''), false);
});

async function settingsBody(base, cookie, account) {
  const view = await (await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } })).json();
  return {
    ...view.settings,
    account: { ...view.settings.account, rotateSessions: false, newPassword: '', ...account },
  };
}

test('changing the password signs out every session issued under the old one', async (context) => {
  const app = await startApp(context);
  const cookie = (await app.login('test-password')).headers.get('set-cookie').split(';', 1)[0];
  assert.equal((await fetch(`${app.base}/api/status`, { headers: { Cookie: cookie } })).status, 200);

  const update = await fetch(`${app.base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(await settingsBody(app.base, cookie, { newPassword: 'a-brand-new-password' })),
  });
  assert.equal(update.status, 200, await update.text());

  // The cookie held before the change is now worthless. Previously it stayed valid for
  // the rest of its lifetime - up to a year - so changing the password, the one thing
  // anyone does after suspecting a compromise, evicted nobody.
  assert.equal((await fetch(`${app.base}/api/status`, { headers: { Cookie: cookie } })).status, 401);

  // The administrator making the change is handed a fresh cookie and stays signed in.
  const reissued = update.headers.get('set-cookie').split(';', 1)[0];
  assert.notEqual(reissued, cookie);
  assert.equal((await fetch(`${app.base}/api/status`, { headers: { Cookie: reissued } })).status, 200);

  assert.equal((await app.login('test-password')).status, 401);
  assert.equal((await app.login('a-brand-new-password')).status, 200);
});

test('the saved password is stored hashed, and an older plaintext one is rehashed at boot', async (context) => {
  const app = await startApp(context);
  const cookie = (await app.login('test-password')).headers.get('set-cookie').split(';', 1)[0];
  const update = await fetch(`${app.base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(await settingsBody(app.base, cookie, { newPassword: 'stored-secret' })),
  });
  assert.equal(update.status, 200, await update.text());

  const settingsPath = path.join(app.root, 'config', 'settings.json');
  const saved = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(saved.values.APP_PASSWORD.includes('stored-secret'), false);
  assert.equal(isHashedPassword(saved.values.APP_PASSWORD), true);

  // An install upgraded from a version that wrote the password in the clear rehashes it
  // on the next start rather than leaving it there forever.
  const legacyRoot = await mkdtemp(path.join(os.tmpdir(), 'kh-legacy-'));
  context.after(() => rm(legacyRoot, { recursive: true, force: true }));
  const legacyConfig = path.join(legacyRoot, 'config');
  await mkdir(legacyConfig, { recursive: true });
  const legacyPath = path.join(legacyConfig, 'settings.json');
  await writeFile(legacyPath, JSON.stringify({
    version: 1,
    values: { APP_USERNAME: 'captain', APP_PASSWORD: 'legacy-plaintext' },
  }));

  const legacy = await startApp(context, { CONFIG_DIR: legacyConfig, APP_PASSWORD: '' });
  assert.equal((await legacy.login('legacy-plaintext')).status, 200);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const values = JSON.parse(await readFile(legacyPath, 'utf8')).values;
    if (isHashedPassword(values.APP_PASSWORD)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const migrated = JSON.parse(await readFile(legacyPath, 'utf8')).values;
  assert.equal(isHashedPassword(migrated.APP_PASSWORD), true, 'plaintext password should be rehashed at boot');
  assert.equal(await verifyPassword('legacy-plaintext', migrated.APP_PASSWORD), true);
});
