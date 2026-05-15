#!/usr/bin/env node
// CM64 CLI — stateless CLI for CM64 Studio
// Each command is an independent HTTP call. No sessions.
// Usage: cm64 <command> [args] [--json]

import { loadConfig, saveConfig, getToken, getEndpoint, getProjectId, getProjectName, getProjectDomain, getProjectSource, findWorkspaceFile, writeWorkspaceFile, CONFIG_FILE, WORKSPACE_FILE_NAME } from '../lib/config.js';
import { callCLI } from '../lib/api.js';
import { cacheFile, getCachedFile, getCachedHash, removeCachedFile } from '../lib/cache.js';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename, extname, resolve } from 'path';
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

const VALID_CLASSES = ['page', 'component', 'function', 'setting', 'database', 'asset', 'css'];

// Auto-correct a server-side path. Plural folders (functions/foo →
// function/foo) are common mistakes (local convention is plural, server
// class is singular) — silently normalize so users don't have to care.
// Returns the (possibly corrected) path; doesn't validate further.
function normalizePath(path) {
  if (!path || !path.includes('/')) return path;
  const idx = path.indexOf('/');
  const cls = path.slice(0, idx);
  if (VALID_CLASSES.includes(cls)) return path;
  const singular = cls.replace(/s$/, '');
  if (VALID_CLASSES.includes(singular)) {
    return `${singular}/${path.slice(idx + 1)}`;
  }
  return path; // unchanged; validatePath will die on it
}

function validatePath(path) {
  if (!path || !path.includes('/')) return; // let server handle missing/malformed paths
  const cls = path.split('/')[0];
  if (VALID_CLASSES.includes(cls)) return;
  die(`Invalid class "${cls}".\n  Valid classes: ${VALID_CLASSES.join(', ')}`);
}

// Normalize a class name passed via --class. Plurals → singular silently.
function normalizeClassFlag(cls) {
  if (!cls) return cls;
  if (VALID_CLASSES.includes(cls)) return cls;
  const singular = cls.replace(/s$/, '');
  if (VALID_CLASSES.includes(singular)) return singular;
  return cls; // leave unchanged; caller surfaces the error
}

// Enforce css restrictions for write/edit/push: only css/global.css is allowed.
// Accepts "css/global" or "css/global.css"; rejects any other name or extension.
function enforceCssWrite(path) {
  if (!path || !path.includes('/')) return;
  const [cls, ...rest] = path.split('/');
  if (cls !== 'css') return;
  const name = rest.join('/');
  const ext = extname(name);
  const bare = ext ? name.slice(0, -ext.length) : name;
  if (ext && ext !== '.css') {
    die('CSS files use the .css extension. CM64 reads exactly css/global.css.');
  }
  if (bare !== 'global') {
    die('Only css/global.css is supported. CM64 reads exactly one CSS file per site. Put all your custom CSS in css/global.css.');
  }
}

// ── Path Mapping (local ↔ server) ───────────────────────────

// Map folder name → file class (accepts plural for backward compat)
const FOLDER_TO_CLASS = {
  'pages': 'page', 'page': 'page',
  'components': 'component', 'component': 'component',
  'functions': 'function', 'function': 'function',
  'settings': 'setting', 'setting': 'setting',
  'databases': 'database', 'database': 'database',
  'assets': 'asset', 'asset': 'asset',
  'css': 'css',
};

// Map file class → default extension
const CLASS_EXT = {
  page: '.json', component: '.jsx', function: '.js',
  setting: '.json', database: '.json', asset: '',
  css: '.css',
};

// Map extension → likely class (when ambiguous, prefer component)
const EXT_TO_CLASS = {
  '.jsx': 'component', '.tsx': 'component',
  '.json': 'setting',
};

/**
 * Parse a local file path into { class, name, ext }.
 * e.g. "component/Hero.jsx" → { class: "component", name: "Hero", ext: ".jsx" }
 *      "setting/theme.json"  → { class: "setting", name: "theme", ext: ".json" }
 *      "component/Nav"       → { class: "component", name: "Nav", ext: "" }
 */
function parseLocalPath(localPath) {
  // Normalize separators and strip leading ./
  const normalized = localPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length < 2) return null; // Need at least folder/file

  const folder = parts[0];
  const cls = FOLDER_TO_CLASS[folder];
  if (!cls) return null;

  // Remaining parts form the name (support nested like component/ui/Button.jsx)
  const rest = parts.slice(1).join('/');
  const ext = extname(rest);
  const name = ext ? rest.slice(0, -ext.length) : rest;

  return { class: cls, name, ext };
}

/**
 * Convert server path (class/name) to local file path.
 * e.g. { class: "component", name: "Hero" } → "component/Hero.jsx"
 */
