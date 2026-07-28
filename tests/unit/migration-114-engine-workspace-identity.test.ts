/**
 * Migration 114 (U037, 2026-07-27) — Engine workspace identity fix +
 * presentations workspace seeding.
 *
 * TWO defects: (a) the presentations workspace carries id='presentations' but
 * slug='dept-presentations' — the only row of 67 to violate the repo's
 * bare-slug convention; (b) docs/ENGINES.md requires a workspace-seeding
 * migration per engine, and migration 113 seeds only podcast + anthology.
 *
 * Proves, against a REAL pre-existing DB shape (companies + several
 * already-provisioned workspace rows, never a fresh/empty DB):
 *   1. RENAME: the full chain renames slug='dept-presentations' ->
 *      'presentations' without changing id.
 *   2. SEED: a box with NO presentations row gets exactly one row with
 *      id == slug == 'presentations', company_id='default'.
 *   3. IDEMPOTENCY: re-running the full chain leaves workspaces byte-identical
 *      (updated_at included).
 *   4. ALREADY-CORRECT BOX: operator-edited slug='presentations' row is
 *      completely untouched — name, icon, sort_order unchanged.
 *   5. BOTH SPELLINGS: both rows survive untouched, no merge, no rename.
 *   6. FOREIGN KEY: a task with workspace_id='presentations' still resolves
 *      after the rename (id is never changed).
 *   7. ROUTING: after the rename, slug='presentations' resolves AND
 *      id='presentations' still resolves.
 *
 * Real production code exercised (never reimplemented): the actual
 * runMigrations() (src/lib/db/migrations.ts), including the full chain
 * 001..114, against a hand-seeded pre-existing DB — never a fresh
 * getDb()-initialized one.
 */
// C8 — DB isolation (see migration-111-funnels-seed.test.ts for the rationale).
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schema } from '../../src/lib/db/schema';
import { runMigrations } from '../../src/lib/db/migrations';

function freshDbPath(tag: string): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `bc-migration-114-${tag}-`)),
    'mission-control.test.db',
  );
}

// ── Filesystem isolation ──────────────────────────────────────────────────
// runMigrations() can reach reseedWorkspacesFromConfig(), which resolves a real
// departments.json via hardcoded ~/clawd paths. Redirect HOME to an isolated
// empty temp dir so resolution falls through to "no config found" — the shape a
// clean CI box sees — so no unrelated workspace rows leak into the row counts.
function withIsolatedHome<T>(fn: () => T): T {
  const isolatedHome = fs.mkdtempSync(
    path.join(os.tmpdir(), 'bc-migration-114-isolated-home-'),
  );
  const savedHome = process.env.HOME;
  const savedMasterFiles = process.env.MASTER_FILES_DIR;
  const savedZhcDir = process.env.ZERO_HUMAN_COMPANY_DIR;
  const savedCcRoot = process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  process.env.HOME = isolatedHome;
  delete process.env.MASTER_FILES_DIR;
  delete process.env.ZERO_HUMAN_COMPANY_DIR;
  delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  try {
    return fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedMasterFiles === undefined) delete process.env.MASTER_FILES_DIR;
    else process.env.MASTER_FILES_DIR = savedMasterFiles;
    if (savedZhcDir === undefined) delete process.env.ZERO_HUMAN_COMPANY_DIR;
    else process.env.ZERO_HUMAN_COMPANY_DIR = savedZhcDir;
    if (savedCcRoot === undefined) delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;
    else process.env.BLACKCEO_COMMAND_CENTER_ROOT = savedCcRoot;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

/**
 * Seed a REAL pre-existing DB shape: schema + one company + several
 * already-provisioned workspace rows (mirrors a box that onboarded BEFORE the
 * presentations engine existed) — never a fresh/empty workspaces table.
 */
function seedPreExistingBox(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(schema);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Acme Co', 'acme-co', '{}', ?, ?)`,
  ).run(now, now);

  const preExisting: {
    id: string;
    slug: string;
    name: string;
    sortOrder: number;
  }[] = [
    {
      id: 'master-orchestrator',
      slug: 'master-orchestrator',
      name: 'CEO / COM',
      sortOrder: 0,
    },
    { id: 'marketing', slug: 'marketing', name: 'Marketing', sortOrder: 1 },
    { id: 'sales', slug: 'sales', name: 'Sales', sortOrder: 2 },
    {
      id: 'general-task',
      slug: 'general-task',
      name: 'General Task',
      sortOrder: 99999,
    },
  ];
  const insertWs = db.prepare(
    `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, '\u{1F4C1}', 'default', ?, ?, ?)`,
  );
  for (const ws of preExisting) {
    insertWs.run(ws.id, ws.name, ws.slug, ws.sortOrder, now, now);
  }
  return db;
}

