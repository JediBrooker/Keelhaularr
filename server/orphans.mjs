import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

function orphanId(app, filePath) {
  return createHash('sha256').update(`${app}\0${filePath}`).digest('hex').slice(0, 24);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function walk(root, config, output) {
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Cannot read ${directory}: ${error.message}`);
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
}

export async function scanOrphans(config, arrResults) {
  const candidates = [];
  const warnings = [];
  const roots = [];

  for (const app of ['radarr', 'sonarr']) {
    const connection = config[app];
    const arrResult = arrResults[app];
    if (!connection.mediaRoots.length && !connection.downloadRoots.length) continue;
    if (arrResult.status !== 'connected') {
      warnings.push(`${app} orphan scan withheld because ${app} is not connected.`);
      continue;
    }

    const known = new Set([...arrResult.knownPaths].map((knownPath) => path.resolve(knownPath)));
    const libraryIdentities = new Set();
    for (const configuredRoot of connection.mediaRoots) {
      let root;
      try {
        await access(configuredRoot, constants.R_OK);
        root = path.resolve(configuredRoot);
      } catch {
        warnings.push(`${app} media root is not readable: ${configuredRoot}`);
        continue;
      }

      const files = [];
      await walk(root, config, files);
      roots.push({ app, kind: 'library', path: root, filesScanned: files.length });
      for (const file of files) {
        libraryIdentities.add(file.identity);
        if (known.has(file.path)) continue;
        candidates.push({
          id: orphanId(app, file.path),
          app,
          title: path.basename(file.path),
          subtitle: path.dirname(path.relative(root, file.path)) || 'Library root',
          path: file.path,
          relativePath: path.relative(root, file.path),
          root,
          sizeBytes: file.sizeBytes,
          modifiedAt: file.modifiedAt,
          identity: file.identity,
          linkCount: file.linkCount,
          source: 'library',
        });
      }
    }

    const minimumModifiedAt = Date.now() - config.hardlinkMinAgeHours * 60 * 60 * 1000;
    for (const configuredRoot of connection.downloadRoots) {
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
      await walk(root, config, files);
      roots.push({ app, kind: 'download', path: root, filesScanned: files.length });
      for (const file of files) {
        if (libraryIdentities.has(file.identity)) continue;
        if (new Date(file.modifiedAt).getTime() > minimumModifiedAt) continue;
        candidates.push({
          id: orphanId(app, file.path),
          app,
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

  return { candidates, warnings, roots };
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

async function quarantineFile(config, candidate, requestedDestination = null) {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const destination = requestedDestination ?? await nextAvailablePath(quarantineDestination(config, candidate, timestamp));
  await mkdir(path.dirname(destination), { recursive: true });
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
  const currentStat = await stat(resolved, { bigint: true });
  const currentIdentity = `${currentStat.dev}:${currentStat.ino}`;
  if (currentIdentity !== candidate.identity || Number(currentStat.size) !== candidate.sizeBytes
    || (candidate.linkCount !== undefined && Number(currentStat.nlink) !== candidate.linkCount)
    || new Date(Number(currentStat.mtimeMs)).toISOString() !== candidate.modifiedAt) {
    throw new Error('File changed after revalidation and was withheld');
  }
  let destination = null;
  if (config.orphanAction === 'permanent') {
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
