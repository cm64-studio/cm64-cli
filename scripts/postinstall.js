#!/usr/bin/env node
// Silently install cm64 Claude Code skill on npm install
// Must never break npm install — all errors are swallowed

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const skillSource = join(__dirname, '..', 'skill', 'cm64.md');
  if (!existsSync(skillSource)) process.exit(0);

  const content = readFileSync(skillSource, 'utf-8');
  const targets = [];

  // Strategy 1: Project-local .claude/commands/ (if INIT_CWD has .claude/)
  const initCwd = process.env.INIT_CWD;
  if (initCwd) {
    const projectClaude = join(initCwd, '.claude');
    if (existsSync(projectClaude)) {
      targets.push(join(projectClaude, 'commands', 'cm64.md'));
    }
  }

  // Strategy 2: User-level ~/.claude/commands/
  const homeClaude = join(homedir(), '.claude');
  if (existsSync(homeClaude)) {
    targets.push(join(homeClaude, 'commands', 'cm64.md'));
  }

  for (const target of targets) {
    try {
      const dir = dirname(target);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(target, content);
      break; // Install to first available location only
    } catch {
      // Silent — try next target
    }
  }
} catch {
  // Silent failure — must never break npm install
}
