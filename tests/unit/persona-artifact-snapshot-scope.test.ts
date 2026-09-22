/**
 * The artifact-snapshot gate measures a producer against ITS OWN attempt.
 *
 * Live incident (client box, CC v7.6.43, 2026-09-21): a content card carried 13
 * rows in `task_deliverables` while its latest root persona report named 6
 * artifacts. `task_deliverables` ACCUMULATES across QC re-routes — every
 * re-execution registers its output beside everything earlier attempts left —
 * but a producer report can only ever cover the artifacts of the attempt that
 * wrote it. The gate compared all 13 against those 6, raised
 * `persona_artifact_snapshot_missing`, and the re-route sent the card back to
 * produce MORE deliverables the next report still could not cover. Perfect QC
 * score, un-reroutable, blocked.
 *
 * The fix links each deliverable to the execution that registered it
 * (migration 158) and scopes the gate to that set. Proved below, with the
 * controls that fail if the scoping is reverted OR if it is widened into a
 * hole: a deliverable the CURRENT attempt registered and did not snapshot is
 * still a hard gap, changed bytes are still a hard gap, and a card with no
 * attributed row at all is measured by the pre-158 whole-card rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-scope-'));
process.env.DATABASE_PATH = path.join(TEMP, 'test.db');
process.env.CC_TEST_FIXTURE_ROOT = TEMP;
process.env.WORKSPACE_BASE_PATH = TEMP;
process.env.OPENCLAW_COMPANY_ROOT = TEMP;
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.PERSONA_FIXTURE_JSON = '{}';
for (const key of ['OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'QC_FIXTURE_JSON_PATH']) delete process.env[key];

let db: typeof import('../../src/lib/db');
let selectors: typeof import('../../src/lib/persona-selector');
let conformance: typeof import('../../src/lib/persona-conformance');
let attempts: typeof import('../../src/lib/execution-attempts');

const now = new Date().toISOString();

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  db.run("INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES('default','Default','default','{}',?,?)", [now, now]);
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug,description,icon,company_id,sort_order,created_at,updated_at) VALUES('marketing','Marketing','marketing','','M','default',10,?,?)", [now, now]);
  selectors = await import('../../src/lib/persona-selector');
  conformance = await import('../../src/lib/persona-conformance');
  attempts = await import('../../src/lib/execution-attempts');
});
test.after(() => { db.closeDb(); fs.rmSync(TEMP, { recursive: true, force: true }); });

function bundle() {
  return {
    confirm_required: false,
    voice: { audience_persona: { id: 'voice-one', why: 'voice' }, collapsed: false },
    resolved_audience: { label: 'Audience A', candidates: ['Audience A'], source: 'asked', confidence: 0.9 },
    blend_directive: 'Write for Audience A.',
    task_personas: [],
    catalog_version: 'test-v1',
  } as never;
}

/** A content card under the persona contract, sitting in `assigned` and ready
 * for its first attempt. */
function card(): { id: string; agent: string } {
  const id = randomUUID(), agent = randomUUID();
  db.run("INSERT INTO agents(id,name,role,workspace_id,model) VALUES(?,?,'builder','marketing','ollama-cloud/deepseek-v4-pro:0813')", [agent, `Writer ${agent.slice(0, 8)}`]);
  db.run("INSERT INTO tasks(id,title,description,status,department,workspace_id,created_at,updated_at) VALUES(?,'Write the launch email','Draft the announcement email.','assigned','marketing','marketing',?,?)", [id, now, now]);
  db.run('UPDATE tasks SET assigned_agent_id=?,persona_contract_version=1 WHERE id=?', [agent, id]);
  selectors.persistPersonaBundle(id, bundle());
  return { id, agent };
}

/** Reserve + send one attempt, exactly as a dispatch does (which is when the
 * dispatch persona manifest is stamped onto the execution row). */
