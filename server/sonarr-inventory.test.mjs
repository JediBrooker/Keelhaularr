import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanArr, arrInstances } from './arr.mjs';
import { getConfig } from './config.mjs';
import { scanOrphans } from './orphans.mjs';
import { identifyScanCandidates } from './imports.mjs';

for (const failedEndpoint of ['episode', 'episodefile', 'series']) {
  test(`Sonarr ${failedEndpoint} failure preserves the correct orphan safety boundary`, async (context) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sonarr-inventory-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const tracked = path.join(root, 'Tracked.mkv');
    const stray = path.join(root, 'Stray.mkv');
    await writeFile(tracked, 'tracked');
    await writeFile(stray, 'stray');
    const config = getConfig({
      SONARR_URL: 'http://sonarr.invalid', SONARR_API_KEY: 'test',
      SONARR_MEDIA_ROOTS: root, MEDIA_EXTENSIONS: 'mkv',
      QBITTORRENT_URL: '', RADARR_URL: '',
    });
    const original = globalThis.fetch;
    context.after(() => { globalThis.fetch = original; });
    globalThis.fetch = async (input) => {
      const endpoint = new URL(input).pathname.split('/').at(-1);
      if (endpoint === failedEndpoint && endpoint === 'series') return Response.json({});
      if (endpoint === failedEndpoint) return new Response('episode service unavailable', { status: 503 });
      if (endpoint === 'system' || endpoint === 'status') return Response.json({ version: '4.0' });
      if (endpoint === 'series') return Response.json([{ id: 1, path: root }]);
      if (endpoint === 'episodefile') return Response.json([{ id: 2, path: tracked }]);
      if (endpoint === 'qualitydefinition') return Response.json([]);
      throw new Error(`Unexpected request: ${input}`);
    };
    const arr = await scanArr(config);
    assert.equal(arr.sonarr.status, 'error');
    const scan = await scanOrphans(config, arr);
    assert.doesNotMatch(scan.warnings.join(' '), /not connected/);
    assert.match(scan.warnings.join(' '), failedEndpoint === 'series' ? /invalid series inventory/ : /503/);
    if (failedEndpoint === 'episode') {
      assert.equal(arr.sonarr.knownPathsComplete, true);
      assert.deepEqual(scan.candidates.map((entry) => entry.path), [stray]);
      assert.deepEqual(await identifyScanCandidates(config, arr, scan.candidates, 10), []);
    } else {
      assert.notEqual(arr.sonarr.knownPathsComplete, true);
      assert.deepEqual(scan.candidates, []);
      assert.match(scan.warnings.join(' '), /inventory is incomplete/);
    }
  });
}

test('legacy Sonarr-only configuration retains its kind and instance id', () => {
  assert.deepEqual(arrInstances({ sonarr: { configured: true } }), [
    { configured: true, kind: 'sonarr', id: 'sonarr' },
  ]);
});
