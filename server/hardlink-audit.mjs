import path from 'node:path';

import { arrInstances, arrRequest, mapArrPath, readImportSettings } from './arr.mjs';
import { fileFacts } from './hardlinks.mjs';

/**
 * Checks what recent imports actually did on disk.
 *
 * The orphan scan finds duplicates months after they were made. This finds them on the
 * first import, which is the only moment the cause is still obvious and the only moment
 * fixing it prevents rather than cleans up.
 *
 * The test is not "does the library file have one link". A move import leaves exactly
 * one link and is entirely correct - there is one copy, in the library, which is what
 * a non-seeding setup wants. What separates a copy from a link is the source the
 * application was given: if it still exists with a different inode, the data is on disk
 * twice. That comparison is the whole audit.
 */

// Radarr and Sonarr both use 3 for downloadFolderImported. The number is sent to narrow
// the query, and the string is checked on the way back, so a wrong guess about the
// numbering can only ever return fewer records - never the wrong kind.
const IMPORT_EVENT_TYPE = 3;
const IMPORT_EVENT_NAME = 'downloadFolderImported';

export const HARDLINKED = 'hardlinked';
export const COPIED = 'copied';
export const MOVED = 'moved';
export const INDETERMINATE = 'indeterminate';

function historyText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function factsOrNull(filePath) {
  try {
    return await fileFacts(filePath);
  } catch {
    return null;
  }
}

/**
 * Classifies one import. Returns null for a record that cannot be judged at all, so
 * "we could not tell" never gets counted as "this was fine".
 */
export async function classifyImport(record, pathMaps) {
  const importedArrPath = historyText(record?.data?.importedPath);
  const droppedArrPath = historyText(record?.data?.droppedPath);
  if (!importedArrPath) return null;

  const importedPath = mapArrPath(importedArrPath, pathMaps ?? []);
  if (!importedPath) {
    return {
      status: INDETERMINATE,
      importedPath: importedArrPath,
      droppedPath: droppedArrPath,
      date: historyText(record?.date),
      sourceTitle: historyText(record?.sourceTitle),
      detail: 'The imported path could not be translated into a path Keelhaularr can reach; check path mappings.',
    };
  }

  const imported = await factsOrNull(importedPath);
  const base = {
    importedPath,
    droppedPath: droppedArrPath,
    date: historyText(record?.date),
    sourceTitle: historyText(record?.sourceTitle),
    sizeBytes: imported?.sizeBytes ?? null,
  };

  // Gone means upgraded away or deleted since. Nothing to judge, and guessing would
  // turn ordinary library churn into a false alarm.
  if (!imported) return null;

  if (!droppedArrPath) {
    return {
      ...base,
      status: INDETERMINATE,
      detail: 'The application did not record where this file was imported from, so the import method cannot be judged.',
    };
  }

  const droppedPath = mapArrPath(droppedArrPath, pathMaps ?? []);
  if (!droppedPath) {
    return {
      ...base,
      status: INDETERMINATE,
      detail: 'The download path could not be translated into a path Keelhaularr can reach; check path mappings.',
    };
  }

  const dropped = await factsOrNull(droppedPath);
  if (!dropped) {
    return {
      ...base,
      status: MOVED,
      droppedPath,
      detail: 'The download is gone and the library file remains, so this import moved the file. One copy exists.',
    };
  }
  if (dropped.identity === imported.identity) {
    return {
      ...base,
      status: HARDLINKED,
      droppedPath,
      linkCount: imported.linkCount,
      detail: 'The download and the library file are one inode, so this import cost no extra space.',
    };
  }
  return {
    ...base,
    status: COPIED,
    droppedPath,
    wastedBytes: imported.sizeBytes,
    detail: 'The download and the library file are separate inodes of the same import, so this file is on disk twice.',
  };
}

/**
 * Audits one application's recent imports.
 *
 * Deliberately bounded to a single page of history: this runs on every scan, and the
 * question it answers - "is importing working correctly right now" - is answered just
 * as well by the last few dozen imports as by all of them.
 */
export async function auditInstanceImports(connection, { limit = 40 } = {}) {
  const result = {
    app: connection?.id ?? null,
    checked: 0,
    hardlinked: 0,
    copied: 0,
    moved: 0,
    indeterminate: 0,
    wastedBytes: 0,
    duplicates: [],
    error: null,
  };
  if (!connection?.configured) {
    result.error = 'The connection is not configured.';
    return result;
  }

  let records;
  try {
    const query = new URLSearchParams({
      page: '1',
      pageSize: String(limit),
      sortKey: 'date',
      sortDirection: 'descending',
      eventType: String(IMPORT_EVENT_TYPE),
    });
    const response = await arrRequest(connection, `history?${query}`);
    records = Array.isArray(response?.records) ? response.records : [];
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  }

  for (const record of records) {
    if (historyText(record?.eventType) !== IMPORT_EVENT_NAME) continue;
    const verdict = await classifyImport(record, connection.pathMaps);
    if (!verdict) continue;
    result.checked += 1;
    if (verdict.status === HARDLINKED) result.hardlinked += 1;
    else if (verdict.status === MOVED) result.moved += 1;
    else if (verdict.status === INDETERMINATE) result.indeterminate += 1;
    else if (verdict.status === COPIED) {
      result.copied += 1;
      result.wastedBytes += verdict.wastedBytes ?? 0;
      if (result.duplicates.length < 20) result.duplicates.push(verdict);
    }
  }
  return result;
}

function appLabel(app) {
  if (app === 'radarr') return 'Radarr';
  if (app === 'sonarr') return 'Sonarr';
  return app;
}

function formatGib(bytes) {
  return `${(Number(bytes) / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * Says what the audit found, and - when the cause is knowable from here - why.
 *
 * The two causes worth naming are the two that are fixable in a minute: storage that
 * cannot hold a link across the boundary, and an application that is set to copy. The
 * import settings are only read when something is actually wrong, so a healthy setup
 * costs no extra request.
 */
export async function auditImports(config, { limit = 40 } = {}) {
  const instances = arrInstances(config).filter((instance) => instance.configured);
  const results = await Promise.all(instances.map((instance) => auditInstanceImports(instance, { limit })));
  const warnings = [];

  for (const result of results) {
    if (!result.copied) continue;
    const label = appLabel(result.app);
    const settings = await readImportSettings(instances.find((instance) => instance.id === result.app));
    const cause = settings.copyUsingHardlinks === false
      ? ` The cause is almost certainly that "Use Hardlinks instead of Copy" is off in ${label} → Settings → Media Management → Importing.`
      : ' Check that the download folder and the library are on one filesystem inside the container - two separate bind mounts of the same host storage still count as two filesystems - and that "Use Hardlinks instead of Copy" is on.';
    warnings.push(
      `${label} copied instead of hardlinking on ${result.copied} of its last ${result.checked} import(s), duplicating ${formatGib(result.wastedBytes)}.${cause}`,
    );
  }

  return {
    checkedAt: new Date().toISOString(),
    instances: results,
    warnings,
  };
}
