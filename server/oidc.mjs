import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

/**
 * Sign in through an OpenID Connect provider (Authelia, Authentik, Keycloak, ...) as well as, or
 * instead of, the password. Deployment-level and env-only, like TRUST_PROXY:
 *
 *   OIDC_ISSUER           https://auth.example.com
 *   OIDC_CLIENT_ID        keelhaularr
 *   OIDC_CLIENT_SECRET    the client's secret (sent in the token request body)
 *   OIDC_REDIRECT_URI     https://keelhaularr.example.com/api/auth/oidc/callback
 *   OIDC_ALLOWED_EMAILS   who may sign in, by verified email (comma list), and/or
 *   OIDC_ALLOWED_SUBJECTS ... by the provider's subject identifier (comma list)
 *   OIDC_NAME             button label, e.g. Authelia
 *   OIDC_PASSWORD_LOGIN   false turns the password form off once single sign-on works
 *
 * An allow list is required: without one, anyone with an account at the provider could sign in.
 * The redirect URI is configured rather than derived from request headers, so nothing a client
 * sends can redirect the provider's answer somewhere else.
 */
const list = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
const FLOW_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_S = 60;

export function oidcConfig(env = process.env) {
  const issuer = (env.OIDC_ISSUER ?? '').trim().replace(/\/+$/, '');
  const clientId = (env.OIDC_CLIENT_ID ?? '').trim();
  const clientSecret = env.OIDC_CLIENT_SECRET ?? '';
  const redirectUri = (env.OIDC_REDIRECT_URI ?? '').trim();
  const allowedEmails = list(env.OIDC_ALLOWED_EMAILS).map((email) => email.toLowerCase());
  const allowedSubjects = list(env.OIDC_ALLOWED_SUBJECTS);
  const configured = Boolean(issuer || clientId || clientSecret || redirectUri);
  const enabled = Boolean(issuer && clientId && clientSecret && redirectUri && (allowedEmails.length || allowedSubjects.length));
  return {
    configured,
    enabled,
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    allowedEmails,
    allowedSubjects,
    name: (env.OIDC_NAME ?? '').trim() || 'single sign-on',
    // The password form can only be turned off once single sign-on is fully set up.
    passwordLogin: !enabled || !/^(false|0|no|off)$/i.test((env.OIDC_PASSWORD_LOGIN ?? '').trim()),
  };
}

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

