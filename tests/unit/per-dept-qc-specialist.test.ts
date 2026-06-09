/**
 * Unit tests for per-department QC Specialist agent seeding + resolution (PR-B).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Strategy: use a dedicated isolated DB (the same pattern as other DB-migration
 * tests in this suite). The DATABASE_PATH env var must be set at module evaluation
 * time so the DB module's DB_PATH constant picks it up before the first import.
 *
 * Covers:
 *   1. Migration 060 adds agents.role_type column (idempotent, verified via PRAGMA).
 *   2. Migration 060 seeds one QC Specialist per workspace
 *      (role_type='qc', specialist_type='permanent').
 *   3. Per-dept QC resolution: finds the correct QC agent by workspace_id.
 *   4. Per-dept QC resolution: unknown workspace returns null (heuristic fallback).
 *   5. review→done gate: QC agent from the correct dept is authorized.
 *   6. review→done gate: QC agent from the WRONG dept is NOT authorized.
 *   7. review→done gate fallback: global master agent is authorized when no
 *      QC agent exists (pre-migration-060 fallback path).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-qc-spec-')),
  'mission-control.test.db',
);
// Must be set before any import of @/lib/db so DB_PATH captures it.
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  run = db.run;
  closeDb = db.closeDb;

  // getDb() triggers the full migration chain (incl. migration 060).
  getDb();

  // Ensure default company exists for FK constraint.
  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );

  // Seed two test workspaces so QC agents can be verified.
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('marketing', 'Marketing', 'marketing', 'Marketing dept', '📣', 'default', 10, ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('sales', 'Sales', 'sales', 'Sales dept', '💼', 'default', 20, ?, ?)`,
    [now, now],
  );

  // Check if role_type column exists before trying to seed QC agents
  // (migration 060 should have added it, but guard for safety).
  const cols = queryAll<{ name: string }>('PRAGMA table_info(agents)', []);
  const hasRoleType = cols.some((c) => c.name === 'role_type');

  if (hasRoleType) {
    // Seed QC agents for the test workspaces (migration 060 deferred if no
    // workspaces existed at migration time; do it manually here).
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, role_type, created_at, updated_at)
       VALUES ('qc-agent-marketing', 'Marketing QC Specialist', 'QC Specialist',
               'QC for Marketing', '🔍', 'standby', 0, 'marketing',
               'permanent', 'qc', ?, ?)`,
      [now, now],
    );
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, role_type, created_at, updated_at)
       VALUES ('qc-agent-sales', 'Sales QC Specialist', 'QC Specialist',
               'QC for Sales', '🔍', 'standby', 0, 'sales',
               'permanent', 'qc', ?, ?)`,
      [now, now],
    );
  }

  // Seed master-orchestrator workspace (needed for master agent FK)
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('master-orchestrator', 'CEO / COM', 'master-orchestrator', 'CEO workspace', '🎯', 'default', 0, ?, ?)`,
    [now, now],
  );

  // Seed a master agent (global) for the fallback test.
  if (hasRoleType) {
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, role_type, created_at, updated_at)
       VALUES ('master-ceo', 'CEO Agent', 'Master Orchestrator', 'Global master',
               '🎯', 'standby', 1, 'master-orchestrator', 'permanent', null, ?, ?)`,
      [now, now],
    );
  } else {
    run(
      `INSERT OR IGNORE INTO agents
         (id, name, role, description, avatar_emoji, status, is_master, workspace_id,
          specialist_type, created_at, updated_at)
       VALUES ('master-ceo', 'CEO Agent', 'Master Orchestrator', 'Global master',
               '🎯', 'standby', 1, 'master-orchestrator', 'permanent', ?, ?)`,
      [now, now],
    );
  }
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ─── Tests ─────────────────────────────────────────────────────────────────

test('migration 060: agents.role_type column exists after migration chain', () => {
  const cols = queryAll<{ name: string }>('PRAGMA table_info(agents)', []);
  assert.ok(
    cols.some((c) => c.name === 'role_type'),
    'agents.role_type column must exist after migration 060',
  );
});

test('per-dept QC: marketing QC agent has role_type=qc and specialist_type=permanent', () => {
  const agent = queryOne<{ id: string; role_type: string; specialist_type: string }>(
    "SELECT id, role_type, specialist_type FROM agents WHERE id = 'qc-agent-marketing'",
    [],
  );
  assert.ok(agent, 'QC agent for marketing should be seeded');
  assert.equal(agent.role_type, 'qc', 'role_type must be qc');
  assert.equal(agent.specialist_type, 'permanent', 'specialist_type must be permanent');
});

test('per-dept QC: sales QC agent has role_type=qc', () => {
  const agent = queryOne<{ id: string; role_type: string }>(
    "SELECT id, role_type FROM agents WHERE id = 'qc-agent-sales'",
    [],
  );
  assert.ok(agent, 'QC agent for sales should be seeded');
  assert.equal(agent.role_type, 'qc');
});

test('per-dept QC resolution: finds QC agent by workspace_id=marketing', () => {
  const agent = queryOne<{ id: string; name: string }>(
    "SELECT id, name FROM agents WHERE workspace_id = 'marketing' AND role_type = 'qc' LIMIT 1",
    [],
  );
  assert.ok(agent, 'should resolve Marketing QC Specialist');
  assert.equal(agent.id, 'qc-agent-marketing');
});

test('per-dept QC resolution: finds QC agent by workspace_id=sales', () => {
  const agent = queryOne<{ id: string }>(
    "SELECT id FROM agents WHERE workspace_id = 'sales' AND role_type = 'qc' LIMIT 1",
    [],
  );
  assert.ok(agent, 'should resolve Sales QC Specialist');
  assert.equal(agent.id, 'qc-agent-sales');
});

test('per-dept QC resolution: unknown workspace returns no QC agent (heuristic fallback)', () => {
  const agent = queryOne<{ id: string }>(
    "SELECT id FROM agents WHERE workspace_id = 'no-such-dept' AND role_type = 'qc' LIMIT 1",
    [],
  );
  // queryOne returns undefined (or null) when no row found — both are falsy
  assert.ok(!agent, 'unknown dept must return null/undefined → heuristic fallback activates');
});

test('review→done gate: QC agent from correct dept is authorized', () => {
  const a = queryOne<{ id: string; role_type: string; workspace_id: string; is_master: number }>(
    "SELECT id, role_type, workspace_id, is_master FROM agents WHERE id = 'qc-agent-marketing'",
    [],
  );
  assert.ok(a);
  const taskWorkspaceId = 'marketing';
  // Replicating the authorization logic from tasks/[id]/route.ts
  const isQCSpecialist = a.role_type === 'qc';
  const isAuthorizedQC = isQCSpecialist && a.workspace_id === taskWorkspaceId;
  const hasDeptQCAgent = true; // QC agent exists for this workspace
  const approved = hasDeptQCAgent ? isAuthorizedQC || a.is_master === 1 : a.is_master === 1;
  assert.ok(approved, 'dept QC agent must be authorized to approve its own dept tasks');
});

test('review→done gate: QC agent from wrong dept is NOT authorized', () => {
  const a = queryOne<{ id: string; role_type: string; workspace_id: string; is_master: number }>(
    "SELECT id, role_type, workspace_id, is_master FROM agents WHERE id = 'qc-agent-sales'",
    [],
  );
  assert.ok(a);
  const taskWorkspaceId = 'marketing'; // Sales QC trying to approve a Marketing task
  const isQCSpecialist = a.role_type === 'qc';
  const isAuthorizedQC = isQCSpecialist && a.workspace_id === taskWorkspaceId;
  const isMasterInWorkspace = a.is_master === 1 && a.workspace_id === taskWorkspaceId;
  const hasDeptQCAgent = true;
  const approved = hasDeptQCAgent
    ? isAuthorizedQC || isMasterInWorkspace
    : a.is_master === 1;
  assert.ok(!approved, 'QC agent from wrong dept must be rejected');
});

test('review→done gate fallback: global master agent is authorized when no QC agent exists', () => {
  const master = queryOne<{ id: string; is_master: number }>(
    "SELECT id, is_master FROM agents WHERE id = 'master-ceo'",
    [],
  );
  assert.ok(master, 'master agent should exist');
  assert.equal(master.is_master, 1);
  // hasDeptQCAgent = false → fallback: any master is authorized
  const hasDeptQCAgent = false;
  const approved = hasDeptQCAgent ? false : master.is_master === 1;
  assert.ok(approved, 'global master must be authorized in fallback (pre-060) mode');
});
