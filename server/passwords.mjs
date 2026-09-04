import { randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt rather than a bare digest: the login password is chosen by a person, and a
// plain SHA-256 of it falls to a wordlist in seconds if config/settings.json ever leaks
// through a backup, a bind mount or a support screenshot.
//
// N = 2^14 with r = 8 costs 16 MiB per derivation, which sits inside Node's default
// 32 MiB scrypt budget and takes roughly a tenth of a second here.
const PARAMETERS = { N: 16384, r: 8, p: 1, keyLength: 64 };
const PREFIX = 'scrypt';
const SALT_BYTES = 16;

// A stored hash is only ever written by this process, but it is read back from a file on
// disk, so the cost parameters are checked before they are handed to scrypt: an edited
// settings.json should fail the login, not exhaust the container's memory.
const MAX_MEMORY = 128 * 1024 * 1024;

export function isHashedPassword(stored) {
  return typeof stored === 'string' && stored.startsWith(`${PREFIX}$`);
}

/**
 * Hashes a password for storage. Synchronous on purpose: this runs when an
 * administrator saves settings, which happens rarely and already awaits a disk write,
 * whereas verification runs on the login route and is asynchronous below.
 */
export function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p, keyLength } = PARAMETERS;
  const derived = scryptSync(String(plain), salt, keyLength, { N, r, p });
  return [PREFIX, N, r, p, salt.toString('base64'), derived.toString('base64')].join('$');
}

function parseStoredHash(stored) {
  const [prefix, rawN, rawR, rawP, rawSalt, rawHash] = stored.split('$');
  if (prefix !== PREFIX) return null;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) return null;
  if (N < 2 || (N & (N - 1)) !== 0) return null;
  if (r > 32 || p > 16 || 128 * N * r > MAX_MEMORY) return null;
  const salt = Buffer.from(rawSalt ?? '', 'base64');
  const expected = Buffer.from(rawHash ?? '', 'base64');
  if (!salt.length || !expected.length) return null;
  return { N, r, p, salt, expected };
}

function equal(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks a password against whatever form the credential is stored in.
 *
 * A plaintext credential is still accepted, because APP_PASSWORD may come from a .env
 * file this application does not own and cannot rewrite. Anything this application
 * persists itself is hashed.
 */
export async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string' || !stored) return false;
  if (!isHashedPassword(stored)) return equal(Buffer.from(String(plain)), Buffer.from(stored));

  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const { N, r, p, salt, expected } = parsed;
  const derived = await new Promise((resolve) => {
    scrypt(String(plain), salt, expected.length, { N, r, p, maxmem: MAX_MEMORY }, (error, key) => {
      resolve(error ? null : key);
    });
  });
  return Boolean(derived) && equal(derived, expected);
}
