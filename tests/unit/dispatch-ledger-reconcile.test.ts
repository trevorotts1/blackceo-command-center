/**
 * v5.16.2 — the migration-ledger-lie regression suite (DATA-01).
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * The migration runner records a migration "applied" by its id ALONE
 * (_migrations.id; see the DATA-03 duplicate-id guard). Migrations 077
 * (dispatch_attempts / last_dispatch_attempt_at / next_dispatch_eligible_at +
 * idx_tasks_next_dispatch_eligible) and 078 (block_reason) each add their columns
 * INSIDE a `if (!cols.includes(x))` guard. On any box where id '077'/'078' was
 * recorded applied while the column was ABSENT, the guarded ALTER is skipped
 * FOREVER: the ledger says "applied", the box climbs to HEAD and reports healthy,
 * but the columns never existed. Every dispatch/board tick then throws
 * "no such column: t.dispatch_attempts" (intake-advance-sweep.ts:104) and task
 * dispatch is SILENTLY DEAD. Confirmed live on a v5.16.1 box.
 *
 * Fixing 077/078 in place can NEVER reach such a box (the id is already applied) —
 * only a NEW migration can. Migration 097 reconciles it by inspecting the LIVE
 * schema (never the ledger) and adding whatever is genuinely missing.
 *
 * This suite reproduces the exact field shape — the _migrations ledger claims
 * 077/078 applied while their columns are absent — proves the runner does NOT
 * self-heal it before 097, that 097 heals it, that it is a no-op on a healthy DB,
 * and that scripts/cc-schema-health.ts tells a truly-healed box from a falsely-
 * healed one. It drives the REAL boot path in a subprocess (never imports a
 * project module in-process), mirroring db-upgrade-migration-ordering.test.ts.
 */

// C8 GUARD: keep this suite off the shared mission-control.db even if a future
// edit pulls a project module in-process. It uses explicit temp DATABASE_PATHs.
import './_isolated-db';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const REPO = path.resolve(__dirname, '../..');
const MIGRATE_ENTRY = path.join(REPO, 'src/lib/db/migrate.ts');
const HEALTH_SCRIPT = path.join(REPO, 'scripts/cc-schema-health.ts');

/** The four tasks columns migrations 077/078 own — dead if the ledger lies. */
const DISPATCH_COLUMNS = [
  'dispatch_attempts',
  'last_dispatch_attempt_at',
  'next_dispatch_eligible_at',
  'block_reason',
];
const DISPATCH_INDEX = 'idx_tasks_next_dispatch_eligible';

function tmpDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-ledger-${label}-`));
  return path.join(dir, 'mission-control.db');
}

/** Run the REAL boot path (`db:push` -> migrate.ts -> getDb() -> exec(schema) +
 *  runMigrations()) against dbPath in a subprocess. Throws if boot fails. */
function boot(dbPath: string): string {
  return execFileSync(process.execPath, ['--import', 'tsx', MIGRATE_ENTRY], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'test' },
    timeout: 180_000,
  });
}

/** Run scripts/cc-schema-health.ts against dbPath; return its exit code + output. */
function runHealthScript(dbPath: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', HEALTH_SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'test' },
      timeout: 60_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

function tasksColumns(db: Database.Database): Set<string> {
  return new Set((db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name));
}
function indexExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);
}
function ledgerHas(db: Database.Database, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM _migrations WHERE id=?').get(id);
}
function headMigration(db: Database.Database): string {
  return (db.prepare('SELECT id FROM _migrations ORDER BY CAST(id AS INTEGER) DESC, id DESC LIMIT 1').get() as
    | { id: string }
    | undefined)?.id ?? '(none)';
}

/**
 * Corrupt a healthy DB into the exact FALSELY-HEALED field shape: the ledger
 * still records 077/078 (and everything up to 096) applied, but the four columns
 * they own — and their index — are gone, and 097 is pending again. This is a box
 * that "climbed to 096, reports healthy" while dispatch is dead. Nothing here
 * runs project code; it is raw SQL on a throwaway handle.
 */
function corruptToFalselyHealed(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec('PRAGMA foreign_keys=OFF');
  // Drop the index first (DROP COLUMN fails while a column is indexed).
  db.exec(`DROP INDEX IF EXISTS ${DISPATCH_INDEX}`);
  for (const col of DISPATCH_COLUMNS) db.exec(`ALTER TABLE tasks DROP COLUMN ${col}`);
  // Make 097 pending again, but LEAVE 077 & 078 recorded (the ledger lie).
  db.exec("DELETE FROM _migrations WHERE id='097'");
  db.exec('PRAGMA foreign_keys=ON');
  db.close();
}

// ---------------------------------------------------------------------------
// The full lifecycle: fresh -> corrupt to field shape -> fail-before -> heal ->
// pass-after -> no-op on healthy.
// ---------------------------------------------------------------------------
test('DATA-01 ledger-lie: 097 reconciles a box whose ledger claims 077/078 applied while their columns are absent', () => {
  const dbPath = tmpDbPath('lifecycle');

  // A fresh install is fully healthy and reaches head 098 (P1-04 added migration
  // 098; the ledger-lie behaviour under test is still owned by migration 097).
  assert.doesNotThrow(() => boot(dbPath), 'fresh install must boot clean');
  {
    const db = new Database(dbPath);
    assert.equal(headMigration(db), '098', 'fresh install must reach the head migration');
    const cols = tasksColumns(db);
    for (const c of DISPATCH_COLUMNS) assert.ok(cols.has(c), `fresh install must have tasks.${c}`);
    assert.ok(indexExists(db, DISPATCH_INDEX), `fresh install must have ${DISPATCH_INDEX}`);
    db.close();
  }

  // Reproduce the field bug: ledger says 077/078 applied, columns gone, 097 pending.
  corruptToFalselyHealed(dbPath);

  // ---- FAIL-BEFORE: the falsely-healed state ----
  {
    const db = new Database(dbPath);
    assert.ok(ledgerHas(db, '077'), 'precondition: _migrations must still record 077 applied');
    assert.ok(ledgerHas(db, '078'), 'precondition: _migrations must still record 078 applied');
    assert.ok(!ledgerHas(db, '097'), 'precondition: 097 must be pending again');
    // The ledger still records everything up to head (096 + the later additive 098)
    // while 097's dispatch columns are gone — the box "looks healthy" by ledger id
    // yet dispatch is dead. (P1-04 added 098; corruptToFalselyHealed removes only
    // 097, so the reported head is now the additive 098, an even stronger lie.)
    assert.equal(headMigration(db), '098', 'precondition: the box reports a high head (looks healthy)');

    const cols = tasksColumns(db);
    for (const c of DISPATCH_COLUMNS) {
      assert.ok(!cols.has(c), `precondition: tasks.${c} must be ABSENT (the ledger lie)`);
    }

    // The exact dispatch read the board runs every tick (intake-advance-sweep.ts:104)
    // throws on a falsely-healed box — this is why dispatch is silently dead.
    assert.throws(
      () => db.prepare('SELECT t.id FROM tasks t WHERE (t.dispatch_attempts IS NULL OR t.dispatch_attempts < 5)').all(),
      /no such column: t\.dispatch_attempts/,
      'the intake-advance query must fail with "no such column: t.dispatch_attempts" before the reconcile',
    );
    db.close();
  }

  // The health SCRIPT (the operator command) flags the falsely-healed box.
  {
    const { code, out } = runHealthScript(dbPath);
    assert.equal(code, 1, `cc-schema-health.ts must exit 1 on a falsely-healed box\n${out}`);
    assert.match(out, /FALSELY-HEALED/, 'health script must name the box FALSELY-HEALED');
    assert.match(out, /077, 078/, 'health script must name the ledger-lie migration ids 077, 078');
  }

  // ---- RUN THE REAL RUNNER: 097 (pending) heals it ----
  const bootOut = boot(dbPath);
  assert.match(bootOut, /Migration 097/, 'boot output must show migration 097 running');

  // ---- PASS-AFTER: the box is genuinely healed ----
  {
    const db = new Database(dbPath);
    assert.ok(ledgerHas(db, '097'), '097 must be recorded after the heal');
    const cols = tasksColumns(db);
    for (const c of DISPATCH_COLUMNS) {
      assert.ok(cols.has(c), `after reconcile tasks.${c} must EXIST (restored by 097, NOT by a 077/078 retry — those were already in the ledger)`);
    }
    assert.ok(indexExists(db, DISPATCH_INDEX), `after reconcile ${DISPATCH_INDEX} must exist`);
    assert.doesNotThrow(
      () => db.prepare('SELECT t.id FROM tasks t WHERE (t.dispatch_attempts IS NULL OR t.dispatch_attempts < 5)').all(),
      'the intake-advance query must succeed after the reconcile',
    );
    db.close();
  }

  // The health SCRIPT now reports HEALTHY.
  {
    const { code, out } = runHealthScript(dbPath);
    assert.equal(code, 0, `cc-schema-health.ts must exit 0 on a healed box\n${out}`);
    assert.match(out, /HEALTHY/, 'health script must report HEALTHY after the reconcile');
  }

  // ---- NO-OP ON HEALTHY: booting a healthy box again changes nothing ----
  assert.doesNotThrow(() => boot(dbPath), 'a second boot on a healthy box must be a clean no-op');
  {
    const db = new Database(dbPath);
    assert.equal(headMigration(db), '098', 'head stays at the head migration (no duplicate row / no error)');
    const n097 = (db.prepare("SELECT COUNT(*) n FROM _migrations WHERE id='097'").get() as { n: number }).n;
    assert.equal(n097, 1, '097 must be recorded exactly once (idempotent)');
    db.close();
  }
});
