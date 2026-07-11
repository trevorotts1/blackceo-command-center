/**
 * v5.16.1 — the migration-deadlock regression suite.
 *
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------
 * src/lib/db/index.ts getDb() boots the database in exactly this order:
 *
 *     handle.exec(schema);      // index.ts:61  <- base schema DDL
 *     runMigrations(handle);    // index.ts:69  <- migrations
 *
 * The base schema runs FIRST. On an EXISTING database every
 * `CREATE TABLE IF NOT EXISTS` in schema.ts is a no-op, so the table keeps its
 * OLD column set. If schema.ts also contains a `CREATE INDEX` on a column that a
 * migration only ALTERs in later, that index throws "no such column" — and
 * because better-sqlite3's db.exec() aborts the ENTIRE script at the first
 * failing statement, the DB layer never comes up. Boot fail-closes, /api/health
 * reports 503, and the migration that would have added the column can never run.
 *
 * That is a DEADLOCK, not a crash: the box cannot upgrade its way out, because
 * the fix ships inside the very migration the broken boot prevents from running.
 *
 * v5.14.0 shipped exactly that (`CREATE INDEX idx_workspaces_archived_at ON
 * workspaces(archived_at)` in schema.ts vs `ALTER TABLE workspaces ADD COLUMN
 * archived_at` in migration 095). Verified against a database built from every
 * tag in this repo's history: EVERY version from v3.2.0 through v5.13.0 — 135 of
 * 138 tags — was unable to boot v5.16.0. Only boxes already at migration 095
 * (v5.14.0+) or fresh installs came up, which is why it survived release: nothing
 * ever tested upgrading a real old database.
 *
 * WHAT DOES AND DOES NOT DEADLOCK (verified against SQLite directly)
 *   CREATE INDEX on a missing column          -> THROWS   (deadlock vector)
 *   CREATE UNIQUE INDEX on a missing column   -> THROWS   (deadlock vector)
 *   partial INDEX with WHERE <missing column> -> THROWS   (deadlock vector)
 *   CREATE TRIGGER referencing a missing col  -> succeeds (SQLite resolves lazily)
 *   CREATE VIEW referencing a missing column  -> succeeds (SQLite resolves lazily)
 * So the invariant below is scoped to indexes, which is the whole class.
 */

// C8 GUARD: FIRST import. This suite never imports @/lib/db in-process — it opens
// throwaway databases directly and drives the real boot path in a SUBPROCESS with an
// explicit DATABASE_PATH. But that boot runs migrations and auto-seeds departments, so
// if a future edit ever pulled a project module in here, an unset DATABASE_PATH would
// point the singleton at the LIVE mission-control.db in the repo root and write fixtures
// straight into a production board. Isolating unconditionally makes that impossible.
import './_isolated-db';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const REPO = path.resolve(__dirname, '../..');
const SCHEMA_TS = path.join(REPO, 'src/lib/db/schema.ts');
const MIGRATIONS_TS = path.join(REPO, 'src/lib/db/migrations.ts');
const MIGRATE_ENTRY = path.join(REPO, 'src/lib/db/migrate.ts');
const OLD_DB_FIXTURE = path.join(REPO, 'tests/fixtures/db-v4.72.0-era.sql');

/** The migration id every database must land on once fully upgraded. */
const HEAD_MIGRATION = '097';

/**
 * Every index the app creates anywhere (schema.ts + migrations.ts).
 * A database that has run every migration must have ALL of them — on the fresh
 * path AND the upgrade path. Two real defects hid here until v5.16.1:
 *   - an index created INSIDE a `if (column missing)` guard is never created on a
 *     fresh install (schema.ts already declared the column, so the guard skips) —
 *     idx_tasks_qc_reroute was missing on EVERY box in the fleet this way;
 *   - a 12-step rebuild that drops a table destroys its indexes; if it does not
 *     replay them they are gone (migration 034 vs idx_agents_workspace).
 * Both were masked because schema.ts re-issued CREATE INDEX on every getDb().
 */
function expectedIndexNames(): Set<string> {
  const names = new Set<string>();
  for (const file of [SCHEMA_TS, MIGRATIONS_TS]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\n?\s*ON\s/gi,
    )) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Index names actually present in `db`, excluding SQLite's internal auto-indexes. */
function actualIndexNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function assertNoMissingIndexes(db: Database.Database, label: string): void {
  const missing = [...expectedIndexNames()].filter((n) => !actualIndexNames(db).has(n)).sort();
  assert.deepEqual(
    missing,
    [],
    `${label}: the database is missing ${missing.length} index(es) that the code creates: ${missing.join(', ')}\n` +
      `  An index is missing when it is created inside a column-absence guard (skipped on fresh installs)\n` +
      `  or when a table rebuild dropped it without replaying it. Create it unconditionally, and back-fill\n` +
      `  existing boxes with a NEW migration — fixing the old migration in place can never reach a box that\n` +
      `  already recorded it as applied.`,
  );
}

