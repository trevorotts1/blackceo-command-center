/**
 * Migration 166 (JGT-106) — "general-task" catch-all workspace backfill.
 *
 * No department fit → the General Task lane, never dropped, never stuck.
 * Today no CC step guarantees a 'general-task' workspace exists at all: it
 * only exists if the onboarding departments.json listed it. This migration is
 * the one-time backfill for every PRE-EXISTING box, mirroring migration 111's
 * own shape (additive-only, anchors company_id to an EXISTING workspace row,
 * never touches a row that already exists, never resurrects an archived row).
 *
 * Real production code exercised (never reimplemented): the actual
 * runMigrations() (src/lib/db/migrations.ts), including the full chain
 * 001..166, against a hand-seeded pre-existing DB — never a fresh/empty one.
 */
// C8 — DB isolation (see migration-111-funnels-seed.test.ts's own header for
// why this import comes first).
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { schema } from '../../src/lib/db/schema';
import { runMigrations, ensureWorkspaceHeadAgents } from '../../src/lib/db/migrations';

function freshDbPath(tag: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `bc-migration-166-${tag}-`)), 'mission-control.test.db');
}

// Same isolation as migration-111-funnels-seed.test.ts: HOME (and the
// zero-human-company / master-files env vars) redirected to an empty temp dir
// so reseedWorkspacesFromConfig() never picks up a REAL departments.json that
// happens to live on this machine.
function withIsolatedHome<T>(fn: () => T): T {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-migration-166-isolated-home-'));
  const saved: Record<string, string | undefined> = {
    HOME: process.env.HOME,
    MASTER_FILES_DIR: process.env.MASTER_FILES_DIR,
    ZERO_HUMAN_COMPANY_DIR: process.env.ZERO_HUMAN_COMPANY_DIR,
    BLACKCEO_COMMAND_CENTER_ROOT: process.env.BLACKCEO_COMMAND_CENTER_ROOT,
  };
  process.env.HOME = isolatedHome;
  delete process.env.MASTER_FILES_DIR;
  delete process.env.ZERO_HUMAN_COMPANY_DIR;
  delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
}

