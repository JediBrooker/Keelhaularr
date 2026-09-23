import { constants, accessSync, statSync } from 'node:fs';
import path from 'node:path';

// The installer mounts storage at the same path it has in the LXC, under these roots
// or under any mount point it detected. Radarr and Sonarr report their own paths,
// which are often somewhere else entirely, so these are where to look for the folder
// an application means.
const COMMON_ROOTS = ['/data', '/mnt', '/media', '/storage', '/torrents', '/usenet', '/downloads', '/srv/media'];
const NOBODY_UID = 65534;

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

export function searchBases(storageRoots = []) {
  return [...new Set([...storageRoots, ...COMMON_ROOTS].map((root) => path.resolve(root)))];
}

/**
 * Finds the folder inside Keelhaularr that most plausibly holds what another
 * application reports as `reportedPath`, by matching the longest trailing run of its
 * path segments under each storage root. `/data/media/movies` from Radarr is found at
 * `/mnt/data/media/movies` or `/mnt/storage/media/movies`, but a bare `movies` match is
 * never offered: one shared folder name is not evidence that it is the same library.
 * Only existing, readable and writable directories are returned.
 */
export function locateReportedPath(reportedPath, storageRoots = []) {
  if (typeof reportedPath !== 'string' || !path.isAbsolute(reportedPath)) return null;
  const resolved = path.resolve(reportedPath);
  const segments = resolved.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const bases = searchBases(storageRoots).filter(isDirectory);
  for (let dropped = 0; dropped <= segments.length - 2; dropped += 1) {
    const suffix = segments.slice(dropped);
    for (const base of bases) {
      const candidate = path.join(base, ...suffix);
      if (candidate === resolved) continue;
      if (isDirectory(candidate) && canAccess(candidate, constants.R_OK | constants.W_OK | constants.X_OK)) {
        return candidate;
      }
    }
  }
  return null;
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
