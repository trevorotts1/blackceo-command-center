/**
 * C3 — duplicate trio agents + headless workspaces.
 *
 * Two defects, one provisioning story:
 *
 *  1. DUPLICATES. Migration 065 and autoSeedTrioAgents seeded the trio with
 *     `INSERT OR IGNORE` keyed on their OWN deterministic ids
 *     ('research-agent-<ws.id>', 'da-agent-<ws.id>'). Skill 23 had already seeded
 *     the same ROLES under hex ids (and under the 'deep-research' alias), so the
 *     insert never hit a PRIMARY-KEY collision — it duplicated. Re-provisioning
 *     (converge → reseedWorkspacesFromConfig → autoSeedTrioAgents) re-ran that seed
 *     every time, so agents multiplied instead of converging. Live marketing carried
 *     BOTH 'Deep Research Specialist — Marketing' (hex) AND 'Marketing Research
 *     Specialist' (research-agent-marketing).
 *
 *  2. HEADLESS. Migration 028 backfilled workspaces.head_agent_id exactly ONCE.
 *     Migrations run once, so every workspace created afterwards was born with
 *     head_agent_id = NULL and nothing ever refilled it — 13 accumulated, including
 *     mandatory floor departments (app-development, quality-control).
 *
 * These tests pin the fix AND the two safety properties that the live data forced:
 *   - non-trio roles are NEVER de-duped (live `presentations` holds 17 DISTINCT
 *     role_type='specialist' agents — a naive dedupe on (workspace_id, role_type)
 *     would delete 16 real agents);
 *   - foreign keys are repointed onto the survivor, never orphaned.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  seedTrioForWorkspaces,
  dedupeTrioAgents,
  ensureWorkspaceHeadAgents,
  findDuplicateTrioAgents,
  findHeadlessWorkspaces,
  canonicalTrioRole,
  TRIO_ROLE_TYPES,
  HEAD_ROLE_TYPE,
} from '../../src/lib/db/migrations';

// ── Minimal schema mirroring the live shape (agents, workspaces, tasks) ──────
// Includes the two FK flavours the live DB has onto agents(id): a SET NULL head
// pointer and NO ACTION task pointers.
function makeDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-c3-'));
  const db = new Database(path.join(dir, 'c3.test.db'));
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      slug TEXT,
      name TEXT NOT NULL,
      company_id TEXT DEFAULT 'default',
      head_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      description TEXT,
      avatar_emoji TEXT DEFAULT '🤖',
      status TEXT DEFAULT 'standby',
      is_master INTEGER DEFAULT 0,
      workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
      model TEXT,
      specialist_type TEXT DEFAULT 'on-call',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      role_type TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      assigned_agent_id TEXT REFERENCES agents(id),
      created_by_agent_id TEXT REFERENCES agents(id)
    );
  `);
  return db;
}

function addWorkspace(db: Database.Database, id: string, name: string): void {
  db.prepare('INSERT INTO workspaces (id, slug, name) VALUES (?, ?, ?)').run(id, id, name);
}

function addAgent(
  db: Database.Database,
  a: { id: string; name: string; workspace: string; roleType: string | null; createdAt?: string },
): void {
  db.prepare(
    `INSERT INTO agents (id, name, role, workspace_id, role_type, created_at)
     VALUES (?, ?, 'Specialist', ?, ?, ?)`,
  ).run(a.id, a.name, a.workspace, a.roleType, a.createdAt ?? '2026-06-15T21:45:49.711727+00:00');
}

const agentIds = (db: Database.Database, ws: string, roleTypes: string[]): string[] =>
  db
    .prepare(
      `SELECT id FROM agents WHERE workspace_id = ? AND role_type IN (${roleTypes.map(() => '?').join(',')})
       ORDER BY id`,
    )
    .all(ws, ...roleTypes)
    .map((r) => (r as { id: string }).id);

// ── 1. role_type vocabulary ──────────────────────────────────────────────────

test("canonicalTrioRole folds Skill-23's 'deep-research' onto 'research'", () => {
  assert.equal(canonicalTrioRole('deep-research'), 'research');
  assert.equal(canonicalTrioRole('research'), 'research');
  assert.equal(canonicalTrioRole('qc'), 'qc');
  assert.equal(canonicalTrioRole('devils-advocate'), 'devils-advocate');
});

test('canonicalTrioRole returns null for non-trio roles (they are many-per-dept)', () => {
  // This is the property that stops the de-dup from deleting 16 of the live
  // `presentations` department's 17 distinct 'specialist' agents.
  for (const role of ['specialist', 'leadership', 'healer', 'orchestrator', '', null, undefined]) {
    assert.equal(canonicalTrioRole(role as string | null), null, `${role} must not be a trio role`);
  }
});

// ── 2. Create-side guard: the seed is idempotent on the ROLE, not the id ─────

test('REGRESSION: seeding over a Skill-23 hex trio does NOT duplicate the role', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  // Exactly the live pre-fix shape: Skill-23 rows, hex ids, 'deep-research' alias.
  addAgent(db, { id: 'f611091b64802fb0', name: 'Deep Research Specialist — Marketing', workspace: 'marketing', roleType: 'deep-research' });
  addAgent(db, { id: '64767e5455e74ebd', name: "Devil's Advocate — Marketing", workspace: 'marketing', roleType: 'devils-advocate' });
  addAgent(db, { id: '8f315776b93e8edc', name: 'QC Specialist — Marketing', workspace: 'marketing', roleType: 'qc' });

  const r = seedTrioForWorkspaces(db, [{ id: 'marketing', name: 'Marketing' }]);

  // Every slot was already filled — under a different id AND a different spelling.
  assert.equal(r.research, 0, 'must not seed a second research agent');
  assert.equal(r.devilsAdvocate, 0, 'must not seed a second devil\'s advocate');
  assert.equal(r.qc, 0, 'must not seed a second QC specialist');
  assert.equal(r.skipped, 3);

  // Pre-fix this produced research-agent-marketing + da-agent-marketing.
  assert.equal(db.prepare('SELECT count(*) c FROM agents').get<{ c: number }>().c, 3);
  assert.equal(findDuplicateTrioAgents(db).length, 0);
  db.close();
});

test('seed fills only the MISSING slot on a partially-seeded workspace', () => {
  const db = makeDb();
  addWorkspace(db, 'sales', 'Sales');
  addAgent(db, { id: 'abc123', name: 'Deep Research — Sales', workspace: 'sales', roleType: 'deep-research' });

  const r = seedTrioForWorkspaces(db, [{ id: 'sales', name: 'Sales' }]);

  assert.equal(r.research, 0, 'research slot was already filled by the alias row');
  assert.equal(r.qc, 1);
  assert.equal(r.devilsAdvocate, 1);
  assert.equal(findDuplicateTrioAgents(db).length, 0);
  db.close();
});

test('re-provisioning is convergent: seeding N times yields the same trio', () => {
  // The converge path (reseedWorkspacesFromConfig) calls this on EVERY run. Pre-fix
  // that is what multiplied the agents.
  const db = makeDb();
  addWorkspace(db, 'legal', 'Legal');

  const first = seedTrioForWorkspaces(db, [{ id: 'legal', name: 'Legal' }]);
  assert.equal(first.qc + first.research + first.devilsAdvocate, 3, 'first run seeds the full trio');

  for (let i = 0; i < 5; i++) {
    const again = seedTrioForWorkspaces(db, [{ id: 'legal', name: 'Legal' }]);
    assert.equal(again.qc + again.research + again.devilsAdvocate, 0, 'later runs seed nothing');
    assert.equal(again.skipped, 3);
  }

  assert.equal(db.prepare('SELECT count(*) c FROM agents').get<{ c: number }>().c, 3);
  assert.equal(findDuplicateTrioAgents(db).length, 0);
  db.close();
});

// ── 3. De-dup of already-corrupted DBs ───────────────────────────────────────

test('dedupeTrioAgents collapses the live marketing duplicate, keeping the Skill-23 row', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addAgent(db, { id: 'f611091b64802fb0', name: 'Deep Research Specialist — Marketing', workspace: 'marketing', roleType: 'deep-research' });
  addAgent(db, { id: '64767e5455e74ebd', name: "Devil's Advocate — Marketing", workspace: 'marketing', roleType: 'devils-advocate' });
  // The migration-065 duplicates, one day younger — exactly the live rows.
  addAgent(db, { id: 'research-agent-marketing', name: 'Marketing Research Specialist', workspace: 'marketing', roleType: 'research', createdAt: '2026-06-16 01:19:38' });
  addAgent(db, { id: 'da-agent-marketing', name: "Marketing Devil's Advocate", workspace: 'marketing', roleType: 'devils-advocate', createdAt: '2026-06-16 01:19:38' });

  assert.equal(findDuplicateTrioAgents(db).length, 2, 'research + DA slots are doubled');

  const r = dedupeTrioAgents(db);

  assert.equal(r.groupsFound, 2);
  assert.equal(r.agentsRemoved, 2);
  assert.equal(findDuplicateTrioAgents(db).length, 0, 'no duplicated slot survives');

  // Spec: keep the older/richer Skill-23 hex row.
  assert.deepEqual(agentIds(db, 'marketing', ['research']), ['f611091b64802fb0']);
  assert.deepEqual(agentIds(db, 'marketing', ['devils-advocate']), ['64767e5455e74ebd']);

  // And the alias is canonicalised so resolveTrioAgents (role_type='research') sees it.
  assert.equal(
    db.prepare("SELECT role_type FROM agents WHERE id='f611091b64802fb0'").get<{ role_type: string }>().role_type,
    'research',
  );
  db.close();
});

test('SAFETY: de-dup never touches non-trio roles (17-specialist department)', () => {
  // Live `presentations` has 17 agents with role_type='specialist' and 17 DISTINCT
  // names. Grouping on (workspace_id, role_type) alone would delete 16 real agents.
  const db = makeDb();
  addWorkspace(db, 'presentations', 'Presentations');
  for (let i = 0; i < 17; i++) {
    addAgent(db, { id: `spec-${i}`, name: `Presentation Specialist ${i}`, workspace: 'presentations', roleType: 'specialist' });
  }
  addAgent(db, { id: 'lead-1', name: 'Signature Presentation Architect', workspace: 'presentations', roleType: 'leadership' });

  const r = dedupeTrioAgents(db);

  assert.equal(r.groupsFound, 0, 'specialist/leadership are not trio slots');
  assert.equal(r.agentsRemoved, 0);
  assert.equal(db.prepare("SELECT count(*) c FROM agents WHERE role_type='specialist'").get<{ c: number }>().c, 17);
  assert.equal(db.prepare("SELECT count(*) c FROM agents WHERE role_type='leadership'").get<{ c: number }>().c, 1);
  db.close();
});

test('de-dup repoints foreign keys onto the survivor instead of orphaning them', () => {
  // Both rows carry work. The survivor is the one with MORE references, and the
  // loser's work must follow it across rather than be deleted with the row.
  const db = makeDb();
  addWorkspace(db, 'ops', 'Operations');
  addAgent(db, { id: 'hexresearch', name: 'Deep Research — Operations', workspace: 'ops', roleType: 'deep-research' });
  addAgent(db, { id: 'research-agent-ops', name: 'Operations Research Specialist', workspace: 'ops', roleType: 'research', createdAt: '2026-06-16 01:19:38' });
  db.prepare('INSERT INTO tasks (id, title, assigned_agent_id, created_by_agent_id) VALUES (?,?,?,?)')
    .run('t1', 'Long-running research', 'hexresearch', 'hexresearch');
  // Work that landed on the duplicate and must NOT be lost when it is collapsed.
  db.prepare('INSERT INTO tasks (id, title, assigned_agent_id, created_by_agent_id) VALUES (?,?,?,?)')
    .run('t2', 'Research the market', 'research-agent-ops', 'research-agent-ops');

  const r = dedupeTrioAgents(db);

  assert.equal(r.agentsRemoved, 1);
  assert.equal(r.referencesRepointed, 2, 'both of the loser\'s task FKs are repointed');

  const task = db.prepare('SELECT assigned_agent_id, created_by_agent_id FROM tasks WHERE id=?').get('t2') as {
    assigned_agent_id: string; created_by_agent_id: string;
  };
  assert.equal(task.assigned_agent_id, 'hexresearch', "the duplicate's task follows the survivor");
  assert.equal(task.created_by_agent_id, 'hexresearch');
  assert.equal(db.prepare('SELECT count(*) c FROM tasks').get<{ c: number }>().c, 2, 'no task was destroyed');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'no dangling foreign keys');
  db.close();
});

test('identity outranks reference count — the work is repointed, not the survivor swapped', () => {
  // The CC-generated duplicate holds ALL the live work; the Skill-23 row holds none.
  // The Skill-23 row still wins (spec: keep the older/richer row) because the
  // repoint moves the work onto it. A reference must never be able to hijack the
  // survivor slot — see the engineering case below, which this rule ordering fixes.
  const db = makeDb();
  addWorkspace(db, 'ops', 'Operations');
  addAgent(db, { id: 'hexresearch', name: 'Deep Research — Operations', workspace: 'ops', roleType: 'deep-research' });
  addAgent(db, { id: 'research-agent-ops', name: 'Operations Research Specialist', workspace: 'ops', roleType: 'research', createdAt: '2026-06-16 01:19:38' });
  db.prepare('INSERT INTO tasks (id, title, assigned_agent_id) VALUES (?,?,?)').run('t1', 'Live work', 'research-agent-ops');
  db.prepare('INSERT INTO tasks (id, title, assigned_agent_id) VALUES (?,?,?)').run('t2', 'More live work', 'research-agent-ops');

  dedupeTrioAgents(db);

  assert.deepEqual(agentIds(db, 'ops', ['research']), ['hexresearch'], 'the Skill-23 row survives');
  // ...and not one task was lost: both followed the survivor.
  const carried = db.prepare("SELECT count(*) c FROM tasks WHERE assigned_agent_id='hexresearch'").get<{ c: number }>().c;
  assert.equal(carried, 2, 'both tasks were repointed onto the survivor');
  assert.equal(db.prepare('SELECT count(*) c FROM tasks').get<{ c: number }>().c, 2, 'no task was destroyed');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});

test('REGRESSION: a stray reference cannot hijack the survivor (engineering x4 DA)', () => {
  // Live `engineering` carries FOUR devils-advocate rows: two leaked in from a merged
  // app-development tree. ONE events row was pinned to 'da-agent-app-development' —
  // and under a "most references wins" rule that single stray reference was enough to
  // beat "Devil's Advocate — Engineering", leaving Engineering with a wrongly-named
  // internal agent. Identity must outrank reference count; the reference is repointed.
  const db = makeDb();
  addWorkspace(db, 'engineering', 'Engineering');
  addAgent(db, { id: 'e39a86464fdad093', name: "Devil's Advocate — App Development", workspace: 'engineering', roleType: 'devils-advocate' });
  addAgent(db, { id: '416655c4915701d3', name: "Devil's Advocate — Engineering", workspace: 'engineering', roleType: 'devils-advocate' });
  addAgent(db, { id: 'da-agent-app-development', name: "App Development Devil's Advocate", workspace: 'engineering', roleType: 'devils-advocate', createdAt: '2026-06-16 01:19:38' });
  addAgent(db, { id: 'da-agent-engineering', name: "Engineering Devil's Advocate", workspace: 'engineering', roleType: 'devils-advocate', createdAt: '2026-06-16 01:19:38' });
  // The exact stray reference from the live DB.
  db.prepare('INSERT INTO tasks (id, title, assigned_agent_id) VALUES (?,?,?)')
    .run('stray', 'Pinned to the wrong DA', 'da-agent-app-development');

  const r = dedupeTrioAgents(db);

  assert.equal(r.agentsRemoved, 3);
  assert.deepEqual(agentIds(db, 'engineering', ['devils-advocate']), ['416655c4915701d3'],
    "Engineering keeps its OWN devil's advocate");
  // The stray reference survived the collapse by moving to the survivor.
  const stray = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id='stray'").get() as { assigned_agent_id: string };
  assert.equal(stray.assigned_agent_id, '416655c4915701d3', 'the stray reference was repointed, not orphaned');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  db.close();
});

test('dedupeTrioAgents is idempotent', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addAgent(db, { id: 'hex1', name: 'Deep Research — Marketing', workspace: 'marketing', roleType: 'deep-research' });
  addAgent(db, { id: 'research-agent-marketing', name: 'Marketing Research Specialist', workspace: 'marketing', roleType: 'research', createdAt: '2026-06-16 01:19:38' });

  const first = dedupeTrioAgents(db);
  assert.equal(first.agentsRemoved, 1);

  const second = dedupeTrioAgents(db);
  assert.equal(second.groupsFound, 0);
  assert.equal(second.agentsRemoved, 0);
  assert.equal(second.aliasesNormalized, 0);
  db.close();
});

// ── 4. Headless-workspace reaper ─────────────────────────────────────────────

test('REGRESSION: a workspace holding only trio agents gets a head materialised', () => {
  // The live shape of all 10 headless blackceo departments: a Research + a DA row,
  // no leadership agent, head_agent_id NULL.
  const db = makeDb();
  addWorkspace(db, 'dept-app-development', 'App Development');
  addAgent(db, { id: 'research-agent-dept-app-development', name: 'App Development Research Specialist', workspace: 'dept-app-development', roleType: 'research' });
  addAgent(db, { id: 'da-agent-dept-app-development', name: "App Development Devil's Advocate", workspace: 'dept-app-development', roleType: 'devils-advocate' });

  assert.equal(findHeadlessWorkspaces(db).length, 1);

  const r = ensureWorkspaceHeadAgents(db);

  assert.equal(r.created, 1);
  assert.equal(r.promoted, 0);
  assert.equal(findHeadlessWorkspaces(db).length, 0, 'no workspace may be headless');

  const head = db
    .prepare('SELECT a.id, a.role_type FROM workspaces w JOIN agents a ON w.head_agent_id = a.id WHERE w.id = ?')
    .get('dept-app-development') as { id: string; role_type: string };
  assert.equal(head.id, 'head-agent-dept-app-development');
  assert.equal(head.role_type, HEAD_ROLE_TYPE, 'heads are leadership rows, like all 54 live heads');
  db.close();
});

test('the head is NEVER a trio agent (the Devil\'s Advocate must not surface)', () => {
  const db = makeDb();
  addWorkspace(db, 'quality-control', 'Quality Control');
  addAgent(db, { id: 'da-agent-quality-control', name: "Quality Control Devil's Advocate", workspace: 'quality-control', roleType: 'devils-advocate' });
  addAgent(db, { id: 'research-agent-quality-control', name: 'Quality Control Research Specialist', workspace: 'quality-control', roleType: 'research' });

  ensureWorkspaceHeadAgents(db);

  const head = db.prepare('SELECT head_agent_id FROM workspaces WHERE id=?').get('quality-control') as { head_agent_id: string };
  const headRole = db.prepare('SELECT role_type FROM agents WHERE id=?').get(head.head_agent_id) as { role_type: string };
  assert.equal(canonicalTrioRole(headRole.role_type), null, 'a trio agent must never be promoted to head');
  assert.equal(headRole.role_type, HEAD_ROLE_TYPE);
  db.close();
});

test('an existing leadership agent is PROMOTED rather than a new head invented', () => {
  const db = makeDb();
  addWorkspace(db, 'anthology', 'Anthology');
  addAgent(db, { id: 'da-1', name: "Anthology Devil's Advocate", workspace: 'anthology', roleType: 'devils-advocate' });
  addAgent(db, { id: 'cmo-1', name: 'Chief Anthology Officer', workspace: 'anthology', roleType: 'leadership' });
  addAgent(db, { id: 'spec-1', name: 'Anthology Specialist', workspace: 'anthology', roleType: 'specialist' });

  const r = ensureWorkspaceHeadAgents(db);

  assert.equal(r.promoted, 1);
  assert.equal(r.created, 0, 'must not mint a head when a leadership agent exists');
  const head = db.prepare('SELECT head_agent_id FROM workspaces WHERE id=?').get('anthology') as { head_agent_id: string };
  assert.equal(head.head_agent_id, 'cmo-1');
  db.close();
});

test('ensureWorkspaceHeadAgents is idempotent and does not churn existing heads', () => {
  const db = makeDb();
  addWorkspace(db, 'sales', 'Sales');
  addAgent(db, { id: 'cso', name: 'Chief Sales Officer', workspace: 'sales', roleType: 'leadership' });

  ensureWorkspaceHeadAgents(db);
  const head1 = db.prepare('SELECT head_agent_id FROM workspaces WHERE id=?').get('sales') as { head_agent_id: string };

  const second = ensureWorkspaceHeadAgents(db);
  assert.equal(second.promoted, 0);
  assert.equal(second.created, 0);

  const head2 = db.prepare('SELECT head_agent_id FROM workspaces WHERE id=?').get('sales') as { head_agent_id: string };
  assert.equal(head2.head_agent_id, head1.head_agent_id, 'a settled head is never reassigned');
  db.close();
});

test('a head pointing at a deleted agent is re-materialised (dangling head_agent_id)', () => {
  const db = makeDb();
  addWorkspace(db, 'ops', 'Operations');
  addAgent(db, { id: 'ghost', name: 'Ops Lead', workspace: 'ops', roleType: 'leadership' });
  db.prepare('UPDATE workspaces SET head_agent_id=? WHERE id=?').run('ghost', 'ops');
  db.prepare('DELETE FROM agents WHERE id=?').run('ghost'); // SET NULL fires only with FKs on

  assert.equal(findHeadlessWorkspaces(db).length, 1, 'a head pointing at nothing counts as headless');
  ensureWorkspaceHeadAgents(db);
  assert.equal(findHeadlessWorkspaces(db).length, 0);
  db.close();
});

// ── 5. The two invariants, end to end ────────────────────────────────────────

test('EXIT TEST: after reconciliation — zero duplicate trio agents, zero headless workspaces', () => {
  const db = makeDb();

  // A corrupted estate: duplicated trio, headless floor departments, a legitimate
  // multi-specialist department that must survive untouched.
  addWorkspace(db, 'marketing', 'Marketing');
  addAgent(db, { id: 'hex-r', name: 'Deep Research Specialist — Marketing', workspace: 'marketing', roleType: 'deep-research' });
  addAgent(db, { id: 'hex-da', name: "Devil's Advocate — Marketing", workspace: 'marketing', roleType: 'devils-advocate' });
  addAgent(db, { id: 'hex-cmo', name: 'Chief Marketing Officer', workspace: 'marketing', roleType: 'leadership' });
  addAgent(db, { id: 'research-agent-marketing', name: 'Marketing Research Specialist', workspace: 'marketing', roleType: 'research', createdAt: '2026-06-16 01:19:38' });
  addAgent(db, { id: 'da-agent-marketing', name: "Marketing Devil's Advocate", workspace: 'marketing', roleType: 'devils-advocate', createdAt: '2026-06-16 01:19:38' });

  addWorkspace(db, 'quality-control', 'Quality Control');
  addAgent(db, { id: 'research-agent-quality-control', name: 'Quality Control Research Specialist', workspace: 'quality-control', roleType: 'research' });
  addAgent(db, { id: 'da-agent-quality-control', name: "Quality Control Devil's Advocate", workspace: 'quality-control', roleType: 'devils-advocate' });

  addWorkspace(db, 'presentations', 'Presentations');
  for (let i = 0; i < 17; i++) {
    addAgent(db, { id: `spec-${i}`, name: `Presentation Specialist ${i}`, workspace: 'presentations', roleType: 'specialist' });
  }

  // What migration 092 does, in order.
  dedupeTrioAgents(db);
  ensureWorkspaceHeadAgents(db);

  assert.deepEqual(findDuplicateTrioAgents(db), [], 'zero duplicate trio agents');
  assert.deepEqual(findHeadlessWorkspaces(db), [], 'zero headless workspaces');
  assert.equal(db.prepare("SELECT count(*) c FROM agents WHERE role_type='specialist'").get<{ c: number }>().c, 17,
    'the 17-specialist department is untouched');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'no dangling foreign keys');

  // And the estate is now STABLE: a further re-provision tops up only what is
  // genuinely ABSENT and duplicates nothing. Absent here: a QC agent for marketing,
  // a QC agent for quality-control, and the whole trio for presentations (which had
  // only specialists) = 5 slots. Every already-filled slot is skipped.
  const ws = db.prepare('SELECT id, name FROM workspaces').all() as { id: string; name: string }[];
  const reseed = seedTrioForWorkspaces(db, ws);
  assert.equal(reseed.qc, 3, 'QC was missing for marketing, quality-control and presentations');
  assert.equal(reseed.research, 1, 'only presentations lacked a research agent');
  assert.equal(reseed.devilsAdvocate, 1, 'only presentations lacked a devil\'s advocate');
  assert.deepEqual(findDuplicateTrioAgents(db), [], 'still zero duplicates after re-provisioning');

  const reseedAgain = seedTrioForWorkspaces(db, ws);
  assert.equal(reseedAgain.qc + reseedAgain.research + reseedAgain.devilsAdvocate, 0, 'fully converged');
  db.close();
});

test('TRIO_ROLE_TYPES is the canonical three', () => {
  assert.deepEqual([...TRIO_ROLE_TYPES], ['qc', 'research', 'devils-advocate']);
});
