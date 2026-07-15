/**
 * blocked-ask-invariant.test.ts — the poison state must be UNCREATABLE.
 *
 * INCIDENT (2026-07-14): a standing set of tasks sat in Blocked with
 * `blocked_on_human` naming a human and `ask` EMPTY. A human blocked on a task
 * with NO QUESTION cannot answer it → the task never leaves Blocked → the
 * ten-minute stale sweep re-escalates it → forever. Hundreds of identical
 * escalations per hour.
 *
 * These tests pin the invariant `blocked_on_human IS NOT NULL ⇒ non-blank ask`
 * at all three layers (request validation, service gate, DATABASE), pin the
 * actual producer (the stuck-in-progress sweep, which set blocked_on_human but
 * wrote its instruction into a DIFFERENT column), and pin the two things the fix
 * must NOT do: destroy pre-existing rows, or silence escalation.
 *
 * Every assertion here FAILS on pre-fix code.
 *
 *   DATABASE_PATH=/tmp/scratch-blocked-ask.db \
 *     node --import tsx --test tests/unit/blocked-ask-invariant.test.ts
 */

// Sweep env (mirrors stuck-in-progress-sweep.test.ts): no shell-out notifies.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.DISABLE_STUCK_IN_PROGRESS_SWEEP;
process.env.STUCK_IN_PROGRESS_MINUTES = '45';

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { UpdateTaskSchema, UpdateAdCampaignStageSchema } from '../../src/lib/validation';
import {
  isBlankAsk,
  violatesBlockedAskInvariant,
  BLOCKED_ASK_TRIGGER_SQL,
  BLOCKED_ASK_TRIGGER_NAMES,
} from '../../src/lib/blocked-ask';
import { runStuckInProgressSweep } from '../../src/lib/jobs/stuck-in-progress-sweep';

const db = getDb();

const REAL_ASK = 'Approve the $200/mo ad spend increase in the billing portal, then move this card to Done.';

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function seedWorkspace(label: string): string {
  const id = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    id, label, `${label}-${uuidv4().slice(0, 8)}`,
  ]);
  return id;
}

function seedAgent(workspaceId: string, status = 'working'): string {
  const id = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master, status) VALUES (?, ?, ?, ?, 0, ?)', [
    id, 'Director of Communications', 'Department Head', workspaceId, status,
  ]);
  return id;
}

/** A plain, unblocked task. */
function seedTask(workspaceId: string, opts: { status?: string; agentId?: string | null } = {}): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, assigned_agent_id, updated_at, last_progress_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id, 'Author SOP: Welcome to the department', opts.status ?? 'backlog', workspaceId,
      opts.agentId ?? null, isoMinutesAgo(90), isoMinutesAgo(90),
    ],
  );
  return id;
}

// ===========================================================================
// LAYER 0 — the blank-ask definition
// ===========================================================================

test('isBlankAsk treats NULL, whitespace-only, and the rendered placeholder as EMPTY', () => {
  assert.equal(isBlankAsk(null), true, 'NULL is blank');
  assert.equal(isBlankAsk(undefined), true, 'undefined is blank');
  assert.equal(isBlankAsk(''), true, 'empty string is blank');
  assert.equal(isBlankAsk('   \t\n  '), true, 'whitespace-only is blank');
  // The exact string the stale-task sweep renders for a missing ask. Round-tripped
  // back into the column it is no more answerable than NULL.
  assert.equal(isBlankAsk('(no ask specified)'), true, 'the rendered placeholder is blank');
  assert.equal(isBlankAsk('  (No Ask Specified)  '), true, 'placeholder is case/space insensitive');
  assert.equal(isBlankAsk('no ask specified'), true, 'unparenthesised placeholder is blank');

  assert.equal(isBlankAsk(REAL_ASK), false, 'a real instruction is NOT blank');
  assert.equal(isBlankAsk('Send the W-9.'), false, 'a short real instruction is NOT blank');
});

test('violatesBlockedAskInvariant fires ONLY on the poison pair', () => {
  assert.equal(violatesBlockedAskInvariant({ blocked_on_human: 'operator', ask: null }), true);
  assert.equal(violatesBlockedAskInvariant({ blocked_on_human: 'owner', ask: '  ' }), true);
  assert.equal(violatesBlockedAskInvariant({ blocked_on_human: 'operator', ask: REAL_ASK }), false);
  // No human named ⇒ nobody is waiting ⇒ a missing ask is not the poison state.
  assert.equal(violatesBlockedAskInvariant({ blocked_on_human: null, ask: null }), false);
  assert.equal(violatesBlockedAskInvariant({}), false);
});

