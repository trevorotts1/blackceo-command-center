/**
 * heal-phantom-assignments.test.ts — C-04 (skill6-v2 U35).
 *
 * Proves the S2 phantom-assignment healer:
 *   (a) on a fixture DB with 3 phantom assignments and 2 valid ones, the
 *       batch healer reports exactly 3 healed, writes exactly 3 events, and
 *       leaves the 2 valid rows completely untouched;
 *   (b) re-running is idempotent — reports 0 healed;
 *   (c) `done` tasks and archived tasks are NEVER touched, even when phantom;
 *   (d) the sweep-integrated variant heals a freshly-injected phantom within
 *       ONE `runIntakeAdvanceSweep()` call;
 *   (e) the standalone CLI script (scripts/heal-phantom-assignments.ts) run
 *       as a real subprocess against a fixture DB: first run heals, second
 *       run (idempotent) heals nothing — proven through the ACTUAL script
 *       entrypoint, not just the underlying function.
 *
 *   node --import tsx --test tests/unit/heal-phantom-assignments.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-heal-batch-'));
const TMP_DB = path.join(TMP_ROOT, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

const FAKE_HOME = path.join(TMP_ROOT, 'fake-home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

process.env.QC_MAX_REROUTES = '3';
process.env.MAX_DISPATCH_ATTEMPTS = '5';
process.env.INTAKE_ADVANCE_GRACE_SECONDS = '0';
process.env.CAMPAIGN_BOARD_FEED_DISABLED = '1';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type HealerModule = typeof import('../../src/lib/jobs/heal-phantom-assignments');
let healPhantomAssignmentsBatch: HealerModule['healPhantomAssignmentsBatch'];

type SweepModule = typeof import('../../src/lib/jobs/intake-advance-sweep');
let runIntakeAdvanceSweep: SweepModule['runIntakeAdvanceSweep'];

const REAL_AGENT_ID = 'agent-batch-real';
const PHANTOM_1 = 'agent-phantom-1';
const PHANTOM_2 = 'agent-phantom-2';
const PHANTOM_3 = 'agent-phantom-3';

test.before(async () => {
  const db: DbModule = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb();

  const now = new Date().toISOString();

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Test Company', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('ws-batch', 'Batch Dept', 'batch-dept', 'Batch test dept', '🧪', 'default', 10, ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO agents
       (id, name, role, description, avatar_emoji, status, is_master, workspace_id, specialist_type, created_at, updated_at)
     VALUES (?, 'Batch Lead', 'Batch Lead', 'Batch specialist', '🧪', 'standby', 0, 'ws-batch', 'permanent', ?, ?)`,
    [REAL_AGENT_ID, now, now],
  );

  const healer: HealerModule = await import('../../src/lib/jobs/heal-phantom-assignments');
  healPhantomAssignmentsBatch = healer.healPhantomAssignmentsBatch;

  const sweep: SweepModule = await import('../../src/lib/jobs/intake-advance-sweep');
  runIntakeAdvanceSweep = sweep.runIntakeAdvanceSweep;
});

test.after(async () => {
  // Matches dispatch-hardblock-sovereignty.test.ts: autoDispatchTask's real
  // path opens an OpenClaw client with a periodic cache-cleanup interval
  // timer, which otherwise keeps the process alive past test completion.
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) { clearInterval(timer); delete g['__openclaw_cache_cleanup_timer__']; }
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ok */ }
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
  delete process.env.QC_MAX_REROUTES;
  delete process.env.MAX_DISPATCH_ATTEMPTS;
  delete process.env.INTAKE_ADVANCE_GRACE_SECONDS;
  delete process.env.CAMPAIGN_BOARD_FEED_DISABLED;
});

function seedTaskBypassingFk(opts: {
  id: string;
  title: string;
  status: string;
  assignedAgentId: string;
  archivedAt?: string | null;
  department?: string;
}): void {
  const now = new Date().toISOString();
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  try {
    run(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, assigned_agent_id, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, 'medium', 'ws-batch', NULL, ?, ?, ?, ?, ?)`,
      [opts.id, opts.title, opts.status, opts.department ?? null, opts.assignedAgentId, opts.archivedAt ?? null, now, now],
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedRealTask(id: string, title: string, status: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', 'ws-batch', NULL, ?, ?, ?)`,
    [id, title, status, REAL_AGENT_ID, now, now],
  );
}

// ── (a)+(b)+(c): batch heal, idempotent, done/archived untouched ───────────

