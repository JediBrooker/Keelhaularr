import { constants } from 'node:fs';
import { access, lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_SUGGESTIONS = 100;
const SYSTEM_ROOTS = ['/proc', '/sys', '/dev'];
const COMMON_ROOTS = ['/data', '/mnt', '/media', '/storage', '/torrents', '/usenet', '/downloads'];

function invalid(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function isSystemPath(value) {
  return SYSTEM_ROOTS.some((root) => value === root || value.startsWith(`${root}/`));
}

async function directoryInfo(directory) {
  try {
    const value = await lstat(directory);
    if (!value.isDirectory() || isSystemPath(await realpath(directory))) return null;
    const [readable, writable] = await Promise.all([
      access(directory, constants.R_OK | constants.X_OK).then(() => true, () => false),
      access(directory, constants.W_OK | constants.X_OK).then(() => true, () => false),
    ]);
    return { name: path.basename(directory) || '/', path: directory, readable, writable };
  } catch {
    return null;
  }
}

function configuredRoots(config) {
  return [...new Set([
    ...(config.storageRoots ?? []),
    ...(config.radarr?.mediaRoots ?? []), ...(config.radarr?.downloadRoots ?? []),
    ...(config.sonarr?.mediaRoots ?? []), ...(config.sonarr?.downloadRoots ?? []),
    ...(config.orphanTrashDir ? [config.orphanTrashDir] : []),
    ...COMMON_ROOTS,
  ].map((root) => path.resolve(root)))];
}

// One directory level only: no file contents, recursive scans, or filesystem writes.
export async function suggestDirectories(input, config = {}) {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f\x7f]/.test(input)) {
    invalid('Folder path must be text without control characters (maximum 4,096 characters).');
  }
  if (!input) {
    const roots = (await Promise.all(configuredRoots(config).map(directoryInfo))).filter(Boolean);
    return {
      directory: null, parent: null, current: null, suggestedRoots: true,
      suggestions: roots.sort((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_SUGGESTIONS),
      truncated: roots.length > MAX_SUGGESTIONS,
    };
  }
  if (!path.isAbsolute(input)) invalid('Start with / to browse folders inside Keelhaularr.');
  const normalized = path.resolve(input);
  if (isSystemPath(normalized)) invalid('System device and process folders cannot be browsed.', 403);
  const exact = await lstat(normalized).catch(() => null);
  if (exact && !exact.isDirectory() && !exact.isSymbolicLink()) invalid('This path is a file, not a folder. Choose a directory.');
  const browsingChildren = input.endsWith(path.sep);
  const directory = browsingChildren ? normalized : path.dirname(normalized);
  const prefix = browsingChildren ? '' : path.basename(normalized);

  let handle;
  try {
    if (isSystemPath(await realpath(directory))) invalid('System device and process folders cannot be browsed.', 403);
    handle = await opendir(directory);
  } catch (error) {
    if (error.statusCode) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) invalid('Folder not found inside Keelhaularr. Check the path or its Docker/LXC mount.', 404);
    if (['EACCES', 'EPERM'].includes(error.code)) invalid('Keelhaularr does not have permission to browse this folder.', 403);
    throw error;
  }

  const paths = [];
  let truncated = false;
  for await (const entry of handle) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue;
    if (/[\x00-\x1f\x7f]/.test(entry.name)) continue;
    const candidate = path.join(directory, entry.name);
    if (isSystemPath(candidate)) continue;
    if (paths.length === MAX_SUGGESTIONS) {
      truncated = true;
      break;
    }
    paths.push(candidate);
  }
  const suggestions = (await Promise.all(paths.map(directoryInfo))).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return {
    directory,
    parent: directory === path.parse(directory).root ? null : path.dirname(directory),
    current: normalized === path.parse(normalized).root ? null : await directoryInfo(normalized),
    suggestedRoots: false,
    suggestions,
    truncated,
  };
}
