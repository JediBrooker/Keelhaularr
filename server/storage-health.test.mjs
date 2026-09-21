import assert from 'node:assert/strict';
import test from 'node:test';

import { hardlinkVerdict } from './storage-health.mjs';

const possible = { app: 'radarr', downloadRoot: '/data/torrents/movies', hardlinksPossible: true };
const impossible = { app: 'radarr', downloadRoot: '/downloads', hardlinksPossible: false };

test('storage that cannot hold a link across the boundary is the first thing reported', () => {
  // Nothing about the application's settings can rescue this, so it is named before
  // the settings are even considered.
  const verdict = hardlinkVerdict(impossible, { copyUsingHardlinks: true });
  assert.equal(verdict.status, 'blocked');
  assert.match(verdict.detail, /one filesystem/);
});

test('an application set to copy on storage that could link is called out as fixable', () => {
  const verdict = hardlinkVerdict(possible, { copyUsingHardlinks: false });
  assert.equal(verdict.status, 'misconfigured');
  assert.match(verdict.summary, /set to copy/);
  assert.match(verdict.detail, /Use Hardlinks instead of Copy/);
});

test('an unreachable application is unknown, never misconfigured', () => {
  // Reporting "this is set to copy" because the request failed would send someone to
  // change a setting that was already correct.
  const verdict = hardlinkVerdict(possible, { copyUsingHardlinks: null, error: 'connect ECONNREFUSED' });
  assert.equal(verdict.status, 'unknown');
  assert.match(verdict.detail, /ECONNREFUSED/);
});

test('a healthy pair says so without overclaiming', () => {
  const verdict = hardlinkVerdict(possible, { copyUsingHardlinks: true });
  assert.equal(verdict.status, 'ready');
  // Compatibility is not proof that any particular file is currently linked.
  assert.match(verdict.detail, /not proof/);
});

test('the app name is used verbatim for instances beyond the original pair', () => {
  const verdict = hardlinkVerdict({ ...possible, app: 'radarr-4k' }, { copyUsingHardlinks: false });
  assert.match(verdict.summary, /^radarr-4k/);
});
