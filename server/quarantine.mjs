import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, link, lstat, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { recordPurge } from './history.mjs';
import { createJsonStore } from './state.mjs';

const store = createJsonStore('quarantine.json', { version: 1, records: [] });
let fileOperationQueue = Promise.resolve();

function serializeFileOperation(operation) {
  fileOperationQueue = fileOperationQueue.then(operation, operation);
  return fileOperationQueue;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function moveFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
    await unlink(source);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const partial = `${destination}.keelhaularr-restore-partial`;
    await unlink(partial).catch((unlinkError) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    try {
      const sourceSize = (await stat(source)).size;
      await copyFile(source, partial, constants.COPYFILE_EXCL);
      if ((await stat(partial)).size !== sourceSize) throw new Error('Cross-filesystem restore copy did not match the quarantined file size.');
      await link(partial, destination);
      await unlink(partial);
      await unlink(source);
    } finally {
      await unlink(partial).catch((unlinkError) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
    }
  }
}

export function listQuarantine() {
  return store.read().records.sort((a, b) => b.quarantinedAt.localeCompare(a.quarantinedAt));
}

export async function recordQuarantine(candidate, destination) {
  const existing = store.read().records.find((record) => path.resolve(record.quarantinePath) === path.resolve(destination));
  if (existing) return existing;
  const record = {
    id: randomUUID(),
    app: candidate.app,
    title: candidate.title,
    sizeBytes: candidate.sizeBytes,
    originalPath: path.resolve(candidate.path),
    originalRoot: path.resolve(candidate.root),
    quarantinePath: path.resolve(destination),
    quarantinedAt: new Date().toISOString(),
  };
  await store.update((document) => document.records.push(record));
  return record;
}

export function restoreQuarantine(id) {
  return serializeFileOperation(() => restoreRecord(id));
}

async function restoreRecord(id) {
  const record = store.read().records.find((item) => item.id === id);
  if (!record) return null;
  if (!isWithin(record.originalRoot, record.originalPath)) throw new Error('Stored original path is outside its recorded root.');
  await access(record.quarantinePath, constants.R_OK);
  try {
    await access(record.originalPath);
    const error = new Error(`Cannot restore because the original path already exists: ${record.originalPath}`);
    error.statusCode = 409;
    throw error;
  } catch (error) {
    if (error.statusCode) throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  await moveFile(record.quarantinePath, record.originalPath);
  await store.update((document) => {
    document.records = document.records.filter((item) => item.id !== id);
  });
  return { ...record, restoredAt: new Date().toISOString() };
}

export function purgeQuarantine(id, options) {
  return serializeFileOperation(() => purgeRecord(id, options));
}

async function purgeRecord(id, { source = 'brig' } = {}) {
  const record = store.read().records.find((item) => item.id === id);
  if (!record) return null;

  // A purge is the one action here with nothing behind it, so what gets unlinked has to
  // be the regular file that was quarantined - not a directory, and not a symlink whose
  // target is still in the library. Records are written by this application but read
  // back from a file on disk.
  let removed = false;
  try {
    const value = await lstat(record.quarantinePath);
    if (!value.isFile()) {
      throw new Error(`Refusing to purge ${record.quarantinePath}: it is no longer a regular file.`);
    }
    await unlink(record.quarantinePath);
    removed = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Already gone. The record is still cleared, but its bytes are not claimed below.
  }

  await store.update((document) => {
    document.records = document.records.filter((item) => item.id !== id);
  });
  // This is the point at which quarantined bytes actually become free space - but only
  // when this purge is what freed them. Crediting a file somebody had already removed
  // from the Brig by hand inflated the reclaimed total with space nothing gave back.
  if (removed) {
    await recordPurge({ fileCount: 1, bytes: record.sizeBytes, source })
      .catch((error) => console.error('Could not record purge history:', error));
  }
  return { ...record, purgedAt: new Date().toISOString(), removed };
}

export async function cleanupExpiredQuarantine(retentionDays) {
  if (!retentionDays || retentionDays <= 0) return [];
  const cutoff = Date.now() - retentionDays * 86400000;
  const expired = store.read().records.filter((record) => new Date(record.quarantinedAt).getTime() <= cutoff);
  const purged = [];
  for (const record of expired) {
    const result = await purgeQuarantine(record.id, { source: 'retention' });
    if (result) purged.push(result);
  }
  return purged;
}

export async function reconcileQuarantine() {
  const missing = [];
  for (const record of store.read().records) {
    try {
      const value = await stat(record.quarantinePath);
      if (!value.isFile()) missing.push(record.id);
    } catch (error) {
      if (error.code === 'ENOENT') missing.push(record.id);
    }
  }
  if (missing.length) {
    await store.update((document) => {
      document.records = document.records.filter((record) => !missing.includes(record.id));
    });
  }
}
