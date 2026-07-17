/**
 * Migration 110 (U118, 2026-07-16, operator ruling) — "funnels" department
 * workspace backfill.
 *
 * Operator ruling, verbatim: "THEN USE THE STANDALONE WORKSPACE IF IT
 * ALREADY EXISTS." Skill 6's 06-ghl-install-pages/tools/cc_board.py has
 * ALWAYS unconditionally stamped department_slug='funnels' for every
 * job_type='funnel' card; this migration is the one-time backfill that makes
 * every PRE-EXISTING box (not just a fresh install) resolve that stamp to a
 * real workspace instead of falling to general-task via INGEST-06.
 *
 * Proves, against a REAL pre-existing DB shape (companies + several
 * already-provisioned workspace rows — never a fresh/empty DB):
 *   1. Running the full migration chain inserts EXACTLY ONE new workspace row
 *      (the funnels department), leaving every existing row untouched.
 *   2. The inserted row carries slug='funnels', name='Funnels', and inherits
 *      company_id from an existing workspace (never a bare/undefined value).
 *   3. Idempotency: re-running the migration chain (simulating a reboot)
 *      inserts ZERO further rows — no duplicates.
 *   4. The "already exists" case the ruling names explicitly: a box that
 *      already carries an ad hoc 'funnels' workspace (seeded outside the
 *      floor, e.g. by hand — the operator's own box) is left COMPLETELY
 *      untouched (0 rows changed, 0 rows inserted) — the migration is a
 *      true no-op, never overwriting the operator's own customization.
 *
 * Real production code exercised (never reimplemented): the actual
 * runMigrations() (src/lib/db/migrations.ts), including the full chain
 * 001..110, against a hand-seeded pre-existing DB — never a fresh
 * getDb()-initialized one.
 */
// C8 — DB isolation. This file opens its OWN raw better-sqlite3 handles
// directly (never via the '@/lib/db' singleton), but runMigrations() pulls in
// helpers (seedStarterSOPs, branding-seed) that CAN reach the singleton
// internally. Import this first so DATABASE_PATH is redirected away from the
// live mission-control.db before anything else evaluates — enforced by
// tests/unit/c8-db-isolation-guard.test.ts.
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `bc-migration-110-${tag}-`)), 'mission-control.test.db');
}

// ── Filesystem isolation ──────────────────────────────────────────────────
// runMigrations() -> reseedWorkspacesFromConfig() resolves a real
// departments.json via zeroHumanCompanyRoots(), which includes the HARDCODED
// path.join(os.homedir(), 'clawd', 'zero-human-company') — no env-var gate.
// On a real operator box that directory can contain a REAL client's real
// departments.json, which would leak dozens of unrelated workspace rows into
// this test's row-count assertions (proven: it does, on this exact machine).
// HOME (which os.homedir() reads on POSIX) is redirected to an isolated empty
// temp dir for the duration of each test below so resolution always falls
// through to "no config found" — the same shape a clean CI box would see —
// regardless of what is actually on this machine's real ~/clawd.
function withIsolatedHome<T>(fn: () => T): T {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-migration-110-isolated-home-'));
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
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedMasterFiles === undefined) delete process.env.MASTER_FILES_DIR; else process.env.MASTER_FILES_DIR = savedMasterFiles;
    if (savedZhcDir === undefined) delete process.env.ZERO_HUMAN_COMPANY_DIR; else process.env.ZERO_HUMAN_COMPANY_DIR = savedZhcDir;
    if (savedCcRoot === undefined) delete process.env.BLACKCEO_COMMAND_CENTER_ROOT; else process.env.BLACKCEO_COMMAND_CENTER_ROOT = savedCcRoot;
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

/**
 * Seed a REAL pre-existing DB shape: schema + one company + several
 * already-provisioned workspace rows (mirrors a box that onboarded BEFORE
 * migration 110 ever existed) — never a fresh/empty workspaces table.
 */
function seedPreExistingBox(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(schema);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Acme Co', 'acme-co', '{}', ?, ?)`,
  ).run(now, now);

  const preExisting: { id: string; slug: string; name: string; sortOrder: number }[] = [
    { id: 'master-orchestrator', slug: 'master-orchestrator', name: 'CEO / COM', sortOrder: 0 },
    { id: 'marketing', slug: 'marketing', name: 'Marketing', sortOrder: 1 },
    { id: 'sales', slug: 'sales', name: 'Sales', sortOrder: 2 },
    { id: 'web-development', slug: 'web-development', name: 'Web Development', sortOrder: 3 },
    { id: 'general-task', slug: 'general-task', name: 'General Task', sortOrder: 99999 },
  ];
  const insertWs = db.prepare(
    `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, '📁', 'default', ?, ?, ?)`,
  );
  for (const ws of preExisting) {
    insertWs.run(ws.id, ws.name, ws.slug, ws.sortOrder, now, now);
  }
  return db;
}

