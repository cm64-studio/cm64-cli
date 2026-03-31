#!/usr/bin/env node
// Silently install cm64 Claude Code skill on npm install
// Must never break npm install — all errors are swallowed

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

try {
  const skillSource = join(__dirname, '..', 'skills', 'cm64', 'SKILL.md');
  if (!existsSync(skillSource)) process.exit(0);

  const content = readFileSync(skillSource, 'utf-8');

  // Install to ~/.claude/skills/cm64/SKILL.md
  const homeSkillDir = join(homedir(), '.claude', 'skills', 'cm64');
  try {
    if (!existsSync(homeSkillDir)) mkdirSync(homeSkillDir, { recursive: true });
    writeFileSync(join(homeSkillDir, 'SKILL.md'), content);
  } catch {
    // Silent
  }
} catch {
  // Silent failure — must never break npm install
}
