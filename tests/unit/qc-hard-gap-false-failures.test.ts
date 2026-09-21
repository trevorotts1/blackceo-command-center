/**
 * QC hard-gap FALSE FAILURES — the furnace closed here.
 *
 * Live incident (client box, CC v7.6.35, 2026-09-21): a content card executed
 * fine, the QC judge scored it 10.0/10, `task_qc_results` recorded passed=1 —
 * and the very same run wrote `[QC-AUTO] Score: 10.0/10 | FAIL → returned to
 * Backlog for re-route ... persona_voice_mismatch`, with a `persona_mismatch`
 * event reporting declared voice "null" against producer-reported "null". The
 * re-route rebuilt the persona bundle; attempt 2 scored 10.0 and failed for
 * `persona_bundle_revision_mismatch` against the revision the re-route had just
 * created. Three attempts, card blocked. Six more cards on the same box.
 *
 * Three defects, each proved below AND mutation-proved (the assertion that
 * catches the fix being reverted is spelled out, not assumed):
 *   1. `persona_voice_mismatch` raised from two NON-declarations (undefined vs
 *      null). Genuine divergence must still be a hard fail — that control runs.
 *   2. `persona_bundle_revision_mismatch` measured against the CURRENT bundle
 *      rather than the one the execution was handed at dispatch.
 *   3. `task_qc_results.passed` re-derived from the score alone, so the durable
 *      row and the routing verdict could disagree.
 * Plus: the QC re-route bumped `persona_input_revision` with its own kickback
 * note, and the provider pool must be debited from the RUNTIME model.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-hard-gap-'));
process.env.DATABASE_PATH = path.join(TEMP, 'test.db');
process.env.CC_TEST_FIXTURE_ROOT = TEMP;
process.env.WORKSPACE_BASE_PATH = TEMP;
process.env.OPENCLAW_COMPANY_ROOT = TEMP;
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.PERSONA_FIXTURE_JSON = '{}';
delete process.env.DISABLE_QC_AUTO_SCORER;
for (const key of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'QC_FIXTURE_JSON_PATH']) delete process.env[key];

let db: typeof import('../../src/lib/db');
let selectors: typeof import('../../src/lib/persona-selector');
let conformance: typeof import('../../src/lib/persona-conformance');
let mismatch: typeof import('../../src/lib/persona-mismatch');
let attempts: typeof import('../../src/lib/execution-attempts');
let qc: typeof import('../../src/lib/qc-scorer');
let runtimeModel: typeof import('../../src/lib/runtime-model');
let pools: typeof import('../../src/lib/capacity/provider-pools');
let personaState: typeof import('../../src/lib/persona-state');

const now = new Date().toISOString();

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  db.run("INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES('default','Default','default','{}',?,?)", [now, now]);
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug,description,icon,company_id,sort_order,created_at,updated_at) VALUES('marketing','Marketing','marketing','','M','default',10,?,?)", [now, now]);
  selectors = await import('../../src/lib/persona-selector');
  conformance = await import('../../src/lib/persona-conformance');
  mismatch = await import('../../src/lib/persona-mismatch');
  attempts = await import('../../src/lib/execution-attempts');
  qc = await import('../../src/lib/qc-scorer');
  runtimeModel = await import('../../src/lib/runtime-model');
  pools = await import('../../src/lib/capacity/provider-pools');
  personaState = await import('../../src/lib/persona-state');
});
test.after(() => { db.closeDb(); fs.rmSync(TEMP, { recursive: true, force: true }); });

/** A bundle whose VOICE decision is empty — exactly the live shape that made
 * `expectedPersonaManifest().voice_persona_id` undefined while the producer
 * reported JSON `null`. `voiceId` names an audience persona instead. */