test('migration 110: exactly ONE new workspace row on a real pre-existing DB shape (never a fresh DB)', () => {
  const dbPath = freshDbPath('backfill');
  const db = seedPreExistingBox(dbPath);
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    assert.equal(before.n, 5, 'sanity: the pre-existing box carries exactly the 5 hand-seeded rows before migrating');

    withIsolatedHome(() => runMigrations(db)); // the FULL chain 001..HEAD, including migration 110, against the pre-seeded rows.

    const after = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    assert.equal(after.n, before.n + 1, 'migration 110 must insert EXACTLY ONE new workspace row — no more, no fewer');

    const funnelsRow = db
      .prepare(`SELECT id, name, slug, company_id FROM workspaces WHERE lower(slug) = 'funnels'`)
      .get() as { id: string; name: string; slug: string; company_id: string } | undefined;
    assert.ok(funnelsRow, 'the inserted row must be the funnels department');
    assert.equal(funnelsRow!.name, 'Funnels');
    assert.equal(funnelsRow!.id, 'funnels');
    assert.equal(
      funnelsRow!.company_id,
      'default',
      'the backfilled row must inherit company_id from an existing workspace (the CEO row), never a bare/undefined value',
    );

    // Every pre-existing row must be COMPLETELY untouched (additive-only).
    for (const slug of ['master-orchestrator', 'marketing', 'sales', 'web-development', 'general-task']) {
      const row = db.prepare('SELECT slug FROM workspaces WHERE lower(slug) = ?').get(slug) as { slug: string } | undefined;
      assert.ok(row, `pre-existing workspace '${slug}' must still exist after migrating`);
    }
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 110: idempotent — re-running the full chain (simulated reboot) inserts ZERO further rows', () => {
  const dbPath = freshDbPath('idempotent');
  const db = seedPreExistingBox(dbPath);
  try {
    withIsolatedHome(() => runMigrations(db));
    const afterFirst = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };

    withIsolatedHome(() => runMigrations(db)); // simulates a second boot on the same box
    const afterSecond = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };

    assert.equal(afterSecond.n, afterFirst.n, 'a second migration run must insert zero further rows (no duplicate funnels workspace)');
    const funnelsCount = db
      .prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE lower(slug) = 'funnels'`)
      .get() as { n: number };
    assert.equal(funnelsCount.n, 1, 'exactly one funnels workspace must exist after two migration runs, never a duplicate');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 110: a box that ALREADY carries an ad hoc "funnels" workspace (the operator ruling\'s named case) is left completely untouched', () => {
  const dbPath = freshDbPath('adhoc-existing');
  const db = seedPreExistingBox(dbPath);
  try {
    // The operator's own box: an ad hoc 'funnels' workspace seeded OUTSIDE the
    // floor (by hand), before this migration ever existed — a custom id/name/
    // icon the migration must never overwrite.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('ws-adhoc-funnels-xyz', 'My Funnels Team', 'funnels', '🎪', 'default', 500, ?, ?)`,
    ).run(now, now);

    const before = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };

    withIsolatedHome(() => runMigrations(db));

    const after = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    assert.equal(after.n, before.n, 'migration 110 must be a TRUE no-op when a funnels workspace already exists — "IF IT ALREADY EXISTS"');

    const row = db
      .prepare(`SELECT id, name, icon FROM workspaces WHERE lower(slug) = 'funnels'`)
      .get() as { id: string; name: string; icon: string };
    assert.equal(row.id, 'ws-adhoc-funnels-xyz', 'the operator\'s own ad hoc workspace id must be untouched');
    assert.equal(row.name, 'My Funnels Team', 'the operator\'s own custom display name must NEVER be overwritten by the backfill');
    assert.equal(row.icon, '🎪', 'the operator\'s own custom icon must NEVER be overwritten by the backfill');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 110: matched-by-id (not just slug) also counts as "already exists" — no duplicate', () => {
  const dbPath = freshDbPath('id-match');
  const db = seedPreExistingBox(dbPath);
  try {
    // A box whose funnels row was seeded with id='funnels' but a DIFFERENT
    // slug casing/variant is still recognized as present (matches the
    // migration's OR lower(id) = 'funnels' guard, mirroring resolveWorkspaceId's
    // own tier-1 OR-on-id fallback).
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('funnels', 'Funnels', 'FUNNELS', '🔻', 'default', 500, ?, ?)`,
    ).run(now, now);

    const before = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    withIsolatedHome(() => runMigrations(db));
    const after = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };

    assert.equal(after.n, before.n, 'an id-matched funnels row must also be recognized as already-present — no duplicate insert');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
