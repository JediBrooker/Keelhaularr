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
      const fileStat = await stat(fullPath);
      output.push({ path: path.resolve(fullPath), sizeBytes: fileStat.size, modifiedAt: fileStat.mtime.toISOString() });
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
    if (!connection.mediaRoots.length) continue;
    if (arrResult.status !== 'connected') {
      warnings.push(`${app} orphan scan withheld because ${app} is not connected.`);
      continue;
    }

    const known = new Set([...arrResult.knownPaths].map((knownPath) => path.resolve(knownPath)));
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
      roots.push({ app, path: root, filesScanned: files.length });
      for (const file of files) {
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

async function quarantineFile(config, candidate) {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const trashRoot = config.orphanTrashDir ?? path.join(candidate.root, '.keelhaularr-trash');
  const destination = await nextAvailablePath(
    path.join(trashRoot, timestamp, candidate.app, candidate.relativePath),
  );
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(candidate.path, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await copyFile(candidate.path, destination, constants.COPYFILE_EXCL);
    await unlink(candidate.path);
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
      const resolved = path.resolve(candidate.path);
      if (!isWithin(candidate.root, resolved)) throw new Error('File escaped its configured media root');
      let destination = null;
      if (config.orphanAction === 'permanent') {
        await unlink(resolved);
      } else {
        destination = await quarantineFile(config, candidate);
      }
      await removeEmptyParents(candidate);
      results.push({
        id: candidate.id,
        title: candidate.title,
        app: candidate.app,
        status: config.orphanAction === 'permanent' ? 'deleted' : 'quarantined',
        destination,
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