function attempt(taskId: string, agent: string): string {
  db.run("UPDATE tasks SET status='assigned' WHERE id=?", [taskId]);
  const claim = attempts.reserveExecution(db.queryOne('SELECT * FROM tasks WHERE id=?', [taskId])!, `agent:scope:${randomUUID()}`, randomUUID());
  assert.ok(claim.execution, `fixture must reserve an execution: ${claim.reason}`);
  attempts.beginExecutionSend(claim.execution!);
  conformance.renderPersonaConformanceInstructions(taskId, claim.execution!.id, agent, 'http://localhost:4000');
  return claim.execution!.id;
}

/** The attempt is over: release the pool so the next one can reserve. */
function settle(executionId: string) {
  db.run("UPDATE task_executions SET state='succeeded' WHERE id=?", [executionId]);
}

/** Register one deliverable. `executionId` null reproduces a pre-158 row — the
 * unattributed state every deliverable on an already-stuck box is in. */
function deliverable(taskId: string, label: string, executionId: string | null): { id: string; sha256: string } {
  const file = path.join(TEMP, `${taskId}-${label}.txt`);
  fs.writeFileSync(file, `Delivered copy ${label}.`);
  const id = randomUUID();
  db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path) VALUES(?,?,'file',?,?)", [id, taskId, label, file]);
  if (executionId) {
    // The real registration paths call this helper; the test calls the same one.
    attempts.linkDeliverableToExecution(taskId, id);
    assert.equal(db.queryOne<{ execution_id: string | null }>('SELECT execution_id FROM task_deliverables WHERE id=?', [id])!.execution_id, executionId,
      'the helper must attribute the row to the attempt that is current right now');
  }
  return { id, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

/** The producer's root persona report for one attempt, naming the artifacts it
 * is accounting for. */
function report(taskId: string, agent: string, executionId: string, artifacts: { id: string; sha256: string }[]) {
  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [taskId])!.bundle_json);
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata) VALUES(?,?,?,'completed','Persona evidence',?)", [
    randomUUID(), taskId, agent,
    JSON.stringify({
      kind: 'persona_used', execution_id: executionId, ...conformance.expectedPersonaManifest(stored),
      conformance_passed: true,
      artifacts: artifacts.map((a) => ({ deliverable_id: a.id, sha256: a.sha256 })),
    }),
  ]);
  db.run("UPDATE tasks SET status='review' WHERE id=?", [taskId]);
}

const deliverableCount = (taskId: string) => db.queryAll('SELECT id FROM task_deliverables WHERE task_id=?', [taskId]).length;

// ── 1. The live shape: 13 registered, 6 in the current report ───────────────

test('13 registered deliverables and 6 in the current attempt\'s report is a PASS', () => {
  const { id, agent } = card();

  // Attempt 1 produced 7 artifacts and was kicked back by QC.
  const first = attempt(id, agent);
  for (let i = 0; i < 7; i += 1) deliverable(id, `a1-${i}`, first);
  settle(first);

  // Attempt 2 produced its own 6 and reported exactly those.
  const second = attempt(id, agent);
  const mine = Array.from({ length: 6 }, (_, i) => deliverable(id, `a2-${i}`, second));
  report(id, agent, second, mine);
  settle(second);

  assert.equal(deliverableCount(id), 13, 'fixture must reproduce the live 13-row card');
  const verdict = conformance.requirePersonaConformanceForCompletion(id);
  assert.equal(verdict.pass, true, `the current attempt accounted for all of its own artifacts: ${verdict.reason}`);
  assert.equal(verdict.reason, 'current_persona_declaration_verified');
});

test('deliverables from an earlier attempt never raise the gap', () => {
  const { id, agent } = card();
  const first = attempt(id, agent);
  const orphan = deliverable(id, 'a1-only', first);
  settle(first);

  const second = attempt(id, agent);
  const mine = [deliverable(id, 'a2-only', second)];
  report(id, agent, second, mine);
  settle(second);

  const inScope = conformance.currentExecutionDeliverables(id, second).map((r) => r.id);
  assert.deepEqual(inScope, [mine[0].id], 'only the current attempt\'s own row is in scope');
  assert.ok(!inScope.includes(orphan.id), 'the earlier attempt\'s deliverable is not this producer\'s to account for');
  assert.equal(conformance.requirePersonaConformanceForCompletion(id).pass, true);
});

