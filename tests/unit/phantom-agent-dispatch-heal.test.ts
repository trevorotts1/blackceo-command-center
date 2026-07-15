/**
 * phantom-agent-dispatch-heal.test.ts — C-03 (skill6-v2 U34).
 *
 * Proves the fake-agent silent-skip fix: `autoDispatchTask`'s "agent not
 * found" branch (task-dispatcher.ts) used to `console.warn + return` — no
 * event, no backoff, no block, no operator alert, and the card kept its dead
 * `assigned_agent_id` forever. This now heals LOUDLY:
 *
 *   (a) a task whose assigned_agent_id has no matching `agents` row gets
 *       exactly ONE `events` row (type 'phantom_agent_healed', metadata
 *       reason 'assigned_agent_missing') and its assigned_agent_id is
 *       cleared (NULL) afterward — proving the silent skip is gone;
 *   (b) the SAME task is then routed by the next runIntakeAdvanceSweep()
 *       call to a REAL seeded agent — proving the self-heal actually
 *       un-sticks the card instead of just logging about it;
 *   (c) a task with a VALID agent takes the unchanged fast path: no
 *       phantom_agent_healed event is written and its assigned_agent_id is
 *       never touched by this guard;
 *   (d) the underlying healing primitive is CAS-guarded: two calls racing
 *       the exact same phantom id heal it exactly once (one event, not two).
 *
 * HERMETIC / OPERATOR-BOX SAFE:
 *   - `DATABASE_PATH` points at a private throwaway file (never the real
 *     mission-control.db).
 *   - `HOME` is overridden to an empty throwaway directory BEFORE importing
 *     task-dispatcher, so `resolveSpecialistSessionKey`'s `~/.openclaw/
 *     agents/<slug>/` filesystem probe can NEVER resolve a real runtime on
 *     this operator's own machine — dispatch for a validly-routed task
 *     deterministically HOLDS at the `no_specialist_runtime` gate and never
 *     reaches `getOpenClawClient()` / a live gateway send.
 *   - `OWNER_NOTIFY_TELEGRAM_DISABLED=1` + an invalid gateway URL, matching
 *     the existing `dispatch-hardblock-sovereignty.test.ts` convention.
 *
 *   node --import tsx --test tests/unit/phantom-agent-dispatch-heal.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-phantom-heal-'));
const TMP_DB = path.join(TMP_ROOT, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

// Never resolve a real ~/.openclaw/agents/<slug>/ runtime on this box.
const FAKE_HOME = path.join(TMP_ROOT, 'fake-home');
fs.mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

// Never attempt a real Telegram send or a real gateway socket.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;

// No real API keys — force the deterministic keyword/explicit-tag routing
// path (no embeddings call).
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;

process.env.QC_MAX_REROUTES = '3';
process.env.MAX_DISPATCH_ATTEMPTS = '5';
// Zero grace so a just-healed/just-updated task is immediately selectable by
// runIntakeAdvanceSweep() in the same test tick.
process.env.INTAKE_ADVANCE_GRACE_SECONDS = '0';
process.env.CAMPAIGN_BOARD_FEED_DISABLED = '1';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type DispatcherModule = typeof import('../../src/lib/task-dispatcher');
let autoDispatchTask: DispatcherModule['autoDispatchTask'];

type HealerModule = typeof import('../../src/lib/jobs/heal-phantom-assignments');
let healPhantomAgentAssignment: HealerModule['healPhantomAgentAssignment'];

type SweepModule = typeof import('../../src/lib/jobs/intake-advance-sweep');
let runIntakeAdvanceSweep: SweepModule['runIntakeAdvanceSweep'];

const REAL_AGENT_ID = 'agent-graphics-real';
const PHANTOM_AGENT_ID = 'agent-00000000-dead-does-not-exist';

test.before(async () => {
  const db: DbModule = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // run the full migration chain

  const now = new Date().toISOString();

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Test Company', 'default', '{}', ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, sort_order, created_at, updated_at)
     VALUES ('ws-graphics', 'Graphics', 'graphics', 'Graphics dept', '🎨', 'default', 10, ?, ?)`,
    [now, now],
  );
  run(
    `INSERT OR IGNORE INTO agents
       (id, name, role, description, avatar_emoji, status, is_master, workspace_id, specialist_type, created_at, updated_at)
     VALUES (?, 'Graphics Lead', 'Graphics Lead', 'Graphics specialist', '🎨', 'standby', 0, 'ws-graphics', 'permanent', ?, ?)`,
    [REAL_AGENT_ID, now, now],
  );

  const dispatcher: DispatcherModule = await import('../../src/lib/task-dispatcher');
  autoDispatchTask = dispatcher.autoDispatchTask;

  const healer: HealerModule = await import('../../src/lib/jobs/heal-phantom-assignments');
  healPhantomAgentAssignment = healer.healPhantomAgentAssignment;

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

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Insert a task with an assigned_agent_id that may not reference a real
 * `agents` row. A fresh DB's `tasks.assigned_agent_id` carries a live
 * `REFERENCES agents(id)` clause under `PRAGMA foreign_keys = ON`, which
 * legitimately blocks a naive INSERT of a phantom id — exactly the DB-01
 * class of protected box the spec calls out. Real phantom rows still occur
 * in production via (i) a pre-migration table whose REFERENCES clause
 * predates the constraint, (ii) a foreign-keys-off migration window
 * (db/migrations.ts), or (iii) raw SQL / manual DB surgery bypassing the API
 * route. This helper reproduces exactly that: it disables enforcement for
 * ONE insert (never for the surrounding test) to seed the fixture, then
 * restores it immediately — the app-level `run()`/`transaction()` helpers
 * used everywhere else keep foreign_keys ON.
 */
