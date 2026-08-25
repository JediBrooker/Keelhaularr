import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { suggestDirectories } from './directories.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'keelhaularr-directories-'));
await Promise.all(['TV Shows', 'Télévision', 'torrents', 'folder2', 'folder10', '.hidden'].map((name) => mkdir(path.join(root, name))));
await mkdir(path.join(root, 'torrents', 'tv'));
await writeFile(path.join(root, 'movie.mkv'), 'not a folder');
await symlink(path.join(root, 'torrents'), path.join(root, 'linked-folder'));
await symlink('/dev', path.join(root, 'devices'));
after(() => rm(root, { recursive: true, force: true }));

test('folder browsing lists directories only, naturally sorted, without changing storage', async () => {
  const before = await readdir(root);
  const result = await suggestDirectories(`${root}/`);
  assert.equal(result.directory, root);
  assert.equal(result.parent, path.dirname(root));
  assert.equal(result.current.path, root);
  assert.equal(result.current.readable, true);
  assert.equal(result.current.writable, true);
  assert.equal(result.truncated, false);
  const names = result.suggestions.map((entry) => entry.name);
  assert.equal(names.includes('movie.mkv'), false);
  assert.equal(names.includes('.hidden'), false);
  assert.equal(names.includes('linked-folder'), false);
  assert.equal(names.includes('devices'), false);
  assert.ok(names.indexOf('folder2') < names.indexOf('folder10'));
  assert.deepEqual(await readdir(root), before);
});

test('prefix completion supports spaces, Unicode, exact folders, and drilling into children', async () => {
  const partial = await suggestDirectories(`${root}/tv`);
  assert.deepEqual(partial.suggestions.map((entry) => entry.name), ['TV Shows']);
  assert.equal(partial.current, null);
  const unicode = await suggestDirectories(`${root}/Tél`);
  assert.deepEqual(unicode.suggestions.map((entry) => entry.name), ['Télévision']);
  const exact = await suggestDirectories(`${root}/torrents`);
  assert.equal(exact.current.path, path.join(root, 'torrents'));
  assert.deepEqual(exact.suggestions.map((entry) => entry.name), ['torrents']);
  const children = await suggestDirectories(`${root}/torrents/`);
  assert.deepEqual(children.suggestions.map((entry) => entry.name), ['tv']);
  const leaf = await suggestDirectories(`${root}/torrents/tv/`);
  assert.equal(leaf.current.path, path.join(root, 'torrents', 'tv'));
  assert.deepEqual(leaf.suggestions, []);
  assert.equal((await suggestDirectories(`${root}/.h`)).suggestions[0].name, '.hidden');
});

test('empty input suggests existing mounted/configured roots and deduplicates them', async () => {
  const result = await suggestDirectories('', {
    storageRoots: [root, root, path.join(root, 'missing')],
    radarr: { mediaRoots: [path.join(root, 'TV Shows')], downloadRoots: [] },
    orphanTrashDir: path.join(root, 'torrents'),
  });
  assert.equal(result.suggestedRoots, true);
  assert.equal(result.current, null);
  const paths = result.suggestions.map((entry) => entry.path);
  assert.equal(paths.filter((value) => value === root).length, 1);
  assert.equal(paths.includes(path.join(root, 'TV Shows')), true);
  assert.equal(paths.includes(path.join(root, 'missing')), false);
});

test('missing folders, malformed paths, and system-directory browsing are handled safely', async () => {
  for (const input of ['relative/path', 'data', '/invalid\0path', '/invalid\npath', '/'.repeat(4097), [], {}]) {
    await assert.rejects(suggestDirectories(input), { statusCode: 400 });
  }
  for (const input of ['/dev/', '/proc/', '/sys/', '/data/../proc/', `${root}/devices/`]) {
    await assert.rejects(suggestDirectories(input), { statusCode: 403 });
  }
  await assert.rejects(suggestDirectories(`${root}/missing/folder/`), { statusCode: 404 });
  await assert.rejects(suggestDirectories(`${root}/movie.mkv/`), { statusCode: 400 });
  await assert.rejects(suggestDirectories(`${root}/movie.mkv`), { statusCode: 400 });
  const newFolder = await suggestDirectories(`${root}/new-quarantine`);
  assert.equal(newFolder.current, null);
  assert.deepEqual(newFolder.suggestions, []);
});

test('large folders return bounded suggestions and can be narrowed by typing', async () => {
  const many = path.join(root, 'many');
  await mkdir(many);
  await Promise.all(Array.from({ length: 105 }, (_, index) => mkdir(path.join(many, `item${index}`))));
  const result = await suggestDirectories(`${many}/`);
  assert.equal(result.suggestions.length, 100);
  assert.equal(result.truncated, true);
  const narrowed = await suggestDirectories(`${many}/item104`);
  assert.deepEqual(narrowed.suggestions.map((entry) => entry.name), ['item104']);
  assert.equal(narrowed.truncated, false);
});

test('permission failures are reported instead of silently returning an empty folder', { skip: process.getuid?.() === 0 }, async () => {
  const locked = path.join(root, 'locked');
  await mkdir(locked);
  await chmod(locked, 0o000);
  try {
    await assert.rejects(suggestDirectories(`${locked}/`), { statusCode: 403 });
  } finally {
    await chmod(locked, 0o700);
  }
});

test('read-only folders are identified in suggestions', { skip: process.getuid?.() === 0 }, async () => {
  const readOnly = path.join(root, 'read-only');
  await mkdir(readOnly);
  await chmod(readOnly, 0o555);
  try {
    const result = await suggestDirectories(readOnly);
    assert.equal(result.current.readable, true);
    assert.equal(result.current.writable, false);
    assert.equal(result.suggestions[0].writable, false);
  } finally {
    await chmod(readOnly, 0o700);
  }
});
