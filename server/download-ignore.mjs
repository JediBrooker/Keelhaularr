/**
 * Ignore lists for the download automations.
 *
 * The global list applies to every automation - recovery included - and each feature
 * has its own on top. A download is left alone when its hash, its exact category, or
 * any of its tags is on either list. The answer is a sentence rather than a flag so the
 * status screen can say which list protected a download.
 */
function normalizedHash(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function listReason(torrent, list, label) {
  if (!list) return null;
  const hash = normalizedHash(torrent?.hash);
  if (hash && (list.hashes ?? []).includes(hash)) return `Its hash is on the ${label}.`;
  if (typeof torrent?.category === 'string' && (list.categories ?? []).includes(torrent.category)) {
    return `Category ${torrent.category === '' ? 'Uncategorized' : `"${torrent.category}"`} is on the ${label}.`;
  }
  const tags = new Set((list.tags ?? []).map((tag) => tag.toLowerCase()));
  const tag = (torrent?.tags ?? []).find((value) => tags.has(String(value).toLowerCase()));
  if (tag !== undefined) return `Tag "${tag}" is on the ${label}.`;
  return null;
}

export function ignoredReason(config, torrent, featureList = null, featureLabel = 'ignore list') {
  return listReason(torrent, config?.downloadIgnore, 'global ignore list')
    ?? listReason(torrent, featureList, featureLabel);
}

export function ignoreListIsEmpty(list) {
  return !list || ['categories', 'tags', 'hashes'].every((field) => !(list[field] ?? []).length);
}
