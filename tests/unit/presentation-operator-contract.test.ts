import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryOne } from '../../src/lib/db';
import { createTaskCore } from '../../src/lib/tasks';
import { bridgeReceipt, loadOperatorPresentationContract, parseOperatorPresentationContract, ensureOperatorPresentationContract } from '../../src/lib/presentation-operator-contract';
import { launchOperatorPresentationContract } from '../../src/lib/presentation-operator-launcher';

process.env.WEBHOOK_SECRET = 'operator-contract-test-secret';
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-operator-contract-'));
const TEST_BRIDGE = path.join(TEST_ROOT, 'bridge.py');
const TEST_BRIDGE_MARKER = path.join(TEST_ROOT, 'bridge-receipt.json');
fs.writeFileSync(TEST_BRIDGE, `import json, os, sys
assert sys.argv[1] == 'operator-contract'
args = sys.argv
contract_file = args[args.index('--contract-file') + 1]
receipt = json.load(open(contract_file))
assert receipt['receipt_version'] == 1
assert set(receipt) == {'receipt_version', 'contract', 'receipt_hmac'}
assert len(receipt['receipt_hmac']) == 64
marker = os.environ['TEST_BRIDGE_MARKER']
tmp = marker + '.tmp'
with open(tmp, 'w') as output: json.dump(receipt, output)
os.replace(tmp, marker)
print(json.dumps({'status': 'worker_acknowledged', 'bridge': {'_rc': 0, 'detail': 'test accepted'}}))
`);
process.env.PRESENTATION_OPERATOR_RUNS_DIR = path.join(TEST_ROOT, 'runs');
process.env.PRESENTATION_INTAKE_BRIDGE = TEST_BRIDGE;
process.env.TEST_BRIDGE_MARKER = TEST_BRIDGE_MARKER;
const intake = {
  version: 1 as const, source: 'operator-delegated' as const, title: 'How Presentations Work',
  presentation_type: 'from_scratch' as const, run_mode: 'ultra' as const,
  workhorse_model: 'deepseek-flash@deepseek-direct' as const, slide_count: 8,
  pitch_included: false, deliverable_set: 'deck, teleprompter, speech, audio',
  want_teleprompter: 'yes' as const, want_speech_script: 'yes' as const,
  want_audio_deliverable: 'yes' as const, want_audio_demo: true,
  want_ghl_upload: 'yes' as const, delivery_destinations: ['local presentation folder', 'GoHighLevel'],
  want_sales_checkout: 'yes' as const, want_vsl_page: 'yes' as const,
  answers: { goal: 'Explain the department.' },
};

test('operator intake is bound durably during canonical task creation', async () => {
  const parsed = parseOperatorPresentationContract(intake);
  const result = await createTaskCore({ title: intake.title, source: 'operator-delegated', department: 'presentations', routing_hold_reason: 'test hold', presentation_operator_intake: parsed, idempotency_key: `operator-contract-${Date.now()}` }, { notifyGateway: false });
  assert.ok(result && !result.deduped);
  const stored = loadOperatorPresentationContract(result!.task.id);
  assert.ok(stored);
  assert.equal(stored!.task_id, result!.task.id);
  assert.notEqual(stored!.execution_id, '');
  assert.equal(stored!.pitch_included, false);
  assert.equal(queryOne<{n:number}>('SELECT count(*) n FROM presentation_operator_contracts WHERE task_id=?', [result!.task.id])?.n, 1);
  const receipt = bridgeReceipt(stored!);
  assert.equal(receipt.receipt_version, 1);
  assert.match(receipt.receipt_hmac, /^[0-9a-f]{64}$/);
});

test('client cannot claim server task/execution ids and an undispatched legacy retry recovers once', async () => {
  assert.throws(() => parseOperatorPresentationContract({ ...intake, task_id: '00000000-0000-4000-8000-000000000000' }), /server-issued/);
  const replay = { ...intake, title: `${intake.title} replay` };
  const result = await createTaskCore({ title: replay.title, source: 'operator-delegated', department: 'presentations', routing_hold_reason: 'test hold', idempotency_key: `operator-contract-replay-${Date.now()}` }, { notifyGateway: false });
  assert.ok(result);
  const first = ensureOperatorPresentationContract(result!.task.id, replay);
  const retry = ensureOperatorPresentationContract(result!.task.id, replay);
  assert.equal(retry.execution_id, first.execution_id);
  assert.throws(() => ensureOperatorPresentationContract(result!.task.id, { ...replay, pitch_included: true }), /immutable/);
});

test('canonical full deliverable selection is preserved and quick is refused', () => {
  const parsed = parseOperatorPresentationContract(intake);
  assert.deepEqual(parsed.delivery_destinations, ['local presentation folder', 'GoHighLevel']);
  assert.equal(parsed.want_teleprompter, 'yes');
  assert.equal(parsed.want_speech_script, 'yes');
  assert.equal(parsed.want_audio_deliverable, 'yes');
  assert.equal(parsed.want_audio_demo, true);
  assert.equal(parsed.want_ghl_upload, 'yes');
  assert.throws(() => parseOperatorPresentationContract({ ...intake, run_mode: 'quick' }), /unsupported execution selection/);
});

