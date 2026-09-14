/**
 * UPDATE-014 / Issue39 — POST /api/tasks/[id]/operator-preengine-recovery.
 *
 * THE DEFECT THIS FILE LOCKS DOWN (Issue39 / UPDATE-014)
 *   A successful acknowledgement through autoDispatchTask() calls
 *   recordDispatchSuccess(), which reset the REAL `tasks.dispatch_attempts` to 0.
 *   Preserving the exhausted budget only inside the recovery row did NOT preserve
 *   the task's cap: the reset handed the task a fresh budget, and the two live
 *   advancers (intake-advance-sweep — the single advancement authority — and the
 *   legacy backlog-redispatch-sweep) both select on `dispatch_attempts < cap`.
 *   A reset therefore made the "single-use" recovery re-launchable every tick.
 *
 *   The independent review of candidate cad38907d FAILED on exactly this point.
 *   Against that unmodified candidate the counter assertion below fails with
 *   `0 !== 5` (raw run captured in the Worker B evidence bundle).
 *
 * PD-TEST-050 — ONE RECEIPTED ATTEMPT PER DISTINCT REPAIR, NOT ONE PER TASK
 *   Migration 146 keyed the receipt on `task_id` alone. On 2026-09-14T23:38Z the
 *   one permitted receipt (row 96932757, repair_key
 *   `pd038-notify-env-and-pd039-recovery-counter`) was legitimately consumed and
 *   the engine then died on a DIFFERENT deterministic pre-engine defect
 *   (PD-TEST-049, the F1 requester-shape bug) with NO engine artifacts. A
 *   different repair_key drew 409 `pre_engine_recovery_already_issued`, the same
 *   repair_key replayed idempotently without re-dispatching, and both sweeps gate
 *   on `dispatch_attempts < MAX_DISPATCH_ATTEMPTS` while the counter had already
 *   moved 5 -> 6. The run had no supported re-drive path.
 *
 *   Migration 147 moves uniqueness to (task_id, repair_key) and the library adds
 *   a bounded ledger gate plus a server-side engine-artifact proof. The
 *   PD-TEST-050 tests below cover: (a) a second DISTINCT repair is authorized
 *   when the first produced no engine artifacts; (b) it is REFUSED once the run
 *   produced any (state.json / execution row / receipt); (c) the same repair_key
 *   still replays idempotently; (e) single-use still holds per receipt row;
 *   (f) the counter is preserved on success and incremented by the product's own
 *   failure path; and the ledger bound that stops repair_key invention from
 *   becoming an unbounded retry budget.
 *
 * WHAT IS EXERCISED FOR REAL (nothing reimplemented)
 *   - the real route handler,
 *   - the real issuePreEngineRecovery / claimPreEngineRecoveryDispatch library,
 *   - the real launchOperatorPresentationContract(),
 *   - the real autoDispatchTask() operator-delegated branch,
 *   - the real recordDispatchSuccess()/recordDispatchFailure() accounting,
 *   - the real runIntakeAdvanceSweep() selection/dispatch path,
 *   - the real U061 /resume route,
 *   - a real SQLite DB (isolated per file) with the real migration 147 shape and
 *     the real contracts table.
 *   Only the OUT-OF-PROCESS bridge transport is stubbed: PRESENTATION_INTAKE_BRIDGE
 *   points at a python stub that records each invocation and answers with the
 *   bridge's documented `worker_acknowledged` JSON. No gateway, no network.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { getDb, queryAll, queryOne, run } from '../../src/lib/db';
import { schema } from '../../src/lib/db/schema';
import { bindOperatorPresentationContract, parseOperatorPresentationContract, saveOperatorPresentationContract } from '../../src/lib/presentation-operator-contract';
import { claimPreEngineRecoveryDispatch, operatorContractSha256, preEngineRecoveryEngineArtifacts } from '../../src/lib/presentation-operator-recovery';
import { autoDispatchTask, recordDispatchFailure } from '../../src/lib/task-dispatcher';
import { runIntakeAdvanceSweep } from '../../src/lib/jobs/intake-advance-sweep';
import { POST } from '../../src/app/api/tasks/[id]/operator-preengine-recovery/route';
import { POST as resumeTask } from '../../src/app/api/tasks/[id]/resume/route';

process.env.WEBHOOK_SECRET = 'preengine-recovery-test-secret';
// The deployed route requires BOTH layers when MC_API_TOKEN is set (Bearer +
// HMAC-SHA256 of the exact raw bytes), so the suite runs with both configured.
process.env.MC_API_TOKEN = 'preengine-recovery-test-token';
process.env.MAX_DISPATCH_ATTEMPTS = '5';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preengine-recovery-'));
const bridge = path.join(root, 'bridge.py');
// The ONLY stub: the out-of-process bridge. It records every invocation to
// $CC_TEST_BRIDGE_LOG (so "exactly one bridge retry" is measured, not inferred
// from a history row) and answers with the documented acknowledged status.
fs.writeFileSync(
  bridge,
  [
    'import json, os, sys, time',
    "log = os.environ.get('CC_TEST_BRIDGE_LOG')",
    'if log:',
    "    with open(log, 'a') as fh:",
    "        fh.write(json.dumps({'argv': sys.argv[1:]}) + '\\n')",
    "delay = os.environ.get('CC_TEST_BRIDGE_DELAY')",
    'if delay:',
    '    time.sleep(float(delay))',
    "print(json.dumps({'status': 'worker_acknowledged', 'bridge': {'_rc': 0, 'detail': 'test bridge accepted'}}))",
    '',
  ].join('\n'),
);
process.env.PRESENTATION_INTAKE_BRIDGE = bridge;
process.env.PRESENTATION_OPERATOR_RUNS_DIR = path.join(root, 'runs');

// ── bridge invocation accounting (real subprocess calls, counted from the log) ──
let bridgeLog = path.join(root, 'bridge-calls-initial.jsonl');
function newBridgeLog(): void {
  bridgeLog = path.join(root, `bridge-calls-${uuidv4()}.jsonl`);
  process.env.CC_TEST_BRIDGE_LOG = bridgeLog;
}
function bridgeCalls(): Array<{ argv: string[] }> {
  if (!fs.existsSync(bridgeLog)) return [];
  return fs
    .readFileSync(bridgeLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[] });
}
function callsForTask(taskId: string): Array<{ argv: string[] }> {
  const runDir = path.join(process.env.PRESENTATION_OPERATOR_RUNS_DIR!, `pres-operator-${taskId}`);
  return bridgeCalls().filter((call) => call.argv.includes(runDir));
}

function seed() {
  getDb().exec(schema);
  run(`INSERT OR IGNORE INTO workspaces (id, name, slug) VALUES ('default', 'Default', 'default')`);
  run(`INSERT OR IGNORE INTO agents (id, name, role, role_type, is_master, workspace_id) VALUES ('presentation-worker', 'Presentation Worker', 'presentation-worker', 'worker', 0, 'default')`);
}

const intake = {
  version: 1 as const, source: 'operator-delegated' as const, title: 'How the Presentation Department Works',
  presentation_type: 'from_scratch' as const, run_mode: 'ultra' as const,
  workhorse_model: 'deepseek-flash@deepseek-direct' as const, slide_count: 8, pitch_included: false,
  deliverable_set: 'deck', want_teleprompter: 'yes' as const, want_speech_script: 'yes' as const,
  want_audio_deliverable: 'yes' as const, want_audio_demo: true, want_ghl_upload: 'yes' as const,
  delivery_destinations: ['local'], want_sales_checkout: 'yes' as const, want_vsl_page: 'yes' as const,
  answers: { goal: 'Explain the department' },
};

function insertTask(over: Record<string, unknown>): string {
  const base: Record<string, unknown> = {
    title: intake.title, status: 'blocked', priority: 'medium', workspace_id: 'default',
    department: 'presentations', assigned_agent_id: 'presentation-worker', source: 'operator-delegated',
  };
  const merged = { ...base, ...over };
  const cols = Object.keys(merged);
  run(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    Object.values(merged),
  );
  return String(merged.id);
}

function createOperatorTask(over: Record<string, unknown> = {}) {
  seed();
  const id = insertTask({ id: uuidv4(), dispatch_attempts: 5, ...over });
  const contract = bindOperatorPresentationContract(id, parseOperatorPresentationContract(intake));
  saveOperatorPresentationContract(id, contract);
  return { id, contract };
}

function evidenceFor(contract: { execution_id: string }, over: Record<string, unknown> = {}) {
  return {
    contract_sha256: operatorContractSha256(contract), execution_id: contract.execution_id,
    repair_key: 'pd034-presentation-type-launcher', prior_failure_code: 'AF-NOTIFY-UNCONFIGURED',
    bridge_state: 'launch_pending' as const, retry_attempt: 1, engine_execution_id: null, no_engine_artifacts: true,
    ...over,
  };
}

function signatureFor(body: object, secret = process.env.WEBHOOK_SECRET!): string {
  return createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

function rawRequest(id: string, body: object, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/tasks/${id}/operator-preengine-recovery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/** The deployed contract: valid Bearer + valid HMAC over the exact raw bytes. */
function request(id: string, body: object) {
  return rawRequest(id, body, {
    authorization: `Bearer ${process.env.MC_API_TOKEN}`,
    'x-webhook-signature': signatureFor(body),
  });
}

