import { createHash } from 'node:crypto';
import { link, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Everything in this module answers one question: are these two paths the same data,
 * and can they be made the same inode?
 *
 * A hardlink cannot break on its own - the kernel has no operation that severs one. So
 * a completed download that shares no inode with its library file was either never
 * linked (the import copied) or had one side replaced afterwards. Both leave two full
 * copies of the same bytes on disk, and both are repairable in place.
 */

// Read in chunks rather than whole files: these are multi-gigabyte videos and the
// server has to stay responsive while hashing one.
const DIGEST_CHUNK_BYTES = 4 * 1024 * 1024;

// A sampled digest reads three windows - the head, the middle and the tail. Two
// different releases of the same film diverge in the container header long before the
// first megabyte is out, so this separates "same file" from "same film" at a cost that
// does not depend on file size. It is evidence, never proof, and nothing destructive
// is allowed to rely on it.
export const SAMPLE_WINDOW_BYTES = 8 * 1024 * 1024;

export const SAME_INODE = 'same-inode';
export const IDENTICAL = 'identical';
export const DIFFERENT = 'different';
export const UNKNOWN = 'unknown';

function abortIfCancelled(signal) {
  if (signal?.aborted) throw new Error('The hardlink check was cancelled.');
}

/**
 * Everything the rest of the app needs to know about a file, read in one stat.
 *
 * `identity` is the dev:ino pair the orphan scan already compares on, so a value from
 * here is directly comparable with a scan candidate's `identity`.
 */
export async function fileFacts(filePath) {
  const resolved = path.resolve(filePath);
  const stats = await stat(resolved, { bigint: true });
  if (!stats.isFile()) throw new Error(`${resolved} is not a regular file.`);
  return {
    path: resolved,
    device: String(stats.dev),
    inode: String(stats.ino),
    identity: `${stats.dev}:${stats.ino}`,
    sizeBytes: Number(stats.size),
    linkCount: Number(stats.nlink),
    modifiedAt: new Date(Number(stats.mtimeMs)).toISOString(),
  };
}

async function digestRange(handle, hash, start, length, signal) {
  const buffer = Buffer.allocUnsafe(Math.min(DIGEST_CHUNK_BYTES, length));
  let offset = start;
  let remaining = length;
  while (remaining > 0) {
    abortIfCancelled(signal);
    const wanted = Math.min(buffer.length, remaining);
    const { bytesRead } = await handle.read(buffer, 0, wanted, offset);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
    remaining -= bytesRead;
  }
  return length - remaining;
}

/**
 * Hashes the head, middle and tail windows. Cheap enough to run on selected rows on
 * demand; use `fullDigest` before anything irreversible.
 */
export async function sampledDigest(filePath, { signal } = {}) {
  const facts = await fileFacts(filePath);
  const hash = createHash('sha256');
  // The size goes into the digest so two files that happen to share all three sampled
  // windows but differ in length can never collide.
  hash.update(`${facts.sizeBytes}\0`);
  const handle = await open(facts.path, 'r');
  try {
    if (facts.sizeBytes <= SAMPLE_WINDOW_BYTES * 3) {
      await digestRange(handle, hash, 0, facts.sizeBytes, signal);
    } else {
      const middle = Math.floor(facts.sizeBytes / 2) - Math.floor(SAMPLE_WINDOW_BYTES / 2);
      await digestRange(handle, hash, 0, SAMPLE_WINDOW_BYTES, signal);
      await digestRange(handle, hash, middle, SAMPLE_WINDOW_BYTES, signal);
      await digestRange(handle, hash, facts.sizeBytes - SAMPLE_WINDOW_BYTES, SAMPLE_WINDOW_BYTES, signal);
    }
  } finally {
    await handle.close();
  }
  return { digest: hash.digest('hex'), facts, sampled: true };
}

/** Hashes every byte. The only evidence strong enough to replace a file with a link. */
export async function fullDigest(filePath, { signal } = {}) {
  const facts = await fileFacts(filePath);
  const hash = createHash('sha256');
  const handle = await open(facts.path, 'r');
  let read = 0;
  try {
    read = await digestRange(handle, hash, 0, facts.sizeBytes, signal);
  } finally {
    await handle.close();
  }
  if (read !== facts.sizeBytes) {
    throw new Error(`${facts.path} returned ${read} of ${facts.sizeBytes} bytes while being hashed, so it was not trusted.`);
  }
  return { digest: hash.digest('hex'), facts, sampled: false };
}

/**
 * Compares two paths without changing either.
 *
 * `mode` is the strength of the evidence wanted: 'size' stops at the length, 'sampled'
 * adds the three-window digest, 'full' hashes everything. A cheaper mode can only ever
 * return DIFFERENT or UNKNOWN for content - never IDENTICAL - so no caller can mistake
 * a fast check for a decisive one.
 */
export async function compareFiles(firstPath, secondPath, { mode = 'sampled', signal } = {}) {
  let first;
  let second;
  try {
    [first, second] = await Promise.all([fileFacts(firstPath), fileFacts(secondPath)]);
  } catch (error) {
    return {
      status: UNKNOWN,
      mode,
      reason: `The pair could not be read: ${error instanceof Error ? error.message : String(error)}`,
      first: null,
      second: null,
    };
  }

  const base = { mode, first, second, sameDevice: first.device === second.device };
  if (first.identity === second.identity) {
    return { ...base, status: SAME_INODE, reason: 'Both paths are the same inode, so the data is stored once.' };
  }
  if (first.sizeBytes !== second.sizeBytes) {
    return { ...base, status: DIFFERENT, reason: 'The two files are different sizes, so they cannot be the same data.' };
  }
  if (mode === 'size') {
    return {
      ...base,
      status: UNKNOWN,
      reason: 'The two files are the same size. Only their contents can prove they are the same data.',
    };
  }

  try {
    const digest = mode === 'full' ? fullDigest : sampledDigest;
    const [left, right] = await Promise.all([digest(first.path, { signal }), digest(second.path, { signal })]);
    if (left.digest !== right.digest) {
      return {
        ...base,
        status: DIFFERENT,
        reason: mode === 'full'
          ? 'The two files hash differently, so they are different data.'
          : 'The sampled windows of the two files differ, so they are different data.',
      };
    }
    // A file that changed while it was being hashed makes the digest meaningless.
    const [firstAfter, secondAfter] = await Promise.all([fileFacts(first.path), fileFacts(second.path)]);
    if (firstAfter.identity !== first.identity || firstAfter.modifiedAt !== first.modifiedAt
      || firstAfter.sizeBytes !== first.sizeBytes
      || secondAfter.identity !== second.identity || secondAfter.modifiedAt !== second.modifiedAt
      || secondAfter.sizeBytes !== second.sizeBytes) {
      return { ...base, status: UNKNOWN, reason: 'One of the files changed while it was being read, so the comparison was discarded.' };
    }
    return {
      ...base,
      status: IDENTICAL,
      digest: left.digest,
      reason: mode === 'full'
        ? 'Every byte of the two files hashes the same, so they are two copies of one file.'
        : 'The sampled windows and sizes match. A full check is still required before anything is replaced.',
    };
  } catch (error) {
    return {
      ...base,
      status: UNKNOWN,
      reason: `The contents could not be compared: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const RELINK_SUFFIX = '.keelhaularr-relink';

/**
 * Replaces `duplicatePath` with a hardlink to `keepPath`, reclaiming the duplicate's
 * blocks without disturbing `keepPath` at all.
 *
 * Direction matters and is not negotiable: the file being replaced is the spare copy in
 * the download folder, and the file being linked from is the one the library tracks.
 * The library file's inode, path and timestamps are never touched, so Radarr and Sonarr
 * see nothing change; a torrent client seeding the download path keeps a file with
 * byte-identical contents and keeps seeding.
 *
 * Every irreversible step is preceded by proof:
 *   - a full hash of both files, because a mismatch here would corrupt a live torrent
 *   - a re-stat after hashing, so a file written during the hash cannot slip through
 *   - the link is made to a temporary name in the same directory and moved into place
 *     with rename(), which is atomic, so an interruption leaves either the old file or
 *     the new link and never a partial one
 */
export async function relinkDuplicate(duplicatePath, keepPath, { signal } = {}) {
  const duplicate = path.resolve(duplicatePath);
  const keep = path.resolve(keepPath);
  if (duplicate === keep) throw new Error('The two paths are the same file, so there is nothing to relink.');

  const comparison = await compareFiles(duplicate, keep, { mode: 'full', signal });
  if (comparison.status === SAME_INODE) {
    return { status: 'already-linked', reclaimedBytes: 0, identity: comparison.first.identity };
  }
  if (comparison.status !== IDENTICAL) {
    throw new Error(`The files were not proven identical, so nothing was replaced: ${comparison.reason}`);
  }
  if (!comparison.sameDevice) {
    throw new Error('The two files are on different filesystems, so they cannot share an inode. Fix the mount layout first.');
  }

  const temporary = `${duplicate}${RELINK_SUFFIX}`;
  await unlink(temporary).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });

  let linked = false;
  try {
    await link(keep, temporary);
    linked = true;
    // Paranoia that costs one stat: prove the temporary name really is the library
    // file's inode before it goes over the top of anything.
    const staged = await fileFacts(temporary);
    if (staged.identity !== comparison.second.identity) {
      throw new Error('The staged hardlink did not resolve to the library file, so nothing was replaced.');
    }
    // Last look before the only destructive instruction in this module.
    const duplicateNow = await fileFacts(duplicate);
    if (duplicateNow.identity !== comparison.first.identity
      || duplicateNow.sizeBytes !== comparison.first.sizeBytes
      || duplicateNow.modifiedAt !== comparison.first.modifiedAt) {
      throw new Error('The duplicate changed after it was hashed, so it was left alone.');
    }
    await rename(temporary, duplicate);
    linked = false;
  } finally {
    if (linked) {
      await unlink(temporary).catch(() => undefined);
    }
  }

  const after = await fileFacts(duplicate);
  if (after.identity !== comparison.second.identity) {
    throw new Error('The replacement did not end up sharing the library file\'s inode. Check the path by hand.');
  }
  return {
    status: 'relinked',
    // The duplicate's blocks are freed only if nothing else linked to it.
    reclaimedBytes: comparison.first.linkCount === 1 ? comparison.first.sizeBytes : 0,
    priorLinkCount: comparison.first.linkCount,
    identity: after.identity,
    linkCount: after.linkCount,
    digest: comparison.digest,
  };
}
