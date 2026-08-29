import { randomUUID } from 'node:crypto';
import { createJsonStore } from './state.mjs';

const store = createJsonStore('exclusions.json', { version: 1, records: [] });

export function listExclusions() {
  return store.read().records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function filterExcluded(candidates) {
  const keys = new Set(store.read().records.flatMap((record) => Array.isArray(record.keys) ? record.keys : []));
  return candidates.filter((candidate) => !candidate.exclusionKeys?.some((key) => keys.has(key)));
}

export async function addExclusions(candidates) {
  const now = new Date().toISOString();
  const records = candidates.map((candidate) => ({
    id: randomUUID(),
    app: candidate.app,
    title: candidate.title,
    subtitle: candidate.subtitle,
    keys: [...candidate.exclusionKeys],
    scope: candidate.scope === 'orphan' ? 'orphan' : 'oversized',
    path: candidate.path,
    sizeBytes: candidate.sizeBytes,
    createdAt: now,
  }));
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