function seedTaskBypassingFk(opts: {
  id: string;
  title: string;
  status: string;
  workspaceId: string;
  assignedAgentId: string;
  department?: string;
}): void {
  const now = new Date().toISOString();
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  try {
    run(
      `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, assigned_agent_id, created_at, updated_at)
       VALUES (?, ?, ?, 'medium', ?, NULL, ?, ?, ?, ?)`,
      [opts.id, opts.title, opts.status, opts.workspaceId, opts.department ?? null, opts.assignedAgentId, now, now],
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function seedRealTask(opts: {
  id: string;
  title: string;
  status: string;
  workspaceId: string;
  assignedAgentId: string;
}): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, assigned_agent_id, created_at, updated_at)
     VALUES (?, ?, ?, 'medium', ?, NULL, ?, ?, ?)`,
    [opts.id, opts.title, opts.status, opts.workspaceId, opts.assignedAgentId, now, now],
  );
}

function countPhantomHealedEvents(taskId: string): number {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'phantom_agent_healed'`,
    [taskId],
  );
  return row?.n ?? 0;
}

// ── (a)+(b): the flip — loud, then self-healing ─────────────────────────────

test('[C-03 a] autoDispatchTask heals a phantom assignment: NULLs the id, writes exactly one events row with reason assigned_agent_missing', async () => {
  const taskId = 'task-phantom-a';
  seedTaskBypassingFk({
    id: taskId,
    title: 'Design a banner',
    status: 'backlog',
    workspaceId: 'ws-graphics',
    assignedAgentId: PHANTOM_AGENT_ID,
    department: 'Graphics',
  });

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  const task = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.strictEqual(task?.assigned_agent_id, null, 'the phantom assigned_agent_id must be cleared');

  const events = queryAll<{ message: string; metadata: string | null }>(
    `SELECT message, metadata FROM events WHERE task_id = ? AND type = 'phantom_agent_healed'`,
    [taskId],
  );
  assert.strictEqual(events.length, 1, 'exactly one phantom_agent_healed events row must be written');
  const metadata = JSON.parse(events[0].metadata ?? '{}');
  assert.strictEqual(metadata.reason, 'assigned_agent_missing');
  assert.strictEqual(metadata.dead_agent_id, PHANTOM_AGENT_ID);
  assert.ok(events[0].message.includes(PHANTOM_AGENT_ID), 'the message must name the dead id');
});

