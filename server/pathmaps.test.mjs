import assert from 'node:assert/strict';
import test from 'node:test';

import { mapArrPath, mapLocalPathToArr } from './arr.mjs';

test('a container path translates back into the path the application uses', () => {
  const maps = [{ from: '/mnt/media', to: '/movies' }];
  assert.equal(mapLocalPathToArr('/movies/Film/x.mkv', maps), '/mnt/media/Film/x.mkv');
  // The root itself, with no suffix to append.
  assert.equal(mapLocalPathToArr('/movies', maps), '/mnt/media');
  // Outside every mapping, so it passes through - the ordinary setup where both sides
  // mount the storage at the same place.
  assert.equal(mapLocalPathToArr('/elsewhere/x.mkv', maps), '/elsewhere/x.mkv');
  // Boundary, not string prefix.
  assert.equal(mapLocalPathToArr('/movies-4k/x.mkv', maps), '/movies-4k/x.mkv');
});

test('separators follow the application, not this container', () => {
  // An application on Windows will not recognise its own library spelled with slashes.
  const windows = [{ from: 'D:\\Media', to: '/movies' }];
  assert.equal(mapLocalPathToArr('/movies/Film/x.mkv', windows), 'D:\\Media\\Film\\x.mkv');
  assert.equal(mapLocalPathToArr('/movies', windows), 'D:\\Media');

  const unc = [{ from: '\\\\nas\\media', to: '/movies' }];
  assert.equal(mapLocalPathToArr('/movies/Film/x.mkv', unc), '\\\\nas\\media\\Film\\x.mkv');
});

test('a half-written or unusable mapping matches nothing rather than everything', () => {
  // An empty destination resolves to the working directory, which would otherwise
  // swallow every path beneath it and hand the application a nonsense translation.
  assert.equal(mapLocalPathToArr('/movies/x.mkv', [{ from: '/mnt/media', to: '' }]), '/movies/x.mkv');
  assert.equal(mapLocalPathToArr('/movies/x.mkv', [{ from: '', to: '/movies' }]), '/movies/x.mkv');
  assert.equal(mapLocalPathToArr('relative/x.mkv', [{ from: '/mnt/media', to: '/movies' }]), null);
  assert.equal(mapLocalPathToArr('', []), null);
  assert.equal(mapLocalPathToArr(null, []), null);
});

test('the two translations are inverses, including the trailing-slash case', () => {
  // This round trip is what callers check before asking an application to act on a
  // path: if it does not come back to the same file, the translation is not trustworthy
  // and nothing should be sent.
  const cases = [
    { maps: [{ from: '/mnt/media', to: '/movies' }], local: '/movies/Film/x.mkv' },
    { maps: [{ from: '/mnt/media//', to: '/movies' }], local: '/movies/Film/x.mkv' },
    { maps: [{ from: 'D:\\Media', to: '/movies' }], local: '/movies/Film/x.mkv' },
    { maps: [{ from: '/data/downloads', to: '/downloads' }], local: '/downloads/Some.Release/x.mkv' },
    { maps: [], local: '/movies/Film/x.mkv' },
  ];
  for (const { maps, local } of cases) {
    const arrPath = mapLocalPathToArr(local, maps);
    assert.ok(arrPath, `no translation for ${local}`);
    assert.equal(mapArrPath(arrPath, maps), local, `round trip failed for ${local} via ${arrPath}`);
  }
});

test('the first matching mapping wins, in both directions', () => {
  const maps = [
    { from: '/mnt/4k', to: '/movies/4k' },
    { from: '/mnt/media', to: '/movies' },
  ];
  // The nested mapping is listed first, so it claims its own subtree.
  assert.equal(mapLocalPathToArr('/movies/4k/Film/x.mkv', maps), '/mnt/4k/Film/x.mkv');
  assert.equal(mapLocalPathToArr('/movies/Other/x.mkv', maps), '/mnt/media/Other/x.mkv');
  assert.equal(mapArrPath('/mnt/4k/Film/x.mkv', maps), '/movies/4k/Film/x.mkv');
});
