import { constants } from 'node:fs';
import { access, stat, statfs } from 'node:fs/promises';
import path from 'node:path';

import { arrInstances, readImportSettings } from './arr.mjs';

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

function appLabel(app) {
  if (app === 'radarr') return 'Radarr';
  if (app === 'sonarr') return 'Sonarr';
  return app;
}

/**
 * Turns the two independent facts - can this filesystem hold a hardlink, and is the
 * application willing to make one - into the sentence a user can act on.
 *
 * Kept separate from the device inspection because the two fail differently: the
 * filesystem answer is local and always available, while the settings answer needs the
 * application to be reachable. An unreachable application must never be reported as
 * misconfigured.
 */
export function hardlinkVerdict(entry, settings) {
  const label = appLabel(entry.app);
  if (!entry.hardlinksPossible) {
    return {
      status: 'blocked',
      summary: `${label} cannot hardlink out of ${entry.downloadRoot}.`,
      detail: 'No configured library root shares this filesystem device. Every import from this folder must copy, leaving two full copies of each file. Mount the download and library folders under one filesystem - ideally one bind mount such as /data, with both folders beneath it and the same path inside every container.',
    };
  }
  if (settings?.copyUsingHardlinks === false) {
    return {
      status: 'misconfigured',
      summary: `${label} can hardlink out of ${entry.downloadRoot} but is set to copy.`,
      detail: `Turn on ${label} → Settings → Media Management → Importing → "Use Hardlinks instead of Copy". While it is off, every import duplicates the file even though this storage supports linking.`,
    };
  }
  if (settings?.copyUsingHardlinks === null) {
    return {
      status: 'unknown',
      summary: `${label} storage supports hardlinks; its import setting could not be read.`,
      detail: settings?.error
        ? `"Use Hardlinks instead of Copy" could not be read from ${label}: ${settings.error}`
        : `${label} did not report whether it uses hardlinks when importing.`,
    };
  }
  return {
    status: 'ready',
    summary: `${label} can and will hardlink out of ${entry.downloadRoot}.`,
    detail: 'Download and library storage share a filesystem device and the application is set to hardlink rather than copy. This is compatibility, not proof that individual files are currently linked.',
  };
}

export async function storageHealth(config) {
  const instances = arrInstances(config);
  const roots = [];
  for (const instance of instances) {
    const app = instance.id;
    roots.push(...await Promise.all(instance.mediaRoots.map((root) => inspectRoot(app, 'library', root))));
    roots.push(...await Promise.all(instance.downloadRoots.map((root) => inspectRoot(app, 'download', root))));
  }

  // One request per application, and only for applications that have somewhere to
  // import into. A failure here degrades the verdict to "unknown" rather than failing
  // the whole health check, which still has useful local answers to give.
  const importSettings = Object.fromEntries(await Promise.all(instances.map(async (instance) => (
    [instance.id, await readImportSettings(instance)]
  ))));

  const compatibility = [];
  for (const { id: app } of instances) {
    const libraries = roots.filter((root) => root.app === app && root.kind === 'library' && root.device);
    const downloads = roots.filter((root) => root.app === app && root.kind === 'download');
    for (const download of downloads) {
      const matches = libraries.filter((library) => library.device === download.device);
      const entry = {
        app,
        downloadRoot: download.path,
        hardlinksPossible: matches.length > 0,
        matchingLibraryRoots: matches.map((root) => root.path),
        copyUsingHardlinks: importSettings[app]?.copyUsingHardlinks ?? null,
        detail: matches.length
          ? 'Download and library storage share a filesystem device; hardlinks are possible.'
          : 'No configured library root shares this filesystem device; hardlinks cannot cross this boundary.',
      };
      compatibility.push({ ...entry, verdict: hardlinkVerdict(entry, importSettings[app]) });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    roots,
    compatibility,
    importSettings: Object.values(importSettings),
  };
}

/**
 * The subset of the health check worth interrupting a scan for: storage that cannot
 * hardlink, or an application that refuses to. Both mean every future import quietly
 * doubles up, so they belong next to the untracked files they are producing rather than
 * on a page nobody opens.
 */
export async function hardlinkConfigurationWarnings(config) {
  const instances = arrInstances(config).filter((instance) => (
    instance.configured && instance.downloadRoots?.length && instance.mediaRoots?.length
  ));
  if (!instances.length) return [];

  const warnings = [];
  for (const instance of instances) {
    const [settings, ...rootFacts] = await Promise.all([
      readImportSettings(instance),
      ...instance.downloadRoots.map((root) => inspectRoot(instance.id, 'download', root)),
      ...instance.mediaRoots.map((root) => inspectRoot(instance.id, 'library', root)),
    ]);
    const downloads = rootFacts.slice(0, instance.downloadRoots.length);
    const libraries = rootFacts.slice(instance.downloadRoots.length).filter((root) => root.device);
    for (const download of downloads) {
      if (!download.device) continue;
      const matches = libraries.filter((library) => library.device === download.device);
      const verdict = hardlinkVerdict({
        app: instance.id,
        downloadRoot: download.path,
        hardlinksPossible: matches.length > 0,
      }, settings);
      if (verdict.status === 'blocked' || verdict.status === 'misconfigured') {
        warnings.push(`${verdict.summary} ${verdict.detail}`);
      }
    }
  }
  return warnings;
}
