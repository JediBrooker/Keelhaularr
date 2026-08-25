import { constants } from 'node:fs';
import { access, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

async function inspectRoot(app, kind, root) {
  const result = {
    id: `${app}:${kind}:${root}`,
    app,
    kind,
    path: path.resolve(root),
    exists: false,
    readable: false,
    writable: false,
    device: null,
    freeBytes: null,
    totalBytes: null,
    error: null,
  };
  try {
    const value = await stat(result.path);
    if (!value.isDirectory()) throw new Error('Path is not a directory.');
    result.exists = true;
    result.device = String(value.dev);
    await access(result.path, constants.R_OK);
    result.readable = true;
    await access(result.path, constants.W_OK);
    result.writable = true;
    const filesystem = await statfs(result.path);
    result.freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    result.totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

export async function storageHealth(config) {
  const roots = [];
  for (const app of ['radarr', 'sonarr']) {
    roots.push(...await Promise.all(config[app].mediaRoots.map((root) => inspectRoot(app, 'library', root))));
    roots.push(...await Promise.all(config[app].downloadRoots.map((root) => inspectRoot(app, 'download', root))));
  }
  const compatibility = [];
  for (const app of ['radarr', 'sonarr']) {
    const libraries = roots.filter((root) => root.app === app && root.kind === 'library' && root.device);
    const downloads = roots.filter((root) => root.app === app && root.kind === 'download');
    for (const download of downloads) {
      const matches = libraries.filter((library) => library.device === download.device);
      compatibility.push({
        app,
        downloadRoot: download.path,
        hardlinksPossible: matches.length > 0,
        matchingLibraryRoots: matches.map((root) => root.path),
        detail: matches.length
          ? 'Download and library storage share a filesystem device; hardlinks are possible.'
          : 'No configured library root shares this filesystem device; hardlinks cannot cross this boundary.',
      });
    }
  }
  return { checkedAt: new Date().toISOString(), roots, compatibility };
}
