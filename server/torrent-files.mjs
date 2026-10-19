import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { arrInstances, listArrHistoryByDownloadId } from './arr.mjs';
import { mapQbittorrentPath } from './qbittorrent.mjs';

/**
 * What deleting a finished torrent's files would actually do, worked out on disk.
 *
 * A file with another hardlink - the library copy, or a cross-seed - loses nothing when
 * this name goes, so it frees no space either. A file that is its own last link is
 * gone for good. Every file is looked up through qBittorrent's path mappings; one that
 * cannot be mapped makes the whole plan unusable, because a file that cannot be found
 * cannot be shown to be safe.
 */
export async function fileDeletionPlan(config, client, torrent) {
  const files = await client.files(torrent.hash);
  const pathMaps = config.qbittorrent?.pathMaps ?? [];
  const extensions = config.extensions ?? new Set();
  const entries = [];
  const unmappable = [];
  for (const file of files) {
    const remote = torrent.savePath ? path.posix.join(torrent.savePath.replaceAll('\\', '/'), file.name) : null;
    const local = remote ? mapQbittorrentPath(remote, pathMaps) : null;
    if (!local) {
      unmappable.push(file.name);
      continue;
    }
    let stats;
    try {
      stats = await lstat(local);
    } catch (error) {
      // qBittorrent says the file exists, so not finding it here means this container is
      // looking in the wrong place, not that it is gone. qBittorrent would still delete
      // its copy, so an unseen file counts as unverifiable.
      if (error.code === 'ENOENT') {
        unmappable.push(file.name);
        continue;
      }
      throw error;
    }
    if (!stats.isFile()) {
      unmappable.push(file.name);
      continue;
    }
    entries.push({
      name: file.name,
      path: local,
      sizeBytes: stats.size,
      links: stats.nlink,
      media: extensions.has(path.extname(local).toLowerCase()),
    });
  }
  const lastCopies = entries.filter((entry) => entry.links === 1);
  return {
    files: entries,
    unmappable,
    media: entries.filter((entry) => entry.media),
    lastCopyMedia: lastCopies.filter((entry) => entry.media),
    lastCopyBytes: lastCopies.reduce((sum, entry) => sum + entry.sizeBytes, 0),
  };
}

/**
 * Whether Radarr or Sonarr recorded importing this download. A media file that is its
 * own last link was either imported and later replaced or deleted from the library -
 * so nothing needs it - or never imported at all, in which case it may be the only
 * copy. History is what tells the two apart.
 */
export async function downloadWasImported(config, hash) {
  const downloadId = String(hash).toUpperCase();
  for (const instance of arrInstances(config).filter((value) => value.configured)) {
    const history = await listArrHistoryByDownloadId(config[instance.id] ?? instance, downloadId);
    if (history.some((record) => String(record?.eventType ?? '').toLowerCase() === 'downloadfolderimported')) {
      return instance.id;
    }
  }
  return null;
}

function gib(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * Refuses a file deletion that could lose the last copy of a media file, and says how
 * much space the deletion would actually free. Returns null when the deletion is safe.
 */
export async function fileDeletionProblem(config, torrent, plan, { importedCheck = downloadWasImported } = {}) {
  if (plan.unmappable.length) {
    return `${plan.unmappable.length} file${plan.unmappable.length === 1 ? '' : 's'} could not be mapped from qBittorrent to a local file Keelhaularr can see, so it cannot be shown that deleting them is safe. Check the qBittorrent path mappings and mounts.`;
  }
  if (!plan.lastCopyMedia.length) return null;
  const importedBy = await importedCheck(config, torrent.hash);
  if (importedBy) return null;
  return `${plan.lastCopyMedia[0].name}${plan.lastCopyMedia.length > 1 ? ` and ${plan.lastCopyMedia.length - 1} more` : ''} (${gib(plan.lastCopyMedia.reduce((sum, entry) => sum + entry.sizeBytes, 0))}) has no other hardlink and neither Radarr nor Sonarr recorded importing this download, so it may be the only copy.`;
}
