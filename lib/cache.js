// lib/cache.js
// ~/.cm64/cache/ — file hash caching for diff & conflict detection

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const CACHE_DIR = join(homedir(), '.cm64', 'cache');

function cacheFilePath(projectId, filePath) {
  // filePath is "class/name" → store as cache/<project_id>/<class>/<name>.json
  return join(CACHE_DIR, projectId, `${filePath}.json`);
}

/**
 * Save file data to cache after a read
 */
export function cacheFile(projectId, filePath, data) {
  const fp = cacheFilePath(projectId, filePath);
  const dir = dirname(fp);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const entry = {
    hash: data.hash,
    content: data.content,
    updatedAt: data.updatedAt,
    cachedAt: new Date().toISOString()
  };
  writeFileSync(fp, JSON.stringify(entry));
}

/**
 * Get cached file data (hash, content, timestamps)
 * Returns null if not cached
 */
export function getCachedFile(projectId, filePath) {
  const fp = cacheFilePath(projectId, filePath);
  try {
    if (!existsSync(fp)) return null;
    const raw = readFileSync(fp, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Get just the cached hash for conflict detection
 */
export function getCachedHash(projectId, filePath) {
  const cached = getCachedFile(projectId, filePath);
  return cached?.hash || null;
}

/**
 * Clear cache for a project
 */
export function clearCache(projectId) {
  const dir = join(CACHE_DIR, projectId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export { CACHE_DIR };
