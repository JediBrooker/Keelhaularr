import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { locateReportedPath, quarantineSuggestion, relativeSamples } from './root-access.mjs';

async function tree(context, folders) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kh-locate-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of folders) await mkdir(path.join(root, folder), { recursive: true });
  return root;
}

test('samples are the first name below the reported folder, and nothing outside it', () => {
  assert.deepEqual(relativeSamples('/movies', [
    '/movies/Film (2020)/Film.mkv',
    '/movies/Film (2020)/Film.srt',
    '/movies/Other (2019)/Other.mkv',
    '/movies-4k/Big (2021)/Big.mkv',
    '/movies/../etc/passwd',
    'relative/path.mkv',
    '/movies',
  ]), ['Film (2020)', 'Other (2019)']);
  assert.deepEqual(relativeSamples('relative', ['/x']), []);
});

test('a one-name match needs its contents to be there; a two-name match does not', async (context) => {
  const root = await tree(context, [
    'mnt/storage/movies/Film (2020)',
    'mnt/storage/movies/Other (2019)',
    'mnt/backup/movies',
    'mnt/data/media/tv',
  ]);
  const mnt = path.join(root, 'mnt');
  const movies = path.join(mnt, 'storage/movies');

  // Radarr's /movies shares only its last name with anything here.
  assert.equal(locateReportedPath('/kh-test/movies', [mnt]), null);
  assert.equal(locateReportedPath('/kh-test/movies', [mnt], { samples: ['Film (2020)', 'Other (2019)'] }), movies);
  // The empty backup folder of the same name is never chosen, and neither is a folder
  // holding only a minority of the samples.
  assert.equal(locateReportedPath('/kh-test/movies', [mnt], { samples: ['Missing (2001)'] }), null);
  assert.equal(
    locateReportedPath('/kh-test/movies', [mnt], { samples: ['Film (2020)', 'Missing (2001)', 'Gone (2002)'] }),
    null,
  );
  // Two shared names are enough on their own.
  assert.equal(locateReportedPath('/kh-test/media/tv', [mnt]), path.join(mnt, 'data/media/tv'));
  // A folder with another name entirely is only found through its contents.
  assert.equal(locateReportedPath('/films', [mnt], { extraCandidates: [movies] }), null);
  assert.equal(locateReportedPath('/films', [mnt], { samples: ['Film (2020)'], extraCandidates: [movies] }), movies);
  // Samples cannot reach outside the candidate.
  assert.equal(locateReportedPath('/kh-test/movies', [mnt], { samples: ['../movies/Film (2020)', '/etc'] }), null);
});

test('the quarantine folder is moved onto the library\'s filesystem only when it is on another', async (context) => {
  const root = await tree(context, ['mnt/storage/movies', 'config']);
  const storage = path.join(root, 'mnt/storage');
  const movies = path.join(storage, 'movies');
  // Two filesystems: everything under <root>/mnt/storage is one, the rest another.
  const device = (target) => (path.resolve(target).startsWith(storage) ? 2 : 1);

  assert.equal(
    quarantineSuggestion(movies, path.join(root, 'config/quarantine'), { device }),
    path.join(storage, 'keelhaularr-quarantine'),
  );
  // Already on the library's filesystem, or no folder at all (files then go to a
  // hidden folder inside each root, which is the same filesystem): nothing to change.
  assert.equal(quarantineSuggestion(movies, path.join(storage, 'brig'), { device }), null);
  assert.equal(quarantineSuggestion(movies, '', { device }), null);
  // A library that is a filesystem of its own has nowhere beside it to put one.
  assert.equal(quarantineSuggestion(storage, path.join(root, 'config/quarantine'), { device }), null);
  // Nor is one ever suggested at the top of the whole system.
  assert.equal(quarantineSuggestion(movies, '/elsewhere', { device: (target) => (target === '/elsewhere' ? 9 : 1) }), null);
});
