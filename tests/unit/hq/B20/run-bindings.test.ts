/**
 * B20 — trusted CC dispatch → ACTUAL gateway run binding.
 *
 * PROVES (the two semantics the B20 check names):
 *
 *   1. ACCEPTED-NOT-DELIVERED. The record shaped by an ACCEPTED dispatch says
 *      `accepted`, carries NO delivery timestamp, and there is no input on that
 *      path which can make it read `delivered`. `recordDispatchRunOutcome`
 *      refuses `delivered` without an explicit delivery timestamp, so an
 *      accepted dispatch that is never delivered can never be recorded as
 *      delivered — the negative is structural, not a convention.
 *
 *   2. UNCERTAIN SEND IS NOT REPLAYED INTO A DUPLICATE. An unacknowledged send
 *      binds as `uncertain` (not terminal, never `delivered`), it is NOT
 *      accepted-run evidence — so it can neither suppress nor stand in for an
 *      accepted run — and a replay of the SAME gateway run never produces a
 *      second mapping: the row is extended in place and its original
 *      task/execution attribution is preserved.
 *
 * Also locked here: company scoping of the reader, the `hq-chat` private-owner
 * classification (SPEC S9), the addressable-session-key fallback (a gateway
 * sentinel must never be stored as a run), and the un-migrated-box degradation
 * (missing table = no binding, never a throw into dispatch).
 *
 * Harness: isolated temp DB + the SHIPPED DDL constant, because the reserved
 * additive HQ migration belongs to B01 and is not on this branch yet — an
 * un-migrated box is exactly the degrade case asserted at the end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hq-run-bindings-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];

type DispatcherModule = typeof import('../../../../src/lib/task-dispatcher');
let recordDispatchRunBinding: DispatcherModule['recordDispatchRunBinding'];
let acceptedRunReplayForTask: DispatcherModule['acceptedRunReplayForTask'];
let resolveDispatchRunBinding: DispatcherModule['resolveDispatchRunBinding'];
let recordDispatchRunOutcome: DispatcherModule['recordDispatchRunOutcome'];
let dispatchRunIdentity: DispatcherModule['dispatchRunIdentity'];
let gatewayRunIdFromResult: DispatcherModule['gatewayRunIdFromResult'];
let HQ_RUN_BINDINGS_DDL: string;

const COMPANY = 'company-b20';
const WS = 'ws-b20';
const AGENT = 'agent-b20';
const SESSION_KEY = 'agent:dept-b20:mission-control-agent-b20-exec-b20';
const ACCEPTED_RUN = 'run-b20-accepted';
const EXECUTION = 'exec-b20';
/** The deterministic no-runtime sentinel the dispatch routes fall back to. */
const SENTINEL_KEY = `mission-control-${AGENT}-${EXECUTION}`;

