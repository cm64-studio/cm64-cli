// lib/config.js
// ~/.cm64/config.json management

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.cm64');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
  endpoint: 'https://build.cm64.io/api/cli',
  token: null,
  project_id: null,
  project_name: null
};

function ensureDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
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
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

export function getToken() {
  return process.env.CM64_TOKEN || loadConfig().token;
}

export function getEndpoint() {
  return process.env.CM64_ENDPOINT || loadConfig().endpoint;
}

export function getProjectId() {
  return process.env.CM64_PROJECT || loadConfig().project_id;
}

export { CONFIG_DIR, CONFIG_FILE };
