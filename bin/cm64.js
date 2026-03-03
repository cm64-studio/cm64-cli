#!/usr/bin/env node
// CM64 CLI — stateless CLI for CM64 Studio
// Each command is an independent HTTP call. No sessions.
// Usage: cm64 <command> [args] [--json]

import { loadConfig, saveConfig, getToken, getEndpoint, getProjectId, CONFIG_FILE } from '../lib/config.js';
import { callCLI } from '../lib/api.js';
import { cacheFile, getCachedFile, getCachedHash } from '../lib/cache.js';
import { createInterface } from 'readline';
import { readFileSync, existsSync } from 'fs';
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

    let content = getFlag(['--content', '-c'], true);
    const localFile = getFlag(['-f', '--file'], true);
    const changelog = getFlag(['--changelog', '--msg', '-m'], true);
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

  // ─── edit ──────────────────────────────────────────────────
  async edit() {
    const path = subArgs[0];
    if (!path) die('Usage: cm64 edit <class/name> --old "text" --new "text"');

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

SEARCH
  cm64 search <pattern>           Grep across project files
  cm64 glob <pattern>             Glob file paths

DEPLOY
  cm64 snapshot <name>            Create snapshot
  cm64 deploy <id|latest>         Pin snapshot to production
  cm64 history <class/name>       File version history

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
