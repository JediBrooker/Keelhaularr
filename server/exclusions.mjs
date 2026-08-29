import { randomUUID } from 'node:crypto';
import { createJsonStore } from './state.mjs';

const store = createJsonStore('exclusions.json', { version: 1, records: [] });

export function listExclusions() {
  return store.read().records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function validBytes(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function exclusionSummary(records = store.read().records) {
  return records.reduce((summary, record) => {
    summary.count += 1;
    if (validBytes(record.sizeBytes)) {
      summary.totalSizeBytes += record.sizeBytes;
    } else {
      summary.unknownSizeCount += 1;
    }
    if (record.scope !== 'orphan') {
      if (validBytes(record.sizeBytes) && validBytes(record.limitBytes)) {
        summary.totalOverageBytes += Math.max(0, record.sizeBytes - record.limitBytes);
      } else {
        summary.unknownOverageCount += 1;
      }
    }
    return summary;
  }, {
    count: 0,
    totalSizeBytes: 0,
    unknownSizeCount: 0,
    totalOverageBytes: 0,
    unknownOverageCount: 0,
  });
}

export function filterExcluded(candidates) {
  const keys = new Set(store.read().records.flatMap((record) => Array.isArray(record.keys) ? record.keys : []));
  return candidates.filter((candidate) => !candidate.exclusionKeys?.some((key) => keys.has(key)));
}

function exclusionKeySignature(keys) {
  if (!Array.isArray(keys) || !keys.length
    || keys.some((key) => typeof key !== 'string' || !key)) return null;
  return JSON.stringify([...keys].sort());
}

export async function refreshExclusionOverages(arrResults) {
  const measurementsByKeys = new Map();
  for (const result of Object.values(arrResults ?? {})) {
    // Only a connected scan is authoritative. Missing, unmonitored, special-season,
    // or otherwise unmeasurable files produce no observation and retain their last value.
    if (result?.status !== 'connected') continue;
    for (const observation of Array.isArray(result.overageObservations) ? result.overageObservations : []) {
      if (!validBytes(observation?.sizeBytes) || !validBytes(observation?.limitBytes)) continue;
      const signature = exclusionKeySignature(observation.exclusionKeys);
      if (signature) {
        measurementsByKeys.set(signature, {
          sizeBytes: observation.sizeBytes,
          limitBytes: observation.limitBytes,
          overageBytes: Math.max(0, observation.sizeBytes - observation.limitBytes),
        });
      }
    }
  }
  if (!measurementsByKeys.size) return listExclusions();

  const updates = new Map();
  for (const record of store.read().records) {
    if (record.scope === 'orphan') continue;
    const signature = exclusionKeySignature(record.keys);
    if (!signature || !measurementsByKeys.has(signature)) continue;
    const measurement = measurementsByKeys.get(signature);
    if (record.sizeBytes !== measurement.sizeBytes
      || record.limitBytes !== measurement.limitBytes
      || record.overageBytes !== measurement.overageBytes) {
      updates.set(record.id, measurement);
    }
  }
  if (!updates.size) return listExclusions();

  await store.update((document) => {
    for (const record of document.records) {
      const measurement = updates.get(record.id);
      if (!measurement) continue;
      record.sizeBytes = measurement.sizeBytes;
      record.limitBytes = measurement.limitBytes;
      record.overageBytes = measurement.overageBytes;
    }
  });
  return listExclusions();
}

export async function addExclusions(candidates) {
  const now = new Date().toISOString();
  const records = candidates.map((candidate) => {
    const scope = candidate.scope === 'orphan' ? 'orphan' : 'oversized';
    return {
      id: randomUUID(),
      app: candidate.app,
      title: candidate.title,
      subtitle: candidate.subtitle,
      keys: [...candidate.exclusionKeys],
      scope,
      path: candidate.path,
      sizeBytes: candidate.sizeBytes,
      ...(scope === 'oversized' ? {
        limitBytes: candidate.limitBytes,
        overageBytes: Math.max(0, candidate.sizeBytes - candidate.limitBytes),
      } : {}),
      createdAt: now,
    };
  });
  await store.update((document) => {
    const existingKeys = new Set(document.records.flatMap((record) => Array.isArray(record.keys) ? record.keys : []));
    for (const record of records) {
      if (record.keys.some((key) => existingKeys.has(key))) continue;
      document.records.push(record);
      record.keys.forEach((key) => existingKeys.add(key));
    }
  });
  return listExclusions();
}

export async function removeExclusion(id) {
  let removed = false;
  await store.update((document) => {
    const before = document.records.length;
    document.records = document.records.filter((record) => record.id !== id);
    removed = document.records.length !== before;
  });
  return removed;
}
