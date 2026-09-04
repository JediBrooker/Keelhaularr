import assert from 'node:assert/strict';
import test from 'node:test';

import { createLoginThrottle } from './login-throttle.mjs';

const settings = { windowMs: 1000, freeFailures: 3, firstDelayMs: 100, maxDelayMs: 800, hardLimit: 8 };

test('guesses are slowed rather than locked out', () => {
  const throttle = createLoginThrottle(settings);
  const delays = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    assert.equal(throttle.refuses('client', 0), false, `attempt ${attempt + 1} should still be answered`);
    delays.push(throttle.fail('client', 0));
  }

  // The first few cost nothing: people mistype their own password.
  assert.deepEqual(delays.slice(0, 3), [0, 0, 0]);
  // Then it doubles, up to a ceiling.
  assert.deepEqual(delays.slice(3), [100, 200, 400, 800, 800]);

  // Only far past anything a person reaches does it stop answering at all, and even
  // then only for the rest of the window. The old behaviour - a flat refusal after ten
  // failures - was a denial of service against the administrator, because behind a
  // reverse proxy every client shares one address and therefore one count.
  assert.equal(throttle.refuses('client', 0), true);
  assert.equal(throttle.refuses('client', 1500), false, 'the window should expire');
});

test('a correct password clears the record', () => {
  const throttle = createLoginThrottle(settings);
  for (let attempt = 0; attempt < 6; attempt += 1) throttle.fail('client', 0);
  assert.ok(throttle.fail('client', 0) > 0);

  throttle.succeed('client');
  assert.equal(throttle.fail('client', 0), 0);
});

test('clients are counted separately and expire out of the window', () => {
  const throttle = createLoginThrottle(settings);
  for (let attempt = 0; attempt < 6; attempt += 1) throttle.fail('noisy', 0);

  assert.equal(throttle.fail('quiet', 0), 0, 'one noisy client must not throttle another');
  // Failures older than the window stop counting, so a throttle is never permanent.
  assert.equal(throttle.fail('noisy', 5000), 0);
});

test('tracking cannot grow without bound', () => {
  // An internet-facing deployment sees a new source address per guess, so an unbounded
  // map is a slow memory leak with an attacker holding the tap.
  const throttle = createLoginThrottle({ ...settings, maxTrackedClients: 10 });
  for (let client = 0; client < 500; client += 1) throttle.fail(`client-${client}`, client);
  assert.ok(throttle.size <= 10, `tracked ${throttle.size} clients`);
});
