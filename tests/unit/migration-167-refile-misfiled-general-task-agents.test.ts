/**
 * Migration 167 (JGT-202) — retro-file agents mis-filed into General Task
 * before agent-sync's id-based resolver (JGT-107) existed.
 *
 * v7.6.88's own release notes for the JGT-107 fix admit the gap this closes:
 * "Existing mis-filed rows are not moved (the agents UPSERT does not update
 * workspace_id)." This migration applies the SAME id-prefix rule agent-sync.ts
 * now uses (agentId matches /^dept-(.+)$/ or /^head-agent-(.+)$/, normalized
 * through canonicalDeptSlug()) to agents already sitting in a live
 * general-task workspace, moving each to its real department's LIVE,
 * SAME-COMPANY workspace when one exists.
 *
 * Real production code exercised (never reimplemented): the actual
 * runMigrations() (src/lib/db/migrations.ts), including the full chain
 * 001..167, against a hand-seeded pre-existing DB — never a fresh/empty one.
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
import { runMigrations } from '../../src/lib/db/migrations';

function freshDbPath(tag: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), `bc-migration-167-${tag}-`)), 'mission-control.test.db');
}

// Same isolation as migration-166: HOME (and the zero-human-company /
// master-files env vars) redirected to an empty temp dir so
// reseedWorkspacesFromConfig() never picks up a REAL departments.json that
// happens to live on this machine.
function withIsolatedHome<T>(fn: () => T): T {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-migration-167-isolated-home-'));
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

function seedDb(
  dbPath: string,
  companies: { id: string; slug: string }[],
  workspaces: { id: string; name: string; slug: string; companyId: string; sortOrder: number; archivedAt?: string | null }[],
  agents: { id: string; name: string; workspaceId: string; isMaster?: boolean }[],
): Database.Database {
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
  const insertAgent = db.prepare(
    `INSERT INTO agents (id, name, role, is_master, workspace_id, specialist_type, created_at, updated_at)
     VALUES (?, ?, 'Specialist', ?, ?, 'permanent', ?, ?)`,
  );
  for (const a of agents) {
    insertAgent.run(a.id, a.name, a.isMaster ? 1 : 0, a.workspaceId, now, now);
  }
  return db;
}

function agentWorkspace(db: Database.Database, agentId: string): string | undefined {
  return (db.prepare('SELECT workspace_id FROM agents WHERE id = ?').get(agentId) as { workspace_id: string } | undefined)
    ?.workspace_id;
}

test('migration 167 (a): a "General Counsel" agent (id dept-legal) sitting in general-task is moved to legal', () => {
  const dbPath = freshDbPath('general-counsel');
  const db = seedDb(
    dbPath,
    [{ id: 'acme', slug: 'acme' }],
    [
      { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
      { id: 'legal', name: 'Legal', slug: 'legal', companyId: 'acme', sortOrder: 1 },
      { id: 'general-task', name: 'General Task', slug: 'general-task', companyId: 'acme', sortOrder: 99999 },
    ],
    [{ id: 'dept-legal', name: 'General Counsel', workspaceId: 'general-task' }],
  );
  try {
    withIsolatedHome(() => runMigrations(db));
    assert.equal(agentWorkspace(db, 'dept-legal'), 'legal', 'the mis-filed General Counsel row must be re-homed to Legal');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 167 (b): the real General Task head agent is never moved', () => {
  const dbPath = freshDbPath('head-stays');
  const db = seedDb(
    dbPath,
    [{ id: 'acme', slug: 'acme' }],
    [
      { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
      { id: 'legal', name: 'Legal', slug: 'legal', companyId: 'acme', sortOrder: 1 },
      { id: 'general-task', name: 'General Task', slug: 'general-task', companyId: 'acme', sortOrder: 99999 },
    ],
    [{ id: 'head-agent-general-task', name: 'General Task Department Head', workspaceId: 'general-task' }],
  );
  try {
    withIsolatedHome(() => runMigrations(db));
    assert.equal(
      agentWorkspace(db, 'head-agent-general-task'),
      'general-task',
      'the General Task head agent (own id resolves to general-task itself) must stay put',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 167 (c): running it twice (simulated reboot) is a no-op the second time', () => {
  const dbPath = freshDbPath('idempotent');
  const db = seedDb(
    dbPath,
    [{ id: 'acme', slug: 'acme' }],
    [
      { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
      { id: 'legal', name: 'Legal', slug: 'legal', companyId: 'acme', sortOrder: 1 },
      { id: 'general-task', name: 'General Task', slug: 'general-task', companyId: 'acme', sortOrder: 99999 },
    ],
    [{ id: 'dept-legal', name: 'General Counsel', workspaceId: 'general-task' }],
  );
  try {
    withIsolatedHome(() => runMigrations(db));
    assert.equal(agentWorkspace(db, 'dept-legal'), 'legal');
    const updatedAtAfterFirst = (
      db.prepare('SELECT updated_at FROM agents WHERE id = ?').get('dept-legal') as { updated_at: string }
    ).updated_at;

    withIsolatedHome(() => runMigrations(db)); // simulated second boot

    assert.equal(agentWorkspace(db, 'dept-legal'), 'legal', 'a second run must never move an already-refiled agent again');
    const updatedAtAfterSecond = (
      db.prepare('SELECT updated_at FROM agents WHERE id = ?').get('dept-legal') as { updated_at: string }
    ).updated_at;
    assert.equal(updatedAtAfterSecond, updatedAtAfterFirst, 'the second run must not even re-touch the row (already moved out of general-task)');
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 167 (d): an id-encoded department with no live workspace means no move', () => {
  const dbPath = freshDbPath('no-workspace');
  const db = seedDb(
    dbPath,
    [{ id: 'acme', slug: 'acme' }],
    [
      { id: 'master-orchestrator', name: 'CEO / COM', slug: 'master-orchestrator', companyId: 'acme', sortOrder: 0 },
      { id: 'general-task', name: 'General Task', slug: 'general-task', companyId: 'acme', sortOrder: 99999 },
    ],
    [{ id: 'dept-nonexistent-department', name: 'Some Ghost Dept', workspaceId: 'general-task' }],
  );
  try {
    withIsolatedHome(() => runMigrations(db));
    assert.equal(
      agentWorkspace(db, 'dept-nonexistent-department'),
      'general-task',
      'with no live workspace for the resolved slug, the agent must stay exactly where it was',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});

test('migration 167 (e): a same-slug department in ANOTHER company is never used as the target', () => {
  const dbPath = freshDbPath('cross-company');
  const db = seedDb(
    dbPath,
    [{ id: 'acme', slug: 'acme' }, { id: 'globex', slug: 'globex' }],
    [
      { id: 'acme-master', name: 'CEO / COM', slug: 'acme-master-orchestrator', companyId: 'acme', sortOrder: 0 },
      { id: 'acme-general-task', name: 'General Task', slug: 'general-task', companyId: 'acme', sortOrder: 99999 },
      // Only Globex has a live 'legal' workspace — Acme does not.
      { id: 'globex-master', name: 'CEO / COM', slug: 'globex-master-orchestrator', companyId: 'globex', sortOrder: 0 },
      { id: 'globex-legal', name: 'Legal', slug: 'legal', companyId: 'globex', sortOrder: 1 },
    ],
    [{ id: 'dept-legal', name: 'General Counsel', workspaceId: 'acme-general-task' }],
  );
  try {
    withIsolatedHome(() => runMigrations(db));
    assert.equal(
      agentWorkspace(db, 'dept-legal'),
      'acme-general-task',
      'a same-slug workspace that belongs to a DIFFERENT company must never be used as the move target',
    );
  } finally {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  }
});
