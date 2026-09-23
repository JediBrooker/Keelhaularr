import { constants, accessSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// The installer mounts storage at the same path it has in the LXC, under these roots
// or under any mount point it detected. Radarr and Sonarr report their own paths,
// which are often somewhere else entirely, so these are where to look for the folder
// an application means.
const COMMON_ROOTS = ['/data', '/mnt', '/media', '/storage', '/torrents', '/usenet', '/downloads', '/srv/media'];
const NOBODY_UID = 65534;
const MAX_CHILD_BASES = 200;
const MAX_SAMPLES = 8;

function isDirectory(candidate) {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function canAccess(candidate, mode) {
  try {
    accessSync(candidate, mode);
    return true;
  } catch {
    return false;
  }
}

function childDirectories(base) {
  try {
    const children = [];
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      children.push(path.join(base, entry.name));
      if (children.length === MAX_CHILD_BASES) break;
    }
    return children;
  } catch {
    return [];
  }
}

// The storage roots, the conventional roots, and one level below each. The installer
// often exposes /mnt as a whole while the library sits a folder further down, in
// /mnt/storage or /mnt/data, and an application that calls it just /movies shares
// only that last name with it.
export function searchBases(storageRoots = []) {
  const roots = [...new Set([...storageRoots, ...COMMON_ROOTS].map((root) => path.resolve(root)))].filter(isDirectory);
  return [...new Set([...roots, ...roots.flatMap(childDirectories)])];
}

function sampleEntries(samples) {
  const output = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (typeof sample !== 'string' || !sample || sample.length > 1024 || sample.includes('\0')) continue;
    const normalized = path.normalize(sample);
    if (path.isAbsolute(normalized) || normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) continue;
    if (!output.includes(normalized)) output.push(normalized);
    if (output.length === MAX_SAMPLES) break;
  }
  return output;
}

/**
 * The first folder or file name below `reportedRoot` of each reported path: a movie
 * folder, a series folder, a torrent's name. These survive upgrades and renames of the
 * files inside them, which makes them good evidence of which folder is the same one.
 */
export function relativeSamples(reportedRoot, reportedPaths, limit = MAX_SAMPLES) {
  if (typeof reportedRoot !== 'string' || !path.isAbsolute(reportedRoot)) return [];
  const root = path.resolve(reportedRoot);
  const output = [];
  for (const reported of Array.isArray(reportedPaths) ? reportedPaths : []) {
    if (typeof reported !== 'string' || !path.isAbsolute(reported)) continue;
    const relative = path.relative(root, path.resolve(reported));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    const first = relative.split(path.sep)[0];
    if (!output.includes(first)) output.push(first);
    if (output.length === limit) break;
  }
  return output;
}

/**
 * Finds the folder inside Keelhaularr that holds what another application reports as
 * `reportedPath`, by matching trailing path segments under each storage root.
 *
 * Without evidence, a match must share at least its last two folder names:
 * `/data/media/movies` from Radarr is found at `/mnt/data/media/movies`, but a bare
 * `movies` is never offered, because one shared name is not proof of one library.
 *
 * `samples` are names the application says are inside the folder (see
 * relativeSamples). With them, a single shared name is enough, and so is a folder with
 * a different name altogether from `extraCandidates`, but only when most of the samples
 * are really there. A candidate that holds none of them is never returned, whatever its
 * name, because an empty folder that happens to be called the same is exactly the
 * wrong place to point a scan.
 */
export function locateReportedPath(reportedPath, storageRoots = [], options = {}) {
  const { samples = [], extraCandidates = [], writable = true } = options;
  if (typeof reportedPath !== 'string' || !path.isAbsolute(reportedPath)) return null;
  const resolved = path.resolve(reportedPath);
  const segments = resolved.split('/').filter(Boolean);
  const checks = sampleEntries(samples);
  const minimumSuffix = checks.length ? 1 : 2;
  const mode = constants.R_OK | constants.X_OK | (writable ? constants.W_OK : 0);
  const seen = new Set([resolved]);
  const scored = [];
  const consider = (candidate, suffixLength) => {
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (!isDirectory(candidate) || !canAccess(candidate, mode)) return;
    const hits = checks.filter((sample) => existsSync(path.join(candidate, sample))).length;
    scored.push({ candidate, suffixLength, hits });
  };

  if (segments.length >= minimumSuffix) {
    const bases = searchBases(storageRoots);
    for (let length = segments.length; length >= minimumSuffix; length -= 1) {
      const suffix = segments.slice(segments.length - length);
      for (const base of bases) consider(path.join(base, ...suffix), length);
    }
  }
  for (const extra of Array.isArray(extraCandidates) ? extraCandidates : []) {
    if (typeof extra === 'string' && path.isAbsolute(extra)) consider(path.resolve(extra), 0);
  }

  if (!checks.length) return scored.find((entry) => entry.suffixLength >= 2)?.candidate ?? null;
  const required = Math.max(1, Math.ceil(checks.length / 2));
  // Array.prototype.sort is stable, so ties keep the longest-suffix-first search order.
  const verified = scored
    .filter((entry) => entry.hits >= required)
    .sort((first, second) => second.hits - first.hits || second.suffixLength - first.suffixLength);
  return verified[0]?.candidate ?? null;
}