test('[C-03 b] the same task is then routed by the next runIntakeAdvanceSweep() call to a real seeded agent', async () => {
  const taskId = 'task-phantom-b';
  seedTaskBypassingFk({
    id: taskId,
    title: 'Design a banner for the campaign',
    status: 'backlog',
    workspaceId: 'ws-graphics',
    assignedAgentId: PHANTOM_AGENT_ID,
    department: 'Graphics',
  });

  // C-03's own real-time catch (inside autoDispatchTask) and C-04's
  // sweep-tail heal pass (which runs BEFORE this tick's selection query)
  // are mutually dependent and ship together: the sweep-tail heals the
  // phantom id proactively at the top of THIS call, so the row is already
  // unassigned by the time the selection query runs and gets routed to a
  // real agent within this SAME tick — "the next runIntakeAdvanceSweep()
  // call" routes it, with no second call required.
  const result = await runIntakeAdvanceSweep();
  assert.ok(result.routed >= 1, 'the tick must route at least one previously-phantom task');

  const afterTick = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.strictEqual(
    afterTick?.assigned_agent_id,
    REAL_AGENT_ID,
    'the task must be routed to the real seeded agent, not left phantom or unassigned',
  );

  const realAgentRow = queryOne<{ id: string }>('SELECT id FROM agents WHERE id = ?', [
    afterTick?.assigned_agent_id ?? '',
  ]);
  assert.ok(realAgentRow, 'the resulting assigned_agent_id must reference a real agents row');

  const healedEvent = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'phantom_agent_healed'`,
    [taskId],
  );
  assert.ok(healedEvent, 'a phantom_agent_healed event must have been written for this task');
});

// ── (c): valid agent takes the unchanged fast path ──────────────────────────

test('[C-03 c] a task with a VALID agent is never touched by the phantom-heal guard', async () => {
  const taskId = 'task-valid-agent';
  seedRealTask({
    id: taskId,
    title: 'Task with a real agent',
    status: 'backlog',
    workspaceId: 'ws-graphics',
    assignedAgentId: REAL_AGENT_ID,
  });

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  assert.strictEqual(countPhantomHealedEvents(taskId), 0, 'no phantom_agent_healed event for a valid agent');

  const task = queryOne<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.strictEqual(
    task?.assigned_agent_id,
    REAL_AGENT_ID,
    'a valid assignment must never be cleared by the phantom-heal guard',
  );
});

// ── (d): CAS-guarded — exactly once even under a race ───────────────────────

test('[C-03 d] healPhantomAgentAssignment is CAS-guarded: a second call on the same phantom id is a no-op', () => {
  const taskId = 'task-phantom-race';
  seedTaskBypassingFk({
    id: taskId,
    title: 'Racy phantom',
    status: 'backlog',
    workspaceId: 'ws-graphics',
    assignedAgentId: PHANTOM_AGENT_ID,
  });

  const first = healPhantomAgentAssignment(taskId, PHANTOM_AGENT_ID, 'test-caller-1');
  const second = healPhantomAgentAssignment(taskId, PHANTOM_AGENT_ID, 'test-caller-2');

  assert.strictEqual(first, true, 'the first caller must perform the heal');
  assert.strictEqual(second, false, 'the second caller must lose the CAS race and no-op');
  assert.strictEqual(countPhantomHealedEvents(taskId), 1, 'exactly one event must exist despite two callers');
});

test('autoDispatchTask: re-import is stable after the phantom-heal wiring (no circular dep crash)', async () => {
  const mod = await import('../../src/lib/task-dispatcher');
  assert.strictEqual(typeof mod.autoDispatchTask, 'function');
  assert.strictEqual(typeof mod.healPhantomAgentAssignment === 'undefined', true, 'healer stays owned by its own module, not re-exported');
});
