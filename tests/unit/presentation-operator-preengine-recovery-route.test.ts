/**
 * UPDATE-014 / Issue39 — POST /api/tasks/[id]/operator-preengine-recovery.
 *
 * THE DEFECT THIS FILE LOCKS DOWN
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
 * WHAT IS EXERCISED FOR REAL (nothing reimplemented)
 *   - the real route handler,
 *   - the real issuePreEngineRecovery / claimPreEngineRecoveryDispatch library,
 *   - the real launchOperatorPresentationContract(),
 *   - the real autoDispatchTask() operator-delegated branch,
 *   - the real recordDispatchSuccess() accounting,
 *   - the real runIntakeAdvanceSweep() selection/dispatch path,
 *   - the real U061 /resume route,
 *   - a real SQLite DB (isolated per file) and the real contracts table.
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
import { operatorContractSha256 } from '../../src/lib/presentation-operator-recovery';
import { autoDispatchTask } from '../../src/lib/task-dispatcher';
import { runIntakeAdvanceSweep } from '../../src/lib/jobs/intake-advance-sweep';
import { POST } from '../../src/app/api/tasks/[id]/operator-preengine-recovery/route';
import { POST as resumeTask } from '../../src/app/api/tasks/[id]/resume/route';

process.env.WEBHOOK_SECRET = 'preengine-recovery-test-secret';
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

function request(id: string, body: object) {
  const raw = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/tasks/${id}/operator-preengine-recovery`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': createHmac('sha256', process.env.WEBHOOK_SECRET!).update(raw).digest('hex') }, body: raw,
  });
}

function attemptsOf(id: string): number | undefined {
  return queryOne<{ dispatch_attempts: number }>('SELECT dispatch_attempts FROM tasks WHERE id=?', [id])?.dispatch_attempts;
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

test('a consumed recovery cannot be re-bound to a different repair key', async () => {
  newBridgeLog();
  const { id, contract } = createOperatorTask();
  const first = await POST(request(id, evidenceFor(contract)), { params: Promise.resolve({ id }) });
  assert.equal(first.status, 200);
  assert.equal(callsForTask(id).length, 1);

  const rebound = await POST(
    request(id, evidenceFor(contract, { repair_key: 'pd038-notification-env-store' })),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(rebound.status, 409);
  assert.equal((await rebound.json()).error, 'pre_engine_recovery_already_issued');
  assert.equal(queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]).length, 1);
  assert.equal(callsForTask(id).length, 1, 'a re-bound repair key must not mint a second bridge launch');
  assert.equal(attemptsOf(id), 5);
});

test('concurrent submissions cannot launch the bridge twice or reset the counter', async () => {
  newBridgeLog();
  process.env.CC_TEST_BRIDGE_DELAY = '0.25';
  try {
    const { id, contract } = createOperatorTask();
    const evidence = evidenceFor(contract);
    const [r1, r2] = await Promise.all([
      POST(request(id, evidence), { params: Promise.resolve({ id }) }),
      POST(request(id, evidence), { params: Promise.resolve({ id }) }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const bodies = [await r1.json(), await r2.json()];
    assert.ok(bodies.some((b) => b.dispatch?.status === 'acknowledged'), 'exactly one concurrent caller performs the dispatch');
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

  const swept = await runIntakeAdvanceSweep();
  assert.equal(swept.scanned, 1, 'only the task below the dispatch cap is selected');
  assert.equal(swept.dispatched, 1);
  assert.equal(callsForTask(recovered.id).length, 1, 'the exhausted recovered task is never re-selected by the live advancer');
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
});

test('ordinary acknowledgement outside the recovery context still clears the counter (default behaviour untouched)', async () => {
  newBridgeLog();
  const { id } = createOperatorTask({ status: 'backlog', dispatch_attempts: 2 });
  const outcome = await autoDispatchTask(id, 'ordinary-dispatch-context');
  assert.equal(outcome.status, 'acknowledged');
  assert.equal(callsForTask(id).length, 1);
  assert.equal(attemptsOf(id), 0, 'the default recordDispatchSuccess() reset is unchanged for every non-recovery caller');
});