function bundle(voiceId?: string, extra: Record<string, unknown> = {}) {
  return {
    confirm_required: false,
    voice: voiceId ? { audience_persona: { id: voiceId, why: 'voice' }, collapsed: false } : { collapsed: false },
    resolved_audience: { label: 'Audience A', candidates: ['Audience A'], source: 'asked', confidence: 0.9 },
    blend_directive: 'Write for Audience A. Topic and task personas provide expertise without replacing the audience voice.',
    task_personas: [],
    catalog_version: 'test-v1',
    ...extra,
  } as never;
}

interface Card { id: string; agent: string; executionId: string; report: Record<string, unknown>; artifact: string; deliverable: string }

/** A content card dispatched under the persona contract: bundle persisted,
 * execution reserved and SENT (which is when the dispatch manifest is
 * recorded), one registered deliverable, and the producer's persona report. */
function dispatchedCard(voiceId?: string, reportVoice?: unknown): Card {
  const id = randomUUID(), agent = randomUUID();
  db.run("INSERT INTO agents(id,name,role,workspace_id,model) VALUES(?,?,'builder','marketing','ollama-cloud/deepseek-v4-pro:0813')", [agent, `Writer ${agent.slice(0, 8)}`]);
  db.run("INSERT INTO tasks(id,title,description,status,department,workspace_id,created_at,updated_at) VALUES(?,'Write the launch email','Draft the announcement email.','assigned','marketing','marketing',?,?)", [id, now, now]);
  db.run('UPDATE tasks SET assigned_agent_id=?,persona_contract_version=1 WHERE id=?', [agent, id]);
  selectors.persistPersonaBundle(id, bundle(voiceId));

  const execution = attempts.reserveExecution(db.queryOne('SELECT * FROM tasks WHERE id=?', [id])!, `agent:qc-gap:${id}`, randomUUID()).execution!;
  assert.ok(execution, 'fixture must reserve an execution');
  attempts.beginExecutionSend(execution);
  // The real dispatch send renders these instructions — and stamping the
  // execution with what its producer was handed is part of that one act.
  conformance.renderPersonaConformanceInstructions(id, execution.id, agent, 'http://localhost:4000');

  const artifact = path.join(TEMP, `${id}.txt`);
  fs.writeFileSync(artifact, 'Delivered copy.');
  const deliverable = randomUUID();
  db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path) VALUES(?,?,'file','Email copy',?)", [deliverable, id, artifact]);

  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [id])!.bundle_json);
  const expected = conformance.expectedPersonaManifest(stored);
  const report = {
    kind: 'persona_used', execution_id: execution.id, ...expected,
    // The live producer posts an explicit JSON null for a voice it was given none of.
    voice_persona_id: reportVoice === undefined ? (expected.voice_persona_id ?? null) : reportVoice,
    conformance_passed: true,
    artifacts: [{ deliverable_id: deliverable, sha256: createHash('sha256').update(fs.readFileSync(artifact)).digest('hex') }],
  };
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata) VALUES(?,?,?,'completed','Persona evidence',?)", [randomUUID(), id, agent, JSON.stringify(report)]);
  db.run("UPDATE tasks SET status='review' WHERE id=?", [id]);
  // The producer's PATCH to `review` settles its attempt; the conformance check
  // still reads it as the latest execution, and the provider pool is released
  // so the next fixture card in this file can reserve one too.
  db.run("UPDATE task_executions SET state='succeeded' WHERE id=?", [execution.id]);
  return { id, agent, executionId: execution.id, report, artifact, deliverable };
}

function withQcVerdict(data: { score: number; pass: boolean; reason: string; gaps: string[] }) {
  const p = path.join(TEMP, `qc-${randomUUID()}.json`);
  fs.writeFileSync(p, JSON.stringify(data));
  process.env.QC_FIXTURE_JSON_PATH = p;
  return () => { delete process.env.QC_FIXTURE_JSON_PATH; try { fs.unlinkSync(p); } catch { /* best-effort */ } };
}

const qcEvents = (taskId: string) => db.queryAll<{ message: string }>("SELECT message FROM events WHERE task_id=? AND type='qc_review' ORDER BY rowid", [taskId]).map((r) => r.message);
const qcRow = (taskId: string) => db.queryOne<{ passed: number; score: number }>('SELECT passed,score FROM task_qc_results WHERE task_id=? ORDER BY rowid DESC LIMIT 1', [taskId]);

