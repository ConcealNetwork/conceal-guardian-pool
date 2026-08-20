#!/usr/bin/env node
/**
 * Agent reminder after a successful change archive (stdout only).
 * Usage: node openspec-archive-agent-message.mjs <change-slug>
 */

import fs from 'node:fs';
import path from 'node:path';

const changeName = process.argv[2];
if (!changeName) {
  process.stderr.write('Usage: openspec-archive-agent-message.mjs <change-slug>\n');
  process.exit(1);
}

let adrDir = 'docs/adr';
let decisionsDoc = 'docs/decisions.md';
let archiveRoot = 'openspec/changes/archive';
let adrEnabled = true;

const cfgPath = path.join(process.cwd(), '.forge', 'config.json');
if (fs.existsSync(cfgPath)) {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (c.plan?.engine === 'specs') {
      archiveRoot = `${c.plan.dir || 'specs'}/changes/archive`;
    }
    if (c.adr?.enabled === false) adrEnabled = false;
    if (c.adr?.dir) adrDir = c.adr.dir;
    if (c.adr?.decisionsDoc) decisionsDoc = c.adr.decisionsDoc;
  } catch {
    // keep defaults
  }
}

if (!adrEnabled) {
  process.stdout.write(
    `Change '${changeName}' was archived. ADRs are disabled for this project\n` +
      `(\`.forge/config.json\` → adr.enabled: false). No archive-to-adr follow-up.\n\n` +
      `Suggested commit (display only — do NOT commit unless the user asks):\n\n` +
      `openspec: archive ${changeName}\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `Change '${changeName}' was just archived.\n\n` +
    `1. archive-to-adr: locate ${archiveRoot}/YYYY-MM-DD-${changeName}/, open proposal.md, and evaluate an ADR (${decisionsDoc}). If yes: ${adrDir}/NNNN-<topic>.md, update ${adrDir}/README.md, add a ## Decision record to proposal.md. If no: add one line to proposal.md: No ADR — non-architectural change.\n\n` +
    `2. Suggested commit (display only — do NOT run git commit / push / gh pr create unless the user explicitly asks):\n\n` +
    `openspec: archive ${changeName}\n`,
);
process.exit(0);