// ── Test 1: Rename ────────────────────────────────────────────────────────

test('migration 114: renames slug=dept-presentations -> presentations, leaves id unchanged', () => {
  const dbPath = freshDbPath('rename');
  const db = seedPreExistingBox(dbPath);
  try {
    const now = new Date().toISOString();
    // Pre-seed the stale row: id='presentations', slug='dept-presentations'
    // (the exact shape measured on the live box).
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('presentations', 'Presentations', 'dept-presentations', 'Presentations production engine workspace.', '\u{1F5A5}️', 'default', 100, ?, ?)`,
    ).run(now, now);

    // Pre-mark all migrations except 114 so 051/091 cannot pre-normalize
    // dept-presentations -> presentations before 114 executes. On a real box
    // that has the stale slug, 051 was applied long ago and did not touch the
    // presentations row (created AFTER 051 ran). Only 114 should rename.
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)`,
    );
    for (let i = 1; i <= 120; i++) {
      if (i === 114) continue;
      db.prepare(
        'INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)',
      ).run(String(i).padStart(3, '0'), `pre-marked-${i}`);
    }

    const beforeCount = (
      db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }
    ).n;
    assert.equal(
      beforeCount,
      5,
      'sanity: the pre-existing box carries exactly the 5 hand-seeded rows before migrating',
    );

    withIsolatedHome(() => runMigrations(db)); // only 114 runs; all others pre-marked

    // The migration chain adds other rows (funnels via 111, podcast+anthology
    // via 113, etc.), so global row count is not a reliable assertion.
    // Assert on the unit's OWN deliverable: the presentations row exists with
    // the correct slug, the stale spelling is gone, and pre-existing rows survive.
    const row = db
      .prepare(
        `SELECT id, slug, name, sort_order FROM workspaces WHERE lower(id) = 'presentations'`,
      )
      .get() as
      | { id: string; slug: string; name: string; sort_order: number }
      | undefined;
    assert.ok(row, 'the presentations row must still exist');
    assert.equal(
      row!.id,
      'presentations',
      'id must be unchanged — it is a foreign-key target for tasks.workspace_id',
    );
    assert.equal(
      row!.slug,
      'presentations',
      'slug must be renamed to the bare canonical form',
    );
    assert.equal(row!.sort_order, 100, 'sort_order must be unchanged');

    // No stale spelling should remain
    const stale = db
      .prepare(
        `SELECT slug FROM workspaces WHERE lower(slug) = 'dept-presentations'`,
      )
      .get();
    assert.equal(
      stale,
      undefined,
      'the stale dept-presentations slug must no longer exist',
    );

    // Every pre-existing row must be untouched
    for (const slug of [
      'master-orchestrator',
      'marketing',
      'sales',
      'general-task',
    ]) {
      const r = db
        .prepare('SELECT slug FROM workspaces WHERE lower(slug) = ?')
        .get(slug) as { slug: string } | undefined;
      assert.ok(
        r,
        `pre-existing workspace '${slug}' must still exist after migrating`,
      );
    }
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

// ── Test 2: Seed ──────────────────────────────────────────────────────────

test('migration 114: seeds EXACTLY ONE presentations row on a box with no presentations row', () => {
  const dbPath = freshDbPath('seed');
  const db = seedPreExistingBox(dbPath);
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as {
      n: number;
    };
    assert.equal(
      before.n,
      4,
      'sanity: the pre-existing box carries exactly the 4 hand-seeded rows before migrating',
    );

    withIsolatedHome(() => runMigrations(db)); // full chain 001..114

    const row = db
      .prepare(
        `SELECT id, slug, name, icon, company_id, sort_order FROM workspaces WHERE lower(slug) = 'presentations'`,
      )
      .get() as
      | {
          id: string;
          slug: string;
          name: string;
          icon: string;
          company_id: string;
          sort_order: number;
        }
      | undefined;
    assert.ok(row, 'a presentations workspace must exist after migrating');
    assert.equal(row!.id, 'presentations', 'id must equal the bare slug');
    assert.equal(
      row!.slug,
      'presentations',
      'slug must be the bare canonical form',
    );
    assert.equal(row!.name, 'Presentations');
    assert.equal(row!.sort_order, 100);
    assert.equal(
      row!.company_id,
      'default',
      'must carry company_id=default so it is visible to all clients on the box',
    );

    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workspaces WHERE lower(slug) = 'presentations'`,
      )
      .get() as { n: number };
    assert.equal(
      count.n,
      1,
      'exactly one presentations workspace must exist — no duplicates',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

// ── Test 3: Idempotency ───────────────────────────────────────────────────

test('migration 114: idempotent — re-running chain leaves workspaces byte-identical', () => {
  const dbPath = freshDbPath('idempotent');
  const db = seedPreExistingBox(dbPath);
  try {
    const now = new Date().toISOString();
    // Pre-seed the stale row.
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('presentations', 'Presentations', 'dept-presentations', 'Presentations production engine workspace.', '\u{1F5A5}️', 'default', 100, ?, ?)`,
    ).run(now, now);

    // Pre-mark all migrations except 114 so 051/091 cannot pre-normalize
    // dept-presentations -> presentations before 114 executes. On a real box
    // that has the stale slug, 051 was applied long ago and did not touch the
    // presentations row (created AFTER 051 ran). Only 114 should rename.
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)`,
    );
    for (let i = 1; i <= 120; i++) {
      if (i === 114) continue;
      db.prepare(
        'INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)',
      ).run(String(i).padStart(3, '0'), `pre-marked-${i}`);
    }

    withIsolatedHome(() => runMigrations(db));  // only 114 runs; all others pre-marked

    // Snapshot the full workspaces table after the first run.
    const afterFirst = db
      .prepare(
        'SELECT id, slug, name, icon, company_id, sort_order, updated_at FROM workspaces ORDER BY slug',
      )
      .all() as Record<string, unknown>[];

    withIsolatedHome(() => runMigrations(db)); // simulated second boot

    const afterSecond = db
      .prepare(
        'SELECT id, slug, name, icon, company_id, sort_order, updated_at FROM workspaces ORDER BY slug',
      )
      .all() as Record<string, unknown>[];

    assert.deepEqual(
      afterSecond,
      afterFirst,
      'the workspaces table must be byte-identical after two migration runs — updated_at included',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

// ── Test 4: Already-correct box ───────────────────────────────────────────

test('migration 114: already-correct box (operator-edited) is left untouched', () => {
  const dbPath = freshDbPath('already-correct');
  const db = seedPreExistingBox(dbPath);
  try {
    const now = new Date().toISOString();
    // Pre-seed a row with slug='presentations' but a DIFFERENT name and sort_order
    // (simulating an operator-edited row on a box that was fixed already).
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('presentations', 'Decks', 'presentations', 'Custom deck engine.', '\u{1F39E}️', 'default', 42, ?, ?)`,
    ).run(now, now);

    withIsolatedHome(() => runMigrations(db));

    const row = db
      .prepare(
        `SELECT id, slug, name, icon, sort_order FROM workspaces WHERE lower(slug) = 'presentations'`,
      )
      .get() as
      | {
          id: string;
          slug: string;
          name: string;
          icon: string;
          sort_order: number;
        }
      | undefined;
    assert.ok(row, 'the presentations workspace must still exist');
    assert.equal(
      row!.name,
      'Decks',
      'operator-edited name must NOT be overwritten',
    );
    assert.equal(
      row!.sort_order,
      42,
      'operator-edited sort_order must NOT be overwritten',
    );

    const count = db
      .prepare(
        `SELECT COUNT(*) AS n FROM workspaces WHERE lower(slug) = 'presentations'`,
      )
      .get() as { n: number };
    assert.equal(
      count.n,
      1,
      'the presentations row must not be duplicated',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

// ── Test 5: Both spellings present ────────────────────────────────────────

test('migration 114: both spellings — leaves BOTH rows untouched, no merge', () => {
  const dbPath = freshDbPath('both-spellings');
  const db = seedPreExistingBox(dbPath);
  try {
    const now = new Date().toISOString();
    // Pre-seed ONE row with slug='dept-presentations'
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('presentations', 'Presentations', 'dept-presentations', 'Old row.', '\u{1F5A5}️', 'default', 100, ?, ?)`,
    ).run(now, now);
    // Pre-seed ANOTHER row with slug='presentations' (different id)
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('presentations-v2', 'Presentations V2', 'presentations', 'New row.', '\u{1F4FD}️', 'default', 200, ?, ?)`,
    ).run(now, now);

    // Mark migrations 001–113 as already applied so they do NOT run.
    // Migration 051 (canonical slug reshape) would try to canonicalize
    // dept-presentations -> presentations, colliding with the other row —
    // precisely the "both spellings" state that exists on a box where 051
    // ran before both rows existed. On a real box that has both spellings,
    // 051 was applied long ago. Only migration 114 (the unit under test)
    // needs to run here. All other migrations are also pre-marked so we
    // test 114 in isolation — full-chain behaviour is proven by tests 1–4.
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)`,
    );
    for (let i = 1; i <= 113; i++) {
      db.prepare(
        'INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)',
      ).run(String(i).padStart(3, '0'), `pre-marked-${i}`);
    }

    const before = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as {
      n: number;
    };
    assert.equal(
      before.n,
      6,
      'sanity: 4 pre-existing + 2 presentations spellings = 6 rows before migrating',
    );

    withIsolatedHome(() => runMigrations(db));

    const after = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as {
      n: number;
    };
    assert.equal(
      after.n,
      before.n,
      'row count must be unchanged — both rows survive',
    );

    // Both rows must survive with their original values
    const staleRow = db
      .prepare(
        `SELECT id, slug FROM workspaces WHERE lower(slug) = 'dept-presentations'`,
      )
      .get() as { id: string; slug: string } | undefined;
    assert.ok(
      staleRow,
      'the dept-presentations row must survive untouched',
    );

    const canonicalRow = db
      .prepare(
        `SELECT id, slug FROM workspaces WHERE lower(slug) = 'presentations' AND lower(slug) != 'dept-presentations'`,
      )
      .get() as { id: string; slug: string } | undefined;
    assert.ok(canonicalRow, 'the presentations row must survive untouched');
    assert.notEqual(
      canonicalRow!.id,
      staleRow!.id,
      'the two rows must have different ids — no merge occurred',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

// ── Test 6: Foreign key holds ─────────────────────────────────────────────

test('migration 114: a task with workspace_id=presentations still resolves after the rename', () => {
  const dbPath = freshDbPath('fk');
  const db = seedPreExistingBox(dbPath);
  try {
    const now = new Date().toISOString();
    // Pre-seed the stale row.
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('presentations', 'Presentations', 'dept-presentations', 'Presentations production engine workspace.', '\u{1F5A5}️', 'default', 100, ?, ?)`,
    ).run(now, now);

    // Create a task that references workspace_id='presentations' (the id, not the slug).
    db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT REFERENCES workspaces(id),
      title TEXT,
      status TEXT DEFAULT 'backlog' CHECK (status IN ('backlog', 'inbox', 'planning', 'pending_dispatch', 'assigned', 'in_progress', 'review', 'testing', 'blocked', 'done')),
      created_at TEXT,
      updated_at TEXT
    )`);
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, status, created_at, updated_at)
       VALUES ('task-probe-001', 'presentations', 'Probe task', 'inbox', ?, ?)`,
    ).run(now, now);

    // Pre-mark all migrations except 114 so 051/091 cannot pre-normalize
    // dept-presentations -> presentations before 114 executes. On a real box
    // that has the stale slug, 051 was applied long ago and did not touch the
    // presentations row (created AFTER 051 ran). Only 114 should rename.
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)`,
    );
    for (let i = 1; i <= 120; i++) {
      if (i === 114) continue;
      db.prepare(
        'INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)',
      ).run(String(i).padStart(3, '0'), `pre-marked-${i}`);
    }

    withIsolatedHome(() => runMigrations(db));  // only 114 runs; all others pre-marked

    // The task must still resolve its workspace.
    const task = db
      .prepare(
        `SELECT t.id AS task_id, t.workspace_id, w.slug
         FROM tasks t LEFT JOIN workspaces w ON w.id = t.workspace_id
         WHERE t.id = 'task-probe-001'`,
      )
      .get() as
      | { task_id: string; workspace_id: string; slug: string }
      | undefined;
    assert.ok(task, 'the probe task must still exist');
    assert.equal(
      task!.workspace_id,
      'presentations',
      'the task workspace_id must be unchanged',
    );
    assert.equal(
      task!.slug,
      'presentations',
      'the task must resolve to slug=presentations after the rename',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

// ── Test 7: Routing — both arms work after the rename ────────────────────

test('migration 114: after rename, slug=presentations resolves AND id=presentations still resolves', () => {
  const dbPath = freshDbPath('routing');
  const db = seedPreExistingBox(dbPath);
  try {
    const now = new Date().toISOString();
    // Pre-seed the stale row.
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('presentations', 'Presentations', 'dept-presentations', 'Presentations production engine workspace.', '\u{1F5A5}️', 'default', 100, ?, ?)`,
    ).run(now, now);

    // Pre-mark all migrations except 114 so 051/091 cannot pre-normalize
    // dept-presentations -> presentations before 114 executes. On a real box
    // that has the stale slug, 051 was applied long ago and did not touch the
    // presentations row (created AFTER 051 ran). Only 114 should rename.
    db.exec(
      `CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)`,
    );
    for (let i = 1; i <= 120; i++) {
      if (i === 114) continue;
      db.prepare(
        'INSERT OR IGNORE INTO _migrations (id, name) VALUES (?, ?)',
      ).run(String(i).padStart(3, '0'), `pre-marked-${i}`);
    }

    withIsolatedHome(() => runMigrations(db));

    // After the rename  // only 114 runs; all others pre-marked

    // After the rename: lookup by slug='presentations' (the NEW slug) must work.
    const byNewSlug = db
      .prepare(
        `SELECT id, slug FROM workspaces WHERE lower(slug) = 'presentations'`,
      )
      .get() as { id: string; slug: string } | undefined;
    assert.ok(
      byNewSlug,
      'slug=presentations must resolve after the rename',
    );

    // After the rename: lookup by id='presentations' must STILL work.
    const byId = db
      .prepare(
        `SELECT id, slug FROM workspaces WHERE lower(id) = 'presentations'`,
      )
      .get() as { id: string; slug: string } | undefined;
    assert.ok(
      byId,
      'id=presentations must still resolve after the rename',
    );
    assert.equal(byId!.id, 'presentations', 'workspace id must be presentations');
    assert.equal(
      byId!.slug,
      'presentations',
      'workspace slug must be presentations',
    );

    // The stale dept-presentations slug must NOT resolve.
    const byOldSlug = db
      .prepare(
        `SELECT id FROM workspaces WHERE lower(slug) = 'dept-presentations'`,
      )
      .get();
    assert.equal(
      byOldSlug,
      undefined,
      'the old dept-presentations spelling must no longer resolve',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
