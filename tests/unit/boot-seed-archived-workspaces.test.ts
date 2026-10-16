/**
 * BOOT SEEDERS MUST SKIP ARCHIVED WORKSPACES.
 *
 * VERIFIED ON A CLIENT BOX: every Command Center restart re-ran the boot
 * seeders across EVERY workspace row, archived ones included, and minted a head
 * + QC + research + devil's-advocate into each of 12 soft-archived departments —
 * 48 agent rows attached to departments the board does not show, counted by
 * every workforce total, dispatchable by nothing. The archived rows were the
 * audit trail the v7.6.38 sync script leaves behind when it prunes or de-dupes
 * a department (`pruned: absent from build-state`, `deduped: loser of <id>`)
 * plus the owner's own declines.
 *
 * The invariant these tests pin:
 *   an archived workspace NEVER receives an agent,
 *   NEVER gets un-archived, and
 *   NEVER gets a head_agent_id stamped on it.
 *
 * Plus the one-time cleanup (migration 153): agent rows already leaked into an
 * archived workspace are deleted ONLY when nothing anywhere references them;
 * a referenced row is kept and reported, never destroyed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  archivedWorkspaces,
  seedTrioForWorkspaces,
  ensureWorkspaceHeadAgents,
  findHeadlessWorkspaces,
  cleanupAgentsInArchivedWorkspaces,
  reseedWorkspacesFromConfig,
  TRIO_ROLE_TYPES,
  HEAD_ROLE_TYPE,
} from '../../src/lib/db/migrations';

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * The live shape, trimmed to what the seeders touch: workspaces (archive
 * columns + head pointer), agents, tasks, companies. `withArchiveColumns=false`
 * reproduces a pre-migration-095 database, which has no archive concept at all.
 */
