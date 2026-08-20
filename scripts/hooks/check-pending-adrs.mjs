#!/usr/bin/env node
/**
 * Pending-ADR backstop: list archived proposals missing ADR link and No-ADR stamp.
 * Honors .forge/config.json adr.enabled === false.
 *
 * Usage: node check-pending-adrs.mjs [repoRoot]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function gitRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}

function loadConfig(cwd) {
  const p = path.join(cwd, '.forge', 'config.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function listProposals(cwd, archiveRoot) {
  const dir = path.join(cwd, ...archiveRoot.split('/'));
  if (!fs.existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const proposal = path.join(dir, name, 'proposal.md');
    if (fs.existsSync(proposal)) out.push(proposal);
  }
  return out;
}

const cwd = process.argv[2] || gitRoot();
if (!cwd) process.exit(0);

const cfg = loadConfig(cwd);
if (cfg.adr && cfg.adr.enabled === false) process.exit(0);

const archives = [
  'openspec/changes/archive',
  `${(cfg.plan && typeof cfg.plan === 'object' && cfg.plan.dir) || 'specs'}/changes/archive`,
];
/** @type {string[]} */
const pending = [];
for (const root of archives) {
  for (const proposal of listProposals(cwd, root)) {
    const body = fs.readFileSync(proposal, 'utf8');
    if (/ADR-[0-9]/.test(body)) continue;
    if (body.includes('No ADR — non-architectural change')) continue;
    pending.push(path.relative(cwd, proposal).replace(/\\/g, '/'));
  }
}

if (pending.length === 0) process.exit(0);

const shown = pending.slice(0, 10).join('\n');
process.stdout.write(
  `Archived changes whose proposal.md does not reference an ADR yet:\n\n${shown}\n\n` +
    `If any had architectural impact, run the archive-to-adr skill.\n` +
    `Otherwise add a one-line stamp to each proposal.md:\n` +
    `  'No ADR — non-architectural change'\n`,
);
process.exit(0);
