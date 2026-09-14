/**
 * PD-TEST-050 — migration 147: the pre-engine recovery receipt is unique per
 * (task_id, repair_key), not per task_id, and the rebuild PRESERVES every
 * existing receipt row.
 *
 * THE DEFECT THIS FILE LOCKS DOWN
 *   Migration 146 declared `task_id TEXT NOT NULL UNIQUE`. That made the first
 *   pre-engine recovery the last one for its task, so when the single authorised
 *   receipt was consumed by repair A and the engine then died on a different
 *   deterministic pre-engine defect (PD-TEST-049), there was no supported
 *   re-drive path: a different repair_key drew 409
 *   `pre_engine_recovery_already_issued`, and the ordinary sweeps gate on
 *   `dispatch_attempts < MAX_DISPATCH_ATTEMPTS` with the counter already at 6.
 *
 * WHAT IS EXERCISED FOR REAL
 *   - the real migration list and the real runMigrations() runner,
 *   - a REAL legacy database carrying the exact migration-146 table DDL and a
 *     pre-existing receipt row (so the copy-on-rebuild is measured, not assumed),
 *   - the resulting SQLite schema read back from sqlite_master,
 *   - the real uniqueness behaviour of the rebuilt table.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { schema } from '../../src/lib/db/schema';
import { runMigrations } from '../../src/lib/db/migrations';

/** The exact DDL migration 146 shipped, including its task_id UNIQUE. */
const LEGACY_146_DDL = `CREATE TABLE presentation_operator_preengine_recoveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  execution_id TEXT NOT NULL,
  contract_sha256 TEXT NOT NULL,
  prior_dispatch_attempts INTEGER NOT NULL,
  repair_key TEXT NOT NULL,
  prior_failure_code TEXT NOT NULL,
  bridge_state TEXT NOT NULL,
  bridge_retry_attempt INTEGER NOT NULL,
  dispatch_started_at TEXT,
  created_at TEXT NOT NULL
)`;

function legacyDbWithOneReceipt(): { db: Database.Database; file: string; row: Record<string, string | number | null> } {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig147-')), 'legacy.db');
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  db.exec(LEGACY_146_DDL);
  const row = {
    id: '96932757-ea89-4e4a-80a0-a8eb98af4974',
    task_id: uuidv4(),
    execution_id: uuidv4(),
    contract_sha256: 'a'.repeat(64),
    prior_dispatch_attempts: 5,
    repair_key: 'pd038-notify-env-and-pd039-recovery-counter',
    prior_failure_code: 'AF-NOTIFY-UNCONFIGURED',
    bridge_state: 'launch_pending',
    bridge_retry_attempt: 1,
    dispatch_started_at: '2026-09-14T23:38:28.879Z',
    created_at: '2026-09-14T23:38:28.869Z',
  };
  db.prepare(`INSERT INTO companies (id, name, slug) VALUES ('default', 'Default', 'default')`).run();
  db.prepare(`INSERT INTO workspaces (id, name, slug) VALUES ('default', 'Default', 'default')`).run();
  db.prepare(`INSERT INTO tasks (id, title, status, workspace_id, department, source) VALUES (?, 'PD-TEST-050', 'blocked', 'default', 'presentations', 'operator-delegated')`).run(row.task_id);
  db.prepare(`INSERT INTO presentation_operator_preengine_recoveries
    (id, task_id, execution_id, contract_sha256, prior_dispatch_attempts, repair_key, prior_failure_code, bridge_state, bridge_retry_attempt, dispatch_started_at, created_at)
    VALUES (@id, @task_id, @execution_id, @contract_sha256, @prior_dispatch_attempts, @repair_key, @prior_failure_code, @bridge_state, @bridge_retry_attempt, @dispatch_started_at, @created_at)`).run(row);
  return { db, file, row };
}