// Points readDepartmentOptoutIds() (called with NO explicit path by the
// migration, exactly like production) at a temp department-optout.json, the
// same way department-optout-board-wiring.test.ts does: via
// OPENCLAW_WORKSPACE_PATH, never a literal file path threaded through.
function withOptoutFile<T>(optedOutIds: string[] | null, fn: () => T): T {
  if (!optedOutIds) return fn();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-migration-166-optout-'));
  fs.mkdirSync(path.join(dir, 'provisioning'), { recursive: true });
  const body = {
    optedOut: Object.fromEntries(optedOutIds.map((id) => [id, { optedOut: true }])),
  };
  fs.writeFileSync(path.join(dir, 'provisioning', 'department-optout.json'), JSON.stringify(body), 'utf8');
  const saved = process.env.OPENCLAW_WORKSPACE_PATH;
  process.env.OPENCLAW_WORKSPACE_PATH = dir;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.OPENCLAW_WORKSPACE_PATH; else process.env.OPENCLAW_WORKSPACE_PATH = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedDb(dbPath: string, companies: { id: string; slug: string }[], workspaces: {
  id: string; name: string; slug: string; companyId: string; sortOrder: number; archivedAt?: string | null;
}[]): Database.Database {
  const db = new Database(dbPath);
  db.exec(schema);
  const now = new Date().toISOString();
  for (const c of companies) {
    db.prepare(`INSERT INTO companies (id, name, slug, config, created_at, updated_at) VALUES (?, ?, ?, '{}', ?, ?)`)
      .run(c.id, c.slug, c.slug, now, now);
  }
  const insertWs = db.prepare(
    `INSERT INTO workspaces (id, name, slug, icon, company_id, sort_order, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, '📁', ?, ?, ?, ?, ?)`,
  );
  for (const ws of workspaces) {
    insertWs.run(ws.id, ws.name, ws.slug, ws.companyId, ws.sortOrder, ws.archivedAt ?? null, now, now);
  }
  return db;
}

function generalTaskRows(db: Database.Database) {
  return db.prepare(`SELECT id, name, slug, company_id, sort_order, archived_at FROM workspaces WHERE lower(slug) = 'general-task'`).all() as {
    id: string; name: string; slug: string; company_id: string; sort_order: number; archived_at: string | null;
  }[];
}

test('migration 166 (a): CEO workspace in company acme + marketing, no general-task -> exactly one general-task row', () => {
  const dbPath = freshDbPath('ceo-plus-marketing');
  const db = seedDb(dbPath, [{ id: 'acme', slug: 'acme' }], [
    { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
    { id: 'marketing', name: 'Marketing', slug: 'marketing', companyId: 'acme', sortOrder: 1 },
  ]);
  try {
    withIsolatedHome(() => runMigrations(db));

    const rows = generalTaskRows(db);
    assert.equal(rows.length, 1, 'exactly one general-task row must exist');
    assert.equal(rows[0].name, 'General Task');
    assert.equal(rows[0].id, 'general-task');
    assert.equal(rows[0].company_id, 'acme');
    assert.equal(rows[0].sort_order, 99999);
    assert.notEqual(rows[0].id, 'default', 'general-task must be a separate row from the structural default workspace');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 166 (b): re-running the full chain (simulated reboot) inserts ZERO further rows', () => {
  const dbPath = freshDbPath('idempotent');
  const db = seedDb(dbPath, [{ id: 'acme', slug: 'acme' }], [
    { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
    { id: 'marketing', name: 'Marketing', slug: 'marketing', companyId: 'acme', sortOrder: 1 },
  ]);
  try {
    withIsolatedHome(() => runMigrations(db));
    const afterFirst = generalTaskRows(db);
    assert.equal(afterFirst.length, 1);

    withIsolatedHome(() => runMigrations(db)); // simulated second boot
    const afterSecond = generalTaskRows(db);
    assert.equal(afterSecond.length, 1, 'a second migration run must never duplicate the general-task workspace');
    assert.equal(afterSecond[0].id, afterFirst[0].id);
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 166 (c): an existing dept-general-task row -> no insert', () => {
  const dbPath = freshDbPath('legacy-alias');
  const db = seedDb(dbPath, [{ id: 'acme', slug: 'acme' }], [
    { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
    { id: 'legacy-general', name: 'General Task', slug: 'dept-general-task', companyId: 'acme', sortOrder: 500 },
  ]);
  try {
    withIsolatedHome(() => runMigrations(db));

    // NOTE: pre-existing, unrelated migration 051 (canonical_department_slug_
    // migration) unconditionally strips the 'dept-' prefix off EVERY workspace
    // slug fleet-wide, so by the time migration 166 runs this row already
    // reads slug='general-task' — that rename is migration 051's job, not
    // 166's, and is asserted by that migration's own test suite. What matters
    // HERE is that migration 166 never inserts a SECOND row for an identity
    // that already existed under the legacy alias: still exactly one
    // general-task-canonical row, and it is still the SAME pre-existing row.
    const rows = db.prepare(`SELECT id, slug FROM workspaces WHERE lower(slug) IN ('general-task', 'dept-general-task') OR lower(id) = 'general-task'`).all() as { id: string; slug: string }[];
    assert.equal(rows.length, 1, 'a legacy dept-general-task row means no NEW general-task row is inserted');
    assert.equal(rows[0].id, 'legacy-general', 'the pre-existing legacy row must be the one that survives, never duplicated under a fresh id');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 166 (d): an archived general-task row stays archived and nothing new is added', () => {
  const dbPath = freshDbPath('archived');
  const archivedAt = '2026-01-01T00:00:00.000Z';
  const db = seedDb(dbPath, [{ id: 'acme', slug: 'acme' }], [
    { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
    { id: 'general-task', name: 'General Task', slug: 'general-task', companyId: 'acme', sortOrder: 99999, archivedAt },
  ]);
  try {
    withIsolatedHome(() => runMigrations(db));

    const rows = generalTaskRows(db);
    assert.equal(rows.length, 1, 'never resurrect an archived row, and never insert a second one');
    assert.equal(rows[0].archived_at, archivedAt, 'the archived row must stay archived — insert-only, never an un-archive');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 166 (e): a provenanced opt-out file -> no row', () => {
  const dbPath = freshDbPath('opted-out');
  const db = seedDb(dbPath, [{ id: 'acme', slug: 'acme' }], [
    { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
    { id: 'marketing', name: 'Marketing', slug: 'marketing', companyId: 'acme', sortOrder: 1 },
  ]);
  try {
    withIsolatedHome(() => withOptoutFile(['general-task'], () => runMigrations(db)));

    const rows = generalTaskRows(db);
    assert.equal(rows.length, 0, 'an honored opt-out must never recreate the catch-all lane');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 166 (f): only a "default" row -> no row (never anchor to the default company)', () => {
  const dbPath = freshDbPath('default-only');
  const db = seedDb(dbPath, [{ id: 'default', slug: 'default' }], [
    { id: 'default', name: 'General', slug: 'default', companyId: 'default', sortOrder: 0 },
  ]);
  try {
    withIsolatedHome(() => runMigrations(db));

    const rows = generalTaskRows(db);
    assert.equal(rows.length, 0, 'a box with nothing but the structural default workspace has no company to anchor a general-task row to');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 166 (g): after migrations plus ensureWorkspaceHeadAgents, general-task has a head agent', () => {
  const dbPath = freshDbPath('head-agent');
  const db = seedDb(dbPath, [{ id: 'acme', slug: 'acme' }], [
    { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
    { id: 'marketing', name: 'Marketing', slug: 'marketing', companyId: 'acme', sortOrder: 1 },
  ]);
  try {
    withIsolatedHome(() => runMigrations(db)); // already calls ensureWorkspaceHeadAgents internally
    ensureWorkspaceHeadAgents(db); // idempotent — explicit call per the contract's own wording

    const row = db.prepare(`SELECT head_agent_id FROM workspaces WHERE lower(slug) = 'general-task'`).get() as
      | { head_agent_id: string | null }
      | undefined;
    assert.ok(row, 'general-task workspace must exist');
    assert.ok(row!.head_agent_id, 'general-task must have a head agent, never headless');
    const head = db.prepare('SELECT id FROM agents WHERE id = ?').get(row!.head_agent_id) as { id: string } | undefined;
    assert.ok(head, 'the stamped head_agent_id must resolve to a real agent row');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 166 (h): CEO/master row itself sits under company "default" -> never anchor general-task to "default"', () => {
  // QC break-it "ceodefault": an un-branded box where master-orchestrator,
  // marketing and sales were all seeded under the sentinel company 'default'
  // (reseedWorkspacesFromConfig's own fallback when no real company id was
  // ever resolved). The CEO/master lookup must exclude company_id='default'
  // just like the majority fallback already does, so there is nothing left
  // to anchor to and the migration must no-op -- never insert with
  // company_id='default'.
  const dbPath = freshDbPath('ceo-under-default');
  const db = seedDb(dbPath, [{ id: 'default', slug: 'default' }], [
    { id: 'default', name: 'General', slug: 'default', companyId: 'default', sortOrder: 0 },
    { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'default', sortOrder: 1 },
    { id: 'marketing', name: 'Marketing', slug: 'marketing', companyId: 'default', sortOrder: 2 },
    { id: 'sales', name: 'Sales', slug: 'sales', companyId: 'default', sortOrder: 3 },
  ]);
  try {
    withIsolatedHome(() => runMigrations(db));

    const rows = generalTaskRows(db);
    assert.equal(rows.length, 0, 'with every workspace (including the CEO row) under "default", there is no real company to anchor to');
    assert.ok(!rows.some((r) => r.company_id === 'default'), 'general-task must never be inserted with company_id="default"');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 166 (i): CEO row under "default" but company acme holds the real departments -> anchors to acme, not default', () => {
  const dbPath = freshDbPath('ceo-default-acme-majority');
  const db = seedDb(dbPath, [{ id: 'default', slug: 'default' }, { id: 'acme', slug: 'acme' }], [
    { id: 'default', name: 'General', slug: 'default', companyId: 'default', sortOrder: 0 },
    { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'default', sortOrder: 1 },
    { id: 'marketing', name: 'Marketing', slug: 'marketing', companyId: 'acme', sortOrder: 2 },
    { id: 'sales', name: 'Sales', slug: 'sales', companyId: 'acme', sortOrder: 3 },
  ]);
  try {
    withIsolatedHome(() => runMigrations(db));

    const rows = generalTaskRows(db);
    assert.equal(rows.length, 1, 'the majority fallback must still anchor the catch-all to the real company');
    assert.equal(rows[0].company_id, 'acme');
    assert.notEqual(rows[0].company_id, 'default', 'a company_id="default" CEO row must never win over a real company');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