// ===========================================================================
// LAYER 1 — request validation (the creation/update boundary)
// ===========================================================================

test('UpdateTaskSchema REJECTS blocked_on_human with an empty / placeholder / missing ask', () => {
  for (const ask of [undefined, null, '', '    ', '(no ask specified)']) {
    const payload: Record<string, unknown> = { status: 'blocked', blocked_reason: 'approval', blocked_on_human: 'operator' };
    if (ask !== undefined) payload.ask = ask;

    const parsed = UpdateTaskSchema.safeParse(payload);
    assert.equal(
      parsed.success,
      false,
      `blocked_on_human + ask=${JSON.stringify(ask)} must be REJECTED — a human blocked with no question can never answer it`,
    );
    assert.ok(
      parsed.success === false && parsed.error.issues.some((i) => i.path.join('.') === 'ask'),
      'the rejection must point at `ask`',
    );
  }
});

test('UpdateTaskSchema REJECTS the poison pair even when `status` is not being touched', () => {
  // The route's status=blocked gate never sees this payload; only the schema can.
  const parsed = UpdateTaskSchema.safeParse({ blocked_on_human: 'owner' });
  assert.equal(parsed.success, false, 'naming a human without an ask is rejected on ANY update');
});

test('UpdateTaskSchema ACCEPTS a real ask, and accepts the unblock (all-null) payload', () => {
  const blocked = UpdateTaskSchema.safeParse({
    status: 'blocked', blocked_reason: 'approval', blocked_on_human: 'operator', ask: REAL_ASK,
  });
  assert.equal(blocked.success, true, 'a genuine blocked task with a real ask is still allowed — escalation is NOT silenced');

  const unblock = UpdateTaskSchema.safeParse({
    status: 'in_progress', blocked_reason: null, blocked_on_human: null, ask: null,
  });
  assert.equal(unblock.success, true, 'leaving Blocked (clearing all three) must still be allowed');
});

test('UpdateAdCampaignStageSchema REJECTS the same poison pair', () => {
  const bad = UpdateAdCampaignStageSchema.safeParse({
    stage_slug: 'creative', status: 'blocked', blocked_reason: 'approval', blocked_on_human: 'operator', ask: '   ',
  });
  assert.equal(bad.success, false, 'ad stage cards obey the same invariant');

  const good = UpdateAdCampaignStageSchema.safeParse({
    stage_slug: 'creative', status: 'blocked', blocked_reason: 'approval', blocked_on_human: 'operator', ask: REAL_ASK,
  });
  assert.equal(good.success, true, 'a real ask still passes');
});

// ===========================================================================
// LAYER 2 — the DATABASE. Code validation cannot stop a raw
// run('UPDATE tasks SET ...'); the triggers can.
// ===========================================================================

test('migration 104 installed BOTH invariant triggers', () => {
  for (const name of BLOCKED_ASK_TRIGGER_NAMES) {
    const row = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?",
      [name],
    );
    assert.ok(row, `trigger ${name} must exist on the live schema`);
  }
});

test('DB REJECTS a raw INSERT of a task blocked on a human with no ask', () => {
  const ws = seedWorkspace('finance');
  assert.throws(
    () =>
      run(
        `INSERT INTO tasks (id, title, status, workspace_id, blocked_on_human, ask) VALUES (?, ?, 'blocked', ?, 'operator', NULL)`,
        [uuidv4(), 'Author SOP: Welcome to finance', ws],
      ),
    /blocked_on_human requires a non-empty ask/,
    'the poison row must be unwritable even by a raw INSERT',
  );
});

test('DB REJECTS a raw UPDATE that parks a task on a human with a blank / placeholder ask', () => {
  const ws = seedWorkspace('sales');
  const taskId = seedTask(ws);

  for (const ask of [null, '   ', '(no ask specified)']) {
    assert.throws(
      () =>
        run(
          `UPDATE tasks SET status='blocked', blocked_on_human='operator', ask=? WHERE id=?`,
          [ask, taskId],
        ),
      /blocked_on_human requires a non-empty ask/,
      `raw UPDATE with ask=${JSON.stringify(ask)} must ABORT`,
    );
  }

  // The row is untouched by the aborted writes.
  const row = queryOne<{ blocked_on_human: string | null; ask: string | null }>(
    'SELECT blocked_on_human, ask FROM tasks WHERE id = ?', [taskId],
  );
  assert.equal(row?.blocked_on_human, null, 'the aborted write left no partial state');
});

