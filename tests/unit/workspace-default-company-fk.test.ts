/**
 * Fixture test for BUG 4 — POST /api/workspaces: SQLITE_CONSTRAINT_FOREIGNKEY
 * on a fresh DB (no company row pre-existing).
 *
 * Verifies:
 *   1. Migration 064 seeds the sentinel 'default' company row (idempotent).
 *   2. An INSERT into workspaces using DEFAULT company_id='default' succeeds
 *      without a foreign-key violation (the bug that caused HTTP 500 on every
 *      fresh install).
 *   3. Running migration 064 a second time (simulated) does NOT error or
 *      duplicate the row (INSERT OR IGNORE is idempotent).
 *
 * Uses the same tmp-DB pattern as other unit tests in this suite.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ws-company-fk-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

test.before(async () => {
  // Importing db triggers DB init + all migrations, including 064.
  const db = await import('../../src/lib/db') as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
});

// ── Test 1: companies sentinel row exists after migration 064 ─────────────────
test('[BUG 4] migration 064: sentinel companies row id=default exists on fresh DB', () => {
  const row = queryOne<{ id: string; slug: string }>(
    "SELECT id, slug FROM companies WHERE id = 'default'", []
  );
  assert.ok(
    row,
    "companies row with id='default' must exist after migration 064 runs on a fresh DB"
  );
  assert.strictEqual(row!.slug, 'default', "sentinel row slug must be 'default'");
});

// ── Test 2: INSERT into workspaces with DEFAULT company_id succeeds ───────────
test('[BUG 4] INSERT into workspaces with DEFAULT company_id does not throw FK violation', () => {
  const id = `ws-fk-test-${Date.now()}`;
  let threw = false;
  let errMsg = '';
  try {
    run(
      `INSERT INTO workspaces (id, name, slug, description, icon)
       VALUES (?, ?, ?, NULL, '📁')`,
      [id, 'Test Workspace FK', `test-ws-fk-${Date.now()}`]
    );
  } catch (err) {
    threw = true;
    errMsg = (err as Error).message;
  }
  assert.ok(
    !threw,
    `INSERT with DEFAULT company_id must not throw (BUG 4 regression). Error was: ${errMsg}`
  );
  const ws = queryOne<{ id: string; company_id: string }>(
    'SELECT id, company_id FROM workspaces WHERE id = ?', [id]
  );
  assert.ok(ws, 'workspace row must be findable after insert');
  assert.strictEqual(
    ws!.company_id,
    'default',
    "company_id must be 'default' (from column DEFAULT)"
  );
});

// ── Test 3: idempotent — inserting sentinel twice does not error ──────────────
test('[BUG 4] migration 064 sentinel seed is idempotent (INSERT OR IGNORE)', () => {
  // Simulate a second run of the migration by re-running the INSERT OR IGNORE.
  // This must not throw and must not create a second row.
  let threw = false;
  try {
    run(
      `INSERT OR IGNORE INTO companies (id, name, slug, config)
       VALUES ('default', 'Default', 'default', '{}')`,
      []
    );
  } catch (err) {
    threw = true;
  }
  assert.ok(!threw, 'Second INSERT OR IGNORE for sentinel row must not throw');

  const { count } = queryOne<{ count: number }>(
    "SELECT COUNT(*) as count FROM companies WHERE id = 'default'", []
  )!;
  assert.strictEqual(count, 1, "Exactly one sentinel row must exist after two inserts");
});

test.after(() => {
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch { /* best-effort */ }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch { /* best-effort */ }
});