// ── 1. null vs null is NOT a mismatch — and a real divergence still is ───────

test('two non-declarations never make a persona_voice_mismatch (the live null-vs-null gap)', () => {
  const empty = bundle();
  for (const reported of [null, undefined, '', '   ', 'null', 'undefined']) {
    assert.equal(
      conformance.comparePersonaManifest(empty, { ...conformance.expectedPersonaManifest(empty), voice_persona_id: reported as string | null, conformance_passed: true }),
      null,
      `reported voice ${JSON.stringify(reported)} against an empty declaration must not be a divergence`,
    );
  }
  // MUTATION PROOF — this is the assertion that fails if the null-guard is
  // reverted to a bare `report.voice_persona_id !== expected.voice_persona_id`.
  const declared = bundle('voice-one');
  assert.equal(
    conformance.comparePersonaManifest(declared, { ...conformance.expectedPersonaManifest(declared), voice_persona_id: 'voice-two', conformance_passed: true }),
    'persona_voice_mismatch',
    'CONTROL: two non-empty, different voices must still be a hard gap',
  );
  // A declaration on one side only is still not evidence of divergence.
  assert.equal(conformance.comparePersonaManifest(declared, { ...conformance.expectedPersonaManifest(declared), voice_persona_id: null, conformance_passed: true }), null);
});

test('a null-voice card passes conformance, raises no mismatch event, and the chip stays clear', () => {
  const card = dispatchedCard(undefined, null);
  assert.equal(db.queryOne<{ voice_persona_id: string | null }>('SELECT voice_persona_id FROM tasks WHERE id=?', [card.id])!.voice_persona_id, null, 'fixture must reproduce declared=null');
  assert.equal(conformance.requirePersonaConformanceForCompletion(card.id).pass, true);
  assert.equal(mismatch.recordPersonaUsedAndCompare(card.id, card.report as never), null);
  assert.equal(db.queryAll("SELECT id FROM events WHERE task_id=? AND type='persona_mismatch'", [card.id]).length, 0, 'no persona_mismatch row may be fabricated from two nulls');
  assert.equal(mismatch.getOpenPersonaMismatch(card.id), null);
});

// ── 2 + 3. One verdict: the durable row and the routing decision agree ───────

test('a 10.0 with no real gap PASSES, writes passed=1 and is never re-routed', async () => {
  const card = dispatchedCard(undefined, null);
  const cleanup = withQcVerdict({ score: 10.0, pass: true, reason: 'Excellent work', gaps: [] });
  try {
    const result = await qc.runQCOnReview(card.id);
    assert.ok(result, 'QC must produce a verdict');
    assert.equal(result!.pass, true, `verdict flipped to FAIL: ${result!.reason} / ${result!.gaps.join(';')}`);
    assert.deepEqual(result!.gaps, [], 'a fail-soft hard gap must not appear as a gap');
    assert.equal(qcRow(card.id)!.passed, 1);
    assert.ok(qcEvents(card.id).some((m) => m.includes('PASS')), 'a PASS verdict event must be written');
    assert.ok(!qcEvents(card.id).some((m) => m.includes('FAIL')), `no FAIL verdict may accompany a pass: ${qcEvents(card.id).join(' | ')}`);
    assert.equal(db.queryAll("SELECT id FROM events WHERE task_id=? AND message LIKE '[QC-REROUTE]%'", [card.id]).length, 0, 'a passing card is never re-routed');
    assert.equal(db.queryOne<{ qc_reroute_attempts: number }>('SELECT qc_reroute_attempts FROM tasks WHERE id=?', [card.id])!.qc_reroute_attempts ?? 0, 0);
  } finally { cleanup(); }
});