function toLocalPath(cls, name, baseDir = '.') {
  const folder = cls; // singular everywhere: component/, page/, function/, etc.
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

// ── Safe JSON parse for fetch responses ─────────────────────

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON response (rate limit, proxy error, etc.)
    const status = res.status;
    const msg = text.trim() || `HTTP ${status}`;
    return { ok: false, error: `${msg} (HTTP ${status})` };
  }
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

      const sendData = await safeJson(sendRes);

      if (!sendRes.ok) {
        if (sendData.redirectToSignup) {
          const doRegister = await prompt(`No account found for ${email}. Register now? (y/n) `);
          if (doRegister.toLowerCase() === 'y') {
            // Transition to registration flow
            await HANDLERS.register();
            return;
          }
          die('Use cm64 register to create an account.');
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

      const verifyData = await safeJson(verifyRes);

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

  // ─── register ──────────────────────────────────────────────
  async register() {
    if (!process.stdin.isTTY) {
      die('Interactive registration requires a terminal.');
    }

    const config = loadConfig();
    const endpoint = getFlag(['--endpoint', '-e'], true);
    const baseEndpoint = endpoint || config.endpoint || 'https://build.cm64.io/api/cli';
    const authBase = baseEndpoint.replace(/\/api\/cli\/?$/, '/api/auth');

    out('CM64 CLI Registration\n');

    // Step 1: Get challenge
    info('Getting verification challenge...');
    let challengeId, question;
    try {
      const res = await fetch(`${authBase}/cli-challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const data = await safeJson(res);
      if (!res.ok || !data.ok) die(data.error || 'Failed to get challenge.');
      challengeId = data.challenge_id;
      question = data.question;
    } catch (e) {
      die(`Could not reach server: ${e.message}`);
    }

    // Step 2: Solve challenge
    const answer = await prompt(`${question} `);
    if (!answer) die('Answer required.');

    // Step 3: Get email
    const email = await prompt('Email: ');
    if (!email || !email.includes('@')) die('Valid email required.');

    // Step 4: Get name
    const name = await prompt('Name: ');

    // Step 5: Send verification code
    info('Sending verification code...');
    try {
      const sendRes = await fetch(`${authBase}/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, isSignup: true })
      });
      const sendData = await safeJson(sendRes);
      if (!sendRes.ok) die(sendData.error || 'Failed to send code.');
      out('Code sent! Check your email.\n');
    } catch (e) {
      die(`Could not reach server: ${e.message}`);
    }

    // Step 6: Get code
    const code = await prompt('Code: ');
    if (!code || code.length < 6) die('Enter the 6-digit code from your email.');

    // Step 7: Register
    info('Creating account...');
    try {
      const regRes = await fetch(`${authBase}/cli-register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `cm64-cli/${pkg.version}`
        },
        body: JSON.stringify({
          email,
          name: name || undefined,
          code: code.trim(),
          challenge_id: challengeId,
          challenge_answer: answer.trim()
        })
      });
      const regData = await safeJson(regRes);
      if (!regRes.ok) die(regData.error || 'Registration failed.');

      // Save token
      const updates = { token: regData.token };
      if (endpoint) updates.endpoint = endpoint;
      saveConfig(updates);

      out(`\nRegistered as ${regData.user?.name || email}`);
      info(`Token saved to ${CONFIG_FILE}`);
      out('\nNext steps:');
      out('  cm64 create "My App"          Create your first project');
      out('  cm64 projects                 List your projects');
    } catch (e) {
      die(`Registration failed: ${e.message}`);
    }
  },

  // ─── projects ──────────────────────────────────────────────
  async projects() {
    const queryFlag = getFlag(['--query', '-q'], true);
    const positional = argv.slice(1).join(' ');
    const query = queryFlag || positional || undefined;
    const result = await callCLI('list_projects', { query });
    outputResult(result);
  },

  // ─── use ───────────────────────────────────────────────────
  async use() {
    const target = subArgs[0];
    if (!target) die('Usage: cm64 use <project_id|domain>');

    // If we're inside a directory already pinned via .cm64.workspace, update
    // that file too — otherwise `cm64 use` would silently be ignored when
    // run from inside a pinned directory.
    const updatePinIfNeeded = (data) => {
      const ws = findWorkspaceFile();
      if (ws) {
        try {
          writeWorkspaceFile(dirname(ws.path), data);
          info(`Updated ${ws.path}.`);
        } catch (e) {
          info(`Warning: could not update ${ws.path}: ${e.message}`);
        }
      }
    };

    // Detect domain (contains a dot) vs project ID
    if (target.includes('.')) {
      const result = await callCLI('find_project_by_domain', { domain: target });
      if (result.ok) {
        const data = {
          project_id: result.data?.id || null,
          project_name: result.data?.name || null,
          project_domain: result.data?.domain || target
        };
        saveConfig(data);
        updatePinIfNeeded(data);
        info(`Project saved to config.`);
      }
      outputResult(result);
    } else {
      const result = await callCLI('set_project', {}, { projectId: target });
      if (result.ok) {
        const data = {
          project_id: target,
          project_name: result.data?.name || null,
          project_domain: result.data?.domain || null
        };
        saveConfig(data);
        updatePinIfNeeded(data);
        info(`Project saved to config.`);
      }
      outputResult(result);
    }
  },

  // ─── create ────────────────────────────────────────────────
  async create() {
    const description = getFlag(['--description'], true);
    const customDomain = getFlag(['--domain', '-d'], true);
    const templateDomain = getFlag(['--template', '-t'], true);

    // Build name from remaining positional args (after flags are stripped from argv)
    const nameArgs = argv.slice(1).filter(a => !a.startsWith('-'));
    const name = nameArgs.join(' ');
    if (!name) die('Usage: cm64 create <project_name> [--domain <sub>] [--template <domain>] [--description <text>]');

    const args = { name, description };
    if (customDomain) args.custom_domain = customDomain;
    if (templateDomain) args.template_domain = templateDomain;

    const result = await callCLI('create_project', args);
    if (result.ok && result.data) {
      saveConfig({
        project_id: result.data.id,
        project_name: result.data.name || name,
        project_domain: result.data.domain || null
      });
      info(`Project saved to config.`);
      out('\nNext steps:');
      out('  cm64 pull                     Pull project files locally');
      out('  cm64 ls                       List project files');
      out('  cm64 load                     Load system prompt context');
    }
    outputResult(result);
  },

  // ─── delete-project ─────────────────────────────────────────
  async 'delete-project'() {
    out('Project deletion is not available via CLI for safety reasons.');
    out('Please delete projects from the dashboard at https://build.cm64.io');
  },

  // ─── info ──────────────────────────────────────────────────
  async info() {
    const verbose = !!getFlag(['-v', '--verbose']);
    const result = await callCLI('project_info', { verbose });
    outputResult(result);
  },

  // ─── status ────────────────────────────────────────────────
  async status() {
    // -v / --verbose on status forwards to project_info to avoid duplicating
    // the enriched view. status by itself stays a one-liner.
    const verbose = !!getFlag(['-v', '--verbose']);

    // Resolve where the active project came from so the user can tell at a
    // glance whether they're pinned to this directory or borrowing the
    // shared global config.
    const source = getProjectSource();
    const ws = source === 'workspace' ? findWorkspaceFile() : null;
    const sourceLabel =
      source === 'env' ? 'env (CM64_PROJECT)'
      : source === 'workspace' ? `workspace (${ws?.path || '?'})`
      : source === 'global' ? 'global (~/.cm64/config.json)'
      : 'none';

    const action = verbose ? 'project_info' : 'status';
    const args = verbose ? { verbose: true } : {};
    const result = await callCLI(action, args);

    if (jsonOutput) {
      // Inject source into structured output without breaking existing fields.
      if (result && typeof result === 'object') {
        result.data = { ...(result.data || {}), project_source: source, workspace_path: ws?.path || null };
      }
      outputResult(result);
      return;
    }

    if (result && result.text != null) {
      result.text = `${result.text}\nProject source: ${sourceLabel}`;
    }
    outputResult(result);
  },

  // ─── doctor ────────────────────────────────────────────────
  async doctor() {
    const result = await callCLI('doctor');
    outputResult(result);
  },

  // ─── invalidate-cache ──────────────────────────────────────
  async ['invalidate-cache']() {
    const target = getFlag(['--target', '-t'], true) || 'all';
    const result = await callCLI('invalidate_cache', { target });
    outputResult(result);
  },

  // ─── ls ────────────────────────────────────────────────────
  async ls() {
    const fileClass = normalizeClassFlag(getFlag(['--class', '-c'], true) || subArgs[0] || undefined);
    const result = await callCLI('list_files', { class: fileClass });
    outputResult(result);
  },

  // ─── read ──────────────────────────────────────────────────
  async read() {
    let path = subArgs[0];
    if (!path) die('Usage: cm64 read <class/name>');
    path = normalizePath(path);
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
    let path = subArgs[0];
    if (!path) die('Usage: cm64 write <class/name> --content "..." | -f file.json | stdin');
    path = normalizePath(path);
    validatePath(path);
    enforceCssWrite(path);

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
    // Skip flag tokens so e.g. `cm64 push --check` isn't treated as a path.
    let target = subArgs.find(a => !a.startsWith('-'));

    // Show project context prominently
    const _pushName = getProjectName();
    const _pushId = getProjectId();
    if (_pushName || _pushId) {
      info(`Project: ${_pushName || 'unknown'} (${_pushId || 'no id'})`);
    }

    // No argument: auto-detect domain folder or current dir
    if (!target) {
      const domain = getProjectDomain();
      if (domain && existsSync(`./${domain}`) && statSync(`./${domain}`).isDirectory()) {
        target = `./${domain}/`;
        info(`Pushing from ./${domain}/`);
      } else if (domain) {
        // No domain folder, try current dir
        target = './';
        info('Pushing from ./');
      } else {
        die('Usage: cm64 push [local-path]\n  cm64 push                     Push from domain folder or ./\n  cm64 push component/Hero.jsx\n  cm64 push ./component/\n  cm64 push ./');
      }
    }

    // If the path isn't on disk, try the plural↔singular sibling. Local
    // convention varies (some tooling writes plural folders, `cm64 pull`
    // writes singular), so a typo'd path often has a working sibling.
    let stat = existsSync(target) ? statSync(target) : null;
    if (!stat && target.includes('/')) {
      const dotPrefix = target.startsWith('./') ? './' : '';
      const stripped = target.replace(/^\.\//, '');
      const idx = stripped.indexOf('/');
      const head = stripped.slice(0, idx);
      const tail = stripped.slice(idx + 1);

      const candidates = [];
      // Plural typed, look for singular sibling
      const cls = FOLDER_TO_CLASS[head];
      if (cls && cls !== head) candidates.push(`${dotPrefix}${cls}/${tail}`);
      // Singular typed, look for plural sibling
      if (VALID_CLASSES.includes(head)) {
        const plural = head === 'css' ? null : `${head}s`;
        if (plural) candidates.push(`${dotPrefix}${plural}/${tail}`);
      }

      for (const alt of candidates) {
        if (existsSync(alt)) {
          info(`Note: using ${alt} (typed: ${target})`);
          target = alt;
          stat = statSync(target);
          break;
        }
      }
    }

    // Push a directory (push all files inside)
    if (stat?.isDirectory()) {
      // Check if it's a class folder directly (e.g., ./component/) or a root dir (e.g., ./)
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

      if (files.length === 0) die(`No pushable files found in ${target}\n  Expected folders: component/, page/, function/, setting/, database/, css/`);

      const checkOnly = !!getFlag(['--check', '--dry-run']);

      // Detect ghost resurrections: files we have a cached hash for (i.e. we
      // saw them on the server at some prior pull/push) but that no longer
      // exist on the server. Pushing these would silently re-create files the
      // user explicitly deleted.
      const projectId = getProjectId();
      const ghostPaths = new Set();
      if (projectId && !forceFlag) {
        try {
          const listed = await callCLI('list_files', {});
          if (listed.ok && Array.isArray(listed.data?.files)) {
            const remoteSet = new Set(
              listed.data.files
                .filter(rf => rf.class && rf.name)
                .map(rf => `${rf.class}/${rf.name}`)
            );
            for (const f of files) {
              const serverPath = `${f.class}/${f.name}`;
              if (remoteSet.has(serverPath)) continue;
              if (getCachedHash(projectId, serverPath)) {
                ghostPaths.add(serverPath);
              }
            }
          }
        } catch (_) {
          // Best-effort check — if list_files fails, fall through to legacy
          // behavior rather than blocking the push.
        }
      }

      let filesToPush = files;
      if (ghostPaths.size > 0 && !checkOnly) {
        info(`These ${ghostPaths.size} local file(s) were deleted on the server:`);
        for (const p of ghostPaths) info(`  - ${p}`);
        const skip = jsonOutput
          ? true
          : (await prompt('Push anyway and re-create them on the server? (y/N) ')).toLowerCase() !== 'y';
        if (skip) {
          info(`Skipping ${ghostPaths.size} ghost file(s). Use --force to push anyway, or rm the local file(s) to silence this.`);
          for (const p of ghostPaths) removeCachedFile(projectId, p);
          filesToPush = files.filter(f => !ghostPaths.has(`${f.class}/${f.name}`));
          if (filesToPush.length === 0) {
            outputResult({ ok: true, text: 'Nothing to push after skipping ghost files.', data: { skipped: [...ghostPaths] } });
            return;
          }
        }
      }

      // --check / --dry-run: classify each file and print a preview, then
      // exit without making any server calls.
      if (checkOnly) {
        const newFiles = [];
        const modified = [];
        const unchanged = [];
        for (const f of filesToPush) {
          const serverPath = `${f.class}/${f.name}`;
          if (ghostPaths.has(serverPath)) continue; // reported separately
          const content = readFileSync(f.localFile, 'utf-8');
          const cached = projectId ? getCachedFile(projectId, serverPath) : null;
          if (!cached) {
            newFiles.push(serverPath);
          } else if (cached.content !== content) {
            modified.push(serverPath);
          } else {
            unchanged.push(serverPath);
          }
        }

        const lines = [];
        if (newFiles.length > 0) {
          lines.push(`New (${newFiles.length}):`);
          for (const p of newFiles) lines.push(`  + ${p}`);
        }
        if (modified.length > 0) {
          lines.push(`Modified (${modified.length}):`);
          for (const p of modified) lines.push(`  ~ ${p}`);
        }
        if (ghostPaths.size > 0) {
          lines.push(`Deleted server-side, would resurrect (${ghostPaths.size}):`);
          for (const p of ghostPaths) lines.push(`  ! ${p}`);
        }
        if (unchanged.length > 0) {
          lines.push(`Unchanged (${unchanged.length}) — not re-uploaded.`);
        }

        const summary = `--check: would push ${newFiles.length + modified.length} file(s), ${unchanged.length} unchanged, ${ghostPaths.size} ghost.`;
        if (lines.length === 0) {
          outputResult({ ok: true, text: 'Nothing to push.', data: { new: [], modified: [], ghosts: [...ghostPaths], unchanged: [] } });
          return;
        }
        outputResult({
          ok: true,
          text: `${lines.join('\n')}\n\n${summary}`,
          data: { new: newFiles, modified, ghosts: [...ghostPaths], unchanged }
        });
        return;
      }

      info(`Pushing ${filesToPush.length} file(s)...`);

      const payload = [];
      for (const f of filesToPush) {
        const content = readFileSync(f.localFile, 'utf-8');
        const serverPath = `${f.class}/${f.name}`;
        enforceCssWrite(serverPath);
        const entry = { path: serverPath, content };

        // Auto-attach cached hash
        if (projectId && !forceFlag) {
          const cached = getCachedHash(projectId, serverPath);
          if (cached) entry.base_hash = cached;
        }
        if (forceFlag) entry.force = true;

        payload.push(entry);
      }

      const result = await callCLI('write_files', { files: payload });

      // Update cache for written files
      if (result.data?.results) {
        const projectId = getProjectId();
        if (projectId) {
          for (const r of result.data.results) {
            if (r.status === 'ok' && r.hash && r.path) {
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
    if (!parsed) die(`Can't detect file class from path: ${target}\n  Expected format: <class>/<name>.<ext>  (e.g., component/Hero.jsx, setting/theme.json)`);

    const serverPath = `${parsed.class}/${parsed.name}`;
    enforceCssWrite(serverPath);
    const content = readFileSync(target, 'utf-8');

    let baseHash = null;
    const projectId = getProjectId();
    if (projectId && !forceFlag) {
      baseHash = getCachedHash(projectId, serverPath);
    }

    // Ghost-resurrection check for single-file push: cached locally but
    // missing server-side means the user (or someone) deleted it on the server
    // since the last sync.
    if (projectId && baseHash && !forceFlag) {
      try {
        const listed = await callCLI('list_files', {});
        if (listed.ok && Array.isArray(listed.data?.files)) {
          const stillThere = listed.data.files.some(rf => rf.class === parsed.class && rf.name === parsed.name);
          if (!stillThere) {
            info(`${serverPath} was deleted on the server.`);
            const skip = jsonOutput
              ? true
              : (await prompt('Push anyway and re-create it? (y/N) ')).toLowerCase() !== 'y';
            if (skip) {
              removeCachedFile(projectId, serverPath);
              outputResult({ ok: true, text: `Skipped ${serverPath} (deleted server-side). Use --force to push anyway.`, data: { skipped: [serverPath] } });
              return;
            }
          }
        }
      } catch (_) { /* best-effort */ }
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

    // Surface a clear next-step on conflict. Server already includes the hint
    // in newer versions, but older deployments may not — make sure the CLI
    // always points at --force / cm64 diff so users aren't stuck.
    if (!result.ok && result.data?.conflict) {
      const hinted = /--force|cm64 diff/i.test(result.error || '');
      if (!hinted) {
        result.error = `${result.error}\n  Run \`cm64 diff ${serverPath}\` to see remote changes, or re-run with --force to overwrite.`;
      }
    }

    outputResult(result);
  },

  // ─── pull ──────────────────────────────────────────────────
  async pull() {
    // Show project context prominently
    const _pullName = getProjectName();
    const _pullId = getProjectId();
    if (_pullName || _pullId) {
      info(`Project: ${_pullName || 'unknown'} (${_pullId || 'no id'})`);
    }

    // Parse flags first so they can't leak into the positional target.
    // (subArgs was snapshotted at module load; getFlag splices argv but not
    // subArgs, so reading subArgs[0] directly would treat --check as a path.)
    const outDir = getFlag(['-o', '--out'], true);
    const checkOnly = !!getFlag(['--check', '--dry-run']);

    let target = subArgs.find(a => !a.startsWith('-'));

    // No positional: auto-detect — pull all files into domain folder or ./
    if (!target) {
      target = './';
    }

    // Pull all files (cm64 pull ./ or cm64 pull . or cm64 pull with no args)
    if (target === './' || target === '.') {
      // Determine output directory: use domain folder if available
      let baseDir = outDir || '.';
      const domain = getProjectDomain();
      if (!outDir && domain) {
        // Don't nest into ./<domain>/ if we're already in that folder, or if
        // a workspace file already pins cwd to this project — would create
        // bluemoon.cm64.studio/bluemoon.cm64.studio/.
        const cwdName = basename(resolve('.'));
        const alreadyInDomainDir = cwdName === domain;
        const cwdWorkspace = existsSync(WORKSPACE_FILE_NAME);
        if (alreadyInDomainDir || cwdWorkspace) {
          baseDir = '.';
        } else {
          baseDir = `./${domain}`;
          info(`Pulling into ./${domain}/`);
        }
      }

      info(checkOnly ? 'Checking remote vs local...' : 'Pulling all files...');
      const result = await callCLI('list_files', {});
      if (!result.ok) { outputResult(result); return; }

      const files = result.data?.files || [];
      if (files.length === 0) { info('No files found.'); return; }

      // --check / --dry-run: classify and print without touching disk.
      // Categories use cache+filesystem comparison (no per-file reads):
      //   new        — remote exists, local file does not (would create)
      //   updated    — remote updatedAt is newer than cached updatedAt
      //   would-clobber — local file content differs from cached content
      //                   AND remote also changed (we'd overwrite local edits)
      //   uncached-local — local file exists but no cache entry (sync state
      //                   unknown; conservative pull would still overwrite)
      //   unchanged  — best-effort match, nothing to do
      if (checkOnly) {
        const projectId = getProjectId();
        const newFiles = [];
        const updated = [];
        const wouldClobber = [];
        const uncachedLocal = [];
        const unchanged = [];

        for (const f of files) {
          if (!f.class || !f.name || f.class === 'asset') continue;
          const serverPath = `${f.class}/${f.name}`;
          const localFile = toLocalPath(f.class, f.name, baseDir);
          const localExists = existsSync(localFile);
          const cached = projectId ? getCachedFile(projectId, serverPath) : null;

          if (!localExists) {
            newFiles.push(serverPath);
            continue;
          }

          const localContent = readFileSync(localFile, 'utf-8');
          const localDiffersFromCache = cached ? localContent !== cached.content : true;

          let remoteChangedSinceCache = false;
          if (cached?.updatedAt && f.updatedAt) {
            try {
              remoteChangedSinceCache = new Date(f.updatedAt) > new Date(cached.updatedAt);
            } catch (_) { remoteChangedSinceCache = false; }
          } else if (!cached) {
            // No cache record for an existing local file — sync state unknown
            uncachedLocal.push(serverPath);
            continue;
          }

          if (remoteChangedSinceCache && localDiffersFromCache) {
            wouldClobber.push(serverPath);
          } else if (remoteChangedSinceCache) {
            updated.push(serverPath);
          } else {
            unchanged.push(serverPath);
          }
        }

        const lines = [];
        if (newFiles.length > 0) {
          lines.push(`New on remote (${newFiles.length}) — would create locally:`);
          for (const p of newFiles) lines.push(`  + ${p}`);
        }
        if (updated.length > 0) {
          lines.push(`Updated on remote (${updated.length}) — safe to pull:`);
          for (const p of updated) lines.push(`  ~ ${p}`);
        }
        if (wouldClobber.length > 0) {
          lines.push(`⚠ Conflicts (${wouldClobber.length}) — pull would clobber local edits:`);
          for (const p of wouldClobber) lines.push(`  ! ${p}`);
        }
        if (uncachedLocal.length > 0) {
          lines.push(`Uncached locals (${uncachedLocal.length}) — local file exists with no cache record; pull would overwrite:`);
          for (const p of uncachedLocal) lines.push(`  ? ${p}`);
        }
        if (unchanged.length > 0) {
          lines.push(`Unchanged (${unchanged.length}).`);
        }

        const summary = `--check: ${newFiles.length} new, ${updated.length} updated, ${wouldClobber.length} would-clobber, ${uncachedLocal.length} uncached-local, ${unchanged.length} unchanged.`;
        outputResult({
          ok: true,
          text: lines.length > 0 ? `${lines.join('\n')}\n\n${summary}` : 'Nothing to pull.',
          data: { new: newFiles, updated, would_clobber: wouldClobber, uncached_local: uncachedLocal, unchanged }
        });
        return;
      }

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

        const localFile = toLocalPath(cls, name, baseDir);
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

      // Pin the project to this directory by writing a .cm64.workspace file
      // so future commands run from inside resolve to the right project
      // without depending on the global ~/.cm64/config.json (which is shared
      // across all terminals/agents on this machine).
      try {
        const wsDir = baseDir === '.' ? '.' : baseDir;
        if (!findWorkspaceFile(wsDir)) {
          const projectId = getProjectId();
          const wsPath = writeWorkspaceFile(wsDir, {
            project_id: projectId,
            project_name: getProjectName(),
            project_domain: getProjectDomain()
          });
          info(`Pinned this directory to the project (${wsPath}).`);
        }
      } catch (e) {
        info(`Note: failed to write ${WORKSPACE_FILE_NAME} (${e.message}); falling back to global config.`);
      }

      out(`Pulled ${count} file(s)`);
      return;
    }

    // Pull by class folder (cm64 pull ./component/ or cm64 pull component/)
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

        const localFile = toLocalPath(folderClass, f.name, outDir || '.');
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

    // Pull a single file: "component/Hero" or "component/Hero.jsx"
    let serverPath;
    const parsed = parseLocalPath(target);
    if (parsed) {
      serverPath = `${parsed.class}/${parsed.name}`;
    } else if (target.includes('/')) {
      serverPath = normalizePath(target);
      validatePath(serverPath);
    } else {
      die(`Can't parse path: ${target}\n  Use class/name (e.g., component/Hero or component/Hero.jsx)`);
    }

    info(`Pulling ${serverPath}...`);
    const readResult = await callCLI('read_file', { path: serverPath });
    if (!readResult.ok) { outputResult(readResult); return; }

    const [cls, ...nameParts] = serverPath.split('/');
    const name = nameParts.join('/');
    const localFile = toLocalPath(cls, name, outDir || '.');
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
    // Show project context prominently
    const _syncName = getProjectName();
    const _syncId = getProjectId();
    if (_syncName || _syncId) {
      info(`Project: ${_syncName || 'unknown'} (${_syncId || 'no id'})`);
    }

    let target = subArgs[0];
    if (!target) {
      const domain = getProjectDomain();
      if (domain && existsSync(`./${domain}`) && statSync(`./${domain}`).isDirectory()) {
        target = `./${domain}/`;
        info(`Syncing ./${domain}/`);
      } else {
        target = './';
      }
    }
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
    let pushedOk = 0;
    let pushFailed = 0;
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
            pushedOk++;
          } else if (!r.ok) {
            info(`  ✗ push failed: ${r.path} — ${r.error || 'unknown error'}`);
            pushFailed++;
          }
        }
      } else if (!pushResult.ok) {
        info(`  ✗ push error: ${pushResult.error}`);
        pushFailed = toPush.length;
      }
    }

    // 6. Execute pulls
    let pulledOk = 0;
    let pullFailed = 0;
    for (const f of toPull) {
      const readResult = await callCLI('read_file', { path: f.serverPath });
      if (!readResult.ok || !readResult.data) {
        info(`  ✗ pull failed: ${f.serverPath}`);
        pullFailed++;
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
      pulledOk++;
    }

    const failParts = [];
    if (pushFailed > 0) failParts.push(`${pushFailed} push failed`);
    if (pullFailed > 0) failParts.push(`${pullFailed} pull failed`);
    const failSuffix = failParts.length > 0 ? ` (${failParts.join(', ')})` : '';
    out(`Sync complete: ${pushedOk} pushed, ${pulledOk} pulled${failSuffix}`);
  },

  // ─── edit ──────────────────────────────────────────────────
  async edit() {
    let path = subArgs[0];
    if (!path) die('Usage: cm64 edit <class/name> --old "text" --new "text"');
    path = normalizePath(path);
    validatePath(path);
    enforceCssWrite(path);

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
    let path = subArgs[0];
    if (!path) die('Usage: cm64 diff <class/name>');
    path = normalizePath(path);
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
    let path = subArgs[0];
    const fileId = getFlag(['--id'], true);
    if (!path && !fileId) die('Usage: cm64 delete <class/name> or --id <file_id>');
    if (path) {
      path = normalizePath(path);
      validatePath(path);
    }

    const result = await callCLI('delete_file', { path, file_id: fileId });
    outputResult(result);
  },

  // ─── rename ───────────────────────────────────────────────
  async rename() {
    let from = subArgs[0];
    let to = subArgs[1];
    if (!from || !to) die('Usage: cm64 rename <class/name> <class/new-name>\n  cm64 rename page/old-slug page/new-slug\n  cm64 rename component/Hero component/HeroV2');
    from = normalizePath(from);
    to = normalizePath(to);
    validatePath(from);
    validatePath(to);

    const result = await callCLI('rename_file', { from, to });

    // Move cache entry from old path to new path
    if (result.ok && result.data) {
      const projectId = getProjectId();
      if (projectId) {
        const cached = getCachedFile(projectId, from);
        if (cached) {
          cacheFile(projectId, result.data.to, cached);
        }
      }
    }

    outputResult(result);
  },

  // ─── search ────────────────────────────────────────────────
  async search() {
    const fileClass = normalizeClassFlag(getFlag(['--class', '-c'], true));
    const maxResults = getFlag(['--limit', '-n'], true);

    const pattern = argv.slice(1).join(' ');
    if (!pattern) die('Usage: cm64 search <pattern>');

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
    const description = getFlag(['--description', '-d'], true);

    const name = argv.slice(1).join(' ');
    if (!name) die('Usage: cm64 snapshot <name>');

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
    let path = subArgs[0];
    if (!path) die('Usage: cm64 history <class/name>');
    path = normalizePath(path);
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

  // ─── load (system prompt) — deprecated alias for `cm64 learn` ───
  async load() {
    if (!jsonOutput) {
      // Deprecation notice on stderr so it doesn't pollute --json output.
      process.stderr.write('Note: `cm64 load` is now `cm64 learn` (no args). Both still work.\n');
    }
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
  // No args: returns the system prompt + the available-skills index (the old
  // `cm64 load` + `cm64 skills` rolled into one). With one or more skill
  // names: returns those skills' content (use --offset/--limit to chunk).
  async learn() {
    const skills = subArgs.length > 0 ? subArgs : undefined;
    const offset = getFlag(['--offset'], true);
    const limit = getFlag(['--limit', '-n'], true);
    const raw = getFlag(['--raw', '-r']);

    if (!skills) {
      // No-arg learn: combine system prompt + skills index. Two calls so the
      // user gets both context surfaces in one shot.
      const promptResult = await callCLI('get_system_prompt', { raw: raw || undefined });
      const skillsResult = await callCLI('learn', {});

      if (jsonOutput) {
        // Structured: callers parse two named fields.
        outputResult({
          ok: promptResult.ok && skillsResult.ok,
          data: {
            system_prompt: promptResult.data ?? promptResult.text ?? null,
            skills: skillsResult.data ?? null,
            skills_text: skillsResult.text ?? null
          },
          error: promptResult.error || skillsResult.error || undefined
        });
        return;
      }

      // Human-readable: stitch the two outputs together.
      const parts = [];
      if (promptResult.ok && (promptResult.text || promptResult.data)) {
        parts.push(promptResult.text || JSON.stringify(promptResult.data, null, 2));
      } else if (!promptResult.ok) {
        parts.push(`(system prompt unavailable: ${promptResult.error})`);
      }
      parts.push('');
      parts.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      parts.push('');
      if (skillsResult.ok) {
        parts.push(skillsResult.text || '');
      } else {
        parts.push(`(skills index unavailable: ${skillsResult.error})`);
      }
      out(parts.join('\n'));
      return;
    }

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
    let path = subArgs[0];
    if (!path) die('Usage: cm64 restore <class/name> --version <id>');
    path = normalizePath(path);
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
    const fn = getFlag(['--function', '--fn'], true);
    const source = getFlag(['--source'], true);

    const result = await callCLI('debug', {
      pattern, level, since,
      function: fn,
      source,
      limit: limit ? parseInt(limit) : undefined
    });
    outputResult(result);
  },

  // ─── help ──────────────────────────────────────────────────
  async help() {
    if (subArgs.includes('--advanced') || subArgs.includes('--help-advanced')) {
      await HANDLERS['help-advanced']();
      return;
    }
    out(`CM64 CLI v${pkg.version} — Stateless CLI for CM64 Studio

WORKFLOW (the local-first loop)
  cm64 pull [--check]             Pull project into ./domain/ folder (--check = preview)
  cm64 push [--check]             Push local changes to server (--check = preview)
  cm64 sync                       Reconcile in both directions (see: cm64 sync --help)
  cm64 use <project_id|domain>    Set active project
  cm64 status [-v]                Context check (-v adds snapshot, dynamic pages, last push, env keys, db counts)
  cm64 info [-v]                  Project metadata (alias of status -v when -v is passed)
  cm64 doctor                     Health checks (missing titles, OG, snapshots, bad JSON)
  cm64 invalidate-cache [-t all]  Flush framework caches (target: all|components|site)

EDIT (remote-affecting; safe to use without a pull)
  cm64 delete <class/name>        Delete a file on the server (alias: rm)
  cm64 rename <from> <to>         Rename/move a file on the server (alias: mv)
  cm64 diff <class/name>          Show remote vs locally-cached content (no pull needed)

CONTEXT
  cm64 learn                      Print system prompt + available skills index
  cm64 learn <skill> [<skill>...] Read skill docs
  cm64 skills                     List all skills with sizes
  cm64 buildme                    Read BUILDME.md
  cm64 buildme --set "content"    Update BUILDME.md

ASSETS
  cm64 upload <name> -f <file>    Upload asset to S3 (images, videos, etc.)
  cm64 upload logo.png -f ./logo.png --folder images
  cm64 assets [--folder x]        List assets with S3 URLs

DEPLOY
  cm64 snapshot <name>            Create snapshot
  cm64 deploy <id|latest>         Pin snapshot to production
  cm64 history <class/name>       File version history
  cm64 restore <class/name>       Restore to version (--version <id>)

DATA
  cm64 users [--search x]         App end-users
  cm64 analytics [--days 7]       Analytics
  cm64 debug [--pattern x]        Server-side function logs

SETUP
  cm64 register                   Create account
  cm64 login [<token>]            Login with email+code (or PAT token)
  cm64 projects [--query x]       List projects
  cm64 create <name>              Create project (--domain, --template, --description)
  cm64 delete-project             Delete project (via dashboard)

FLAGS
  --json                          Structured JSON output
  --check, --dry-run              Preview pull/push without touching anything
  --force, -F                     Skip conflict detection
  -f, --file <path>               Read content from local file
  --diff                          Preview changes before writing

ENVIRONMENT
  CM64_TOKEN                      Override token
  CM64_ENDPOINT                   Override endpoint
  CM64_PROJECT                    Override project ID (highest priority)

PROJECT RESOLUTION (first match wins)
  1. CM64_PROJECT env var
  2. .cm64.workspace file in cwd or any ancestor (auto-written by 'cm64 pull')
  3. ~/.cm64/config.json (global, shared across terminals)
  Run 'cm64 status' to see which source is active.

ADVANCED
  Remote-only verbs (read/write/edit/ls/search/glob/write-many) are hidden by
  default — they overlap with your local editor/grep/etc. once you have a
  pull. See: cm64 help --advanced

Config: ~/.cm64/config.json
Docs: https://docs.cm64.io/cli`);
  },

  async ['help-advanced']() {
    out(`CM64 CLI v${pkg.version} — Advanced commands

These are remote-only escape hatches. Once you've run \`cm64 pull\` they
duplicate things your local editor already does (Read/Edit/grep/ls). Useful
in repo-style workflows or for one-off remote ops without pulling.

REMOTE FILES (escape hatches; prefer pull → edit locally → push)
  cm64 ls [--class component]     List remote files
  cm64 read <class/name>          Read remote file (auto-caches hash)
  cm64 write <class/name>         Write file (--content, -f, or stdin)
  cm64 write-many                 Bulk write (JSON from stdin)
  cm64 edit <class/name>          Edit (--old "x" --new "y")

  (delete, rename, diff have been promoted to main help — see 'cm64 help')

REMOTE SEARCH (escape hatches; prefer ripgrep on a pulled project)
  cm64 search <pattern>           Grep across project files
  cm64 glob <pattern>             Glob file paths

DEPRECATED
  cm64 load [--raw]               Use \`cm64 learn\` instead.

Run \`cm64 <command> --help\` for per-command usage.
`);
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

// ── Per-Subcommand Help ──────────────────────────────────────

const SUBCOMMAND_HELP = {
  login:      'Usage: cm64 login [<token>] [--endpoint <url>]\n  Interactive email+code login, or direct PAT token login.',
  register:   'Usage: cm64 register [--endpoint <url>]\n  Create a new CM64 account (email + challenge).',
  projects:   'Usage: cm64 projects [--query <search>] [--json]\n  List all projects. Use --query to filter by name or domain.',
  use:        'Usage: cm64 use <project_id|domain>\n  Set the active project by ID or domain. Saves to ~/.cm64/config.json (global). If run inside a directory containing a .cm64.workspace file, that file is updated too so multi-terminal sessions stay isolated.',
  create:     'Usage: cm64 create <name> [--domain <sub>] [--template <domain>] [--description <text>]\n  Create a new project.',
  'delete-project': 'Project deletion is only available from the dashboard at https://build.cm64.io',
  status:     'Usage: cm64 status [-v|--verbose] [--json]\n  One-liner context check. -v forwards to `info -v` for the verbose view.\n  Always prints "Project source: env|workspace|global" so you can tell where the active project came from in multi-terminal sessions.',
  info:       'Usage: cm64 info [-v|--verbose] [--json]\n  Project metadata. -v adds pinned snapshot, dynamic pages, last push, env keys, and DB row counts.',
  doctor:     'Usage: cm64 doctor [--json]\n  Health checks: missing meta.title, missing OG image, no production pin, invalid page JSON.',
  'invalidate-cache': 'Usage: cm64 invalidate-cache [--target all|components|site]\n  Flush framework caches so the next request rebuilds from MongoDB.\n  - all (default): nukes everything (process-wide; affects all projects on this framework instance)\n  - components: clears the component bundle cache for this project\'s primary domain\n  - site: clears the trusted-component cache for this project',
  ls:         'Usage: cm64 ls [--class <type>] [--json]\n  List project files. Filter by class: page, component, function, setting, database, asset.',
  read:       'Usage: cm64 read <class/name> [--json]\n  Read a file and cache its hash for conflict detection.',
  write:      'Usage: cm64 write <class/name> [--content <text>] [-f <file>] [--diff]\n  Write file content from --content, -f file, or stdin.',
  'write-many':'Usage: cm64 write-many < files.json\n  Bulk write files from JSON array on stdin.',
  edit:       'Usage: cm64 edit <class/name> --old "text" --new "text"\n  Find-and-replace within a file.',
  diff:       'Usage: cm64 diff <class/name>\n  Compare locally cached version vs remote.',
  delete:     'Usage: cm64 delete <class/name>\n  Delete a file from the project.',
  rename:     'Usage: cm64 rename <class/old_name> <class/new_name>\n  Rename or move a file.',
  pull:       'Usage: cm64 pull [<class/name>|<./folder/>] [--check|--dry-run] [--force]\n  Pull project files to local directory.\n  --check / --dry-run: preview what would be pulled (new/updated/would-clobber/unchanged) without writing to disk.',
  push:       'Usage: cm64 push [<class/name.ext>|<./folder/>] [--check|--dry-run] [--force] [--diff]\n  Push local files to server.\n  --check / --dry-run: preview what would be pushed (new/modified/ghost/unchanged) without uploading.',
  sync:       'Usage: cm64 sync [<./folder/>]\n  One-shot bidirectional reconcile of local and server state.\n  - Local exists, remote does not  → push (treated as a new file).\n  - Both exist, local content differs from cache → push with base_hash (server rejects if remote also changed since cache).\n  - Both exist, no cache entry → skipped (sync is conservative; explicit pull/push for these).\n  - Remote exists, local does not → pull.\n  - Both exist, remote hash differs from cache, not already pushing → pull (clobbers any uncached local edits).\n  Conflict policy: no per-file prompt. The server\'s base_hash check decides. Use --force to override.\n  Prints a summary line: "Sync complete: N pushed, M pulled". For surgical diffs, use `cm64 diff` then explicit pull/push.',
  search:     'Usage: cm64 search <pattern> [--class <type>] [--limit <n>]\n  Grep across project files.',
  glob:       'Usage: cm64 glob <pattern>\n  Glob file paths in the project.',
  snapshot:   'Usage: cm64 snapshot <name> [--description <text>]\n  Create a named snapshot.',
  deploy:     'Usage: cm64 deploy <snapshot_id|latest> [--domain <d>]\n  Pin a snapshot to production.',
  history:    'Usage: cm64 history <class/name>\n  Show version history for a file.',
  restore:    'Usage: cm64 restore <class/name> --version <id>\n  Restore a file to a previous version.',
  upload:     'Usage: cm64 upload <name> -f <file> [--folder <path>] [--mime <type>]\n  Upload an asset (image, video, etc.).',
  assets:     'Usage: cm64 assets [--folder <path>]\n  List uploaded assets with S3 URLs.',
  buildme:    'Usage: cm64 buildme [--set "content"] [--append]\n  Read or update BUILDME.md.',
  load:       'Usage: cm64 load [--raw]\n  Deprecated alias for `cm64 learn` (no args). Returns the system prompt.',
  skills:     'Usage: cm64 skills [<name>]\n  List skills or show details for a specific skill.',
  learn:      'Usage: cm64 learn [<skill> ...] [--raw] [--offset <n>] [--limit <n>]\n  No args: prints the project system prompt + available skills index (the old `cm64 load` + `cm64 skills` rolled into one).\n  With skill names: prints those skills\' contents (use --offset/--limit to chunk long ones).',
  users:      'Usage: cm64 users [--search <x>] [--role <r>] [--status <s>] [--page <n>] [--limit <n>]\n  List app end-users.',
  analytics:  'Usage: cm64 analytics [--days <n>] [--event <e>]\n  View analytics data.',
  debug:      'Usage: cm64 debug [--pattern <p>] [--level <l>] [--function <name>] [--source function|component] [--limit <n>] [--since <date>]\n  View server-side function execution logs (app.log, errors, recommendations).',
};

// ── Main ─────────────────────────────────────────────────────

async function main() {
  if (command === '--help-advanced' || command === 'help-advanced') {
    await HANDLERS['help-advanced']();
    process.exit(0);
  }
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
    'mv': 'rename',
    'move': 'rename',
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
    'signup': 'register',
    'reg': 'register',
    'clone': 'pull',
    'flush': 'invalidate-cache',
    'flush-cache': 'invalidate-cache',
  };

  const cmd = aliases[command] || command;

  // ── Per-subcommand --help ──────────────────────────────────
  if (subArgs.includes('--help') || subArgs.includes('-h')) {
    const usage = SUBCOMMAND_HELP[cmd];
    if (usage) {
      out(usage);
    } else {
      out(`cm64 ${cmd} — no detailed help available.\nRun 'cm64 help' for full usage.`);
    }
    process.exit(0);
  }

  const handler = HANDLERS[cmd];
  if (!handler) {
    die(`Unknown command: ${command}\nRun 'cm64 help' for usage.`);
  }

  // Check token for commands that need it (everything except login, register, and help)
  if (!['login', 'register', 'help', 'delete-project'].includes(cmd)) {
    if (!getToken()) {
      die('Not logged in. Run: cm64 login');
    }
  }

  // Check project for commands that need it
  const needsProject = !['login', 'register', 'help', 'projects', 'create', 'use', 'learn', 'skills', 'delete-project'].includes(cmd);
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
