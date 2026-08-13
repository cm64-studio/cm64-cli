// lib/config.js
// ~/.cm64/config.json management + per-directory .cm64.workspace resolution.
//
// Project resolution order (first match wins):
//   1. CM64_PROJECT env var (overrides everything)
//   2. .cm64.workspace file in cwd or any ancestor directory
//   3. ~/.cm64/config.json (global)
//
// Other config (endpoint, token) only lives in the global config — workspace
// files don't override auth.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.cm64');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const WORKSPACE_FILE_NAME = '.cm64.workspace';

const DEFAULTS = {
  endpoint: 'https://build.cm64.io/api/cli',
  token: null,
  project_id: null,
  project_name: null,
  project_domain: null
};

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadConfig() {
  ensureDir();
  try {
    if (existsSync(CONFIG_FILE)) {
      const raw = readFileSync(CONFIG_FILE, 'utf-8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch (e) {
    // Corrupted config — reset
  }
  return { ...DEFAULTS };
}

export function saveConfig(updates) {
  ensureDir();
  const current = loadConfig();
  const merged = { ...current, ...updates };
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  return merged;
}

export function getToken() {
  return process.env.CM64_TOKEN || loadConfig().token;
}

export function getEndpoint() {
  return process.env.CM64_ENDPOINT || loadConfig().endpoint;
}

// Walk from `startDir` up to filesystem root looking for `.cm64.workspace`.
// Returns { path, data } or null. Cached per-process so repeated calls in a
// single command don't restat ancestors.
let _workspaceCache = undefined;
export function findWorkspaceFile(startDir = process.cwd()) {
  if (_workspaceCache !== undefined) return _workspaceCache;
  let dir = resolve(startDir);
  // Stop at filesystem root or homedir (don't pick up an unrelated workspace
  // file in the user's home — workspaces are per-project).
  const home = resolve(homedir());
  while (dir && dir !== '/' && dir !== '.') {
    if (dir === home) break;
    const candidate = join(dir, WORKSPACE_FILE_NAME);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        const raw = readFileSync(candidate, 'utf-8');
        _workspaceCache = { path: candidate, data: JSON.parse(raw) };
        return _workspaceCache;
      }
    } catch (_) { /* unreadable / invalid JSON — treat as missing */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  _workspaceCache = null;
  return null;
}

// Write a workspace file into the given directory. Used by `cm64 pull` to
// pin the working directory to a project so future commands resolve without
// touching the global config.
export function writeWorkspaceFile(dir, data) {
  const fp = join(dir, WORKSPACE_FILE_NAME);
  const payload = {
    project_id: data.project_id || null,
    project_name: data.project_name || null,
    project_domain: data.project_domain || null
  };
  writeFileSync(fp, JSON.stringify(payload, null, 2) + '\n');
  // Bust the lookup cache so a follow-up `cm64 status` in the same process
  // sees the new file.
  _workspaceCache = undefined;
  return fp;
}

// Returns 'env' | 'workspace' | 'global' | 'none' — used by `cm64 status`
// so users can see which source decided their active project.
export function getProjectSource() {
  if (process.env.CM64_PROJECT) return 'env';
  const ws = findWorkspaceFile();
  if (ws?.data?.project_id) return 'workspace';
  if (loadConfig().project_id) return 'global';
  return 'none';
}

export function getProjectId() {
  if (process.env.CM64_PROJECT) return process.env.CM64_PROJECT;
  const ws = findWorkspaceFile();
  if (ws?.data?.project_id) return ws.data.project_id;
  return loadConfig().project_id;
}

// Name/domain must never be read from a source that didn't also supply the
// active project id — otherwise `CM64_PROJECT=<other> cm64 pull` displays (and
// worse, writes into .cm64.workspace) the *previous* project's name/domain
// while operating on the new id. Return null instead of a confident lie; call
// resolveProjectMeta() to get the real values from the server.
//
// The same guard applies to a workspace file that pins an id: the global
// config's name/domain describe whatever project `cm64 use` last selected,
// which need not be this one.
function metaSource() {
  if (process.env.CM64_PROJECT) return { kind: 'env', data: null };
  const ws = findWorkspaceFile();
  if (ws?.data?.project_id) return { kind: 'workspace', data: ws.data };
  return { kind: 'global', data: loadConfig() };
}

export function getProjectName() {
  const src = metaSource();
  return src.data?.project_name || null;
}

export function getProjectDomain() {
  const src = metaSource();
  return src.data?.project_domain || null;
}

// True when the active project id came from CM64_PROJECT, meaning any cached
// name/domain belongs to a different project and must be re-resolved.
export function projectMetaIsStale() {
  return metaSource().kind === 'env';
}

// Resolve name/domain for the active project. Uses the local values when they
// are known to describe this project; otherwise asks the server via `fetcher`
// (a function taking a projectId and returning { name, domain }). Never throws
// — falls back to nulls so callers can degrade to id-only output.
export async function resolveProjectMeta(fetcher) {
  const name = getProjectName();
  const domain = getProjectDomain();
  if (!projectMetaIsStale() && (name || domain)) return { name, domain };

  const projectId = getProjectId();
  if (!projectId || typeof fetcher !== 'function') return { name, domain };

  try {
    const remote = await fetcher(projectId);
    return {
      name: remote?.name ?? name ?? null,
      domain: remote?.domain ?? domain ?? null
    };
  } catch (_) {
    return { name: null, domain: null };
  }
}

export { CONFIG_DIR, CONFIG_FILE, WORKSPACE_FILE_NAME };
