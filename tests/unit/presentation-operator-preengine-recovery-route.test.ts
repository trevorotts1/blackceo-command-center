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
import { POST } from '../../src/app/api/tasks/[id]/operator-preengine-recovery/route';

process.env.WEBHOOK_SECRET = 'preengine-recovery-test-secret';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-preengine-recovery-'));
const bridge = path.join(root, 'bridge.py');
fs.writeFileSync(bridge, "import json\nprint(json.dumps({'status':'worker_acknowledged','bridge':{'_rc':0,'detail':'test bridge accepted'}}))\n");
process.env.PRESENTATION_INTAKE_BRIDGE = bridge;
process.env.PRESENTATION_OPERATOR_RUNS_DIR = path.join(root, 'runs');

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

function createBlockedOperatorTask() {
  seed();
  const id = uuidv4();
  run(`INSERT INTO tasks (id, title, status, priority, workspace_id, department, assigned_agent_id, source, dispatch_attempts)
       VALUES (?, ?, 'blocked', 'medium', 'default', 'presentations', 'presentation-worker', 'operator-delegated', 5)`, [id, intake.title]);
  const contract = bindOperatorPresentationContract(id, parseOperatorPresentationContract(intake));
  saveOperatorPresentationContract(id, contract);
  return { id, contract };
}

function request(id: string, body: object) {
  const raw = JSON.stringify(body);
  return new NextRequest(`http://localhost/api/tasks/${id}/operator-preengine-recovery`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-signature': createHmac('sha256', process.env.WEBHOOK_SECRET!).update(raw).digest('hex') }, body: raw,
  });
}

test('verified pre-engine repair retains exhausted history and invokes exactly one bridge retry', async () => {
  const { id, contract } = createBlockedOperatorTask();
  const evidence = { contract_sha256: operatorContractSha256(contract), execution_id: contract.execution_id, repair_key: 'pd034-presentation-type-launcher', prior_failure_code: 'AF-NOTIFY-UNCONFIGURED', bridge_state: 'launch_pending' as const, retry_attempt: 1, engine_execution_id: null, no_engine_artifacts: true };
  const first = await POST(request(id, evidence), { params: Promise.resolve({ id }) });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.authorized, true);
  assert.equal(firstBody.dispatch.status, 'acknowledged');
  const recovery = queryOne<{ prior_dispatch_attempts: number; dispatch_started_at: string | null; execution_id: string }>('SELECT prior_dispatch_attempts, dispatch_started_at, execution_id FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]);
  assert.equal(recovery?.prior_dispatch_attempts, 5);
  assert.equal(recovery?.execution_id, contract.execution_id);
  assert.ok(recovery?.dispatch_started_at);
  assert.equal(queryAll('SELECT * FROM task_activities WHERE task_id=? AND activity_type=?', [id, 'operator_preengine_recovery_issued']).length, 1);

  const replay = await POST(request(id, evidence), { params: Promise.resolve({ id }) });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.idempotent, true);
  assert.equal(queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]).length, 1);
});

test('mismatched immutable contract and ordinary blocked task are refused without a recovery row', async () => {
  const { id, contract } = createBlockedOperatorTask();
  const bad = { contract_sha256: '0'.repeat(64), execution_id: contract.execution_id, repair_key: 'pd034-presentation-type-launcher', prior_failure_code: 'AF-NOTIFY-UNCONFIGURED', bridge_state: 'launch_pending' as const, retry_attempt: 1, engine_execution_id: null, no_engine_artifacts: true };
  const response = await POST(request(id, bad), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 422);
  assert.equal(queryAll('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [id]).length, 0);
});
