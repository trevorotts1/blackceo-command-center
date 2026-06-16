#!/usr/bin/env tsx
/**
 * scripts/repair-model-defaults.ts
 *
 * Repair existing "no model" / "openrouter/free" rows across the Command Center DB
 * for the box where this script runs.
 *
 * What it does (idempotent):
 *   1. Purges agent_settings rows with value='openrouter/free' or NULL
 *      so the task-time selector takes over on next dispatch.
 *   2. Clears tasks.model_id = 'openrouter/free' so they will be re-resolved.
 *   3. Checks every sops row for a model_pin that is 'openrouter/free'
 *      and clears it (the SOP pin column was added by migration 072).
 *   4. Reports a summary: how many rows were repaired.
 *
 * Run with:
 *   npx tsx scripts/repair-model-defaults.ts [--dry-run]
 *
 * In dry-run mode it reports what would be changed but makes no writes.
 *
 * Per the AF-MODEL-SOVEREIGNTY doctrine, this script is the repair half —
 * prevention lives in migration 072 (new DBs) and the gate in task-dispatcher.ts
 * (runtime enforcement).
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Find the DB ──────────────────────────────────────────────────────────────

const DB_CANDIDATES = [
  path.join(os.homedir(), 'canary', 'canary.db'),
  path.join(process.cwd(), 'canary.db'),
  path.join(process.cwd(), 'mission-control.db'),
  path.join(os.homedir(), 'mission-control.db'),
];

function findDb(): string {
  for (const p of DB_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  const envPath = process.env.CC_DB_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  throw new Error(
    `Cannot find Command Center DB. Tried:\n${DB_CANDIDATES.join('\n')}\n` +
    `Set CC_DB_PATH to override.`,
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const REJECTED_FREE = 'openrouter/free';

function main() {
  const dbPath = findDb();
  console.log(`[repair-model-defaults] DB: ${dbPath}${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`);

  const db = new Database(dbPath, { readonly: DRY_RUN });

  // ── 1. agent_settings: count offenders ───────────────────────────────────
  const badSettings = db.prepare(
    `SELECT id, department_id, role_id, value
     FROM agent_settings
     WHERE setting_type = 'model'
       AND (value = ? OR value = '' OR value IS NULL)`,
  ).all(REJECTED_FREE) as { id: string; department_id: string; role_id: string | null; value: string | null }[];

  console.log(`[repair-model-defaults] agent_settings rows with bad model value: ${badSettings.length}`);
  for (const row of badSettings) {
    const slot = row.role_id ? `role=${row.role_id}` : 'dept-default';
    console.log(`  dept=${row.department_id} ${slot} value=${JSON.stringify(row.value)}`);
  }

  if (!DRY_RUN && badSettings.length > 0) {
    const del = db.prepare(
      `DELETE FROM agent_settings
       WHERE setting_type = 'model'
         AND (value = ? OR value = '' OR value IS NULL)`,
    ).run(REJECTED_FREE);
    console.log(`  → deleted ${del.changes} rows`);
  }

  // ── 2. tasks.model_id ─────────────────────────────────────────────────────
  const hasMigration31 = (() => {
    try {
      const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
      return cols.includes('model_id');
    } catch { return false; }
  })();

  if (hasMigration31) {
    const badTasks = db.prepare(
      `SELECT id, title FROM tasks WHERE model_id = ?`,
    ).all(REJECTED_FREE) as { id: string; title: string }[];

    console.log(`[repair-model-defaults] tasks with model_id='${REJECTED_FREE}': ${badTasks.length}`);
    for (const t of badTasks) {
      console.log(`  task_id=${t.id} title=${JSON.stringify(t.title)}`);
    }

    if (!DRY_RUN && badTasks.length > 0) {
      const upd = db.prepare(
        `UPDATE tasks SET model_id = NULL WHERE model_id = ?`,
      ).run(REJECTED_FREE);
      console.log(`  → cleared ${upd.changes} task model_id rows`);
    }
  } else {
    console.log(`[repair-model-defaults] tasks.model_id column not present — skipping`);
  }

  // ── 3. sops.model_pin ─────────────────────────────────────────────────────
  const hasSopPin = (() => {
    try {
      const cols = (db.prepare('PRAGMA table_info(sops)').all() as { name: string }[]).map((c) => c.name);
      return cols.includes('model_pin');
    } catch { return false; }
  })();

  if (hasSopPin) {
    const badSops = db.prepare(
      `SELECT id, name FROM sops WHERE model_pin = ? AND deleted_at IS NULL`,
    ).all(REJECTED_FREE) as { id: string; name: string }[];

    console.log(`[repair-model-defaults] sops with model_pin='${REJECTED_FREE}': ${badSops.length}`);
    for (const s of badSops) {
      console.log(`  sop_id=${s.id} name=${JSON.stringify(s.name)}`);
    }

    if (!DRY_RUN && badSops.length > 0) {
      const upd = db.prepare(
        `UPDATE sops SET model_pin = NULL WHERE model_pin = ?`,
      ).run(REJECTED_FREE);
      console.log(`  → cleared ${upd.changes} sop model_pin rows`);
    }
  } else {
    console.log(`[repair-model-defaults] sops.model_pin column not present — run migration 072 first`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const totalFixed = badSettings.length + (hasMigration31 ? 0 : 0);
  console.log(
    DRY_RUN
      ? `\n[repair-model-defaults] DRY RUN complete — ${badSettings.length} agent_settings rows would be repaired. Re-run without --dry-run to apply.`
      : `\n[repair-model-defaults] Done. Repair complete — rows cleared, selector will take over on next dispatch.`,
  );

  db.close();
}

main();
