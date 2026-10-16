#!/usr/bin/env tsx
/**
 * scripts/import-skill71-runs.ts: Skill 71 run events, file transport.
 *
 * Fix plan Item 26 (Amendment 1 rider): the ingestion core has two
 * transports over one code path (src/lib/skill71-runs.ts). This script is
 * the FILE transport, used where the Command Center can read the run
 * index directly:
 *
 *   - fleet-contabo: the per-client bind mounts aggregate on the host at
 *     /srv/skill71-runs/<client-slug>/runs.jsonl: pass --mount-root
 *     /srv/skill71-runs (the default when the directory exists).
 *   - any single index file (a copied runs.jsonl, a local host index):
 *     pass --index <path> or set SKILL71_RUNS_INDEX.
 *
 * The HTTP transport (fleet-hostinger push, opted-in fleet-mac) is
 * POST /api/skill-runs/ingest; it shares the same validation, dedupe by
 * event_id, and upsert logic in src/lib/skill71-runs.ts.
 *
 * Idempotent: re-running over the same lines changes nothing (events
 * dedupe by event_id; run records hold the latest event state). The
 * importer is read-only with respect to run folders and index files.
 *
 * Usage:
 *   DATABASE_PATH=/path/to/mission-control.db npx tsx scripts/import-skill71-runs.ts
 *   DATABASE_PATH=... npx tsx scripts/import-skill71-runs.ts --index /srv/skill71-runs/acme/runs.jsonl
 *   DATABASE_PATH=... npx tsx scripts/import-skill71-runs.ts --mount-root /srv/skill71-runs
 *
 * DATABASE_PATH is required by the C8 isolation guard in src/lib/db -
 * without it this script refuses to start rather than risk opening the
 * live database by accident. That is deliberate; do not "fix" it here.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  ingestSkill71Event,
  validateSkill71Event,
} from '../src/lib/skill71-runs';

interface Counts {
  read: number;
  inserted: number;
  duplicates: number;
  rejected: number;
}

function importFile(file: string, counts: Counts): void {
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    counts.read += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      counts.rejected += 1;
      console.error(`[skill71-import] ${file}: unparseable line rejected`);
      continue;
    }
    const result = validateSkill71Event(parsed);
    if (!result.ok) {
      counts.rejected += 1;
      console.error(
        `[skill71-import] ${file}: rejected (${result.errors.join('; ')})`,
      );
      continue;
    }
    const outcome = ingestSkill71Event(result.event, { source: `file:${file}` });
    if (outcome.status === 'inserted') counts.inserted += 1;
    else counts.duplicates += 1;
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const argValue = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const files: string[] = [];
  const index = argValue('--index') ?? process.env.SKILL71_RUNS_INDEX;
  const mountRoot = argValue('--mount-root')
    ?? (fs.existsSync('/srv/skill71-runs') ? '/srv/skill71-runs' : undefined);

  if (index) files.push(index);
  if (mountRoot) {
    for (const entry of fs.readdirSync(mountRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(mountRoot, entry.name, 'runs.jsonl');
      if (fs.existsSync(candidate)) files.push(candidate);
    }
  }
  if (files.length === 0) {
    console.error(
      '[skill71-import] no index files found: pass --index <path>, ' +
      '--mount-root <dir>, or set SKILL71_RUNS_INDEX',
    );
    process.exit(2);
  }

  const counts: Counts = { read: 0, inserted: 0, duplicates: 0, rejected: 0 };
  for (const file of files) {
    console.log(`[skill71-import] reading ${file}`);
    importFile(file, counts);
  }
  console.log(
    `[skill71-import] done: ${counts.read} lines read, ${counts.inserted} events inserted, ` +
    `${counts.duplicates} duplicates skipped, ${counts.rejected} rejected`,
  );
  process.exit(counts.rejected > 0 ? 1 : 0);
}

main();
