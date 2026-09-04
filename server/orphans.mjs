import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { arrInstances } from './arr.mjs';
import { inspectQbittorrent, pathIsProtected } from './qbittorrent.mjs';


function orphanId(app, filePath) {
  return createHash('sha256').update(`${app}\0${filePath}`).digest('hex').slice(0, 24);
}

function orphanExclusionKey(filePath) {
  return `orphan:path:${createHash('sha256').update(filePath).digest('hex')}`;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function pathsOverlap(first, second) {
  const resolvedFirst = path.resolve(first);
  const resolvedSecond = path.resolve(second);
  return resolvedFirst === resolvedSecond
    || isWithin(resolvedFirst, resolvedSecond)
    || isWithin(resolvedSecond, resolvedFirst);
}

function pathsOutsideRoots(paths, roots) {
  return paths.filter((candidatePath) => !roots.some((root) => pathsOverlap(root, candidatePath)));
}

export async function assertQbittorrentSafe(config, candidate) {
  if (candidate.source !== 'download' || !config.qbittorrent?.configured) return;
  let snapshot;
  try {
    snapshot = await inspectQbittorrent(config.qbittorrent);
  } catch (error) {
    throw new Error(`qBittorrent safety check failed immediately before the file change; file preserved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (snapshot.unmappedIncompleteCount) {
    throw new Error('qBittorrent reported an incomplete torrent path that could not be mapped; file preserved.');
  }
  const configuredRoots = arrInstances(config)
    .flatMap((instance) => instance.downloadRoots ?? [])
    .map((root) => path.resolve(root));
  const outsideRoots = pathsOutsideRoots(snapshot.incompletePaths, configuredRoots);
  if (outsideRoots.length) {
    throw new Error(`qBittorrent reported ${outsideRoots.length} incomplete torrent path(s) outside the configured completed-download roots; file preserved.`);
  }
  if (pathIsProtected(candidate.path, snapshot.incompletePaths)) {
    throw new Error('qBittorrent reports this file as part of an incomplete torrent; file preserved.');
  }
}

/**
 * Returns the directories it could not read rather than throwing on the first one.
 * A single unreadable subdirectory - `lost+found` is 0700 root:root on every directly
 * mounted ext4 volume - used to abort the whole scan for every app and every root.
 *
 * An incomplete walk is still dangerous, though: files under a directory that could
 * not be read are invisible, so the caller must treat the result as untrustworthy for
 * deciding what is missing. Callers gate on `unreadable.length`.
 */
async function walk(root, config, output) {
  const stack = [root];
  const unreadable = [];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      unreadable.push({ path: directory, reason: error.code ?? error.message });
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!config.ignoreDirectories.has(entry.name.toLowerCase())) stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !config.extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const fileStat = await stat(fullPath, { bigint: true });
      output.push({
        path: path.resolve(fullPath),
        sizeBytes: Number(fileStat.size),
        modifiedAt: new Date(Number(fileStat.mtimeMs)).toISOString(),
        identity: `${fileStat.dev}:${fileStat.ino}`,
        linkCount: Number(fileStat.nlink),
      });
      if (output.length > config.maxFiles) {
        throw new Error(`Orphan scan stopped after exceeding ORPHAN_MAX_FILES=${config.maxFiles}`);
      }
    }
  }
  return unreadable;
}

export async function scanOrphans(config, arrResults) {
  const candidates = [];
  const warnings = [];
  const roots = [];
  let downloadScanAllowed = true;
  let protectedDownloadPaths = [];
  let qbittorrentSafety = {
    checked: false,
    metadataPendingCount: 0,
    metadataPendingTorrents: [],
    metadataPendingOmittedCount: 0,
    unresolvedIncompleteCount: 0,
    unresolvedIncompleteTorrents: [],
    unresolvedIncompleteOmittedCount: 0,
    detailLimit: 0,
    warning: null,
  };

  const configuredDownloadRoots = arrInstances(config)
    .flatMap((instance) => instance.downloadRoots ?? [])
    .map((root) => path.resolve(root));
  if (config.qbittorrent?.configured && configuredDownloadRoots.length) {
    try {
      const snapshot = await inspectQbittorrent(config.qbittorrent);
      protectedDownloadPaths = snapshot.incompletePaths;
      qbittorrentSafety = {
        checked: true,
        metadataPendingCount: snapshot.metadataPendingCount,
        metadataPendingTorrents: snapshot.metadataPendingTorrents,
        metadataPendingOmittedCount: snapshot.metadataPendingOmittedCount,
        unresolvedIncompleteCount: snapshot.unmappedIncompleteCount,
        unresolvedIncompleteTorrents: snapshot.unresolvedIncompleteTorrents,
        unresolvedIncompleteOmittedCount: snapshot.unresolvedIncompleteOmittedCount,
        detailLimit: snapshot.detailLimit,
        warning: null,
      };
      if (snapshot.unmappedIncompleteCount) {
        downloadScanAllowed = false;
      } else {
        const outsideRoots = pathsOutsideRoots(protectedDownloadPaths, configuredDownloadRoots);
        if (outsideRoots.length) {
          downloadScanAllowed = false;
          warnings.push(
            `qBittorrent reported ${outsideRoots.length} incomplete torrent path(s) outside the configured completed-download roots; completed-download orphan scans were withheld.`,
          );
        }
      }
    } catch (error) {
      downloadScanAllowed = false;
      warnings.push(
        `qBittorrent safety check failed; completed-download orphan scans were withheld: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const connection of arrInstances(config)) {
    const app = connection.id;
    const arrResult = arrResults[app];
    if (!connection.mediaRoots.length && !connection.downloadRoots.length) continue;
    if (arrResult.status !== 'connected') {
      warnings.push(`${app} orphan scan withheld because ${app} is not connected.`);
      continue;
    }

    const known = new Set([...arrResult.knownPaths].map((knownPath) => path.resolve(knownPath)));
    const libraryIdentities = new Set();
    // Whether this app's library was surveyed completely enough to be used as evidence
    // that a completed download has no library hardlink. Any doubt withholds the
    // download roots below, because "not found in the library" is only meaningful when
    // the library was actually and fully readable.
    let libraryTrustworthy = connection.mediaRoots.length > 0;
    if (!connection.mediaRoots.length && connection.downloadRoots.length) {
      warnings.push(`${app} has completed-download roots but no media roots, so no library exists to prove a download is unlinked. Completed-download results were withheld.`);
    }

    for (const configuredRoot of connection.mediaRoots) {
      let root;
      try {
        await access(configuredRoot, constants.R_OK);
        root = path.resolve(configuredRoot);
      } catch {
        warnings.push(`${app} media root is not readable, so its library could not be surveyed: ${configuredRoot}`);
        libraryTrustworthy = false;
        continue;
      }

      const files = [];
      const unreadable = await walk(root, config, files);
      roots.push({ app, kind: 'library', path: root, filesScanned: files.length });

      if (unreadable.length) {
        // Files under a directory we could not read are invisible to us, so neither
        // this root's own results nor the hardlink evidence can be trusted.
        warnings.push(`${app} could not read ${unreadable.length} folder(s) under ${root} (for example ${unreadable[0].path}: ${unreadable[0].reason}). Results for this root were withheld.`);
        libraryTrustworthy = false;
        continue;
      }

      // Sanity floor against a broken path mapping. If the application tracks files
      // somewhere, and this root holds media, but not one tracked path lands inside
      // it, the paths are almost certainly not being translated correctly - and
      // treating that as "everything here is untracked" would offer the whole root
      // for deletion. That is the difference between a bad mapping and a genuine
      // library of strays, and it cannot be told apart from here, so withhold.
      if (files.length && known.size && ![...known].some((knownPath) => isWithin(root, knownPath))) {
        warnings.push(`${app} tracks ${known.size} file(s) but none of them resolve inside ${root}, although ${files.length} media file(s) were found there. This usually means a path mapping is wrong. Results for this root were withheld; fix the mapping or remove the root.`);
        libraryTrustworthy = false;
        continue;
      }

      for (const file of files) {
        const relativePath = path.relative(root, file.path);
        const relativeDirectory = path.dirname(relativePath);
        libraryIdentities.add(file.identity);
        if (known.has(file.path)) continue;
        candidates.push({
          id: orphanId(app, file.path),
          app,
          exclusionKeys: [orphanExclusionKey(file.path)],
          title: path.basename(file.path),
          subtitle: relativeDirectory === '.' ? 'Library root' : relativeDirectory,
          path: file.path,
          relativePath,
          root,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          identity: file.identity,
          linkCount: file.linkCount,
          source: 'library',
        });
      }
    }

    if (!libraryTrustworthy && connection.downloadRoots.length) {
      warnings.push(`${app} completed-download results were withheld because its library could not be surveyed completely.`);
    }
    const minimumModifiedAt = Date.now() - config.hardlinkMinAgeHours * 60 * 60 * 1000;
    for (const configuredRoot of connection.downloadRoots) {
      if (!downloadScanAllowed || !libraryTrustworthy) continue;
      let root;
      try {
        await access(configuredRoot, constants.R_OK);
        root = path.resolve(configuredRoot);
      } catch {
        warnings.push(`${app} download root is not readable: ${configuredRoot}`);
        continue;
      }

      const overlapsLibrary = connection.mediaRoots.some((mediaRoot) => {
        const resolvedMediaRoot = path.resolve(mediaRoot);
        return root === resolvedMediaRoot || isWithin(root, resolvedMediaRoot) || isWithin(resolvedMediaRoot, root);
      });
      if (overlapsLibrary) {
        warnings.push(`${app} download root overlaps a media root and was skipped: ${root}`);
        continue;
      }

      const files = [];
      const unreadableDownloads = await walk(root, config, files);
      roots.push({ app, kind: 'download', path: root, filesScanned: files.length });
      if (unreadableDownloads.length) {
        warnings.push(`${app} could not read ${unreadableDownloads.length} folder(s) under ${root} (for example ${unreadableDownloads[0].path}: ${unreadableDownloads[0].reason}). Results for this root were withheld.`);
        continue;
      }
      for (const file of files) {
        if (pathIsProtected(file.path, protectedDownloadPaths)) continue;
        if (libraryIdentities.has(file.identity)) continue;
        if (new Date(file.modifiedAt).getTime() > minimumModifiedAt) continue;
        candidates.push({
          id: orphanId(app, file.path),
          app,
          exclusionKeys: [orphanExclusionKey(file.path)],
          title: path.basename(file.path),
          subtitle: `No ${app === 'radarr' ? 'Radarr' : 'Sonarr'} library hardlink`,
          path: file.path,
          relativePath: path.relative(root, file.path),
          root,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          identity: file.identity,
          linkCount: file.linkCount,
          source: 'download',
        });
      }
    }
  }

  if (qbittorrentSafety.unresolvedIncompleteCount) {
    const warning = `qBittorrent is connected, but ${qbittorrentSafety.unresolvedIncompleteCount} incomplete torrent path${qbittorrentSafety.unresolvedIncompleteCount === 1 ? '' : 's'} could not be resolved. Completed-download folders were skipped to protect active downloads; this qBittorrent issue did not block library-folder scanning. Check Settings → Connections → qBittorrent → Path mapping.`;
    qbittorrentSafety.warning = warning;
    warnings.unshift(warning);
  }

  return { candidates, warnings, roots, qbittorrentSafety };
}

async function nextAvailablePath(destination) {
  try {
    await access(destination);
  } catch {
    return destination;
  }
  const extension = path.extname(destination);
  const base = destination.slice(0, -extension.length || undefined);
  return `${base}-${Date.now()}${extension}`;
}

export function quarantineDestination(config, candidate, token = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')) {
  const trashRoot = config.orphanTrashDir ?? path.join(candidate.root, '.keelhaularr-trash');
  return path.join(trashRoot, token, candidate.app, candidate.relativePath);
}

export async function quarantineFile(config, candidate, requestedDestination = null) {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const destination = requestedDestination ?? await nextAvailablePath(quarantineDestination(config, candidate, timestamp));
  await mkdir(path.dirname(destination), { recursive: true });
  await assertQbittorrentSafe(config, candidate);
  await assertCandidateUnchanged(candidate);
  try {
    await rename(candidate.path, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const partial = `${destination}.keelhaularr-partial`;
    await unlink(partial).catch((unlinkError) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    try {
      await copyFile(candidate.path, partial, constants.COPYFILE_EXCL);
      const copied = await stat(partial);
      if (copied.size !== candidate.sizeBytes) throw new Error('Cross-filesystem quarantine copy did not match the source size.');
      await assertQbittorrentSafe(config, candidate);
      await assertCandidateUnchanged(candidate);
      await rename(partial, destination);
      await unlink(candidate.path);
    } finally {
      await unlink(partial).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
    }
  }
  return destination;
}

async function removeEmptyParents(candidate) {
  let current = path.dirname(candidate.path);
  while (current !== candidate.root && isWithin(candidate.root, current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

export async function applyOrphans(config, arrResults, requestedIds) {
  const current = await scanOrphans(config, arrResults);
  const requested = new Set(requestedIds);
  const selected = current.candidates.filter((candidate) => requested.has(candidate.id));
  const results = [];

  for (const candidate of selected) {
    try {
      const result = await applyOrphanCandidate(config, candidate);
      results.push({
        id: candidate.id,
        title: candidate.title,
        app: candidate.app,
        ...result,
      });
    } catch (error) {
      results.push({
        id: candidate.id,
        title: candidate.title,
        app: candidate.app,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { requested: requested.size, matched: selected.length, results };
}

export async function applyOrphanCandidate(config, candidate, requestedDestination = null) {
  const resolved = path.resolve(candidate.path);
  if (!isWithin(candidate.root, resolved)) throw new Error('File escaped its configured scan root');
  let destination = null;
  if (config.orphanAction === 'permanent') {
    await assertQbittorrentSafe(config, candidate);
    await assertCandidateUnchanged(candidate);
    await unlink(resolved);
  } else {
    destination = await quarantineFile(config, candidate, requestedDestination);
  }
  await removeEmptyParents(candidate);
  return {
    status: config.orphanAction === 'permanent' ? 'deleted' : 'quarantined',
    destination,
  };
}

export async function assertCandidateUnchanged(candidate) {
  const currentStat = await stat(candidate.path, { bigint: true });
  const currentIdentity = `${currentStat.dev}:${currentStat.ino}`;
  if (currentIdentity !== candidate.identity || Number(currentStat.size) !== candidate.sizeBytes
    || (candidate.linkCount !== undefined && Number(currentStat.nlink) !== candidate.linkCount)
    || new Date(Number(currentStat.mtimeMs)).toISOString() !== candidate.modifiedAt) {
    throw new Error('File changed after revalidation and was withheld');
  }
}
