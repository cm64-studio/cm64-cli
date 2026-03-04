#!/usr/bin/env node
// CM64 CLI — stateless CLI for CM64 Studio
// Each command is an independent HTTP call. No sessions.
// Usage: cm64 <command> [args] [--json]

import { loadConfig, saveConfig, getToken, getEndpoint, getProjectId, CONFIG_FILE } from '../lib/config.js';
import { callCLI } from '../lib/api.js';
import { cacheFile, getCachedFile, getCachedHash } from '../lib/cache.js';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

// ── Argument Parsing ─────────────────────────────────────────

const argv = process.argv.slice(2);

function getFlag(names, hasValue = false) {
  for (const name of (Array.isArray(names) ? names : [names])) {
    const idx = argv.indexOf(name);
    if (idx !== -1) {
      if (hasValue) {
        const val = argv[idx + 1];
        argv.splice(idx, 2);
        return val;
      }
      argv.splice(idx, 1);
      return true;
    }
  }
  return hasValue ? null : false;
}

const jsonOutput = getFlag(['--json']);
const forceFlag = getFlag(['--force', '-F']);
const command = argv[0];
const subArgs = argv.slice(1);

// ── Output Helpers ───────────────────────────────────────────

function out(text) {
  process.stdout.write(text + '\n');
}

function info(text) {
  if (!jsonOutput) process.stderr.write(text + '\n');
}

function die(message, code = 1) {
  if (jsonOutput) {
    out(JSON.stringify({ ok: false, error: message }));
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(code);
}

function outputResult(result) {
  if (jsonOutput) {
    out(JSON.stringify(result));
  } else if (result.ok === false) {
    die(result.error);
  } else {
    out(result.text || '');
  }
}

// ── Path Validation ─────────────────────────────────────────

const VALID_CLASSES = ['page', 'component', 'function', 'css', 'setting', 'database', 'asset'];

function validatePath(path) {
  if (!path || !path.includes('/')) return; // let server handle missing/malformed paths
  const cls = path.split('/')[0];
  if (VALID_CLASSES.includes(cls)) return;
  // Check for common mistakes (plurals, typos)
  const singular = cls.replace(/s$/, '');
  if (VALID_CLASSES.includes(singular)) {
    die(`Invalid class "${cls}". Did you mean "${singular}"?\n  Valid classes: ${VALID_CLASSES.join(', ')}`);
  }
  die(`Invalid class "${cls}".\n  Valid classes: ${VALID_CLASSES.join(', ')}`);
}

// ── Path Mapping (local ↔ server) ───────────────────────────

// Map folder name (plural or singular) → file class
const FOLDER_TO_CLASS = {
  'pages': 'page', 'page': 'page',
  'components': 'component', 'component': 'component',
  'functions': 'function', 'function': 'function',
  'css': 'css',
  'settings': 'setting', 'setting': 'setting',
  'databases': 'database', 'database': 'database',
  'assets': 'asset', 'asset': 'asset',
};

// Map file class → default extension
const CLASS_EXT = {
  page: '.json', component: '.jsx', function: '.js',
  css: '.css', setting: '.json', database: '.json', asset: '',
};

// Map extension → likely class (when ambiguous, prefer component)
const EXT_TO_CLASS = {
  '.jsx': 'component', '.tsx': 'component',
  '.css': 'css', '.scss': 'css',
  '.json': 'setting',
};

/**
 * Parse a local file path into { class, name, ext }.
 * e.g. "components/Hero.jsx" → { class: "component", name: "Hero", ext: ".jsx" }
 *      "settings/theme.json" → { class: "setting", name: "theme", ext: ".json" }
 *      "component/Nav"       → { class: "component", name: "Nav", ext: "" }  (server-style path)
 */
function parseLocalPath(localPath) {
  // Normalize separators and strip leading ./
  const normalized = localPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length < 2) return null; // Need at least folder/file

  const folder = parts[0];
  const cls = FOLDER_TO_CLASS[folder];
  if (!cls) return null;

  // Remaining parts form the name (support nested like components/ui/Button.jsx)
  const rest = parts.slice(1).join('/');
  const ext = extname(rest);
  const name = ext ? rest.slice(0, -ext.length) : rest;

  return { class: cls, name, ext };
}

/**
 * Convert server path (class/name) to local file path.
 * e.g. { class: "component", name: "Hero" } → "components/Hero.jsx"
 */
function toLocalPath(cls, name, baseDir = '.') {
  // Use plural folder names for local filesystem
  const folderMap = {
    page: 'pages', component: 'components', function: 'functions',
    css: 'css', setting: 'settings', database: 'databases', asset: 'assets',
  };
  const folder = folderMap[cls] || cls;
  const ext = CLASS_EXT[cls] || '';
  // Only add ext if name doesn't already have one
  const fileName = extname(name) ? name : name + ext;
  return join(baseDir, folder, fileName);
}

/**
 * Scan a local directory for pushable files.
 * Returns array of { localFile, class, name }
 */