test('[C-04 a-c] batch healer heals exactly the phantom rows, leaves valid/done/archived rows untouched, and is idempotent', () => {
  seedTaskBypassingFk({ id: 'batch-p1', title: 'Phantom 1', status: 'backlog', assignedAgentId: PHANTOM_1 });
  seedTaskBypassingFk({ id: 'batch-p2', title: 'Phantom 2', status: 'in_progress', assignedAgentId: PHANTOM_2 });
  seedTaskBypassingFk({ id: 'batch-p3', title: 'Phantom 3', status: 'planning', assignedAgentId: PHANTOM_3 });
  // A phantom on a DONE task must NEVER be touched (history stays honest).
  seedTaskBypassingFk({ id: 'batch-p-done', title: 'Phantom but done', status: 'done', assignedAgentId: 'agent-phantom-done' });
  // A phantom on an ARCHIVED task must NEVER be touched.
  seedTaskBypassingFk({
    id: 'batch-p-archived',
    title: 'Phantom but archived',
    status: 'backlog',
    assignedAgentId: 'agent-phantom-archived',
    archivedAt: new Date().toISOString(),
  });
  seedRealTask('batch-v1', 'Valid 1', 'backlog');
  seedRealTask('batch-v2', 'Valid 2', 'in_progress');

  const first = healPhantomAssignmentsBatch({ healedBy: 'test-script' });
  assert.strictEqual(first.healed, 3, 'exactly the 3 non-done, non-archived phantom rows must be healed');
  assert.deepStrictEqual(
    [...first.healedIds].sort(),
    ['batch-p1', 'batch-p2', 'batch-p3'],
    'healedIds must name exactly the 3 healed tasks',
  );

  const eventCount = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE type = 'phantom_agent_healed'
       AND task_id IN ('batch-p1','batch-p2','batch-p3')`,
  );
  assert.strictEqual(eventCount?.n, 3, 'exactly 3 events must be written');

  // Valid rows untouched.
  for (const id of ['batch-v1', 'batch-v2']) {
    const row = queryOne<{ assigned_agent_id: string | null }>(
      'SELECT assigned_agent_id FROM tasks WHERE id = ?',
      [id],
    );
    assert.strictEqual(row?.assigned_agent_id, REAL_AGENT_ID, `${id} must keep its valid agent`);
  }

  // done / archived phantom rows untouched.
  const doneRow = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    ['batch-p-done'],
  );
  assert.strictEqual(doneRow?.assigned_agent_id, 'agent-phantom-done', 'a done task must never be healed');

  const archivedRow = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    ['batch-p-archived'],
  );
  assert.strictEqual(
    archivedRow?.assigned_agent_id,
    'agent-phantom-archived',
    'an archived task must never be healed',
  );

  // Idempotent re-run.
  const second = healPhantomAssignmentsBatch({ healedBy: 'test-script' });
  assert.strictEqual(second.healed, 0, 're-running must heal 0 rows (idempotent)');
  assert.deepStrictEqual(second.healedIds, []);
});

// ── (d): sweep-integrated variant heals within ONE tick ─────────────────────

test('[C-04 d] intake-advance-sweep heals a freshly-injected phantom within ONE runIntakeAdvanceSweep() call', async () => {
  const taskId = 'sweep-fresh-phantom';
  seedTaskBypassingFk({
    id: taskId,
    title: 'Freshly injected phantom',
    status: 'backlog',
    assignedAgentId: 'agent-fresh-phantom',
    department: 'Batch Dept',
  });

  const before = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.strictEqual(before?.assigned_agent_id, 'agent-fresh-phantom', 'sanity: still phantom before the sweep');

  await runIntakeAdvanceSweep();

  const after = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.notStrictEqual(
    after?.assigned_agent_id,
    'agent-fresh-phantom',
    'the phantom id must be gone after exactly one sweep call',
  );
  // Sweep-tail heals BEFORE the tick's own selection query runs, so the
  // now-unassigned row is picked up and routed in that SAME call.
  assert.strictEqual(
    after?.assigned_agent_id,
    REAL_AGENT_ID,
    'within the same tick the healed (now-unassigned) task must be routed to a real agent',
  );

  const healedEvent = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'phantom_agent_healed'`,
    [taskId],
  );
  assert.ok(healedEvent, 'a phantom_agent_healed event must exist for the freshly-injected phantom');
});

// ── (e): the real CLI script, run as a subprocess ───────────────────────────

test('[C-04 e] scripts/heal-phantom-assignments.ts CLI heals then is idempotent on re-run', () => {
  const scriptDb = path.join(TMP_ROOT, 'script-fixture.db');
  const scriptDir = path.resolve(__dirname, '../..');

  // Seed a standalone fixture DB (separate connection/process from the
  // in-process `db` singleton this test file otherwise uses).
  const dbIndexAbsPath = path.join(scriptDir, 'src/lib/db/index.ts');
  const seed = `
    process.env.DATABASE_PATH = ${JSON.stringify(scriptDb)};
    const { getDb, run } = await import(${JSON.stringify(dbIndexAbsPath)});
    const db = getDb();
    const now = new Date().toISOString();
    run("INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES ('default','Test','default','{}',?,?)", [now, now]);
    run("INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at) VALUES ('ws-script','Script','script','Script dept','🧪','default',10,?,?)", [now, now]);
    run("INSERT INTO agents (id, name, role, is_master, workspace_id, created_at, updated_at) VALUES ('agent-script-real','Real','specialist',0,'ws-script',?,?)", [now, now]);
    db.pragma('foreign_keys = OFF');
    run("INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at) VALUES ('script-p1','P1','backlog','medium','ws-script',NULL,'agent-script-dead-1',?,?)", [now, now]);
    run("INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at) VALUES ('script-p2','P2','backlog','medium','ws-script',NULL,'agent-script-dead-2',?,?)", [now, now]);
    db.pragma('foreign_keys = ON');
    db.close();
  `;
  const seedFile = path.join(TMP_ROOT, 'seed-script-fixture.mjs');
  fs.writeFileSync(seedFile, seed);
  execFileSync(process.execPath, ['--import', 'tsx', seedFile], {
    cwd: scriptDir,
    env: { ...process.env, DATABASE_PATH: scriptDb },
  });

  const runScript = (): string =>
    execFileSync(
      process.execPath,
      ['--import', 'tsx', path.join(scriptDir, 'scripts/heal-phantom-assignments.ts')],
      {
        cwd: scriptDir,
        env: { ...process.env, DATABASE_PATH: scriptDb },
        encoding: 'utf8',
      },
    );

  const firstRunOutput = runScript();
  assert.match(firstRunOutput, /healed 2 phantom assignment\(s\)/, 'first run must report 2 healed');
  assert.match(firstRunOutput, /script-p1/);
  assert.match(firstRunOutput, /script-p2/);

  const secondRunOutput = runScript();
  assert.match(secondRunOutput, /healed 0 phantom assignment\(s\)/, 'second run must be idempotent (0 healed)');
  assert.match(secondRunOutput, /nothing to heal/);
});