function tmpDbPath(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cc-dbtest-${label}-`));
  return path.join(dir, 'mission-control.db');
}

/**
 * Run the REAL boot path a client box runs (`npm run db:push` -> migrate.ts ->
 * getDb() -> exec(schema) + runMigrations()) against `dbPath`, in a subprocess so
 * each scenario gets a clean module registry and the getDb() singleton is not
 * shared between tests. Returns combined output; throws if the boot fails.
 */
function boot(dbPath: string): string {
  return execFileSync(
    process.execPath,
    ['--import', 'tsx', MIGRATE_ENTRY],
    {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_PATH: dbPath, NODE_ENV: 'test' },
      timeout: 120_000,
    },
  );
}

// ---------------------------------------------------------------------------
// 1. THE INVARIANT — the static check that would have caught this at author time
// ---------------------------------------------------------------------------
test('schema.ts never indexes a column that a migration ALTER-adds (deadlock class)', () => {
  const schemaSrc = fs.readFileSync(SCHEMA_TS, 'utf8');
  const migrationsSrc = fs.readFileSync(MIGRATIONS_TS, 'utf8');

  // Every column any migration adds via ALTER TABLE ... ADD COLUMN.
  // These columns DO NOT EXIST on an existing database until that migration runs,
  // and schema.ts runs before all migrations.
  const migrationAdded = new Set<string>();
  for (const m of migrationsSrc.matchAll(
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi,
  )) {
    migrationAdded.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  }
  assert.ok(
    migrationAdded.size > 0,
    'parsed zero ALTER TABLE ADD COLUMN out of migrations.ts — the parser is broken, not the code',
  );

  // Strip SQL line comments so the explanatory notes in schema.ts (which name the
  // very indexes we moved out) are not mistaken for live DDL.
  const schemaSql = schemaSrc
    .slice(schemaSrc.indexOf('`') + 1, schemaSrc.lastIndexOf('`'))
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const violations: string[] = [];
  // CREATE [UNIQUE] INDEX <name> ON <table>(<cols>) [WHERE <predicate>]
  for (const m of schemaSql.matchAll(
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)([^;]*)/gi,
  )) {
    const [, idxName, table, colList, tail] = m;
    // Indexed columns, plus any column named in a partial-index WHERE clause —
    // both are resolved by SQLite at CREATE INDEX time and both throw.
    const cols = colList
      .split(',')
      .map((c) => c.trim().split(/\s+/)[0].replace(/["'`\[\]]/g, ''))
      .filter(Boolean);
    for (const w of tail.matchAll(/\b(\w+)\b/g)) cols.push(w[1]);

    for (const col of cols) {
      const key = `${table.toLowerCase()}.${col.toLowerCase()}`;
      if (migrationAdded.has(key)) {
        violations.push(
          `  ${idxName}: schema.ts indexes ${key}, but ${key} is ALTER-added by a migration.\n` +
            `    schema.ts runs BEFORE migrations -> this bricks every database predating that migration.\n` +
            `    FIX: delete the index from schema.ts and create it UNCONDITIONALLY inside the migration that adds the column.`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    `\nMIGRATION DEADLOCK — schema.ts indexes column(s) that migrations add later:\n${violations.join('\n')}\n`,
  );
});