function scanLocalFiles(dir) {
  const results = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return results;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      // Check if this is a class folder
      const cls = FOLDER_TO_CLASS[entry];
      if (cls) {
        // Scan files inside
        scanDir(fullPath, cls, '', results);
      }
    }
  }
  return results;
}

function scanDir(dir, cls, prefix, results) {
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath, cls, prefix ? `${prefix}/${entry}` : entry, results);
    } else {
      const ext = extname(entry);
      const name = prefix
        ? `${prefix}/${ext ? entry.slice(0, -ext.length) : entry}`
        : (ext ? entry.slice(0, -ext.length) : entry);
      results.push({ localFile: fullPath, class: cls, name });
    }
  }
}

// Read from stdin (for piping)
async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Prompt user for input
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Commands ─────────────────────────────────────────────────

const HANDLERS = {

  // ─── login ─────────────────────────────────────────────────
  async login() {
    const tokenArg = subArgs[0];
    const endpoint = getFlag(['--endpoint', '-e'], true);
    const tokenFlag = getFlag(['--token', '-t'], true);

    // If a raw token is provided directly (cm64 login cm64_pat_... or --token)
    if (tokenArg?.startsWith('cm64_pat_') || tokenFlag) {
      const token = tokenFlag || tokenArg;
      const updates = { token };
      if (endpoint) updates.endpoint = endpoint;
      saveConfig(updates);
      info(`Token saved to ${CONFIG_FILE}`);

      const result = await callCLI('list_projects', { limit: 1 });
      if (result.ok === false) {
        die(`Token saved but validation failed: ${result.error}`);
      }
      out('Logged in successfully.');
      return;
    }

    // Interactive email + code flow
    if (!process.stdin.isTTY) {
      die('Interactive login requires a terminal. Use: cm64 login <token>');
    }

    const config = loadConfig();
    const baseEndpoint = endpoint || config.endpoint || 'https://build.cm64.io/api/cli';
    // Derive the auth base URL from the CLI endpoint
    const authBase = baseEndpoint.replace(/\/api\/cli\/?$/, '/api/auth');

    out('CM64 CLI Login\n');

    // Step 1: Get email
    const email = await prompt('Email: ');
    if (!email || !email.includes('@')) die('Valid email required.');

    // Step 2: Request verification code
    info('Sending verification code...');
    try {
      const sendRes = await fetch(`${authBase}/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });

      const sendData = await sendRes.json();

      if (!sendRes.ok) {
        if (sendData.redirectToSignup) {
          die(`No account found for ${email}. Sign up at https://build.cm64.io first.`);
        }
        die(sendData.error || 'Failed to send code.');
      }

      out('Code sent! Check your email.\n');
    } catch (e) {
      die(`Could not reach server: ${e.message}`);
    }

    // Step 3: Get code
    const code = await prompt('Code: ');
    if (!code || code.length < 6) die('Enter the 6-digit code from your email.');

    // Step 4: Verify code and get token
    info('Verifying...');
    try {
      const verifyRes = await fetch(`${authBase}/cli-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'cm64-cli/2.0.0'
        },
        body: JSON.stringify({ email, code: code.trim() })
      });

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok) {
        die(verifyData.error || 'Verification failed.');
      }

      // Save token
      const updates = { token: verifyData.token };
      if (endpoint) updates.endpoint = endpoint;
      saveConfig(updates);

      out(`\nLogged in as ${verifyData.user?.name || verifyData.user?.email || email}`);
      info(`Token saved to ${CONFIG_FILE}`);
    } catch (e) {
      die(`Verification failed: ${e.message}`);
    }
  },

  // ─── projects ──────────────────────────────────────────────
  async projects() {
    const query = subArgs.join(' ') || undefined;
    const result = await callCLI('list_projects', { query });
    outputResult(result);
  },

  // ─── use ───────────────────────────────────────────────────
  async use() {
    const projectId = subArgs[0];
    if (!projectId) die('Usage: cm64 use <project_id>');

    const result = await callCLI('set_project', {}, { projectId });
    if (result.ok) {
      saveConfig({ project_id: projectId, project_name: result.data?.name || null });
      info(`Project saved to config.`);
    }
    outputResult(result);
  },

  // ─── create ────────────────────────────────────────────────
  async create() {
    const name = subArgs.join(' ');
    if (!name) die('Usage: cm64 create <project_name>');

    const description = getFlag(['--description', '-d'], true);
    const result = await callCLI('create_project', { name, description });
    outputResult(result);
  },

  // ─── info ──────────────────────────────────────────────────
  async info() {
    const result = await callCLI('project_info');
    outputResult(result);
  },

  // ─── status ────────────────────────────────────────────────
  async status() {
    const result = await callCLI('status');
    outputResult(result);
  },

  // ─── ls ────────────────────────────────────────────────────
  async ls() {
    const fileClass = getFlag(['--class', '-c'], true) || subArgs[0] || undefined;
    const result = await callCLI('list_files', { class: fileClass });
    outputResult(result);
  },

  // ─── read ──────────────────────────────────────────────────
  async read() {
    const path = subArgs[0];
    if (!path) die('Usage: cm64 read <class/name>');
    validatePath(path);

    const result = await callCLI('read_file', { path });
    if (result.ok && result.data) {
      // Cache for diff and conflict detection
      const projectId = getProjectId();
      if (projectId && result.data.hash) {
        cacheFile(projectId, path, {
          hash: result.data.hash,
          content: result.data.content,
          updatedAt: result.data.updatedAt
        });
      }
    }
    outputResult(result);
  },

  // ─── write ─────────────────────────────────────────────────
  async write() {
    const path = subArgs[0];
    if (!path) die('Usage: cm64 write <class/name> --content "..." | -f file.json | stdin');
    validatePath(path);

    let content = getFlag(['--content', '-c'], true);
    const localFile = getFlag(['-f', '--file'], true);
    const changelog = getFlag(['--changelog', '--msg', '-m'], true);
    const showDiff = getFlag(['--diff', '--preview']);
    let baseHash = getFlag(['--hash'], true);

    // Read from local file
    if (localFile) {
      if (!existsSync(localFile)) die(`File not found: ${localFile}`);
      content = readFileSync(localFile, 'utf-8');
    }

    // Read from stdin
    if (!content) {
      content = await readStdin();
    }

    if (!content) die('No content provided. Use --content, -f, or pipe stdin.');

    // --diff: show changes vs cached version before writing
    if (showDiff) {
      const projectId = getProjectId();
      const cached = projectId ? getCachedFile(projectId, path) : null;
      if (cached?.content) {
        const diff = simpleDiff(cached.content, content);
        if (diff) {
          info(`Changes to ${path}:\n${diff}`);
          const answer = await prompt('Write this file? (y/n) ');
          if (answer.toLowerCase() !== 'y') {
            die('Aborted.', 0);
          }
        } else {
          info('No changes detected.');
          return;
        }
      } else {
        info(`New file: ${path} (no cached version to diff)`);
      }
    }

    // Auto-use cached hash for conflict detection
    if (!baseHash && !forceFlag) {
      const projectId = getProjectId();
      if (projectId) {
        baseHash = getCachedHash(projectId, path);
      }
    }

    const args = { path, content, changelog };
    if (baseHash) args.base_hash = baseHash;
    if (forceFlag) args.force = true;

    info(`Writing ${path}...`);
    const result = await callCLI('write_file', args);

    // Update cache with new hash
    if (result.ok && result.data?.hash) {
      const projectId = getProjectId();
      if (projectId) {
        cacheFile(projectId, path, {
          hash: result.data.hash,
          content,
          updatedAt: new Date().toISOString()
        });
      }
    }

    outputResult(result);
  },

  // ─── write-many ────────────────────────────────────────────
  async 'write-many'() {
    const input = await readStdin();
    if (!input) die('Pipe JSON array of files via stdin. Format: [{ "path": "class/name", "content": "..." }]');

    let files;
    try {
      files = JSON.parse(input);
    } catch (e) {
      die('Invalid JSON input');
    }

    if (!Array.isArray(files)) die('Expected JSON array of files');

    // Auto-attach cached hashes
    const projectId = getProjectId();
    if (projectId && !forceFlag) {
      for (const f of files) {
        if (!f.base_hash && f.path) {
          const cached = getCachedHash(projectId, f.path);
          if (cached) f.base_hash = cached;
        }
      }
    }

    const result = await callCLI('write_files', { files });
    outputResult(result);
  },

  // ─── push ──────────────────────────────────────────────────
  async push() {
    const target = subArgs[0];
    if (!target) die('Usage: cm64 push <local-path>\n  cm64 push components/Hero.jsx\n  cm64 push ./components/\n  cm64 push ./');

    const stat = existsSync(target) ? statSync(target) : null;

    // Push a directory (push all files inside)
    if (stat?.isDirectory()) {
      // Check if it's a class folder directly (e.g., ./components/) or a root dir (e.g., ./)
      const dirName = basename(target.replace(/\/+$/, ''));
      const cls = FOLDER_TO_CLASS[dirName];

      let files;
      if (cls) {
        // It's a class folder — scan files inside it
        const items = [];
        scanDir(target, cls, '', items);
        files = items;
      } else {
        // It's a root-like dir — scan for class subfolders
        files = scanLocalFiles(target);
      }

      if (files.length === 0) die(`No pushable files found in ${target}\n  Expected folders: components/, pages/, functions/, css/, settings/, databases/`);

      info(`Pushing ${files.length} file(s)...`);

      const payload = [];
      for (const f of files) {
        const content = readFileSync(f.localFile, 'utf-8');
        const serverPath = `${f.class}/${f.name}`;
        const entry = { path: serverPath, content };

        // Auto-attach cached hash
        const projectId = getProjectId();
        if (projectId && !forceFlag) {
          const cached = getCachedHash(projectId, serverPath);
          if (cached) entry.base_hash = cached;
        }
        if (forceFlag) entry.force = true;

        payload.push(entry);
      }

      const result = await callCLI('write_files', { files: payload });

      // Update cache for written files
      if (result.ok && result.data?.results) {
        const projectId = getProjectId();
        if (projectId) {
          for (const r of result.data.results) {
            if (r.ok && r.hash && r.path) {
              const f = payload.find(p => p.path === r.path);
              if (f) {
                cacheFile(projectId, r.path, {
                  hash: r.hash,
                  content: f.content,
                  updatedAt: new Date().toISOString()
                });
              }
            }
          }
        }
      }

      outputResult(result);
      return;
    }

    // Push a single file
    if (!stat) die(`Not found: ${target}`);

    const parsed = parseLocalPath(target);
    if (!parsed) die(`Can't detect file class from path: ${target}\n  Expected format: <class-folder>/<name>.<ext>  (e.g., components/Hero.jsx, settings/theme.json)`);

    const serverPath = `${parsed.class}/${parsed.name}`;
    const content = readFileSync(target, 'utf-8');

    let baseHash = null;
    const projectId = getProjectId();
    if (projectId && !forceFlag) {
      baseHash = getCachedHash(projectId, serverPath);
    }

    const args = { path: serverPath, content };
    if (baseHash) args.base_hash = baseHash;
    if (forceFlag) args.force = true;

    info(`Pushing ${serverPath}...`);
    const result = await callCLI('write_file', args);

    if (result.ok && result.data?.hash && projectId) {
      cacheFile(projectId, serverPath, {
        hash: result.data.hash,
        content,
        updatedAt: new Date().toISOString()
      });
    }

    outputResult(result);
  },

  // ─── pull ──────────────────────────────────────────────────
  async pull() {
    const target = subArgs[0];
    if (!target) die('Usage: cm64 pull <class/name|local-path|./>\n  cm64 pull component/Hero\n  cm64 pull ./components/\n  cm64 pull ./');

    const outDir = getFlag(['-o', '--out'], true) || '.';

    // Pull all files (cm64 pull ./ or cm64 pull .)
    if (target === './' || target === '.') {
      info('Pulling all files...');
      const result = await callCLI('list_files', {});
      if (!result.ok) { outputResult(result); return; }

      const files = result.data?.files || [];
      if (files.length === 0) { info('No files found.'); return; }

      let count = 0;
      for (const f of files) {
        const cls = f.class;
        const name = f.name;
        if (!cls || !name) continue;
        // Skip assets (binary, not text)
        if (cls === 'asset') continue;

        const serverPath = `${cls}/${name}`;
        const readResult = await callCLI('read_file', { path: serverPath });
        if (!readResult.ok || !readResult.data) continue;

        const localFile = toLocalPath(cls, name, outDir);
        const dir = dirname(localFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(localFile, readResult.data.content || '');

        // Cache the hash
        const projectId = getProjectId();
        if (projectId && readResult.data.hash) {
          cacheFile(projectId, serverPath, {
            hash: readResult.data.hash,
            content: readResult.data.content,
            updatedAt: readResult.data.updatedAt || new Date().toISOString()
          });
        }
        count++;
        info(`  ${serverPath} → ${localFile}`);
      }
      out(`Pulled ${count} file(s)`);
      return;
    }

    // Pull by class folder (cm64 pull ./components/ or cm64 pull components/)
    const dirName = basename(target.replace(/\/+$/, ''));
    const folderClass = FOLDER_TO_CLASS[dirName];
    if (folderClass && (target.endsWith('/') || !target.includes('.'))) {
      info(`Pulling all ${folderClass} files...`);
      const result = await callCLI('list_files', { class: folderClass });
      if (!result.ok) { outputResult(result); return; }

      const files = result.data?.files || [];
      let count = 0;
      for (const f of files) {
        const serverPath = `${folderClass}/${f.name}`;
        const readResult = await callCLI('read_file', { path: serverPath });
        if (!readResult.ok || !readResult.data) continue;

        const localFile = toLocalPath(folderClass, f.name, outDir);
        const dir = dirname(localFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(localFile, readResult.data.content || '');

        const projectId = getProjectId();
        if (projectId && readResult.data.hash) {
          cacheFile(projectId, serverPath, {
            hash: readResult.data.hash,
            content: readResult.data.content,
            updatedAt: readResult.data.updatedAt || new Date().toISOString()
          });
        }
        count++;
        info(`  ${serverPath} → ${localFile}`);
      }
      out(`Pulled ${count} ${folderClass} file(s)`);
      return;
    }

    // Pull a single file: accept either "component/Hero" or "components/Hero.jsx"
    let serverPath;
    const parsed = parseLocalPath(target);
    if (parsed) {
      serverPath = `${parsed.class}/${parsed.name}`;
    } else if (target.includes('/')) {
      validatePath(target);
      serverPath = target;
    } else {
      die(`Can't parse path: ${target}\n  Use class/name (e.g., component/Hero) or local path (e.g., components/Hero.jsx)`);
    }

    info(`Pulling ${serverPath}...`);
    const readResult = await callCLI('read_file', { path: serverPath });
    if (!readResult.ok) { outputResult(readResult); return; }

    const [cls, ...nameParts] = serverPath.split('/');
    const name = nameParts.join('/');
    const localFile = toLocalPath(cls, name, outDir);
    const dir = dirname(localFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(localFile, readResult.data.content || '');

    const projectId = getProjectId();
    if (projectId && readResult.data.hash) {
      cacheFile(projectId, serverPath, {
        hash: readResult.data.hash,
        content: readResult.data.content,
        updatedAt: readResult.data.updatedAt || new Date().toISOString()
      });
    }

    out(`Pulled ${serverPath} → ${localFile}`);
  },

  // ─── sync ─────────────────────────────────────────────────
  async sync() {
    const target = subArgs[0] || './';
    const projectId = getProjectId();
    if (!projectId) die('No active project. Run: cm64 use <project_id>');

    // Determine which classes to sync
    const dirName = basename(target.replace(/\/+$/, ''));
    const singleClass = FOLDER_TO_CLASS[dirName];
    const classFilter = singleClass ? [singleClass] : VALID_CLASSES.filter(c => c !== 'asset');
    const baseDir = singleClass ? dirname(target.replace(/\/+$/, '')) || '.' : target.replace(/\/+$/, '') || '.';

    info('Syncing...');

    // 1. Get all remote files
    const remoteResult = await callCLI('list_files', {});
    if (!remoteResult.ok) { outputResult(remoteResult); return; }
    const remoteFiles = (remoteResult.data?.files || []).filter(f => classFilter.includes(f.class));

    // 2. Scan local files
    const localFiles = singleClass
      ? (() => { const items = []; scanDir(target, singleClass, '', items); return items; })()
      : scanLocalFiles(baseDir);

    // Build lookup maps
    const remoteMap = new Map();
    for (const f of remoteFiles) remoteMap.set(`${f.class}/${f.name}`, f);
    const localMap = new Map();
    for (const f of localFiles) localMap.set(`${f.class}/${f.name}`, f);

    const toPush = [];
    const toPull = [];

    // 3. Check local files against remote
    for (const [serverPath, local] of localMap) {
      const localContent = readFileSync(local.localFile, 'utf-8');
      const cached = getCachedFile(projectId, serverPath);

      if (!remoteMap.has(serverPath)) {
        // Exists locally but not remote → push (new file)
        toPush.push({ serverPath, content: localContent, localFile: local.localFile });
      } else if (cached) {
        // Both exist — compare hashes
        const localChanged = localContent !== cached.content;
        if (localChanged) {
          toPush.push({ serverPath, content: localContent, localFile: local.localFile, base_hash: cached.hash });
        }
      }
    }

    // 4. Check remote files not local → pull
    for (const [serverPath, remote] of remoteMap) {
      if (!localMap.has(serverPath)) {
        toPull.push({ serverPath, class: remote.class, name: remote.name });
      } else {
        // Both exist — check if remote changed since our cache
        const cached = getCachedFile(projectId, serverPath);
        if (cached && remote.hash && remote.hash !== cached.hash && !toPush.find(p => p.serverPath === serverPath)) {
          toPull.push({ serverPath, class: remote.class, name: remote.name });
        }
      }
    }

    if (toPush.length === 0 && toPull.length === 0) {
      out('Everything up to date.');
      return;
    }

    // Show summary
    if (toPush.length > 0) info(`  ↑ Push: ${toPush.map(f => f.serverPath).join(', ')}`);
    if (toPull.length > 0) info(`  ↓ Pull: ${toPull.map(f => f.serverPath).join(', ')}`);

    // 5. Execute pushes
    if (toPush.length > 0) {
      const payload = toPush.map(f => {
        const entry = { path: f.serverPath, content: f.content };
        if (f.base_hash) entry.base_hash = f.base_hash;
        if (forceFlag) entry.force = true;
        return entry;
      });

      const pushResult = await callCLI('write_files', { files: payload });
      if (pushResult.ok && pushResult.data?.results) {
        for (const r of pushResult.data.results) {
          if (r.ok && r.hash && r.path) {
            const f = toPush.find(p => p.serverPath === r.path);
            if (f) {
              cacheFile(projectId, r.path, {
                hash: r.hash,
                content: f.content,
                updatedAt: new Date().toISOString()
              });
            }
            info(`  ✓ pushed ${r.path}`);
          } else if (!r.ok) {
            info(`  ✗ push failed: ${r.path} — ${r.error || 'unknown error'}`);
          }
        }
      } else if (!pushResult.ok) {
        info(`  ✗ push error: ${pushResult.error}`);
      }
    }

    // 6. Execute pulls
    for (const f of toPull) {
      const readResult = await callCLI('read_file', { path: f.serverPath });
      if (!readResult.ok || !readResult.data) {
        info(`  ✗ pull failed: ${f.serverPath}`);
        continue;
      }

      const localFile = toLocalPath(f.class, f.name, baseDir);
      const dir = dirname(localFile);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(localFile, readResult.data.content || '');

      if (readResult.data.hash) {
        cacheFile(projectId, f.serverPath, {
          hash: readResult.data.hash,
          content: readResult.data.content,
          updatedAt: readResult.data.updatedAt || new Date().toISOString()
        });
      }
      info(`  ✓ pulled ${f.serverPath} → ${localFile}`);
    }

    out(`Sync complete: ${toPush.length} pushed, ${toPull.length} pulled`);
  },

  // ─── edit ──────────────────────────────────────────────────
  async edit() {
    const path = subArgs[0];
    if (!path) die('Usage: cm64 edit <class/name> --old "text" --new "text"');
    validatePath(path);

    const oldText = getFlag(['--old'], true);
    const newText = getFlag(['--new'], true);
    const changelog = getFlag(['--changelog', '--msg', '-m'], true);
    const all = getFlag(['--all']);
    let baseHash = getFlag(['--hash'], true);

    if (!oldText || newText === null) die('--old and --new are required');

    if (!baseHash && !forceFlag) {
      const projectId = getProjectId();
      if (projectId) baseHash = getCachedHash(projectId, path);
    }

    const args = { path, old_text: oldText, new_text: newText, changelog };
    if (baseHash) args.base_hash = baseHash;
    if (forceFlag) args.force = true;
    if (all) args.all = true;

    const result = await callCLI('edit_file', args);
    outputResult(result);
  },

  // ─── diff ──────────────────────────────────────────────────
  async diff() {
    const path = subArgs[0];
    if (!path) die('Usage: cm64 diff <class/name>');
    validatePath(path);

    const projectId = getProjectId();
    if (!projectId) die('No active project. Run: cm64 use <project_id>');

    const cached = getCachedFile(projectId, path);
    if (!cached) die(`No cached version of ${path}. Run cm64 read ${path} first.`);

    // Fetch current remote version
    const result = await callCLI('diff', { path });
    if (result.ok === false) die(result.error);

    const remote = result.data;

    if (cached.hash === remote.hash) {
      out(`${path}: no changes (hash: ${cached.hash})`);
      return;
    }

    // Simple unified diff
    const cachedLines = (cached.content || '').split('\n');
    const remoteLines = (remote.content || '').split('\n');

    const cachedTime = cached.cachedAt ? `(read ${timeSince(cached.cachedAt)})` : '';
    const remoteTime = remote.updatedAt ? `(modified ${timeSince(remote.updatedAt)})` : '';

    out(`--- local ${cachedTime}`);
    out(`+++ remote ${remoteTime}`);
    out(`@@ hash: ${cached.hash} -> ${remote.hash} @@`);

    // Basic line-by-line diff
    const maxLen = Math.max(cachedLines.length, remoteLines.length);
    let inChange = false;
    let changeStart = -1;

    for (let i = 0; i < maxLen; i++) {
      const local = cachedLines[i];
      const rem = remoteLines[i];
      if (local !== rem) {
        if (!inChange) {
          inChange = true;
          changeStart = i;
          // Context: show 2 lines before
          for (let j = Math.max(0, i - 2); j < i; j++) {
            out(` ${cachedLines[j] || ''}`);
          }
        }
        if (local !== undefined) out(`-${local}`);
        if (rem !== undefined) out(`+${rem}`);
      } else {
        if (inChange) {
          // Context: show 2 lines after
          out(` ${local || ''}`);
          const next = cachedLines[i + 1];
          if (next !== undefined && next === remoteLines[i + 1]) {
            out(` ${next}`);
          }
          inChange = false;
        }
      }
    }
  },

  // ─── delete ────────────────────────────────────────────────
  async delete() {
    const path = subArgs[0];
    const fileId = getFlag(['--id'], true);
    if (!path && !fileId) die('Usage: cm64 delete <class/name> or --id <file_id>');
    if (path) validatePath(path);

    const result = await callCLI('delete_file', { path, file_id: fileId });
    outputResult(result);
  },

  // ─── search ────────────────────────────────────────────────
  async search() {
    const pattern = subArgs.join(' ');
    if (!pattern) die('Usage: cm64 search <pattern>');

    const fileClass = getFlag(['--class', '-c'], true);
    const maxResults = getFlag(['--limit', '-n'], true);

    const result = await callCLI('grep', {
      pattern,
      class: fileClass,
      max_results: maxResults ? parseInt(maxResults) : undefined
    });
    outputResult(result);
  },

  // ─── glob ──────────────────────────────────────────────────
  async glob() {
    const pattern = subArgs.join(' ');
    if (!pattern) die('Usage: cm64 glob <pattern>');

    const result = await callCLI('glob', { pattern });
    outputResult(result);
  },

  // ─── snapshot ──────────────────────────────────────────────
  async snapshot() {
    const name = subArgs.join(' ');
    if (!name) die('Usage: cm64 snapshot <name>');

    const description = getFlag(['--description', '-d'], true);
    const result = await callCLI('snapshot', { name, description });
    outputResult(result);
  },

  // ─── deploy ────────────────────────────────────────────────
  async deploy() {
    let build = subArgs[0];
    if (!build) die('Usage: cm64 deploy <snapshot_id|latest>');

    const domain = getFlag(['--domain', '-d'], true);
    const result = await callCLI('set_production', { build, domain });
    outputResult(result);
  },

  // ─── history ───────────────────────────────────────────────
  async history() {
    const path = subArgs[0];
    if (!path) die('Usage: cm64 history <class/name>');
    validatePath(path);

    const limit = getFlag(['--limit', '-n'], true);
    const result = await callCLI('file_history', { path, limit: limit ? parseInt(limit) : undefined });
    outputResult(result);
  },

  // ─── buildme ───────────────────────────────────────────────
  async buildme() {
    const setContent = getFlag(['--set'], true);
    const append = getFlag(['--append']);

    if (setContent) {
      const result = await callCLI('update_buildme', { content: setContent, append });
      outputResult(result);
    } else {
      // Check for stdin content
      const stdin = await readStdin();
      if (stdin) {
        const result = await callCLI('update_buildme', { content: stdin, append });
        outputResult(result);
      } else {
        const result = await callCLI('get_buildme');
        outputResult(result);
      }
    }
  },

  // ─── load (system prompt) ─────────────────────────────────
  async load() {
    const raw = getFlag(['--raw', '-r']);
    const result = await callCLI('get_system_prompt', { raw: raw || undefined });
    outputResult(result);
  },

  // ─── skills ─────────────────────────────────────────────────
  async skills() {
    const skill = subArgs[0] || undefined;
    const result = await callCLI('skill_info', { skill });
    outputResult(result);
  },

  // ─── learn ─────────────────────────────────────────────────
  async learn() {
    const skills = subArgs.length > 0 ? subArgs : undefined;
    const offset = getFlag(['--offset'], true);
    const limit = getFlag(['--limit', '-n'], true);
    const result = await callCLI('learn', {
      skills,
      offset: offset ? parseInt(offset) : undefined,
      limit: limit ? parseInt(limit) : undefined
    });
    outputResult(result);
  },

  // ─── users ─────────────────────────────────────────────────
  async users() {
    const search = getFlag(['--search', '-s'], true);
    const role = getFlag(['--role'], true);
    const status = getFlag(['--status'], true);
    const page = getFlag(['--page', '-p'], true);
    const limit = getFlag(['--limit', '-n'], true);

    const result = await callCLI('users', {
      search, role, status,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined
    });
    outputResult(result);
  },

  // ─── analytics ─────────────────────────────────────────────
  async analytics() {
    const days = getFlag(['--days', '-d'], true);
    const event = getFlag(['--event', '-e'], true);

    const result = await callCLI('analytics', {
      days: days ? parseInt(days) : undefined,
      event
    });
    outputResult(result);
  },

  // ─── upload (asset) ────────────────────────────────────────
  async upload() {
    const name = subArgs[0];
    if (!name) die('Usage: cm64 upload <filename> -f <local-file> [--folder <path>]');

    const localFile = getFlag(['-f', '--file'], true);
    const folder = getFlag(['--folder', '--dir'], true);
    const mimeType = getFlag(['--mime', '--type'], true);

    if (!localFile) die('File path required: cm64 upload hero.jpg -f ./hero.jpg');
    if (!existsSync(localFile)) die(`File not found: ${localFile}`);

    const buffer = readFileSync(localFile);
    const data = buffer.toString('base64');

    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
    info(`Uploading ${name} (${sizeMB}MB)...`);

    const args = { name, data };
    if (folder) args.folder = folder;
    if (mimeType) args.mime_type = mimeType;

    const result = await callCLI('upload_asset', args);

    if (result.ok && !jsonOutput) {
      out(result.data?.url || result.text);
    } else {
      outputResult(result);
    }
  },

  // ─── assets (list) ───────────────────────────────────────
  async assets() {
    const folder = getFlag(['--folder', '--dir'], true) || subArgs[0];
    const result = await callCLI('list_assets', { folder });
    outputResult(result);
  },

  // ─── restore ─────────────────────────────────────────────
  async restore() {
    const path = subArgs[0];
    if (!path) die('Usage: cm64 restore <class/name> --version <id>');
    validatePath(path);

    const versionId = getFlag(['--version', '--id', '-v'], true);
    if (!versionId) die('Version required: cm64 restore component/Hero --version <version_id>\nUse cm64 history <class/name> to see versions.');

    const result = await callCLI('restore_version', { path, version_id: versionId });
    outputResult(result);
  },

  // ─── debug ─────────────────────────────────────────────────
  async debug() {
    const pattern = getFlag(['--pattern', '-p'], true) || subArgs[0];
    const level = getFlag(['--level', '-l'], true);
    const limit = getFlag(['--limit', '-n'], true);
    const since = getFlag(['--since'], true);

    const result = await callCLI('debug', {
      pattern, level, since,
      limit: limit ? parseInt(limit) : undefined
    });
    outputResult(result);
  },

  // ─── help ──────────────────────────────────────────────────
  async help() {
    out(`CM64 CLI v${pkg.version} — Stateless CLI for CM64 Studio

SETUP
  cm64 login                      Login with email + verification code
  cm64 login <token>              Login with an existing PAT token
  cm64 projects [--query x]       List projects
  cm64 use <project_id>           Set active project
  cm64 create <name>              Create new project
  cm64 status                     Quick context check (one-liner)
  cm64 info                       Full project metadata

FILES
  cm64 ls [--class component]     List files
  cm64 read <class/name>          Read file (auto-caches hash)
  cm64 write <class/name>         Write file (--content, -f, or stdin)
  cm64 write-many                 Bulk write (JSON from stdin)
  cm64 edit <class/name>          Edit file (--old "x" --new "y")
  cm64 diff <class/name>          Compare cached vs remote
  cm64 delete <class/name>        Delete file

PUSH / PULL
  cm64 push components/Hero.jsx   Push local file to server
  cm64 push ./components/         Push all files in folder
  cm64 push ./                    Push all local files
  cm64 pull component/Hero        Pull file and save locally
  cm64 pull ./components/         Pull all components
  cm64 pull ./                    Pull all files to local
  cm64 sync ./                    Bidirectional sync
  cm64 sync ./components/         Sync specific folder

SEARCH
  cm64 search <pattern>           Grep across project files
  cm64 glob <pattern>             Glob file paths

ASSETS
  cm64 upload <name> -f <file>    Upload asset to S3 (images, videos, etc.)
  cm64 upload logo.png -f ./logo.png --folder images
  cm64 assets [--folder x]        List assets with S3 URLs

DEPLOY
  cm64 snapshot <name>            Create snapshot
  cm64 deploy <id|latest>         Pin snapshot to production
  cm64 history <class/name>       File version history
  cm64 restore <class/name>       Restore to version (--version <id>)

PROJECT
  cm64 load                       Get system prompt (interpolated)
  cm64 load --raw                 Get system prompt (raw, no variables)
  cm64 skills                     List all skills with sizes
  cm64 skills <name>              Skill metadata and preview
  cm64 learn [skill_name]         Read full skill docs
  cm64 buildme                    Read BUILDME.md
  cm64 buildme --set "content"    Update BUILDME.md

DATA
  cm64 users [--search x]         App end-users
  cm64 analytics [--days 7]       Analytics
  cm64 debug [--pattern x]        Logs

FLAGS
  --json                          Structured JSON output
  --force, -F                     Skip conflict detection
  -f, --file <path>               Read content from local file
  --diff                          Preview changes before writing

ENVIRONMENT
  CM64_TOKEN                      Override token
  CM64_ENDPOINT                   Override endpoint
  CM64_PROJECT                    Override project ID

Config: ~/.cm64/config.json
Docs: https://docs.cm64.io/cli`);
  }
};

// ── Time helper ──────────────────────────────────────────────

function timeSince(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Diff helper ─────────────────────────────────────────────

function simpleDiff(oldStr, newStr) {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const lines = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) continue;
    if (o !== undefined && n !== undefined) {
      lines.push(`  L${i + 1}:`);
      lines.push(`  - ${o}`);
      lines.push(`  + ${n}`);
    } else if (o === undefined) {
      lines.push(`  + L${i + 1}: ${n}`);
    } else {
      lines.push(`  - L${i + 1}: ${o}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    await HANDLERS.help();
    process.exit(0);
  }

  // Normalize command aliases
  const aliases = {
    'list': 'ls',
    'grep': 'search',
    'find': 'glob',
    'cat': 'read',
    'rm': 'delete',
    'remove': 'delete',
    'snap': 'snapshot',
    'pub': 'deploy',
    'publish': 'deploy',
    'log': 'debug',
    'logs': 'debug',
    'systemprompt': 'load',
    'prompt': 'load',
    'sp': 'load',
    'skill': 'skills',
    'asset': 'assets',
    'rollback': 'restore',
  };

  const cmd = aliases[command] || command;

  const handler = HANDLERS[cmd];
  if (!handler) {
    die(`Unknown command: ${command}\nRun 'cm64 help' for usage.`);
  }

  // Check token for commands that need it (everything except login and help)
  if (cmd !== 'login' && cmd !== 'help') {
    if (!getToken()) {
      die('Not logged in. Run: cm64 login');
    }
  }

  // Check project for commands that need it
  const needsProject = !['login', 'help', 'projects', 'create', 'use', 'learn', 'skills'].includes(cmd);
  if (needsProject && !getProjectId()) {
    die('No active project. Run: cm64 use <project_id>');
  }

  try {
    await handler();
  } catch (error) {
    die(error.message);
  }
}

main();