function deviceOf(target) {
  // The nearest folder that exists: a quarantine folder is created on first use.
  let current = path.resolve(target);
  for (;;) {
    try {
      return statSync(current).dev;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

export const QUARANTINE_FOLDER_NAME = 'keelhaularr-quarantine';

/**
 * A quarantine folder on the library's own filesystem, when `trashDir` is on another.
 *
 * Quarantining is a rename on one filesystem and a full copy across two, and the
 * installer's default of /config/quarantine is on the LXC's own system disk: the first
 * large film quarantined there fills it. The suggestion sits at the top of the
 * library's filesystem, beside the library folders rather than inside them, and is
 * never offered at / or when the library folder is the whole filesystem.
 */
export function quarantineSuggestion(libraryRoot, trashDir, { device = deviceOf } = {}) {
  if (typeof libraryRoot !== 'string' || !path.isAbsolute(libraryRoot) || !trashDir) return null;
  const library = path.resolve(libraryRoot);
  const libraryDevice = device(library);
  if (libraryDevice === null || device(trashDir) === libraryDevice) return null;
  let top = library;
  for (;;) {
    const parent = path.dirname(top);
    if (parent === top || device(parent) !== libraryDevice) break;
    top = parent;
  }
  if (top === library || top === path.parse(top).root || !canAccess(top, constants.W_OK | constants.X_OK)) return null;
  return path.join(top, QUARANTINE_FOLDER_NAME);
}

function ownerText(stats) {
  if (stats.uid === NOBODY_UID) {
    return ' It is owned by nobody (UID 65534), which inside an unprivileged Proxmox LXC means the bind mount belongs to a host user that is not mapped into the container. Give the mapped LXC root (normally host UID 100000) write access to that folder on the Proxmox host, or add an ID mapping for its owner.';
  }
  const runningAs = typeof process.getuid === 'function' ? process.getuid() : null;
  const runningText = runningAs === null ? '' : ` while Keelhaularr runs as UID ${runningAs}`;
  return ` It is owned by UID ${stats.uid}:${stats.gid}${runningText}. Grant write access to that folder, from the Proxmox host if it is a bind mount.`;
}

/**
 * Says exactly why a configured scan root cannot be used, and what to do about it,
 * or returns null when it is a readable and writable directory. "Not readable and
 * writable" covered a missing mount, a typo, an application's own path copied
 * verbatim, and a permissions problem - four different fixes behind one sentence.
 */
export function rootAccessProblem(root, { label = 'Folder', storageRoots = [] } = {}) {
  let stats;
  try {
    stats = statSync(root);
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return `${label} ${root} cannot be reached: Keelhaularr does not have permission to open one of its parent folders.`;
    }
    const located = locateReportedPath(root, storageRoots);
    if (located) {
      return `${label} ${root} does not exist inside Keelhaularr, but ${located} does. Radarr and Sonarr report paths from inside their own containers; use ${located} here and add the path mapping ${root}=>${located}.`;
    }
    return `${label} ${root} does not exist inside Keelhaularr. If this is the path Radarr or Sonarr reports from its own container, enter the folder where this LXC sees the same files and add a path mapping. If that storage is not visible in this LXC yet, add it as a Proxmox mount point and rerun the installer so Keelhaularr can reach it.`;
  }
  if (!stats.isDirectory()) return `${label} ${root} is a file, not a folder.`;
  const readable = canAccess(root, constants.R_OK | constants.X_OK);
  const writable = canAccess(root, constants.W_OK | constants.X_OK);
  if (readable && writable) return null;
  if (readable) {
    return `${label} ${root} is read-only inside Keelhaularr. Write access is needed to quarantine, re-link or remove files.${ownerText(stats)}`;
  }
  return `${label} ${root} exists but Keelhaularr cannot read it.${ownerText(stats)}`;
}