// ---------------------------------------------------------------------------
// 2. THE UPGRADE TEST — a REAL old database, the one that was never tested
// ---------------------------------------------------------------------------
test('upgrade: a v4.72.0-era database (migrations stopped at 090) boots clean and applies 091-095', () => {
  const dbPath = tmpDbPath('upgrade');

  // Build the genuine old database from the repo's own history (see the fixture
  // header — it is a `.schema` dump of a database built by tag v4.72.0's own code,
  // never copied from a client box).
  const old = new Database(dbPath);
  old.exec(fs.readFileSync(OLD_DB_FIXTURE, 'utf8'));

  // Precondition: this really is the broken shape the fleet is stuck on.
  const wsCols = () =>
    (old.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(!wsCols().includes('archived_at'), 'fixture precondition: workspaces.archived_at must be ABSENT');
  assert.ok(
    (old.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).some((c) => c.name === 'archived_at'),
    'fixture precondition: tasks.archived_at must be PRESENT (migration 058 ran)',
  );
  const lastBefore = old.prepare('SELECT id FROM _migrations ORDER BY id DESC LIMIT 1').get() as { id: string };
  assert.equal(lastBefore.id, '090', 'fixture precondition: last applied migration must be 090');

  // Seed real rows so we can prove the upgrade PRESERVES data (archiving is soft).
  old.exec(`
    INSERT INTO companies (id, name, slug) VALUES ('c1', 'Acme', 'acme');
    INSERT INTO workspaces (id, name, slug, company_id) VALUES
      ('w1', 'Marketing', 'marketing', 'c1'),
      ('w2', 'Sales', 'sales', 'c1');
    INSERT INTO tasks (id, title, status, workspace_id) VALUES
      ('t1', 'Ship the thing', 'backlog', 'w1'),
      ('t2', 'Close the deal', 'done', 'w2');
  `);
  old.close();

  // THE ASSERTION THAT FAILED BEFORE THE FIX:
  // pre-fix this throws `SqliteError: no such column: archived_at` at
  // getDb (src/lib/db/index.ts:61) and the process exits non-zero.
  assert.doesNotThrow(() => boot(dbPath), 'an old database must boot the current code without throwing');

  const db = new Database(dbPath);

  // Migrations 091-096 actually ran.
  const lastAfter = db.prepare('SELECT id FROM _migrations ORDER BY id DESC LIMIT 1').get() as { id: string };
  assert.equal(lastAfter.id, HEAD_MIGRATION, `expected the upgraded database to reach migration ${HEAD_MIGRATION}`);
  for (const id of ['091', '092', '093', '094', '095', '096', '097']) {
    const row = db.prepare('SELECT id FROM _migrations WHERE id = ?').get(id);
    assert.ok(row, `migration ${id} must have been applied by the upgrade`);
  }

  // Migration 096 back-filled every index the fleet was silently missing.
  assertNoMissingIndexes(db, 'upgraded v4.72.0-era database');

  // Migration 095 did its job: the columns AND the index exist.
  const cols = (db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('archived_at'), 'workspaces.archived_at must exist after upgrade');
  assert.ok(cols.includes('archived_reason'), 'workspaces.archived_reason must exist after upgrade');
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_workspaces_archived_at'")
    .get();
  assert.ok(idx, 'idx_workspaces_archived_at must be created by migration 095 (not by schema.ts)');

  // The board query the index exists for must actually run.
  assert.doesNotThrow(() => db.prepare('SELECT id FROM workspaces WHERE archived_at IS NULL').all());

  // The upgrade is non-destructive: every pre-existing row survived, un-archived.
  // (An exact COUNT would be wrong — boot also auto-seeds departments from config.
  // What matters is that the rows that were already there are still there.)
  for (const id of ['w1', 'w2']) {
    const ws = db.prepare('SELECT id, archived_at FROM workspaces WHERE id = ?').get(id) as
      | { id: string; archived_at: string | null }
      | undefined;
    assert.ok(ws, `pre-existing workspace ${id} must survive the upgrade`);
    assert.equal(ws.archived_at, null, `upgrade must not archive pre-existing workspace ${id}`);
  }
  for (const id of ['t1', 't2']) {
    assert.ok(
      db.prepare('SELECT id FROM tasks WHERE id = ?').get(id),
      `pre-existing task ${id} must survive the upgrade`,
    );
  }
  db.close();
});

// ---------------------------------------------------------------------------
// 3. FRESH INSTALL — do not fix the old path by breaking the new one
// ---------------------------------------------------------------------------
test('fresh install: a new database boots clean, reaches head, and has every index', () => {
  const dbPath = tmpDbPath('fresh');
  assert.ok(!fs.existsSync(dbPath), 'precondition: the database must not exist yet');

  assert.doesNotThrow(() => boot(dbPath), 'a fresh database must boot the current code without throwing');

  const db = new Database(dbPath);

  const last = db.prepare('SELECT id FROM _migrations ORDER BY id DESC LIMIT 1').get() as { id: string };
  assert.equal(last.id, HEAD_MIGRATION, `a fresh install must also reach migration ${HEAD_MIGRATION}`);

  const cols = (db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('archived_at'), 'fresh: workspaces.archived_at must exist (declared in schema.ts)');

  // These indexes were MOVED OUT of schema.ts into their migrations. A fresh
  // database must still end up with all of them — if a migration created its index
  // inside the "column is missing" guard, a fresh install (where schema.ts already
  // declared the column, so the guard is skipped) would silently never get it.
  for (const name of [
    'idx_workspaces_archived_at', // migration 095
    'idx_workspaces_company', // migration 012
    'idx_tasks_workspace', // migration 002
    'idx_agents_workspace', // migration 002 (destroyed by the 034 rebuild before v5.16.1)
    'idx_tasks_qc_reroute', // migration 061 (guard-skipped on fresh installs before v5.16.1)
  ]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
    assert.ok(row, `fresh install is missing index ${name} — a migration-owned index was not created unconditionally`);
  }

  // Nothing the code creates may be missing from a fresh install.
  assertNoMissingIndexes(db, 'fresh install');
  db.close();
});