test('a REAL persona divergence still fails the card, and passed follows the verdict, not the score', async () => {
  // CONTROL for the whole fix: the gate is unchanged for genuine mismatches.
  const card = dispatchedCard('voice-one', 'voice-two');
  const cleanup = withQcVerdict({ score: 10.0, pass: true, reason: 'Excellent work', gaps: [] });
  try {
    const result = await qc.runQCOnReview(card.id);
    assert.ok(result);
    assert.equal(result!.pass, false, 'a genuine voice divergence must still block review→done');
    assert.ok(result!.gaps.includes('persona_voice_mismatch'), `gaps must name the divergence: ${result!.gaps.join(';')}`);
    // MUTATION PROOF for defect 3: with `passed` re-derived from the score this
    // row reads 1 beside a FAIL verdict — precisely the live contradiction.
    assert.equal(qcRow(card.id)!.score, 10.0);
    assert.equal(qcRow(card.id)!.passed, 0, 'the durable row must record the SAME verdict the router acted on');
    assert.ok(qcEvents(card.id).some((m) => m.includes('FAIL')), 'the FAIL verdict must be on the feed');
  } finally { cleanup(); }
});

// ── 4. The revision check measures against the DISPATCH snapshot ────────────

test('a bundle rebuilt after dispatch cannot fail the producer for a revision it never saw', () => {
  const card = dispatchedCard('voice-one');
  assert.equal(conformance.requirePersonaConformanceForCompletion(card.id).pass, true);

  const dispatched = conformance.dispatchedPersonaShas(card.executionId);
  assert.ok(dispatched?.root, 'the dispatch send must record what the producer was handed');
  assert.ok(db.queryOne<{ persona_bundle_shas: string | null }>('SELECT persona_bundle_shas FROM task_executions WHERE id=?', [card.executionId])!.persona_bundle_shas,
    'the snapshot lives on the execution row, not on the operator live feed');

  // The QC re-route does exactly this: re-resolves and re-persists the bundle.
  // Same decision, different bytes — so a different sha.
  selectors.persistPersonaBundle(card.id, bundle('voice-one', { rationale: { rebuilt_by: 'qc-reroute' } }));
  const rebuilt = personaState.personaBundleHash(JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [card.id])!.bundle_json));
  assert.notEqual(rebuilt, dispatched!.root, 'fixture must actually move the bundle sha');
  assert.equal(conformance.requirePersonaConformanceForCompletion(card.id).pass, true, 'a post-dispatch rebuild must not fail the in-flight execution');

  // MUTATION PROOF: the check is still live — a producer reporting a sha that
  // is NOT the one it was handed is still a hard gap.
  const stale = { ...card.report, bundle_sha: 'a'.repeat(64) };
  assert.equal(conformance.comparePersonaManifest(bundle('voice-one'), stale as never, dispatched!.root), 'persona_bundle_revision_mismatch');
  // …and with no recorded snapshot the check is SKIPPED, never failed.
  assert.equal(conformance.comparePersonaManifest(bundle('voice-one'), stale as never, null), null);
  db.run('UPDATE task_executions SET persona_bundle_shas=NULL WHERE id=?', [card.executionId]);
  assert.equal(conformance.dispatchedPersonaShas(card.executionId), null);
  assert.equal(conformance.requirePersonaConformanceForCompletion(card.id).pass, true, 'no snapshot is fail-soft, never a failure');
});

// ── 5. The QC re-route stops inventing a new persona revision ───────────────