// ── 2. CONTROL: the gate is untouched for the current attempt ───────────────

test('an artifact THIS attempt registered and did not snapshot is still a hard gap', () => {
  const { id, agent } = card();
  const first = attempt(id, agent);
  for (let i = 0; i < 7; i += 1) deliverable(id, `b1-${i}`, first);
  settle(first);

  const second = attempt(id, agent);
  const mine = Array.from({ length: 6 }, (_, i) => deliverable(id, `b2-${i}`, second));
  const unreported = deliverable(id, 'b2-hidden', second);
  // The producer reports 6 of the 7 artifacts IT registered.
  report(id, agent, second, mine);
  settle(second);

  const verdict = conformance.requirePersonaConformanceForCompletion(id);
  assert.equal(verdict.pass, false, 'a producer may not leave one of its own artifacts out of the manifest');
  assert.equal(verdict.reason, 'persona_artifact_snapshot_missing');
  assert.equal(db.queryOne<{ execution_id: string }>('SELECT execution_id FROM task_deliverables WHERE id=?', [unreported.id])!.execution_id, second,
    'and the row that failed it really is attributed to the current attempt');
});

test('bytes that changed after the report are still a hard gap', () => {
  const { id, agent } = card();
  const execution = attempt(id, agent);
  const mine = [deliverable(id, 'c-1', execution)];
  report(id, agent, execution, mine);
  settle(execution);
  assert.equal(conformance.requirePersonaConformanceForCompletion(id).pass, true);

  fs.appendFileSync(path.join(TEMP, `${id}-c-1.txt`), ' edited after the report');
  assert.equal(conformance.requirePersonaConformanceForCompletion(id).reason, 'persona_artifact_revision_changed');
});

// ── 3. The repair path: a card already stuck on a v7.6.43 box ───────────────

test('a card stuck with unattributed rows recovers on its next attempt, with no SQL', () => {
  const { id, agent } = card();

  // The stuck state on a live box: three attempts' worth of deliverables, ALL
  // written before the linkage existed, so every one of them is unattributed.
  const stale = attempt(id, agent);
  settle(stale);
  for (let i = 0; i < 7; i += 1) deliverable(id, `d-stale-${i}`, null);
  assert.equal(db.queryAll("SELECT id FROM task_deliverables WHERE task_id=? AND execution_id IS NULL", [id]).length, 7,
    'fixture must reproduce pre-158 rows');

  // The operator re-queues the card. Nothing else is done to it.
  const fresh = attempt(id, agent);
  const mine = Array.from({ length: 6 }, (_, i) => deliverable(id, `d-new-${i}`, fresh));
  report(id, agent, fresh, mine);
  settle(fresh);

  assert.equal(deliverableCount(id), 13);
  const verdict = conformance.requirePersonaConformanceForCompletion(id);
  assert.equal(verdict.pass, true, `the re-queued card must clear the gate unaided: ${verdict.reason}`);
});

test('a card with NO attributed row at all is still measured whole (the pre-158 rule)', () => {
  const { id, agent } = card();
  const execution = attempt(id, agent);
  // A pre-158 attempt finishing right after the upgrade: its own rows are
  // unattributed, so scoping has nothing to scope to and the whole card is the
  // question — the STRICTER of the two rules, never the looser one.
  const mine = [deliverable(id, 'e-1', null)];
  const hidden = deliverable(id, 'e-2', null);
  report(id, agent, execution, mine);
  settle(execution);

  assert.equal(conformance.currentExecutionDeliverables(id, execution).length, 2,
    'with nothing attributed, every row on the card is in scope');
  assert.equal(conformance.requirePersonaConformanceForCompletion(id).reason, 'persona_artifact_snapshot_missing',
    'CONTROL: the fallback cannot become a hole — an unreported row still fails');
  assert.ok(hidden.id);
});
