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

  // Strategy 1: User-level ~/.claude/skills/cm64/ (new format — preferred)
  const homeSkillDir = join(homedir(), '.claude', 'skills', 'cm64');
  try {
    if (!existsSync(homeSkillDir)) mkdirSync(homeSkillDir, { recursive: true });
    writeFileSync(join(homeSkillDir, 'SKILL.md'), content);
  } catch {
    // Silent
  }

  // Strategy 2: Legacy — ~/.claude/commands/cm64.md (backwards compat)
  const legacySource = join(__dirname, '..', 'skill', 'cm64.md');
  if (existsSync(legacySource)) {
    const legacyContent = readFileSync(legacySource, 'utf-8');
    const homeClaude = join(homedir(), '.claude');
    if (existsSync(homeClaude)) {
      try {
        const cmdDir = join(homeClaude, 'commands');
        if (!existsSync(cmdDir)) mkdirSync(cmdDir, { recursive: true });
        writeFileSync(join(cmdDir, 'cm64.md'), legacyContent);
      } catch {
        // Silent
      }
    }
  }
} catch {
  // Silent failure — must never break npm install
}