async function getJson(url, fetchImpl, init) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${new URL(url).pathname} answered ${response.status} without JSON`);
  }
  if (!response.ok) {
    const reason = typeof body?.error_description === 'string' ? body.error_description : body?.error;
    throw new Error(`${new URL(url).pathname} answered ${response.status}${reason ? `: ${String(reason).slice(0, 200)}` : ''}`);
  }
  return body;
}

let discoveryCache = null;

export function resetOidcCache() {
  discoveryCache = null;
}

async function discover(config, fetchImpl, refreshKeys = false) {
  const fresh = discoveryCache?.issuer === config.issuer && Date.now() - discoveryCache.at < 60 * 60 * 1000;
  if (fresh && !refreshKeys) return discoveryCache;
  const document = fresh ? discoveryCache.document : await getJson(`${config.issuer}/.well-known/openid-configuration`, fetchImpl);
  if (document.issuer !== config.issuer) {
    throw new Error(`The provider calls itself ${document.issuer}, not ${config.issuer}`);
  }
  const jwks = await getJson(document.jwks_uri, fetchImpl);
  discoveryCache = { issuer: config.issuer, at: Date.now(), document, keys: Array.isArray(jwks.keys) ? jwks.keys : [] };
  return discoveryCache;
}

// The state, nonce and PKCE verifier ride in a short-lived signed cookie between the two legs.
function sealFlow(flow, secret) {
  const payload = base64url(JSON.stringify(flow));
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

function openFlow(token, secret) {
  const [payload, signature, ...rest] = String(token ?? '').split('.');
  if (!payload || !signature || rest.length) throw new Error('The sign-in took too long or started in another browser. Try again.');
  if (!safeEqual(signature, createHmac('sha256', secret).update(payload).digest('base64url'))) {
    throw new Error('The sign-in took too long or started in another browser. Try again.');
  }
  const flow = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (!(Number(flow.expiresAt) > Date.now())) throw new Error('The sign-in took too long. Try again.');
  return flow;
}

export async function beginOidcLogin(config, secret, fetchImpl = fetch) {
  const { document } = await discover(config, fetchImpl);
  const flow = {
    state: base64url(randomBytes(24)),
    nonce: base64url(randomBytes(24)),
    verifier: base64url(randomBytes(48)),
    expiresAt: Date.now() + FLOW_TTL_MS,
  };
  const url = new URL(document.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid email profile',
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: base64url(createHash('sha256').update(flow.verifier).digest()),
    code_challenge_method: 'S256',
  }).toString();
  return { url: url.toString(), flowToken: sealFlow(flow, secret), maxAge: Math.round(FLOW_TTL_MS / 1000) };
}

const ALGORITHMS = {
  RS256: { hash: 'sha256' },
  RS384: { hash: 'sha384' },
  RS512: { hash: 'sha512' },
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  ES384: { hash: 'sha384', dsaEncoding: 'ieee-p1363' },
};

async function verifyIdToken(idToken, config, flow, fetchImpl) {
  const [rawHeader, rawPayload, rawSignature, ...rest] = String(idToken ?? '').split('.');
  if (!rawHeader || !rawPayload || !rawSignature || rest.length) throw new Error('The provider sent no usable ID token');
  const header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
  const algorithm = ALGORITHMS[header.alg];
  if (!algorithm) throw new Error(`Unsupported ID token signature ${header.alg}`);
  const findKey = (keys) => keys.find((key) => (!header.kid || key.kid === header.kid) && (!key.use || key.use === 'sig'));
  let key = findKey((await discover(config, fetchImpl)).keys);
  if (!key) key = findKey((await discover(config, fetchImpl, true)).keys);   // the provider rotated its keys
  if (!key) throw new Error('The ID token was signed with a key the provider does not publish');
  const valid = verify(
    algorithm.hash,
    Buffer.from(`${rawHeader}.${rawPayload}`),
    algorithm.dsaEncoding ? { key: createPublicKey({ key, format: 'jwk' }), dsaEncoding: algorithm.dsaEncoding } : createPublicKey({ key, format: 'jwk' }),
    Buffer.from(rawSignature, 'base64url'),
  );
  if (!valid) throw new Error('The ID token signature is invalid');
  const claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));
  const now = Date.now() / 1000;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer) throw new Error('The ID token is from a different issuer');
  if (!audience.includes(config.clientId)) throw new Error('The ID token is for a different client');
  if (audience.length > 1 && claims.azp && claims.azp !== config.clientId) throw new Error('The ID token is for a different client');
  if (!(Number(claims.exp) > now - CLOCK_SKEW_S)) throw new Error('The ID token has expired');
  if (Number(claims.iat) > now + CLOCK_SKEW_S) throw new Error('The ID token is dated in the future');
  if (!claims.nonce || !safeEqual(claims.nonce, flow.nonce)) throw new Error('The ID token does not belong to this sign-in');
  return claims;
}

/** Finish the sign-in: returns { subject, email } of an allowed user, or throws a message safe to show. */
export async function completeOidcLogin(config, secret, query, flowToken, fetchImpl = fetch) {
  const flow = openFlow(flowToken, secret);
  if (query.error) {
    throw new Error(`The provider refused: ${String(query.error_description || query.error).slice(0, 200)}`);
  }
  if (!query.state || !safeEqual(query.state, flow.state)) throw new Error('The sign-in does not match this browser. Try again.');
  if (!query.code) throw new Error('The provider sent no authorization code');
  const { document } = await discover(config, fetchImpl);
  const tokens = await getJson(document.token_endpoint, fetchImpl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(query.code),
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: flow.verifier,
    }).toString(),
  });
  const claims = await verifyIdToken(tokens.id_token, config, flow, fetchImpl);
  let { email, email_verified: emailVerified } = claims;
  if (!email && config.allowedEmails.length && tokens.access_token && document.userinfo_endpoint) {
    const info = await getJson(document.userinfo_endpoint, fetchImpl, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (info.sub === claims.sub) ({ email, email_verified: emailVerified } = info);
  }
  const subjectAllowed = config.allowedSubjects.includes(String(claims.sub));
  const emailAllowed = typeof email === 'string' && emailVerified !== false && config.allowedEmails.includes(email.toLowerCase());
  if (!subjectAllowed && !emailAllowed) {
    throw new Error(`${email || claims.sub} is not allowed to sign in to Keelhaularr`);
  }
  return { subject: String(claims.sub), email: email ?? null };
}