function attemptsOf(id: string): number | undefined {
  return queryOne<{ dispatch_attempts: number }>('SELECT dispatch_attempts FROM tasks WHERE id=?', [id])?.dispatch_attempts;
}

/** The operator bridge's run directory — same definition the server uses. */
function runDirFor(taskId: string): string {
  return path.join(process.env.PRESENTATION_OPERATOR_RUNS_DIR!, `pres-operator-${taskId}`);
}

/**
 * PD-TEST-050: the engine's own pinned state file. A real run writes it; the
 * PD-TEST-049 pre-engine death wrote .mode-plan/.model-plan/.credit-preflight
 * and the OCR probe receipt but NO state.json.
 */
function writeEngineState(taskId: string): void {
  fs.mkdirSync(runDirFor(taskId), { recursive: true });
  fs.writeFileSync(path.join(runDirFor(taskId), 'state.json'), JSON.stringify({ phase: 'P1', manifest_sha256: 'deadbeef' }));
}

/** A terminal (non-active) execution row — engine work that has FINISHED. */
function insertTerminalExecution(taskId: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO task_executions (id, task_id, assignment_version, agent_id, workspace_id, generation, session_key, session_id, state, lease_owner, lease_expires_at, idempotency_key, created_at, updated_at)
     VALUES (?, ?, 0, 'presentation-worker', 'default', 1, ?, ?, 'failed', 'test-lease', ?, ?, ?, ?)`,
    [uuidv4(), taskId, `sess-${uuidv4()}`, `sid-${uuidv4()}`, now, `idem-${uuidv4()}`, now, now],
  );
}

/**
 * The recorded dispatch failure that follows a consumed recovery on the real
 * path: the bridge accepted the launch, the engine died pre-engine, the
 * dispatcher recorded the failure and the counter moved up (5 -> 6). Uses the
 * REAL recordDispatchFailure so the counter move is the product's own.
 */
function recordPostRecoveryFailure(taskId: string): void {
  recordDispatchFailure(taskId, 'presentation-worker', {
    reason: 'presentation_operator_bridge_deferred',
    audience: 'SYSTEM',
    needs: 'Deterministic pre-engine prerequisite still failing (PD-TEST-050 regression).',
    context: 'operator-preengine-recovery',
  });
}

function recoveryRows(taskId: string): Array<{ id: string; repair_key: string; dispatch_started_at: string | null; prior_dispatch_attempts: number }> {
  return queryAll<{ id: string; repair_key: string; dispatch_started_at: string | null; prior_dispatch_attempts: number }>(
    'SELECT id, repair_key, dispatch_started_at, prior_dispatch_attempts FROM presentation_operator_preengine_recoveries WHERE task_id=? ORDER BY created_at ASC',
    [taskId],
  );
}

test('verified pre-engine repair retains the REAL exhausted counter and launches the bridge exactly once', async () => {
  newBridgeLog();
  const { id, contract } = createOperatorTask();
  const evidence = evidenceFor(contract);
  const first = await POST(request(id, evidence), { params: Promise.resolve({ id }) });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.authorized, true);
  assert.equal(firstBody.dispatch.status, 'acknowledged');
  const recovery = queryOne<{ prior_dispatch_attempts: number; dispatch_started_at: string | null; execution_id: string }>('SELECT prior_dispatch_attempts, dispatch_started_at, execution_id FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]);
  assert.equal(recovery?.prior_dispatch_attempts, 5);
  assert.equal(recovery?.execution_id, contract.execution_id);
  assert.ok(recovery?.dispatch_started_at);
  // THE regression assertion: the REAL task row, read back from the tasks table
  // after the acknowledged launch through autoDispatchTask()/recordDispatchSuccess().
  assert.equal(attemptsOf(id), 5);
  assert.equal(queryAll('SELECT * FROM task_activities WHERE task_id=? AND activity_type=?', [id, 'operator_preengine_recovery_issued']).length, 1);
  // "exactly one bridge retry" is MEASURED off the real subprocess log, not inferred.
  assert.equal(callsForTask(id).length, 1);

  const replay = await POST(request(id, evidence), { params: Promise.resolve({ id }) });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.idempotent, true);
  assert.equal(queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]).length, 1);
  assert.equal(callsForTask(id).length, 1, 'a duplicate submission must not launch the bridge a second time');
  assert.equal(attemptsOf(id), 5, 'a duplicate submission must not touch the exhausted counter');
});

test('wrong binding — bad contract hash, foreign execution id and foreign task — is refused without a launch', async () => {
  newBridgeLog();
  const a = createOperatorTask();
  const b = createOperatorTask();
  const good = evidenceFor(a.contract);

  const badHash = await POST(request(a.id, { ...good, contract_sha256: '0'.repeat(64) }), { params: Promise.resolve({ id: a.id }) });
  assert.equal(badHash.status, 422);
  assert.equal((await badHash.json()).error, 'immutable_contract_mismatch');

  const foreignExecution = await POST(request(a.id, { ...good, execution_id: b.contract.execution_id }), { params: Promise.resolve({ id: a.id }) });
  assert.equal(foreignExecution.status, 422);
  assert.equal((await foreignExecution.json()).error, 'immutable_contract_mismatch');

  // Task B's whole binding posted at task A: the route's own `id` is the authority.
  const foreignTask = await POST(request(a.id, evidenceFor(b.contract)), { params: Promise.resolve({ id: a.id }) });
  assert.equal(foreignTask.status, 422);
  assert.equal((await foreignTask.json()).error, 'immutable_contract_mismatch');

  assert.equal(queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [a.id]).length, 0);
  assert.equal(bridgeCalls().length, 0, 'no refused binding may reach the bridge');

  // The refusals consumed nothing: the genuine binding still authorizes exactly once.
  const ok = await POST(request(a.id, good), { params: Promise.resolve({ id: a.id }) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).dispatch.status, 'acknowledged');
  assert.equal(callsForTask(a.id).length, 1);
  assert.equal(callsForTask(b.id).length, 0);
  assert.equal(attemptsOf(a.id), 5);
});

test('non-operator scope and a non-exhausted budget are refused — the endpoint is not a general dispatch bypass', async () => {
  newBridgeLog();
  seed();
  // (a) operator-delegated contract shape, but the task is not an operator
  //     Presentations task → the scope gate refuses before any contract read.
  const foreignId = insertTask({ id: uuidv4(), source: 'telegram', department: 'presentations', dispatch_attempts: 5 });
  const scoped = await POST(request(foreignId, evidenceFor({ execution_id: uuidv4() })), { params: Promise.resolve({ id: foreignId }) });
  assert.equal(scoped.status, 422);
  assert.equal((await scoped.json()).error, 'operator_presentation_scope_required');

  // (b) a genuine operator task that still has budget left must NOT be able to
  //     use the recovery path as a bypass.
  const { id, contract } = createOperatorTask({ dispatch_attempts: 2 });
  const premature = await POST(request(id, evidenceFor(contract)), { params: Promise.resolve({ id }) });
  assert.equal(premature.status, 422);
  assert.equal((await premature.json()).error, 'exhausted_dispatch_budget_required');
  assert.equal(queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]).length, 0);
  assert.equal(bridgeCalls().length, 0);
});

test('both auth layers are required — unsigned, foreign bearer and wrong HMAC are refused without consuming the recovery', async () => {
  newBridgeLog();
  const { id, contract } = createOperatorTask();
  const evidence = evidenceFor(contract);

  const unsigned = await POST(rawRequest(id, evidence), { params: Promise.resolve({ id }) });
  assert.equal(unsigned.status, 401);
  const foreignBearer = await POST(
    rawRequest(id, evidence, { authorization: 'Bearer not-the-configured-token', 'x-webhook-signature': signatureFor(evidence) }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(foreignBearer.status, 401);
  const wrongHmac = await POST(
    rawRequest(id, evidence, { authorization: `Bearer ${process.env.MC_API_TOKEN}`, 'x-webhook-signature': signatureFor(evidence, 'wrong-secret') }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(wrongHmac.status, 401);

  assert.equal(queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]).length, 0);
  assert.equal(bridgeCalls().length, 0);
  assert.equal(attemptsOf(id), 5);
  // ...and the fully authenticated request is still authorized exactly once.
  const ok = await POST(request(id, evidence), { params: Promise.resolve({ id }) });
  assert.equal(ok.status, 200);
  assert.equal(callsForTask(id).length, 1);
});

test('pre-engine state guards hold — unknown task, non-blocked task, active execution, engine proof', async () => {
  newBridgeLog();
  const missingId = uuidv4();
  const missing = await POST(request(missingId, evidenceFor({ execution_id: uuidv4() })), { params: Promise.resolve({ id: missingId }) });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'task_not_found');

  // An exhausted operator task that is not blocked is out of scope for recovery.
  const open = createOperatorTask({ status: 'backlog' });
  const notBlocked = await POST(request(open.id, evidenceFor(open.contract)), { params: Promise.resolve({ id: open.id }) });
  assert.equal(notBlocked.status, 422);
  assert.equal((await notBlocked.json()).error, 'blocked_task_required');

  // No recovery while the engine already has an in-flight execution…
  const running = createOperatorTask();
  const now = new Date().toISOString();
  run(
    `INSERT INTO task_executions (id, task_id, assignment_version, agent_id, workspace_id, generation, session_key, session_id, state, lease_owner, lease_expires_at, idempotency_key, created_at, updated_at)
     VALUES (?, ?, 0, 'presentation-worker', 'default', 1, ?, ?, 'running', 'test-lease', ?, ?, ?, ?)`,
    [uuidv4(), running.id, `sess-${running.id}`, `sid-${running.id}`, now, `idem-${running.id}`, now, now],
  );
  const activeExecution = await POST(request(running.id, evidenceFor(running.contract)), { params: Promise.resolve({ id: running.id }) });
  assert.equal(activeExecution.status, 422);
  assert.equal((await activeExecution.json()).error, 'active_execution_exists');

  // …nor once engine proof exists for the task.
  const proved = createOperatorTask();
  run(`INSERT INTO presentation_verification_receipts (id, task_id, receipt_sha256, status) VALUES (?, ?, ?, 'active')`, [uuidv4(), proved.id, 'a'.repeat(64)]);
  const engineProof = await POST(request(proved.id, evidenceFor(proved.contract)), { params: Promise.resolve({ id: proved.id }) });
  assert.equal(engineProof.status, 422);
  assert.equal((await engineProof.json()).error, 'engine_proof_exists');

  // Every refusal wrote zero recovery rows and launched nothing.
  assert.equal(
    queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id IN (?, ?, ?)', [open.id, running.id, proved.id]).length,
    0,
  );
  assert.equal(bridgeCalls().length, 0);
  assert.equal(attemptsOf(running.id), 5);
  assert.equal(attemptsOf(proved.id), 5);
});

/**
 * PD-TEST-050 case (a) + (f) + (e).
 *
 * The exact live sequence: the one authorised recovery was consumed by repair A
 * (row 96932757), the engine then died on a DIFFERENT deterministic pre-engine
 * defect (PD-TEST-049) producing NO engine artifacts, and the counter moved
 * 5 -> 6. A second, distinct repair must now be authorizable — while every
 * historical attempt and the first receipt row stay intact.
 */
test('PD-TEST-050(a,f,e): a second DISTINCT repair is authorized while the first produced no engine artifacts; the counter is preserved', async () => {
  newBridgeLog();
  const { id, contract } = createOperatorTask();
  const first = evidenceFor(contract, { repair_key: 'pd038-notify-env-and-pd039-recovery-counter' });
  const firstResponse = await POST(request(id, first), { params: Promise.resolve({ id }) });
  assert.equal(firstResponse.status, 200);
  const firstBody = await firstResponse.json();
  assert.equal(firstBody.idempotent, false);
  assert.equal(firstBody.dispatch.status, 'acknowledged');
  assert.equal(callsForTask(id).length, 1);
  assert.equal(attemptsOf(id), 5, 'the acknowledged recovery still preserves the exhausted counter');

  // The engine dies pre-engine and the dispatcher records the failure — the
  // product's own accounting, not a hand-edited counter.
  recordPostRecoveryFailure(id);
  assert.equal(queryOne<{ status: string }>('SELECT status FROM tasks WHERE id=?', [id])?.status, 'blocked');
  assert.equal(attemptsOf(id), 6, 'the post-recovery failure increments 5 -> 6');

  // The NEW distinct repair.
  const second = evidenceFor(contract, { repair_key: 'pd049-f1-requester-shape', prior_failure_code: 'F1-NO-REQUESTER-CHAT-ID' });
  const secondResponse = await POST(request(id, second), { params: Promise.resolve({ id }) });
  assert.equal(secondResponse.status, 200);
  const secondBody = await secondResponse.json();
  assert.equal(secondBody.authorized, true);
  assert.equal(secondBody.idempotent, false, 'a genuinely new repair is NOT reported as a replay');
  assert.equal(secondBody.dispatch.status, 'acknowledged');
  assert.equal(callsForTask(id).length, 2, 'the second repair claims exactly one further bridge dispatch');

  // History preserved: two receipt rows, five historical attempts still counted,
  // no counter reset.
  const rows = recoveryRows(id);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.repair_key), ['pd038-notify-env-and-pd039-recovery-counter', 'pd049-f1-requester-shape']);
  assert.deepEqual(rows.map((row) => row.prior_dispatch_attempts), [5, 6]);
  assert.ok(rows.every((row) => row.dispatch_started_at), 'both receipts were claimed');
  assert.equal(attemptsOf(id), 6, 'a second recovery still preserves the exhausted counter');
  assert.equal(
    queryAll('SELECT * FROM task_activities WHERE task_id=? AND activity_type=?', [id, 'operator_preengine_recovery_issued']).length,
    2,
    'each issuance is audited once, and the first audit row is not overwritten',
  );

  // (c) same repair_key still replays idempotently without a second dispatch.
  const replay = await POST(request(id, second), { params: Promise.resolve({ id }) });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).idempotent, true);
  assert.equal(callsForTask(id).length, 2, 'replaying the SAME repair_key never launches again');

  // (e) single-use holds per ROW: a claimed receipt can never be claimed again.
  assert.equal(claimPreEngineRecoveryDispatch(rows[1].id), false, 'a claimed recovery row is single-use');
  assert.equal(claimPreEngineRecoveryDispatch(rows[0].id), false, 'the older claimed row stays single-use');

  // …and the unchanged readback: the same repair_key bound to a foreign
  // contract/execution is still refused, not replayed.
  const rebound = await POST(
    request(id, { ...first, contract_sha256: '0'.repeat(64) }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(rebound.status, 409);
  assert.equal((await rebound.json()).error, 'pre_engine_recovery_already_issued');
  assert.equal(callsForTask(id).length, 2);
});

/**
 * PD-TEST-050 case (b): the artifact gate. A further repair is REFUSED the
 * moment the run has produced ANY engine work, whatever the repair_key is.
 */
test('PD-TEST-050(b): once the run produced engine artifacts the recovery lane is closed for that task', async () => {
  newBridgeLog();

  // (b1) state.json in the operator run dir, with NO execution row and NO
  // receipt: exactly the shape the existing gates do not catch. Refused even for
  // a FIRST receipt, because `no_engine_artifacts: true` in the body is a claim
  // and the server now proves it.
  const stateful = createOperatorTask();
  writeEngineState(stateful.id);
  assert.deepEqual(preEngineRecoveryEngineArtifacts(stateful.id), ['state_json']);
  const firstRefusal = await POST(request(stateful.id, evidenceFor(stateful.contract)), { params: Promise.resolve({ id: stateful.id }) });
  assert.equal(firstRefusal.status, 409);
  assert.equal((await firstRefusal.json()).error, 'pre_engine_recovery_engine_artifacts_present');
  assert.equal(recoveryRows(stateful.id).length, 0, 'a refused recovery writes no receipt row');
  assert.equal(callsForTask(stateful.id).length, 0, 'a refused recovery launches nothing');

  // (b2) a TERMINAL execution row (state 'failed' — so `active_execution_exists`
  // does NOT fire) after a legitimately consumed first receipt.
  const executed = createOperatorTask();
  const consumed = await POST(request(executed.id, evidenceFor(executed.contract)), { params: Promise.resolve({ id: executed.id }) });
  assert.equal(consumed.status, 200);
  assert.equal(callsForTask(executed.id).length, 1);
  recordPostRecoveryFailure(executed.id);
  insertTerminalExecution(executed.id);
  assert.deepEqual(preEngineRecoveryEngineArtifacts(executed.id), ['task_execution']);
  const terminalRefusal = await POST(
    request(executed.id, evidenceFor(executed.contract, { repair_key: 'pd049-f1-requester-shape' })),
    { params: Promise.resolve({ id: executed.id }) },
  );
  assert.equal(terminalRefusal.status, 409);
  assert.equal((await terminalRefusal.json()).error, 'pre_engine_recovery_engine_artifacts_present');
  assert.equal(recoveryRows(executed.id).length, 1, 'the historical receipt survives the refusal');
  assert.equal(callsForTask(executed.id).length, 1, 'no further launch');

  // (b3) an INVALIDATED receipt: the engine produced a proof that was later
  // invalidated, so `engine_proof_exists` (active-only) does not fire — the
  // artifact probe does.
  const invalidated = createOperatorTask();
  run(
    `INSERT INTO presentation_verification_receipts (id, task_id, receipt_sha256, status, invalidated_at, invalidated_reason) VALUES (?, ?, ?, 'invalidated', ?, ?)`,
    [uuidv4(), invalidated.id, 'b'.repeat(64), new Date().toISOString(), 'regression fixture'],
  );
  const invalidatedRefusal = await POST(request(invalidated.id, evidenceFor(invalidated.contract)), { params: Promise.resolve({ id: invalidated.id }) });
  assert.equal(invalidatedRefusal.status, 409);
  assert.equal((await invalidatedRefusal.json()).error, 'pre_engine_recovery_engine_artifacts_present');

  // (b4) contrast, unchanged: an ACTIVE receipt still answers the pre-existing
  // `engine_proof_exists` 422 — the new gate did not take over that refusal.
  const proved = createOperatorTask();
  run(`INSERT INTO presentation_verification_receipts (id, task_id, receipt_sha256, status) VALUES (?, ?, ?, 'active')`, [uuidv4(), proved.id, 'c'.repeat(64)]);
  const provedRefusal = await POST(request(proved.id, evidenceFor(proved.contract)), { params: Promise.resolve({ id: proved.id }) });
  assert.equal(provedRefusal.status, 422);
  assert.equal((await provedRefusal.json()).error, 'engine_proof_exists');

  assert.equal(bridgeCalls().length, 1, 'only the one legitimately consumed receipt ever reached the bridge');
});

/**
 * PD-TEST-050 case: the ledger is bounded. Inventing repair_key strings does not
 * buy attempts — each further receipt must be paid for, and the per-task receipt
 * budget is finite.
 */
test('PD-TEST-050: the pre-engine ledger is bounded — outstanding receipts, spent budgets and unpaid re-blocks are all refused', async () => {
  newBridgeLog();

  // (1) An ISSUED but UNCLAIMED receipt is outstanding: minting a different key
  //     is refused; the caller must replay the key it already holds.
  const outstanding = createOperatorTask();
  const outstandingReceipt = evidenceFor(outstanding.contract);
  run(
    `INSERT INTO presentation_operator_preengine_recoveries
       (id, task_id, execution_id, contract_sha256, prior_dispatch_attempts, repair_key, prior_failure_code, bridge_state, bridge_retry_attempt, created_at)
     VALUES (?, ?, ?, ?, 5, ?, 'AF-NOTIFY-UNCONFIGURED', 'launch_pending', 1, ?)`,
    [uuidv4(), outstanding.id, outstanding.contract.execution_id, operatorContractSha256(outstanding.contract), outstandingReceipt.repair_key, new Date().toISOString()],
  );
  const stillOutstanding = await POST(
    request(outstanding.id, evidenceFor(outstanding.contract, { repair_key: 'pd049-f1-requester-shape' })),
    { params: Promise.resolve({ id: outstanding.id }) },
  );
  assert.equal(stillOutstanding.status, 409);
  assert.equal((await stillOutstanding.json()).error, 'pre_engine_recovery_already_issued');
  assert.equal(callsForTask(outstanding.id).length, 0, 'the outstanding receipt is replayed, never duplicated');

  // (2) A task that is blocked again WITHOUT a new recorded dispatch failure
  //     buys nothing: re-blocking is not a repair.
  const unpaid = createOperatorTask();
  const consumed = await POST(request(unpaid.id, evidenceFor(unpaid.contract)), { params: Promise.resolve({ id: unpaid.id }) });
  assert.equal(consumed.status, 200);
  run(`UPDATE tasks SET status='blocked' WHERE id=?`, [unpaid.id]);
  assert.equal(attemptsOf(unpaid.id), 5);
  const unpaidRefusal = await POST(
    request(unpaid.id, evidenceFor(unpaid.contract, { repair_key: 'pd049-f1-requester-shape' })),
    { params: Promise.resolve({ id: unpaid.id }) },
  );
  assert.equal(unpaidRefusal.status, 409);
  assert.equal((await unpaidRefusal.json()).error, 'pre_engine_recovery_no_new_dispatch_failure');
  assert.equal(callsForTask(unpaid.id).length, 1);

  // (3) The per-task receipt budget is finite: with the budget set to 2, a THIRD
  //     distinct repair is refused even though it is otherwise perfectly valid.
  process.env.PREENGINE_RECOVERY_MAX_PER_TASK = '2';
  try {
    const capped = createOperatorTask();
    for (const [index, key] of ['repair-one', 'repair-two'].entries()) {
      if (index > 0) recordPostRecoveryFailure(capped.id);
      const response = await POST(
        request(capped.id, evidenceFor(capped.contract, { repair_key: key })),
        { params: Promise.resolve({ id: capped.id }) },
      );
      assert.equal(response.status, 200, `receipt ${index + 1} must be issuable inside the budget`);
    }
    recordPostRecoveryFailure(capped.id);
    const spent = await POST(
      request(capped.id, evidenceFor(capped.contract, { repair_key: 'repair-three' })),
      { params: Promise.resolve({ id: capped.id }) },
    );
    assert.equal(spent.status, 409);
    assert.equal((await spent.json()).error, 'pre_engine_recovery_budget_exhausted');
    assert.equal(recoveryRows(capped.id).length, 2, 'the spent budget mints no third receipt');
    assert.equal(callsForTask(capped.id).length, 2, 'and launches nothing further');
    assert.equal(attemptsOf(capped.id), 7, 'even the refused attempt leaves the counter where the dispatcher put it');
  } finally {
    delete process.env.PREENGINE_RECOVERY_MAX_PER_TASK;
  }
});

test('concurrent submissions cannot launch the bridge twice or reset the counter', async () => {
  newBridgeLog();
  process.env.CC_TEST_BRIDGE_DELAY = '0.25';
  try {
    const { id, contract } = createOperatorTask();
    const evidence = evidenceFor(contract);
    // Three truly concurrent submissions, then one replay of the same evidence.
    const responses = await Promise.all([
      POST(request(id, evidence), { params: Promise.resolve({ id }) }),
      POST(request(id, evidence), { params: Promise.resolve({ id }) }),
      POST(request(id, evidence), { params: Promise.resolve({ id }) }),
    ]);
    const bodies = [];
    for (const response of responses) {
      assert.equal(response.status, 200);
      bodies.push(await response.json());
    }
    const replay = await POST(request(id, evidence), { params: Promise.resolve({ id }) });
    assert.equal(replay.status, 200);
    bodies.push(await replay.json());

    assert.equal(bodies.filter((b) => b.dispatch?.status === 'acknowledged').length, 1, 'exactly one of the four callers performs the dispatch');
    // The winner is whichever caller wins the atomic claim (not necessarily the
    // one that inserted the row), so the other three are idempotent replays.
    assert.ok(bodies.filter((b) => b.idempotent === true).length >= 3, 'every losing caller returns an idempotent replay');
    assert.equal(queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]).length, 1);
    const claim = queryOne<{ dispatch_started_at: string | null }>('SELECT dispatch_started_at FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]);
    assert.ok(claim?.dispatch_started_at, 'the single-use claim is stamped');
    assert.equal(callsForTask(id).length, 1, 'the atomic dispatch claim admits exactly one bridge launch under concurrency');
    assert.equal(attemptsOf(id), 5, 'concurrency must not reset the exhausted counter either');
    assert.equal(
      queryAll('SELECT * FROM task_activities WHERE task_id=? AND activity_type=?', [id, 'operator_preengine_recovery_issued']).length,
      1,
      'concurrent submissions must not duplicate the recovery-issued audit row',
    );
  } finally {
    delete process.env.CC_TEST_BRIDGE_DELAY;
  }
});

test('the live intake-advance sweep cannot re-launch a recovered task, but still advances an ordinary one', async () => {
  newBridgeLog();
  const recovered = createOperatorTask();
  const first = await POST(request(recovered.id, evidenceFor(recovered.contract)), { params: Promise.resolve({ id: recovered.id }) });
  assert.equal(first.status, 200);
  assert.equal(callsForTask(recovered.id).length, 1);

  // A control task that differs ONLY in `dispatch_attempts`: same shape, same
  // agent, same old updated_at, no recovery row. If the counter were reset to 0
  // (the failed candidate), the recovered task would be selected exactly like
  // the control one and the sweep would launch the bridge a second time.
  const control = createOperatorTask({ status: 'backlog', dispatch_attempts: 0 });
  const past = '2026-09-14T00:00:00.000Z';
  run('UPDATE tasks SET updated_at=? WHERE id IN (?, ?)', [past, recovered.id, control.id]);

  // A dispatch spy over the sweep's documented dependency seam: it records every
  // task the LIVE advancer actually re-selects for dispatch, then delegates to
  // the real autoDispatchTask so no behaviour is faked.
  const selected: string[] = [];
  const swept = await runIntakeAdvanceSweep({
    dispatch: (taskId, context) => {
      selected.push(taskId);
      return autoDispatchTask(taskId, context);
    },
  });
  // The live advancer's own invariant: every card it selects is below the cap.
  assert.equal(
    selected.filter((taskId) => (attemptsOf(taskId) ?? 0) >= 5).length,
    0,
    'the live advancer never selects a card at/over the dispatch cap',
  );
  assert.ok(selected.includes(control.id), 'the otherwise-identical below-cap control card IS advanced');
  assert.ok(!selected.includes(recovered.id), 'the live advancer re-selects the recovered task ZERO times');
  assert.ok(swept.dispatched >= 1);
  assert.equal(callsForTask(recovered.id).length, 1, 'the exhausted recovered task is never re-launched by the live advancer');
  assert.equal(callsForTask(control.id).length, 1);
  assert.equal(attemptsOf(recovered.id), 5);
  // Ordinary (non-recovery) acknowledgement keeps its documented behaviour.
  assert.equal(attemptsOf(control.id), 0);
});

test('ordinary retry policy is unchanged — U061 /resume preserves the counter and launches nothing', async () => {
  newBridgeLog();
  const { id } = createOperatorTask();
  const resumed = await resumeTask(
    { json: async () => ({}), headers: new Headers() } as Parameters<typeof resumeTask>[0],
    { params: Promise.resolve({ id }) },
  );
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).success, true);
  assert.equal(queryOne<{ status: string }>('SELECT status FROM tasks WHERE id=?', [id])?.status, 'backlog');
  assert.equal(attemptsOf(id), 5, 'U061 resume preserves dispatch_attempts — it must not zero the exhausted budget');
  assert.equal(bridgeCalls().length, 0, 'resume itself never launches the bridge');

  // The resumed card is inert in the live advancer, exactly as before — proven
  // against a control card in the same DB that the same sweep DOES advance.
  const control = createOperatorTask({ status: 'backlog', dispatch_attempts: 0 });
  const past = '2026-09-14T00:00:00.000Z';
  run('UPDATE tasks SET updated_at=? WHERE id IN (?, ?)', [past, id, control.id]);
  const selected: string[] = [];
  await runIntakeAdvanceSweep({
    dispatch: (taskId, context) => {
      selected.push(taskId);
      return autoDispatchTask(taskId, context);
    },
  });
  assert.equal(
    selected.filter((taskId) => (attemptsOf(taskId) ?? 0) >= 5).length,
    0,
    'a resumed-but-exhausted card is never selected by the live advancer',
  );
  assert.ok(selected.includes(control.id), 'the below-cap control card is still advanced by the same sweep');
  assert.ok(!selected.includes(id), 'the resumed task is selected zero times');
  assert.equal(attemptsOf(id), 5);
  assert.equal(callsForTask(id).length, 0);
});

test('ordinary acknowledgement outside the recovery context still clears the counter (default behaviour untouched)', async () => {
  newBridgeLog();
  const { id } = createOperatorTask({ status: 'backlog', dispatch_attempts: 2 });
  const outcome = await autoDispatchTask(id, 'ordinary-dispatch-context');
  assert.equal(outcome.status, 'acknowledged');
  assert.equal(callsForTask(id).length, 1);
  assert.equal(attemptsOf(id), 0, 'the default recordDispatchSuccess() reset is unchanged for every non-recovery caller');
});