test('DB ALLOWS a genuine block (real ask) — escalation is NOT silenced', () => {
  const ws = seedWorkspace('ops');
  const taskId = seedTask(ws);

  run(
    `UPDATE tasks SET status='blocked', blocked_reason='approval', blocked_on_human='operator', ask=? WHERE id=?`,
    [REAL_ASK, taskId],
  );

  const row = queryOne<{ status: string; blocked_on_human: string; ask: string }>(
    'SELECT status, blocked_on_human, ask FROM tasks WHERE id = ?', [taskId],
  );
  assert.equal(row?.status, 'blocked', 'a genuinely-stuck task still reaches Blocked');
  assert.equal(row?.blocked_on_human, 'operator', 'and still names the human it needs');
  assert.equal(row?.ask, REAL_ASK, 'and now carries an answerable question');
});

// ===========================================================================
// ⛔ SAFETY — the pre-existing rows this incident already created carry REAL
// task_deliverables + task_activities. The invariant is FORWARD-ONLY: it must
// never reject, rewrite, or destroy them on migration.
// ===========================================================================

test('pre-existing poisoned rows SURVIVE the invariant, keep their work-product, and stay archivable + repairable', () => {
  const ws = seedWorkspace('legal');

  // Simulate a box that ALREADY has poisoned rows when migration 104 lands:
  // drop the triggers, write the legacy rows + their real work-product, then
  // re-apply the EXACT trigger DDL the migration applies.
  for (const name of BLOCKED_ASK_TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);

  const legacyIds = [uuidv4(), uuidv4()];
  for (const id of legacyIds) {
    run(
      `INSERT INTO tasks (id, title, status, workspace_id, blocked_on_human, ask, updated_at)
       VALUES (?, ?, 'blocked', ?, 'operator', NULL, ?)`,
      [id, 'Author SOP: Welcome to legal', ws, isoMinutesAgo(6000)],
    );
    run(
      `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path) VALUES (?, ?, 'file', ?, ?)`,
      [uuidv4(), id, 'Welcome SOP draft', '/work/welcome-sop.md'],
    );
    run(
      `INSERT INTO task_activities (id, task_id, activity_type, message) VALUES (?, ?, 'file_created', ?)`,
      [uuidv4(), id, 'Agent produced the SOP draft'],
    );
  }

  // ── The migration lands on the poisoned DB. It must NOT throw. ──
  assert.doesNotThrow(() => {
    for (const sql of BLOCKED_ASK_TRIGGER_SQL) db.exec(sql);
  }, 'installing the invariant on a DB that ALREADY holds poisoned rows must not fail');

  // ── The rows and their work-product survived. ──
  for (const id of legacyIds) {
    const row = queryOne<{ id: string; ask: string | null }>('SELECT id, ask FROM tasks WHERE id = ?', [id]);
    assert.ok(row, 'the legacy poisoned task row SURVIVED — never DELETE, it holds real work-product');
    const deliverables = queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM task_deliverables WHERE task_id = ?', [id],
    );
    assert.equal(deliverables?.n, 1, 'its deliverable survived');
    const activities = queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM task_activities WHERE task_id = ?', [id],
    );
    assert.equal(activities?.n, 1, 'its activity survived');
  }

  // ── ARCHIVE (the sanctioned cleanup path) still works on a legacy row: the
  //    UPDATE does not name blocked_on_human/ask, so the trigger never fires.
  assert.doesNotThrow(
    () => run('UPDATE tasks SET archived_at = ? WHERE id = ?', [new Date().toISOString(), legacyIds[0]]),
    'a legacy poisoned row must remain ARCHIVABLE (reversible cleanup, never DELETE)',
  );
  const archived = queryOne<{ archived_at: string | null }>(
    'SELECT archived_at FROM tasks WHERE id = ?', [legacyIds[0]],
  );
  assert.ok(archived?.archived_at, 'archived_at was set — the row is still there, just archived');

  // ── REPAIR: giving a legacy row a real ask passes the trigger.
  assert.doesNotThrow(
    () => run('UPDATE tasks SET ask = ? WHERE id = ?', [REAL_ASK, legacyIds[1]]),
    'a legacy poisoned row must remain REPAIRABLE (supply the missing ask)',
  );

  // ── UNBLOCK: clearing the human passes too (NULL blocked_on_human ⇒ no poison).
  const spare = uuidv4();
  for (const name of BLOCKED_ASK_TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, blocked_on_human, ask) VALUES (?, ?, 'blocked', ?, 'owner', NULL)`,
    [spare, 'Author SOP: Welcome to legal', ws],
  );
  for (const sql of BLOCKED_ASK_TRIGGER_SQL) db.exec(sql);
  assert.doesNotThrow(
    () =>
      run(
        `UPDATE tasks SET status='in_progress', blocked_reason=NULL, blocked_on_human=NULL, ask=NULL WHERE id=?`,
        [spare],
      ),
    'moving a legacy poisoned row OUT of Blocked must remain possible',
  );
});

// ===========================================================================
// THE PRODUCER — the stuck-in-progress sweep wrote the poison rows: it set
// blocked_on_human='operator' and put its instruction in `block_needs`,
// a DIFFERENT column, leaving `ask` NULL.
// ===========================================================================

test('the stuck-in-progress sweep now writes an ANSWERABLE ask alongside blocked_on_human', async () => {
  const ws = seedWorkspace('engineering');
  const agentId = seedAgent(ws, 'working');
  const taskId = seedTask(ws, { status: 'in_progress', agentId }); // 90 min of no progress

  // Drop the DB triggers for THIS test so we observe what the sweep's own code
  // writes with no database gate in the way. This isolates the CODE fix (the sweep
  // must populate `ask` itself) from the DB fix (migration 104), and makes the
  // assertion independent of trigger state. Restored at the end.
  for (const name of BLOCKED_ASK_TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  try {
    const result = await runStuckInProgressSweep();
    assert.ok(result.blockedIds.includes(taskId), 'the silently-stuck task is auto-blocked (safety net intact)');

    const row = queryOne<{ blocked_on_human: string | null; ask: string | null; block_needs: string | null }>(
      'SELECT blocked_on_human, ask, block_needs FROM tasks WHERE id = ?', [taskId],
    );
    assert.equal(row?.blocked_on_human, 'operator', 'it names the operator as the human being waited on');
    assert.ok(row?.block_needs, 'it writes its human-readable instruction into block_needs');
    assert.equal(
      isBlankAsk(row?.ask),
      false,
      'PRE-FIX BUG: the sweep named the operator in blocked_on_human but left `ask` NULL — its instruction ' +
        'went to block_needs, a DIFFERENT column. The operator was paged with NO question, could never clear ' +
        'the task, and it re-escalated every sweep tick forever. THIS is what produced the flood.',
    );
    assert.ok((row?.ask ?? '').length <= 500, 'the ask respects the 500-char cap on the column');
  } finally {
    for (const sql of BLOCKED_ASK_TRIGGER_SQL) db.exec(sql);
  }
});

test('with the invariant LIVE, the stuck sweep still blocks + escalates — it is not silently aborted', async () => {
  // ⛔ ESCALATION MUST STILL HAPPEN. The DB triggers are a gate on the poison pair,
  // NOT a mute button: a producer that writes a REAL ask must sail straight through
  // them. If the sweep still wrote a blank ask, its metadata UPDATE would ABORT
  // against the trigger, the abort would be swallowed, and the genuinely-stuck task
  // would silently NEVER be escalated — trading a flood for a blackout. Pre-fix code
  // fails this test for exactly that reason.
  for (const name of BLOCKED_ASK_TRIGGER_NAMES) {
    assert.ok(
      queryOne("SELECT name FROM sqlite_master WHERE type='trigger' AND name = ?", [name]),
      `trigger ${name} must be live for this test to mean anything`,
    );
  }

  const ws = seedWorkspace('product');
  const agentId = seedAgent(ws, 'working');
  const taskId = seedTask(ws, { status: 'in_progress', agentId });

  const result = await runStuckInProgressSweep();
  assert.ok(
    result.blockedIds.includes(taskId),
    'the stuck task STILL reaches Blocked with the invariant enforced — the gate rejects the poison pair, ' +
      'it does not suppress the escalation',
  );

  const row = queryOne<{ status: string; blocked_on_human: string | null; ask: string | null }>(
    'SELECT status, blocked_on_human, ask FROM tasks WHERE id = ?', [taskId],
  );
  assert.equal(row?.status, 'blocked', 'the card is on the board in Blocked');
  assert.equal(row?.blocked_on_human, 'operator', 'the operator is still named');
  assert.equal(isBlankAsk(row?.ask), false, 'and the operator is handed a question they can actually answer');
});