function makeDb(withArchiveColumns = true): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-archived-seed-'));
  const db = new Database(path.join(dir, 'archived-seed.test.db'));
  db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      industry TEXT,
      logo_url TEXT,
      config TEXT DEFAULT '{}'
    );
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT,
      description TEXT,
      icon TEXT,
      company_id TEXT DEFAULT 'default',
      sort_order INTEGER DEFAULT 1000,
      head_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      updated_at TEXT DEFAULT (datetime('now'))
      ${withArchiveColumns ? ', archived_at TEXT, archived_reason TEXT' : ''}
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
      specialist_type TEXT DEFAULT 'on-call',
      role_type TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      workspace_id TEXT,
      assigned_agent_id TEXT REFERENCES agents(id),
      created_by_agent_id TEXT REFERENCES agents(id)
    );
    -- a conventional agent-id column with NO declared foreign key, exactly like
    -- task_qc_results.qc_agent_id on the live schema
    CREATE TABLE task_qc_results (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      qc_agent_id TEXT
    );
  `);
  return db;
}

function addWorkspace(
  db: Database.Database,
  id: string,
  name: string,
  archivedReason?: string,
): void {
  db.prepare(
    'INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?, ?, ?, ?, 1000)',
  ).run(id, name, id, '📁');
  if (archivedReason !== undefined) {
    db.prepare(
      "UPDATE workspaces SET archived_at = '2026-09-01T00:00:00.000Z', archived_reason = ? WHERE id = ?",
    ).run(archivedReason, id);
  }
}

function addAgent(
  db: Database.Database,
  a: { id: string; workspace: string; roleType: string | null; isMaster?: boolean },
): void {
  db.prepare(
    `INSERT INTO agents (id, name, role, workspace_id, role_type, is_master)
     VALUES (?, ?, 'Specialist', ?, ?, ?)`,
  ).run(a.id, a.id, a.workspace, a.roleType, a.isMaster ? 1 : 0);
}

const agentsIn = (db: Database.Database, ws: string): string[] =>
  (
    db.prepare('SELECT id FROM agents WHERE workspace_id = ? ORDER BY id').all(ws) as {
      id: string;
    }[]
  ).map((r) => r.id);

// ── 1. the archived set itself ───────────────────────────────────────────────

test('archivedWorkspaces reports every archived row with its reason', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addWorkspace(db, 'dept-marketing', 'Marketing', 'deduped: loser of marketing');
  addWorkspace(db, 'retired-dept', 'Retired', 'pruned: absent from build-state');

  const archived = archivedWorkspaces(db);
  assert.equal(archived.size, 2);
  assert.equal(archived.get('dept-marketing'), 'deduped: loser of marketing');
  assert.equal(archived.get('retired-dept'), 'pruned: absent from build-state');
  assert.equal(archived.has('marketing'), false, 'a live workspace is never in the archived set');
  db.close();
});

test('archivedWorkspaces is EMPTY on a pre-095 database (no archived_at column)', () => {
  const db = makeDb(false);
  addWorkspace(db, 'marketing', 'Marketing');
  assert.equal(archivedWorkspaces(db).size, 0, 'no archive column means no archive concept');
  db.close();
});

// ── 2. the trio seeder ───────────────────────────────────────────────────────

test('REGRESSION: the boot trio seeder seeds the LIVE workspace and skips the ARCHIVED one', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addWorkspace(db, 'dept-marketing', 'Marketing', 'deduped: loser of marketing');

  const r = seedTrioForWorkspaces(db, [
    { id: 'marketing', name: 'Marketing' },
    { id: 'dept-marketing', name: 'Marketing' },
  ]);

  assert.equal(r.qc, 1);
  assert.equal(r.research, 1);
  assert.equal(r.devilsAdvocate, 1);
  assert.equal(r.skippedArchived, 1);
  assert.deepEqual(agentsIn(db, 'marketing'), [
    'da-agent-marketing',
    'qc-agent-marketing',
    'research-agent-marketing',
  ]);
  assert.deepEqual(agentsIn(db, 'dept-marketing'), [], 'an archived workspace receives NOTHING');
  db.close();
});

test('a SECOND boot creates nothing — neither for the live nor the archived workspace', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addWorkspace(db, 'dept-marketing', 'Marketing', 'deduped: loser of marketing');
  const ws = [
    { id: 'marketing', name: 'Marketing' },
    { id: 'dept-marketing', name: 'Marketing' },
  ];

  seedTrioForWorkspaces(db, ws);
  const before = db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };

  const second = seedTrioForWorkspaces(db, ws);
  assert.equal(second.qc + second.research + second.devilsAdvocate, 0, 'nothing new on re-boot');
  assert.equal(second.skipped, TRIO_ROLE_TYPES.length, 'the live trio slots are already filled');
  assert.equal(second.skippedArchived, 1);

  const after = db.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number };
  assert.equal(after.n, before.n, 'restarting the Command Center adds no agent rows');
  db.close();
});

test('MUTATION PROOF: the SAME call seeds the SAME workspace once it is un-archived', () => {
  // If the archived filter were removed, the first assertion below would pass
  // anyway — so prove the filter is reading archived_at and nothing else by
  // flipping ONLY that column and re-running the identical call.
  const db = makeDb();
  addWorkspace(db, 'legal', 'Legal', 'declined');
  const ws = [{ id: 'legal', name: 'Legal' }];

  const archivedRun = seedTrioForWorkspaces(db, ws);
  assert.equal(archivedRun.qc + archivedRun.research + archivedRun.devilsAdvocate, 0);
  assert.deepEqual(agentsIn(db, 'legal'), []);

  db.prepare('UPDATE workspaces SET archived_at = NULL, archived_reason = NULL WHERE id = ?').run(
    'legal',
  );

  const liveRun = seedTrioForWorkspaces(db, ws);
  assert.equal(liveRun.qc, 1);
  assert.equal(liveRun.research, 1);
  assert.equal(liveRun.devilsAdvocate, 1);
  assert.equal(liveRun.skippedArchived, 0);
  assert.equal(agentsIn(db, 'legal').length, 3, 'un-archiving restores normal seeding');
  db.close();
});

test('a pre-095 database still seeds every workspace (no behaviour change)', () => {
  const db = makeDb(false);
  addWorkspace(db, 'marketing', 'Marketing');
  addWorkspace(db, 'sales', 'Sales');

  const r = seedTrioForWorkspaces(db, [
    { id: 'marketing', name: 'Marketing' },
    { id: 'sales', name: 'Sales' },
  ]);

  assert.equal(r.qc, 2);
  assert.equal(r.skippedArchived, 0);
  assert.equal(agentsIn(db, 'sales').length, 3);
  db.close();
});

// ── 3. the head seeder ───────────────────────────────────────────────────────

test('REGRESSION: an archived workspace is never reported headless and never gets a head', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addWorkspace(db, 'retired-dept', 'Retired', 'pruned: absent from build-state');

  const headless = findHeadlessWorkspaces(db).map((w) => w.id);
  assert.deepEqual(headless, ['marketing'], 'an archived workspace with no head is not a defect');

  const r = ensureWorkspaceHeadAgents(db);
  assert.equal(r.created, 1, 'only the live department gets a head materialised');

  const retired = db
    .prepare('SELECT head_agent_id FROM workspaces WHERE id = ?')
    .get('retired-dept') as { head_agent_id: string | null };
  assert.equal(retired.head_agent_id, null, 'head_agent_id is never stamped on an archived row');
  assert.deepEqual(agentsIn(db, 'retired-dept'), [], 'no Department Head is minted for it');

  const live = db.prepare('SELECT head_agent_id FROM workspaces WHERE id = ?').get('marketing') as {
    head_agent_id: string;
  };
  const headRole = db.prepare('SELECT role_type FROM agents WHERE id = ?').get(live.head_agent_id) as {
    role_type: string;
  };
  assert.equal(headRole.role_type, HEAD_ROLE_TYPE);
  db.close();
});

test('an archived workspace does NOT get un-archived by the head seeder', () => {
  const db = makeDb();
  addWorkspace(db, 'retired-dept', 'Retired', 'pruned: absent from build-state');
  ensureWorkspaceHeadAgents(db);
  const row = db
    .prepare('SELECT archived_at, archived_reason FROM workspaces WHERE id = ?')
    .get('retired-dept') as { archived_at: string | null; archived_reason: string | null };
  assert.equal(row.archived_at, '2026-09-01T00:00:00.000Z');
  assert.equal(row.archived_reason, 'pruned: absent from build-state');
  db.close();
});

// ── 4. the manifest re-seed (reseedWorkspacesFromConfig) ─────────────────────

test('the manifest UPSERT leaves an archived row archived, untouched and un-agented', () => {
  const db = makeDb();
  db.prepare("INSERT INTO companies (id, name, slug) VALUES ('northwind', 'Northwind', 'northwind')").run();
  addWorkspace(db, 'marketing', 'Marketing');
  addWorkspace(db, 'retired-dept', 'Retired', 'pruned: absent from build-state');
  // A stale display value the reseed WOULD have refreshed on an unarchived row.
  db.prepare("UPDATE workspaces SET name = 'Retired (old name)', icon = '🗄️' WHERE id = ?").run(
    'retired-dept',
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-archived-manifest-'));
  fs.writeFileSync(
    path.join(fixtureRoot, 'departments.json'),
    JSON.stringify([
      { id: 'marketing', slug: 'marketing', name: 'Marketing', emoji: '📣' },
      { id: 'retired-dept', slug: 'retired-dept', name: 'Retired Department', emoji: '🧪' },
    ]),
  );

  const saved = {
    fixture: process.env.CC_TEST_FIXTURE_ROOT,
    zhc: process.env.ZERO_HUMAN_COMPANY_DIR,
    ccRoot: process.env.BLACKCEO_COMMAND_CENTER_ROOT,
    companyName: process.env.COMPANY_NAME,
    companySlug: process.env.COMPANY_SLUG,
  };
  process.env.CC_TEST_FIXTURE_ROOT = fixtureRoot;
  delete process.env.ZERO_HUMAN_COMPANY_DIR;
  delete process.env.BLACKCEO_COMMAND_CENTER_ROOT;
  delete process.env.COMPANY_NAME;
  delete process.env.COMPANY_SLUG;

  try {
    const r = reseedWorkspacesFromConfig(db, { force: true });
    assert.equal(r.outcome, 'seeded');
    assert.equal(r.created, 0, 'no NEW row is minted for the archived department');

    const retired = db
      .prepare('SELECT name, icon, archived_at, archived_reason FROM workspaces WHERE id = ?')
      .get('retired-dept') as {
      name: string;
      icon: string;
      archived_at: string | null;
      archived_reason: string | null;
    };
    assert.equal(retired.archived_at, '2026-09-01T00:00:00.000Z', 'still archived');
    assert.equal(retired.archived_reason, 'pruned: absent from build-state', 'reason preserved');
    assert.equal(retired.name, 'Retired (old name)', 'display fields are not re-synced either');

    assert.deepEqual(agentsIn(db, 'retired-dept'), [], 'and it gets no trio and no head');

    // The live department is seeded exactly as before — the guard is targeted.
    const liveAgents = agentsIn(db, 'marketing');
    assert.equal(liveAgents.length, 4, 'live department: head + QC + research + DA');
    const liveName = db.prepare('SELECT name FROM workspaces WHERE id = ?').get('marketing') as {
      name: string;
    };
    assert.equal(liveName.name, 'Marketing');

    // A second boot is a no-op on both.
    const again = reseedWorkspacesFromConfig(db, { force: true });
    assert.equal(again.created, 0);
    assert.deepEqual(agentsIn(db, 'retired-dept'), []);
    assert.equal(agentsIn(db, 'marketing').length, 4, 'restarting adds no agents');

    // Only ONE row represents the retired department — never a fresh live twin.
    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM workspaces WHERE slug = 'retired-dept'")
      .get() as { n: number };
    assert.equal(rows.n, 1);
  } finally {
    if (saved.fixture === undefined) delete process.env.CC_TEST_FIXTURE_ROOT;
    else process.env.CC_TEST_FIXTURE_ROOT = saved.fixture;
    if (saved.zhc !== undefined) process.env.ZERO_HUMAN_COMPANY_DIR = saved.zhc;
    if (saved.ccRoot !== undefined) process.env.BLACKCEO_COMMAND_CENTER_ROOT = saved.ccRoot;
    if (saved.companyName !== undefined) process.env.COMPANY_NAME = saved.companyName;
    if (saved.companySlug !== undefined) process.env.COMPANY_SLUG = saved.companySlug;
    db.close();
  }
});

// ── 5. the one-time cleanup (migration 153) ──────────────────────────────────

test('cleanup DELETES unreferenced stray agents in an archived workspace', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addWorkspace(db, 'retired-dept', 'Retired', 'pruned: absent from build-state');

  // The exact leak: a head + the trio, minted into the archived department.
  for (const [id, role] of [
    ['head-agent-retired-dept', HEAD_ROLE_TYPE],
    ['qc-agent-retired-dept', 'qc'],
    ['research-agent-retired-dept', 'research'],
    ['da-agent-retired-dept', 'devils-advocate'],
  ] as const) {
    addAgent(db, { id, workspace: 'retired-dept', roleType: role });
  }
  db.prepare('UPDATE workspaces SET head_agent_id = ? WHERE id = ?').run(
    'head-agent-retired-dept',
    'retired-dept',
  );
  // Real work in the live department must be untouched.
  addAgent(db, { id: 'qc-agent-marketing', workspace: 'marketing', roleType: 'qc' });

  const r = cleanupAgentsInArchivedWorkspaces(db);

  assert.equal(r.archivedWorkspaces, 1);
  assert.equal(r.headPointersCleared, 1);
  assert.equal(r.agentsDeleted, 4);
  assert.equal(r.agentsKept, 0);
  assert.deepEqual(agentsIn(db, 'retired-dept'), []);
  assert.deepEqual(agentsIn(db, 'marketing'), ['qc-agent-marketing'], 'live agents are untouched');

  const retired = db
    .prepare('SELECT head_agent_id, archived_at FROM workspaces WHERE id = ?')
    .get('retired-dept') as { head_agent_id: string | null; archived_at: string | null };
  assert.equal(retired.head_agent_id, null);
  assert.ok(retired.archived_at, 'the workspace row itself is PRESERVED, still archived');
  db.close();
});

test('cleanup KEEPS every referenced agent and names it', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addWorkspace(db, 'retired-dept', 'Retired', 'declined');

  addAgent(db, { id: 'stray', workspace: 'retired-dept', roleType: 'qc' });
  addAgent(db, { id: 'has-task', workspace: 'retired-dept', roleType: 'research' });
  addAgent(db, { id: 'heads-a-live-dept', workspace: 'retired-dept', roleType: HEAD_ROLE_TYPE });
  addAgent(db, { id: 'scored-qc', workspace: 'retired-dept', roleType: 'qc' });
  addAgent(db, { id: 'the-orchestrator', workspace: 'retired-dept', roleType: null, isMaster: true });

  // a declared FK reference
  db.prepare("INSERT INTO tasks (id, title, assigned_agent_id) VALUES ('t1', 'real work', 'has-task')").run();
  // a LIVE workspace's head pointer — never cleared, so the agent stays referenced
  db.prepare('UPDATE workspaces SET head_agent_id = ? WHERE id = ?').run(
    'heads-a-live-dept',
    'marketing',
  );
  // a conventional, FK-less agent-id column
  db.prepare("INSERT INTO task_qc_results (id, task_id, qc_agent_id) VALUES ('q1', 't1', 'scored-qc')").run();

  const r = cleanupAgentsInArchivedWorkspaces(db);

  assert.equal(r.agentsDeleted, 1, 'only the unreferenced stray goes');
  assert.equal(r.agentsKept, 3);
  assert.deepEqual(
    r.kept.map((k) => k.id).sort(),
    ['has-task', 'heads-a-live-dept', 'scored-qc'],
    'every kept agent is reported by name',
  );
  assert.deepEqual(agentsIn(db, 'retired-dept').sort(), [
    'has-task',
    'heads-a-live-dept',
    'scored-qc',
    'the-orchestrator',
  ]);

  const liveHead = db.prepare('SELECT head_agent_id FROM workspaces WHERE id = ?').get('marketing') as {
    head_agent_id: string;
  };
  assert.equal(liveHead.head_agent_id, 'heads-a-live-dept', "a live department's head pointer survives");
  db.close();
});

test('cleanup is idempotent and a no-op when nothing is archived', () => {
  const db = makeDb();
  addWorkspace(db, 'marketing', 'Marketing');
  addAgent(db, { id: 'qc-agent-marketing', workspace: 'marketing', roleType: 'qc' });

  const clean = cleanupAgentsInArchivedWorkspaces(db);
  assert.equal(clean.archivedWorkspaces, 0);
  assert.equal(clean.agentsDeleted, 0);
  assert.equal(agentsIn(db, 'marketing').length, 1);

  addWorkspace(db, 'retired-dept', 'Retired', 'operator');
  addAgent(db, { id: 'stray', workspace: 'retired-dept', roleType: 'qc' });

  assert.equal(cleanupAgentsInArchivedWorkspaces(db).agentsDeleted, 1);
  const second = cleanupAgentsInArchivedWorkspaces(db);
  assert.equal(second.agentsDeleted, 0, 'a second run finds nothing left to delete');
  assert.equal(second.agentsKept, 0);
  db.close();
});

test('cleanup is a no-op on a pre-095 database', () => {
  const db = makeDb(false);
  addWorkspace(db, 'marketing', 'Marketing');
  addAgent(db, { id: 'qc-agent-marketing', workspace: 'marketing', roleType: 'qc' });

  const r = cleanupAgentsInArchivedWorkspaces(db);
  assert.equal(r.archivedWorkspaces, 0);
  assert.equal(r.agentsDeleted, 0);
  assert.equal(agentsIn(db, 'marketing').length, 1);
  db.close();
});
