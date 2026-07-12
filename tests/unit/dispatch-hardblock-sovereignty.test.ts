/**
 * dispatch-hardblock-sovereignty.test.ts — P1-01 step 3.
 *
 * A model-sovereignty refusal (no sovereign / modality-fit model resolved) is
 * NON-TRANSIENT: retrying it cannot cure a missing model. The old ladder retried
 * it 5× over ~33 min and only alerted the owner at the cap — the silent-refusal
 * defect (#3 of the phantom-worker chain). recordDispatchFailure now supports a
 * `hardBlock` class that BLOCKS + reports on THIS attempt, no retry.
 *
 * FAIL-FIRST PROOF (Section 2.1 item 3): against the PRE-FIX recordDispatchFailure
 * (origin/main v5.16.2) the first sovereignty failure only DEFERRED — attempts=1,
 * status stayed 'backlog', no task_blocked event — so the "blocked on attempt 1"
 * assertion FAILS pre-fix and PASSES post-fix. The control test (non-hardBlock)
 * proves the ordinary retry ladder is unchanged.
 *
 *   node --import tsx --test tests/unit/dispatch-hardblock-sovereignty.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hardblock-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
// Keep the notify path hermetic — never attempt a real Telegram send in test.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
// Invalid gateway URL so no live socket/timer is opened by the module graph.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type DispatcherModule = typeof import('../../src/lib/task-dispatcher');
let recordDispatchFailure: DispatcherModule['recordDispatchFailure'];

const AGENT_ID = 'agent-hardblock';

function insertTask(id: string): void {
  const now = new Date().toISOString();
  // workspace_id / business_id NULL → no FK dependency on a seeded workspace row.
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id, dispatch_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, NULL, NULL, 0, ?, ?)`,
    [id, `Task ${id}`, 'Cannot resolve a sovereign model.', AGENT_ID, now, now],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // run migrations

  run(
    `INSERT INTO agents (id, name, role, is_master, workspace_id) VALUES (?, ?, ?, 0, NULL)`,
    [AGENT_ID, 'Hard Block Agent', 'specialist'],
  );

  const dispatcher = await import('../../src/lib/task-dispatcher');
  recordDispatchFailure = dispatcher.recordDispatchFailure;
});

test.after(async () => {
  delete process.env.OWNER_NOTIFY_TELEGRAM_DISABLED;
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) { clearInterval(timer); delete g['__openclaw_cache_cleanup_timer__']; }
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── hardBlock: model-sovereignty refusal blocks + reports on attempt 1 ────────
test('[P1-01] a hardBlock (model_sovereignty) failure BLOCKS + reports on attempt 1', () => {
  const id = 'hb-sovereignty';
  insertTask(id);

  recordDispatchFailure(id, AGENT_ID, {
    reason: 'model_sovereignty_needs_owner_input',
    audience: 'OWNER',
    needs: 'Assign/approve a model (Settings → Models) to release it.',
    context: 'test',
    hardBlock: true,
  });

  const task = queryOne<{ status: string; dispatch_attempts: number; block_audience: string | null; block_reason: string | null }>(
    'SELECT status, dispatch_attempts, block_audience, block_reason FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(task!.status, 'blocked', 'a sovereignty refusal must BLOCK on attempt 1, not retry');
  assert.equal(task!.dispatch_attempts, 1, 'it must block on the FIRST attempt (not the 5th)');
  assert.equal(task!.block_audience, 'OWNER', 'the owner must be the block audience');
  assert.ok(
    (task!.block_reason ?? '').startsWith('model_sovereignty'),
    'block_reason must record the sovereignty class',
  );

  const blockedEvt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'task_blocked' LIMIT 1`,
    [id],
  );
  assert.ok(blockedEvt, 'a task_blocked event must be written on attempt 1');
  assert.ok(
    blockedEvt!.message.includes('non-transient'),
    'the block note must mark the failure non-transient (not "after N attempts")',
  );
});

// ── control: an ordinary (transient) failure still uses the retry ladder ──────
test('[P1-01] a transient failure (no hardBlock) still DEFERS on attempt 1', () => {
  const id = 'hb-transient';
  insertTask(id);

  recordDispatchFailure(id, AGENT_ID, {
    reason: 'gateway_unreachable',
    audience: 'SYSTEM',
    needs: 'Runtime temporarily unavailable; will retry.',
    context: 'test',
  });

  const task = queryOne<{ status: string; dispatch_attempts: number; next_dispatch_eligible_at: string | null }>(
    'SELECT status, dispatch_attempts, next_dispatch_eligible_at FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(task!.status, 'backlog', 'a transient failure must NOT block on attempt 1');
  assert.equal(task!.dispatch_attempts, 1, 'the attempt counter increments');
  assert.ok(task!.next_dispatch_eligible_at, 'a backoff window must be stamped for retry');

  const deferredEvt = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'task_dispatch_deferred' LIMIT 1`,
    [id],
  );
  assert.ok(deferredEvt, 'a task_dispatch_deferred event must be written for the transient retry');
});