test('migration 147 rebuilds the receipt table to UNIQUE(task_id, repair_key) and preserves every existing receipt', () => {
  const { db, row } = legacyDbWithOneReceipt();
  try {
    // The legacy shape really does forbid a second receipt for the same task —
    // this is the defect, reproduced on a real database.
    assert.throws(
      () => db.prepare(`INSERT INTO presentation_operator_preengine_recoveries
        (id, task_id, execution_id, contract_sha256, prior_dispatch_attempts, repair_key, prior_failure_code, bridge_state, bridge_retry_attempt, created_at)
        VALUES (?, ?, ?, ?, 6, 'pd049-f1-requester-shape', 'F1-NO-REQUESTER-CHAT-ID', 'launch_pending', 1, ?)`)
        .run(uuidv4(), row.task_id, row.execution_id, row.contract_sha256, new Date().toISOString()),
      /UNIQUE/i,
    );

    runMigrations(db);

    // The migration applied and is recorded once.
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE id='147'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM _migrations WHERE id='146'`).get() as { n: number }).n, 1);

    // The legacy receipt survived byte-for-byte.
    const preserved = db.prepare('SELECT * FROM presentation_operator_preengine_recoveries WHERE id=?').get(row.id) as Record<string, unknown>;
    assert.deepEqual(preserved, row, 'no recovery history is deleted or rewritten by the rebuild');

    // The rebuilt table carries the new uniqueness and no longer carries the old.
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='presentation_operator_preengine_recoveries'`).get() as { sql: string }).sql;
    assert.match(ddl, /UNIQUE\s*\(\s*task_id\s*,\s*repair_key\s*\)/i, 'the rebuild must declare UNIQUE(task_id, repair_key)');
    assert.doesNotMatch(ddl, /task_id TEXT NOT NULL UNIQUE/i, 'the task_id-only UNIQUE must be gone');
    assert.match(ddl, /REFERENCES tasks\(id\) ON DELETE CASCADE/i, 'the FK to tasks is preserved');
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_147'`).get() as { n: number }).n,
      0,
      'the rebuild scratch table is renamed away, not left behind',
    );

    // (a) a SECOND, distinct repair key is now insertable for the same task…
    db.prepare(`INSERT INTO presentation_operator_preengine_recoveries
      (id, task_id, execution_id, contract_sha256, prior_dispatch_attempts, repair_key, prior_failure_code, bridge_state, bridge_retry_attempt, created_at)
      VALUES (?, ?, ?, ?, 6, 'pd049-f1-requester-shape', 'F1-NO-REQUESTER-CHAT-ID', 'launch_pending', 1, ?)`)
      .run(uuidv4(), row.task_id, row.execution_id, row.contract_sha256, new Date().toISOString());
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM presentation_operator_preengine_recoveries WHERE task_id=?').get(row.task_id) as { n: number }).n,
      2,
    );

    // …while the SAME (task_id, repair_key) pair still cannot be duplicated.
    assert.throws(
      () => db.prepare(`INSERT INTO presentation_operator_preengine_recoveries
        (id, task_id, execution_id, contract_sha256, prior_dispatch_attempts, repair_key, prior_failure_code, bridge_state, bridge_retry_attempt, created_at)
        VALUES (?, ?, ?, ?, 6, ?, 'F1-NO-REQUESTER-CHAT-ID', 'launch_pending', 1, ?)`)
        .run(uuidv4(), row.task_id, row.execution_id, row.contract_sha256, row.repair_key, new Date().toISOString()),
      /UNIQUE/i,
      'one receipt per (task, repair) — the idempotent-replay key — is still enforced',
    );

    // No orphaned foreign keys were introduced by the rebuild.
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('a fresh database boots straight to the (task_id, repair_key) shape', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mig147-fresh-')), 'fresh.db');
  const db = new Database(file);
  try {
    db.exec(schema);
    runMigrations(db);
    const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='presentation_operator_preengine_recoveries'`).get() as { sql: string }).sql;
    assert.match(ddl, /UNIQUE\s*\(\s*task_id\s*,\s*repair_key\s*\)/i);
    assert.doesNotMatch(ddl, /task_id TEXT NOT NULL UNIQUE/i);
  } finally {
    db.close();
  }
});
