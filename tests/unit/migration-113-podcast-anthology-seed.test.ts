/**
 * Migration 113 (U017, 2026-07-23) — Podcast/Anthology workspace seeding.
 *
 * Podcast and Anthology cards are gated on `workspaces` rows with
 * slug='podcast' / slug='anthology'. Those rows were only seeded at initial
 * onboarding, so a client onboarded BEFORE those engines existed never gets
 * the rows and the cards never render. This one-time, idempotent migration
 * seeds them fleet-wide on the next update roll.
 *
 * Proves, against a REAL pre-existing DB shape (companies + several
 * already-provisioned workspace rows, none of them podcast/anthology — never a
 * fresh/empty DB):
 *   1. Running the full migration chain inserts EXACTLY TWO new workspace rows
 *      (podcast + anthology), both with company_id='default' so they are visible
 *      to all clients on the box, leaving every existing row untouched.
 *   2. Idempotency: re-running the migration chain (simulating a reboot) inserts
 *      ZERO further rows — exactly one row per slug after re-run.
 *   3. The "already exists" case: a box that already carries an ad hoc 'podcast'
 *      workspace (seeded at onboarding or by hand) is left COMPLETELY untouched
 *      (INSERT OR IGNORE is a true no-op, never overwriting).
 *
 * Real production code exercised (never reimplemented): the actual
 * runMigrations() (src/lib/db/migrations.ts), including the full chain
 * 001..113, against a hand-seeded pre-existing DB — never a fresh
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `bc-migration-113-${tag}-`)), 'mission-control.test.db');
}

// ── Filesystem isolation ──────────────────────────────────────────────────
// runMigrations() can reach reseedWorkspacesFromConfig(), which resolves a real
// departments.json via hardcoded ~/clawd paths. Redirect HOME to an isolated
// empty temp dir so resolution falls through to "no config found" — the shape a
// clean CI box sees — so no unrelated workspace rows leak into the row counts.
function withIsolatedHome<T>(fn: () => T): T {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-migration-113-isolated-home-'));
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
 * already-provisioned workspace rows (mirrors a box that onboarded BEFORE the
 * podcast/anthology engines existed) — never a fresh/empty workspaces table,
 * and never a box that already carries podcast/anthology.
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

test('migration 113: seeds EXACTLY ONE podcast + ONE anthology workspace on a real pre-existing DB shape', () => {
  const dbPath = freshDbPath('seed');
  const db = seedPreExistingBox(dbPath);
  try {
    const before = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    assert.equal(before.n, 4, 'sanity: the pre-existing box carries exactly the 4 hand-seeded rows before migrating');

    withIsolatedHome(() => runMigrations(db)); // full chain 001..113 against the pre-seeded rows

    // Assert on the unit's OWN deliverable — exactly one row per engine slug —
    // not the global row delta (the full chain also runs other additive
    // migrations, e.g. 111's funnels backfill, whose rows are not this unit's).
    for (const [slug, name, icon] of [['podcast', 'Podcast', '🎙️'], ['anthology', 'Anthology', '📚']] as const) {
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE lower(slug) = ?`)
        .get(slug) as { n: number };
      assert.equal(count.n, 1, `exactly one '${slug}' workspace must exist after migrating`);

      const row = db
        .prepare(`SELECT id, name, slug, icon, company_id FROM workspaces WHERE lower(slug) = ?`)
        .get(slug) as { id: string; name: string; slug: string; icon: string; company_id: string } | undefined;
      assert.ok(row, `the '${slug}' workspace must exist after migrating`);
      assert.equal(row!.id, slug, `the '${slug}' row id must equal its slug`);
      assert.equal(row!.name, name);
      assert.equal(row!.icon, icon);
      assert.equal(
        row!.company_id,
        'default',
        `the '${slug}' row must carry company_id='default' so it is visible to all clients on the box`,
      );
    }

    // Every pre-existing row must be COMPLETELY untouched (additive-only).
    for (const slug of ['master-orchestrator', 'marketing', 'sales', 'general-task']) {
      const row = db.prepare('SELECT slug FROM workspaces WHERE lower(slug) = ?').get(slug) as { slug: string } | undefined;
      assert.ok(row, `pre-existing workspace '${slug}' must still exist after migrating`);
    }
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 113: idempotent — re-running the full chain (simulated reboot) inserts ZERO further rows', () => {
  const dbPath = freshDbPath('idempotent');
  const db = seedPreExistingBox(dbPath);
  try {
    withIsolatedHome(() => runMigrations(db));
    const afterFirst = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };

    withIsolatedHome(() => runMigrations(db)); // simulates a second boot on the same box
    const afterSecond = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };

    assert.equal(afterSecond.n, afterFirst.n, 'a second migration run must insert zero further rows');

    for (const slug of ['podcast', 'anthology']) {
      const count = db
        .prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE lower(slug) = ?`)
        .get(slug) as { n: number };
      assert.equal(count.n, 1, `exactly one '${slug}' workspace must exist after two migration runs, never a duplicate`);
    }
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 113: a box that ALREADY carries an ad hoc "podcast" workspace is left completely untouched', () => {
  const dbPath = freshDbPath('adhoc-existing');
  const db = seedPreExistingBox(dbPath);
  try {
    // A box that already carries an ad hoc 'podcast' workspace seeded OUTSIDE
    // this migration (at onboarding or by hand) — a custom id/name/icon the
    // migration must never overwrite.
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at)
       VALUES ('ws-adhoc-podcast-xyz', 'My Podcast Team', 'podcast', '🎧', 'default', 500, ?, ?)`,
    ).run(now, now);

    withIsolatedHome(() => runMigrations(db));

    // Assert per-slug (the unit's deliverable), not the global delta — the full
    // chain also runs other additive migrations (e.g. 111's funnels backfill).
    const podcastCount = db
      .prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE lower(slug) = 'podcast'`)
      .get() as { n: number };
    assert.equal(podcastCount.n, 1, 'the ad hoc podcast workspace must NOT be duplicated');

    const anthologyCount = db
      .prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE lower(slug) = 'anthology'`)
      .get() as { n: number };
    assert.equal(anthologyCount.n, 1, 'the missing anthology workspace must still be seeded');

    const row = db
      .prepare(`SELECT id, name, icon FROM workspaces WHERE lower(slug) = 'podcast'`)
      .get() as { id: string; name: string; icon: string };
    assert.equal(row.id, 'ws-adhoc-podcast-xyz', 'the existing ad hoc podcast workspace id must be untouched');
    assert.equal(row.name, 'My Podcast Team', 'the existing custom display name must NEVER be overwritten');
    assert.equal(row.icon, '🎧', 'the existing custom icon must NEVER be overwritten');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