test('a QC kickback note does not bump persona_input_revision; a real edit still does', async () => {
  const card = dispatchedCard('voice-one');
  const revision = () => db.queryOne<{ persona_input_revision: number }>('SELECT persona_input_revision FROM tasks WHERE id=?', [card.id])!.persona_input_revision;
  const before = revision();

  const outcome = await qc.rerouteOrBlock({
    taskId: card.id, taskTitle: 'Write the launch email', taskDescription: 'Draft the announcement email.',
    attempts: 1, cap: 3, score: 9.9, reason: 'Rework needed', gaps: ['persona_voice_mismatch'],
    kickbackNote: '[QC-FAIL] Score 9.9/10 (attempt 1/3). Rework needed',
  });
  assert.equal(outcome, 'rerouted');
  const after = db.queryOne<{ status: string; description: string }>('SELECT status,description FROM tasks WHERE id=?', [card.id])!;
  assert.equal(after.status, 'backlog');
  assert.match(after.description, /\[QC-FAIL\]/, 'the kickback note must still land — the write is preserved, only its side effect is undone');
  assert.equal(revision(), before, 'QC annotating its own card is not a change to the persona inputs');

  // MUTATION PROOF: the trigger IS live on this database — a real input edit
  // bumps the revision, so the assertion above is discriminating, not vacuous.
  db.run("UPDATE tasks SET title='A different brief entirely' WHERE id=?", [card.id]);
  assert.equal(revision(), before + 1, 'CONTROL: a real input change must still bump the revision');
});

// ── 6. The provider pool is debited from the RUNTIME model ──────────────────

test('pool selection follows the runtime model, not the Command Center intent', () => {
  const agent = randomUUID();
  db.run("INSERT INTO agents(id,name,role,workspace_id,model) VALUES(?,?,'builder','marketing','ollama-cloud/deepseek-v4-pro:0813')", [agent, 'Skew Writer']);
  const agentRow = db.queryOne('SELECT * FROM agents WHERE id=?', [agent])! as never;

  const configPath = path.join(TEMP, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({ agents: { list: [{ id: 'dept-marketing', model: { primary: '9router/glm-5.3', fallbacks: ['openrouter/glm-5.3'] } }] } }));

  const chain = runtimeModel.resolveRuntimeModelChainFromConfig(agentRow, 'marketing', configPath);
  assert.deepEqual(chain, ['9router/glm-5.3', 'openrouter/glm-5.3'], 'the chain is the agent OWN runtime config, primary first');
  // MODEL SKEW, as logged on the live box: intended ollama-cloud, runtime 9router.
  assert.equal(pools.providerOf('ollama-cloud/deepseek-v4-pro:0813'), 'ollama');
  assert.equal(pools.providerOf(chain[0]), '9router');

  const id = randomUUID();
  db.run("INSERT INTO tasks(id,title,description,status,department,workspace_id,assigned_agent_id,created_at,updated_at) VALUES(?,'Pool probe','Body','assigned','marketing','marketing',?,?,?)", [id, agent, now, now]);
  const task = db.queryOne('SELECT * FROM tasks WHERE id=?', [id])! as Record<string, unknown>;
  const claim = attempts.reserveExecution({ ...task, model_chain: chain } as never, `agent:pool:${id}`, randomUUID());
  assert.ok(claim.execution, `reserve must succeed: ${claim.reason}`);
  assert.equal(db.queryOne<{ provider: string }>('SELECT provider FROM task_executions WHERE id=?', [claim.execution!.id])!.provider, '9router',
    'the reservation is debited from the pool the run actually lands in');

  // MUTATION PROOF: a caller that passes NO chain falls back to the CC-pinned
  // `agents.model` and debits the WRONG pool — which is what the dispatchers
  // must never do, and why both of them resolve the runtime chain first.
  const id2 = randomUUID();
  db.run("INSERT INTO tasks(id,title,description,status,department,workspace_id,assigned_agent_id,created_at,updated_at) VALUES(?,'Pool probe 2','Body','assigned','marketing','marketing',?,?,?)", [id2, agent, now, now]);
  const claim2 = attempts.reserveExecution(db.queryOne('SELECT * FROM tasks WHERE id=?', [id2])! as never, `agent:pool2:${id2}`, randomUUID());
  assert.ok(claim2.execution, `reserve must succeed: ${claim2.reason}`);
  assert.equal(db.queryOne<{ provider: string }>('SELECT provider FROM task_executions WHERE id=?', [claim2.execution!.id])!.provider, 'ollama',
    'CONTROL: the fallback really is the CC intent, so the assertion above discriminates');
});