test('a deferred bridge result remains retryable rather than becoming a handoff', async () => {
  const title = `${intake.title} deferred`;
  const created = await createTaskCore({ title, source: 'operator-delegated', department: 'presentations', routing_hold_reason: 'test hold', presentation_operator_intake: { ...intake, title } }, { notifyGateway: false });
  assert.ok(created);
  fs.writeFileSync(TEST_BRIDGE, "import json, sys\nprint(json.dumps({'status':'launch_pending','bridge':{'_rc':7,'detail':'lease held'}}))\nsys.exit(7)\n");
  const deferred = await launchOperatorPresentationContract(created!.task.id);
  assert.deepEqual(deferred, { kind: 'deferred', detail: 'lease held' });
  fs.writeFileSync(TEST_BRIDGE, `import json, os, sys
assert sys.argv[1] == 'operator-contract'
args = sys.argv
contract_file = args[args.index('--contract-file') + 1]
receipt = json.load(open(contract_file))
assert receipt['receipt_version'] == 1
assert set(receipt) == {'receipt_version', 'contract', 'receipt_hmac'}
assert len(receipt['receipt_hmac']) == 64
marker = os.environ['TEST_BRIDGE_MARKER']
tmp = marker + '.tmp'
with open(tmp, 'w') as output: json.dump(receipt, output)
os.replace(tmp, marker)
print(json.dumps({'status': 'worker_acknowledged', 'bridge': {'_rc': 0, 'detail': 'test accepted'}}))
`);
});

test('dispatcher maps a deferred bridge exit to the durable retry ladder', async () => {
  fs.writeFileSync(TEST_BRIDGE, "import json, sys\nprint(json.dumps({'status':'launch_pending','bridge':{'_rc':7,'detail':'lease held'}}))\nsys.exit(7)\n");
  const title = `${intake.title} dispatch deferred`;
  const created = await createTaskCore({ title, source: 'operator-delegated', department: 'presentations', presentation_operator_intake: { ...intake, title }, idempotency_key: `operator-contract-deferred-${Date.now()}` }, { notifyGateway: false });
  assert.ok(created);
  const deadline = Date.now() + 5000;
  let retry = queryOne<{ dispatch_attempts: number; next_dispatch_eligible_at: string | null }>('SELECT dispatch_attempts, next_dispatch_eligible_at FROM tasks WHERE id=?', [created!.task.id]);
  while ((!retry?.next_dispatch_eligible_at || retry.dispatch_attempts !== 1) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    retry = queryOne<{ dispatch_attempts: number; next_dispatch_eligible_at: string | null }>('SELECT dispatch_attempts, next_dispatch_eligible_at FROM tasks WHERE id=?', [created!.task.id]);
  }
  assert.equal(retry?.dispatch_attempts, 1);
  assert.ok(retry?.next_dispatch_eligible_at);
  fs.writeFileSync(TEST_BRIDGE, `import json, os, sys
assert sys.argv[1] == 'operator-contract'
args = sys.argv
contract_file = args[args.index('--contract-file') + 1]
receipt = json.load(open(contract_file))
assert receipt['receipt_version'] == 1
assert set(receipt) == {'receipt_version', 'contract', 'receipt_hmac'}
assert len(receipt['receipt_hmac']) == 64
marker = os.environ['TEST_BRIDGE_MARKER']
tmp = marker + '.tmp'
with open(tmp, 'w') as output: json.dump(receipt, output)
os.replace(tmp, marker)
print(json.dumps({'status': 'worker_acknowledged', 'bridge': {'_rc': 0, 'detail': 'test accepted'}}))
`);
});

test('the persisted binding is handed off before dispatch and carries the signed receipt', async () => {
  const title = `${intake.title} dispatch`;
  const result = await createTaskCore({ title, source: 'operator-delegated', department: 'presentations', presentation_operator_intake: { ...intake, title }, idempotency_key: `operator-contract-dispatch-${Date.now()}` }, { notifyGateway: false });
  assert.ok(result && !result.deduped);
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(TEST_BRIDGE_MARKER) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(TEST_BRIDGE_MARKER), 'dispatcher must hand the durable receipt to the bridge');
  const receipt = JSON.parse(fs.readFileSync(TEST_BRIDGE_MARKER, 'utf8'));
  assert.equal(receipt.contract.task_id, result!.task.id);
  assert.equal(receipt.contract.pitch_included, false);
  assert.match(receipt.contract.execution_id, /^[0-9a-f-]{36}$/i);
});

test('a failed contract insert rolls back the canonical task creation', async () => {
  const title = `${intake.title} rollback ${Date.now()}`;
  await assert.rejects(
    () => createTaskCore({ title, source: 'telegram', department: 'presentations', routing_hold_reason: 'test hold', presentation_operator_intake: { ...intake, title } }, { notifyGateway: false }),
    /operator-delegated task record/,
  );
  assert.equal(queryOne<{ n: number }>('SELECT count(*) n FROM tasks WHERE title=?', [title])?.n, 0);
});

test.after(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));