function seedTask(id: string, opts: { requesterChannel?: string | null; requesterChatId?: string | null } = {}): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id,
       workspace_id, department, requester_channel, requester_chat_id, created_at, updated_at)
     VALUES (?, ?, 'B20 binding fixture.', 'in_progress', 'medium', ?, ?, 'dept-b20', ?, ?, ?, ?)`,
    [id, `B20 binding task ${id}`, AGENT, WS, opts.requesterChannel ?? null, opts.requesterChatId ?? null, now, now],
  );
}

function bindingsFor(taskId: string) {
  return queryAll<{
    runtime_run_id: string;
    runtime_session_key: string | null;
    execution_id: string | null;
    visibility: string;
    owner_subject: string | null;
    outcome: string;
    delivered_at: string | null;
  }>(
    `SELECT runtime_run_id, runtime_session_key, execution_id, visibility, owner_subject, outcome, delivered_at
       FROM hq_run_bindings WHERE task_id = ? ORDER BY recorded_at`,
    [taskId],
  );
}

test.before(async () => {
  const db = (await import('../../../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  db.getDb(); // full migration chain against the temp DB

  const td = (await import('../../../../src/lib/task-dispatcher')) as DispatcherModule;
  recordDispatchRunBinding = td.recordDispatchRunBinding;
  acceptedRunReplayForTask = td.acceptedRunReplayForTask;
  resolveDispatchRunBinding = td.resolveDispatchRunBinding;
  recordDispatchRunOutcome = td.recordDispatchRunOutcome;
  dispatchRunIdentity = td.dispatchRunIdentity;
  gatewayRunIdFromResult = td.gatewayRunIdFromResult;
  HQ_RUN_BINDINGS_DDL = td.HQ_RUN_BINDINGS_DDL;

  // B01 owns applying this DDL in the reserved additive HQ migration; it is not
  // on this branch, so stand it up from the SHIPPED constant — the same string
  // B01's migration will carry.
  db.getDb().exec(HQ_RUN_BINDINGS_DDL);

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES (?, 'B20 Company', 'b20-company', '{}', ?, ?)`,
    [COMPANY, now, now],
  );
  run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, icon, company_id, sort_order, created_at, updated_at)
     VALUES (?, 'dept-b20', 'B20 Dept', '🧪', ?, 1, ?, ?)`,
    [WS, COMPANY, now, now],
  );
  run(
    `INSERT OR IGNORE INTO agents (id, name, role, avatar_emoji, status, is_master, specialist_type,
       workspace_id, created_at, updated_at)
     VALUES (?, 'B20 Worker', 'B20 Operations', '🤖', 'standby', 0, 'permanent', ?, ?, ?)`,
    [AGENT, WS, now, now],
  );
});

test.after(async () => {
  try { closeDb(); } catch { /* best-effort */ }
  try { fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── 1. ACCEPTED IS NOT DELIVERED ─────────────────────────────────────────────

test('[B20-1] an ACCEPTED dispatch records accepted with NO delivery timestamp, and the accepted path cannot write delivered', () => {
  const taskId = 'b20-task-accepted';
  seedTask(taskId);

  recordDispatchRunBinding({
    taskId,
    executionId: EXECUTION,
    agentId: AGENT,
    sessionKey: SESSION_KEY,
    acceptedRunId: ACCEPTED_RUN,
    outcome: 'accepted',
  });

  const rows = bindingsFor(taskId);
  assert.equal(rows.length, 1, 'exactly one binding is written for one accepted dispatch');
  assert.equal(rows[0].runtime_run_id, ACCEPTED_RUN, 'the binding names the gateway runId, not a local id');
  assert.equal(rows[0].outcome, 'accepted');
  assert.equal(rows[0].delivered_at, null, 'ACCEPTED IS NOT DELIVERED — delivered_at must be NULL');
  assert.equal(rows[0].execution_id, EXECUTION, 'the canonical CC execution id is recorded');
  assert.equal(rows[0].visibility, 'task-audience', 'an ordinary task run is task-audience');

  // The only writer of 'delivered' refuses to write it without real evidence.
  assert.equal(
    recordDispatchRunOutcome({ companyId: COMPANY, runtimeRunId: ACCEPTED_RUN, outcome: 'delivered' }),
    false,
    'delivered without an explicit delivery timestamp is REFUSED',
  );
  const after = bindingsFor(taskId)[0];
  assert.equal(after.outcome, 'accepted', 'the accepted record is untouched by the refused write');
  assert.equal(after.delivered_at, null);

  // …and accepts it once explicit evidence is supplied.
  assert.equal(
    recordDispatchRunOutcome({
      companyId: COMPANY,
      runtimeRunId: ACCEPTED_RUN,
      outcome: 'delivered',
      deliveredAt: new Date().toISOString(),
    }),
    true,
    'a delivery proven with an explicit timestamp is recorded',
  );
  assert.notEqual(bindingsFor(taskId)[0].delivered_at, null);
});

test('[B20-2] the accepted-run replay evidence is exactly the accepted, undocumented-delivery run', () => {
  const taskId = 'b20-task-replay-evidence';
  seedTask(taskId);
  recordDispatchRunBinding({
    taskId, executionId: EXECUTION, agentId: AGENT, sessionKey: SESSION_KEY,
    acceptedRunId: 'run-b20-evidence', outcome: 'accepted',
  });

  const evidence = acceptedRunReplayForTask(taskId, WS);
  assert.ok(evidence, 'an accepted run is replay evidence for this task');
  assert.equal(evidence!.executionId, EXECUTION, 'the route reports WHICH execution was accepted');

  // A DIFFERENT task with no binding yields nothing — the guard never fires blind.
  seedTask('b20-task-no-binding');
  assert.equal(acceptedRunReplayForTask('b20-task-no-binding', WS), null);

  // A foreign workspace/company cannot produce evidence for this task.
  assert.equal(acceptedRunReplayForTask(taskId, 'ws-does-not-exist'), null);
});

// ── 2. UNCERTAIN SEND ────────────────────────────────────────────────────────

test('[B20-3] an UNCERTAIN send records uncertain, is not delivered, and is not accepted-run evidence', () => {
  const taskId = 'b20-task-uncertain';
  seedTask(taskId);

  recordDispatchRunBinding({
    taskId, executionId: EXECUTION, agentId: AGENT, sessionKey: SESSION_KEY,
    acceptedRunId: null, outcome: 'uncertain',
  });

  const rows = bindingsFor(taskId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'uncertain', 'an unacknowledged send is uncertain, never accepted');
  assert.equal(rows[0].delivered_at, null);
  assert.equal(
    rows[0].runtime_run_id,
    SESSION_KEY,
    'with no accepted runId the binding names the ADDRESSED gateway session key — the only trusted identity available',
  );

  // Not accepted evidence: an uncertain send must never stand in for an accepted
  // run, so nothing downstream can treat unproven delivery as admission.
  assert.equal(
    acceptedRunReplayForTask(taskId, WS),
    null,
    'an uncertain send is NOT accepted-run evidence — unproven work is never counted as admitted',
  );
});

test('[B20-4] replaying the SAME gateway run extends the binding in place — no second mapping, no duplicate', () => {
  const taskId = 'b20-task-replay';
  seedTask(taskId);
  const bind = (executionId: string) =>
    recordDispatchRunBinding({
      taskId, executionId, agentId: AGENT, sessionKey: SESSION_KEY,
      acceptedRunId: 'run-b20-replay', outcome: 'accepted',
    });

  bind('exec-first');
  const first = bindingsFor(taskId)[0];
  const firstExpiry = queryOne<{ expires_at: string }>(
    'SELECT expires_at FROM hq_run_bindings WHERE task_id = ?',
    [taskId],
  )!.expires_at;

  // Same run observed again (a replayed replay).
  bind('exec-second');
  const rows = bindingsFor(taskId);
  assert.equal(rows.length, 1, 'one gateway run maps to exactly ONE row — a replay never duplicates it');
  assert.equal(rows[0].execution_id, 'exec-first', 'the ORIGINAL execution attribution is preserved, never rewritten');
  assert.equal(rows[0].runtime_run_id, first.runtime_run_id);

  const secondExpiry = queryOne<{ expires_at: string }>(
    'SELECT expires_at FROM hq_run_bindings WHERE task_id = ?',
    [taskId],
  )!.expires_at;
  assert.ok(
    Date.parse(secondExpiry) >= Date.parse(firstExpiry),
    'a re-observation EXTENDS the 48h window rather than creating a new record',
  );
});

// ── 3. Trusted identity and scope ────────────────────────────────────────────

test('[B20-5] the run identity is gateway-issued: accepted runId first, addressable session key second, sentinel never', () => {
  assert.equal(gatewayRunIdFromResult({ runId: 'run-x' }), 'run-x');
  assert.equal(gatewayRunIdFromResult({ run_id: 'run-y' }), 'run-y', 'the snake_case result shape is honoured too');
  assert.equal(gatewayRunIdFromResult({ ok: true }), null, 'an acknowledgement with no run id yields NO identity');
  assert.equal(gatewayRunIdFromResult(undefined), null);

  assert.equal(dispatchRunIdentity({ sessionKey: SESSION_KEY, acceptedRunId: 'run-z' }), 'run-z');
  assert.equal(
    dispatchRunIdentity({ sessionKey: SESSION_KEY, acceptedRunId: null }),
    SESSION_KEY,
    'without an accepted runId the addressed gateway session key is the fallback identity',
  );
  assert.equal(
    dispatchRunIdentity({ sessionKey: SENTINEL_KEY, acceptedRunId: null }),
    null,
    'the deterministic no-runtime sentinel is NOT a gateway object — no binding may name it',
  );
});

test('[B20-6] a sentinel session key writes NO binding at all', () => {
  const taskId = 'b20-task-sentinel';
  seedTask(taskId);
  recordDispatchRunBinding({
    taskId, executionId: EXECUTION, agentId: AGENT, sessionKey: SENTINEL_KEY,
    acceptedRunId: null, outcome: 'uncertain',
  });
  assert.equal(bindingsFor(taskId).length, 0, 'a binding that names no gateway object is worse than no binding');
});

test('[B20-7] an hq-chat task binds private-owner with its owner subject; every other channel is task-audience', () => {
  const privateTask = 'b20-task-private';
  const publicTask = 'b20-task-public';
  seedTask(privateTask, { requesterChannel: 'hq-chat', requesterChatId: 'owner-subject-1' });
  seedTask(publicTask, { requesterChannel: 'telegram', requesterChatId: 'chat-1' });

  recordDispatchRunBinding({
    taskId: privateTask, executionId: EXECUTION, agentId: AGENT, sessionKey: SESSION_KEY,
    acceptedRunId: 'run-b20-private', outcome: 'accepted',
  });
  recordDispatchRunBinding({
    taskId: publicTask, executionId: EXECUTION, agentId: AGENT, sessionKey: SESSION_KEY,
    acceptedRunId: 'run-b20-public', outcome: 'accepted',
  });

  const priv = bindingsFor(privateTask)[0];
  assert.equal(priv.visibility, 'private-owner', 'a private HQ turn keeps owner-subject privacy (SPEC S9)');
  assert.equal(priv.owner_subject, 'owner-subject-1');

  const pub = bindingsFor(publicTask)[0];
  assert.equal(pub.visibility, 'task-audience');
  assert.equal(pub.owner_subject, null, 'an ordinary task run carries no owner subject');
});

test('[B20-8] the reader is company-scoped, and a rebind never inherits a foreign or reassigned mapping', () => {
  const taskId = 'b20-task-scope';
  seedTask(taskId);
  recordDispatchRunBinding({
    taskId, executionId: EXECUTION, agentId: AGENT, sessionKey: SESSION_KEY,
    acceptedRunId: 'run-b20-scope', outcome: 'accepted',
  });

  const mine = resolveDispatchRunBinding(COMPANY, 'run-b20-scope');
  assert.ok(mine, 'the owning company resolves its own run to its task');
  assert.equal(mine!.task_id, taskId);
  assert.equal(
    resolveDispatchRunBinding('company-someone-else', 'run-b20-scope'),
    null,
    'a run bound under another company is NOT FOUND for this one — never returned',
  );

  // A task reassigned to a different agent cannot inherit the old mapping.
  const other = 'b20-task-reassigned';
  seedTask(other);
  run('UPDATE tasks SET assigned_agent_id = NULL WHERE id = ?', [other]);
  recordDispatchRunBinding({
    taskId: other, executionId: EXECUTION, agentId: AGENT, sessionKey: SESSION_KEY,
    acceptedRunId: 'run-b20-reassigned', outcome: 'accepted',
  });
  assert.equal(bindingsFor(other).length, 0, 'the binding requires the row to still name the dispatching agent');
});

// ── 4. Degradation (no throw into dispatch) ──────────────────────────────────

test('[B20-9] an un-migrated box (no hq_run_bindings table) degrades to no binding and never throws', () => {
  const taskId = 'b20-task-degrade';
  seedTask(taskId);

  const db = queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='hq_run_bindings'",
  );
  assert.ok(db, 'precondition: the table exists before this case');
  run('DROP TABLE hq_run_bindings');

  assert.doesNotThrow(() => {
    recordDispatchRunBinding({
      taskId, executionId: EXECUTION, agentId: AGENT, sessionKey: SESSION_KEY,
      acceptedRunId: 'run-b20-degrade', outcome: 'accepted',
    });
  }, 'a capture miss is invisible to the business call it describes');
  assert.equal(acceptedRunReplayForTask(taskId, WS), null, 'with no table there is no evidence — the route behaves as before');
  assert.equal(resolveDispatchRunBinding(COMPANY, 'run-b20-degrade'), null);
  assert.equal(
    recordDispatchRunOutcome({ companyId: COMPANY, runtimeRunId: 'run-b20-degrade', outcome: 'accepted' }),
    false,
  );
});
