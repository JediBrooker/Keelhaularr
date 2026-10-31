import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

/** A minimal OpenID Connect provider: discovery, JWKS, an authorize step that always approves, and a token endpoint. */
async function startProvider(context, { email = 'captain@example.com', badSignature = false } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const grants = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, issuer);
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }] });
    if (url.pathname === '/authorize') {
      const code = randomBytes(12).toString('hex');
      grants.set(code, Object.fromEntries(url.searchParams));
      response.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
      return response.end();
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const form = Object.fromEntries(new URLSearchParams(body));
      const grant = grants.get(form.code);
      grants.delete(form.code);
      const challenge = createHash('sha256').update(form.code_verifier ?? '').digest('base64url');
      if (!grant || form.client_secret !== 'test-client-secret' || challenge !== grant.code_challenge || form.redirect_uri !== grant.redirect_uri) {
        return json(400, { error: 'invalid_grant' });
      }
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({
        iss: issuer, aud: grant.client_id, sub: 'subject-1', email, email_verified: true, nonce: grant.nonce, iat: now, exp: now + 300,
      })).toString('base64url');
      let signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
      if (badSignature) signature = `${signature.slice(0, -4)}AAAA`;
      return json(200, { access_token: 'access', token_type: 'Bearer', id_token: `${header}.${payload}.${signature}` });
    }
    json(404, { error: 'not found' });
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  context.after(() => server.close());
  return issuer;
}

async function startApp(context, issuer, extraEnv = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-oidc-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
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
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: 'keelhaularr',
      OIDC_CLIENT_SECRET: 'test-client-secret',
      OIDC_REDIRECT_URI: `${base}/api/auth/oidc/callback`,
      OIDC_ALLOWED_EMAILS: 'Captain@Example.com',
      OIDC_NAME: 'Authelia',
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${log}`);
    try { if ((await fetch(`${base}/api/auth/status`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return base;
}

const cookieValue = (response, name) => (response.headers.getSetCookie() ?? [])
  .map((cookie) => cookie.split(';')[0]).find((cookie) => cookie.startsWith(`${name}=`) && cookie.length > name.length + 1);

/** Walk the whole sign-in: start -> provider -> callback. Returns the callback response and the flow cookie. */
async function signIn(base, { tamperState = false } = {}) {
  const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const flow = cookieValue(start, 'keelhaularr_oidc');
  assert.ok(flow, 'the start step sets the flow cookie');
  const authorize = await fetch(start.headers.get('location'), { redirect: 'manual' });
  let callbackUrl = authorize.headers.get('location');
  if (tamperState) callbackUrl = callbackUrl.replace(/state=[^&]+/, 'state=forged');
  const callback = await fetch(callbackUrl, { redirect: 'manual', headers: { Cookie: flow } });
  return { callback, flow };
}

test('an allowed user signs in through the provider and gets a working session', async (context) => {
  const base = await startApp(context, await startProvider(context));
  const status = await (await fetch(`${base}/api/auth/status`)).json();
  assert.deepEqual(status.sso, { name: 'Authelia' });
  assert.equal(status.passwordLogin, true);

  const { callback } = await signIn(base);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/');
  const session = cookieValue(callback, 'keelhaularr_session');
  assert.ok(session, 'a session cookie is issued');
  assert.equal((await fetch(`${base}/api/status`, { headers: { Cookie: session } })).status, 200);
});

test('a verified email outside the allow list is refused', async (context) => {
  const base = await startApp(context, await startProvider(context, { email: 'stranger@example.com' }));
  const { callback } = await signIn(base);
  assert.equal(callback.status, 302);
  assert.match(decodeURIComponent(callback.headers.get('location')), /login_error=stranger@example\.com is not allowed/);
  assert.equal(cookieValue(callback, 'keelhaularr_session'), undefined);
});

test('a forged state or a forged ID token signature is refused', async (context) => {
  const base = await startApp(context, await startProvider(context));
  const forgedState = await signIn(base, { tamperState: true });
  assert.match(decodeURIComponent(forgedState.callback.headers.get('location')), /does not match this browser/);
  assert.equal(cookieValue(forgedState.callback, 'keelhaularr_session'), undefined);

  const badBase = await startApp(context, await startProvider(context, { badSignature: true }));
  const forgedToken = await signIn(badBase);
  assert.match(decodeURIComponent(forgedToken.callback.headers.get('location')), /signature is invalid/);
  assert.equal(cookieValue(forgedToken.callback, 'keelhaularr_session'), undefined);
});

test('a callback without the flow cookie from this browser is refused', async (context) => {
  const base = await startApp(context, await startProvider(context));
  const start = await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' });
  const authorize = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const callback = await fetch(authorize.headers.get('location'), { redirect: 'manual' });
  assert.match(decodeURIComponent(callback.headers.get('location')), /another browser/);
  assert.equal(cookieValue(callback, 'keelhaularr_session'), undefined);
});

test('the password form can be turned off once single sign-on is set up', async (context) => {
  const base = await startApp(context, await startProvider(context), { OIDC_PASSWORD_LOGIN: 'false' });
  assert.equal((await (await fetch(`${base}/api/auth/status`)).json()).passwordLogin, false);
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'captain', password: 'test-password' }),
  });
  assert.equal(login.status, 403);
});

test('single sign-on stays off without an allow list, and the password still works', async (context) => {
  const base = await startApp(context, await startProvider(context), { OIDC_ALLOWED_EMAILS: '', OIDC_PASSWORD_LOGIN: 'false' });
  const status = await (await fetch(`${base}/api/auth/status`)).json();
  assert.equal(status.sso, null);
  assert.equal(status.passwordLogin, true);
  assert.equal((await fetch(`${base}/api/auth/oidc/start`, { redirect: 'manual' })).status, 404);
});
