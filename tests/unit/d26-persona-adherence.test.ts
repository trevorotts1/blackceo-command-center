/**
 * D26 adherence tests (spec 11.2-11.3, A40/A42).
 *
 * Own helper: src/lib/persona-adherence.ts. Folds the five 11.2 completion
 * items — registered deliverables, used identifiers, blueprint load,
 * methods account, INDEPENDENT review — into one verdict. Proves identity
 * alone never passes and the producer can never self-approve.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd26-adher-'));
process.env.DATABASE_PATH = path.join(TEMP, 'test.db');
process.env.CC_TEST_FIXTURE_ROOT = TEMP;
process.env.WORKSPACE_BASE_PATH = TEMP;
process.env.OPENCLAW_COMPANY_ROOT = TEMP;
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.PERSONA_FIXTURE_JSON = '{}';
for (const key of ['OPENAI_API_KEY','GOOGLE_API_KEY','GOOGLE_GENERATIVE_AI_API_KEY','GEMINI_API_KEY','QC_FIXTURE_JSON_PATH']) delete process.env[key];

let db: typeof import('../../src/lib/db');
let selectors: typeof import('../../src/lib/persona-selector');
let conformance: typeof import('../../src/lib/persona-conformance');
let attempts: typeof import('../../src/lib/execution-attempts');
let loadEv: typeof import('../../src/lib/execution-load-evidence');
let adherence: typeof import('../../src/lib/persona-adherence');

const now = new Date().toISOString();

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  db.run("INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES('default','Default','default','{}',?,?)", [now, now]);
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug,description,icon,company_id,sort_order,created_at,updated_at) VALUES('marketing','Marketing','marketing','','M','default',10,?,?)", [now, now]);
  selectors = await import('../../src/lib/persona-selector');
  conformance = await import('../../src/lib/persona-conformance');
  attempts = await import('../../src/lib/execution-attempts');
  loadEv = await import('../../src/lib/execution-load-evidence');
  adherence = await import('../../src/lib/persona-adherence');
});
test.after(() => { db.closeDb(); fs.rmSync(TEMP, { recursive: true, force: true }); });

const SECTIONS = ['section-4A','section-4B','appendix-7B'];

function bundle() {
  return {
    confirm_required: false,
    voice: { audience_persona: { id: 'voice-one', why: 'voice' }, topic_persona: { id: 'topic-one', why: 'topic' }, collapsed: false },
    resolved_audience: { label: 'Audience A', candidates: ['Audience A'], source: 'asked', confidence: 0.9 },
    blend_directive: 'Write for Audience A.',
    task_personas: [{ seq: 1, persona_id: 'task-one', why: 'fit' }],
    catalog_version: 'test-catalog-v3',
    blueprintSections: { required: SECTIONS },
  } as never;
}

function card(): { id: string; agent: string } {
  const id = randomUUID(), agent = randomUUID();
  db.run("INSERT INTO agents(id,name,role,workspace_id,model) VALUES(?,?,'builder','marketing','ollama-cloud/deepseek-v4-pro:0813')", [agent, `Writer ${agent.slice(0, 8)}`]);
  db.run("INSERT INTO tasks(id,title,description,status,department,workspace_id,created_at,updated_at) VALUES(?,'Write the launch email','Draft the announcement email.','assigned','marketing','marketing',?,?)", [id, now, now]);
  db.run('UPDATE tasks SET assigned_agent_id=?,persona_contract_version=1 WHERE id=?', [agent, id]);
  selectors.persistPersonaBundle(id, bundle());
  return { id, agent };
}

function attempt(taskId: string, agent: string): string {
  db.run("UPDATE tasks SET status='assigned' WHERE id=?", [taskId]);
  const claim = attempts.reserveExecution(db.queryOne('SELECT * FROM tasks WHERE id=?', [taskId])!, `agent:scope:${randomUUID()}`, randomUUID());
  assert.ok(claim.execution, `fixture must reserve an execution: ${claim.reason}`);
  attempts.beginExecutionSend(claim.execution!);
  conformance.renderPersonaConformanceInstructions(taskId, claim.execution!.id, agent, 'http://localhost:4000');
  loadEv.captureExecutionLoadEvidence(taskId, claim.execution!.id);
  return claim.execution!.id;
}

function settle(executionId: string) {
  db.run("UPDATE task_executions SET state='succeeded' WHERE id=?", [executionId]);
}

function deliverable(taskId: string, label: string): { id: string; sha256: string } {
  const file = path.join(TEMP, `${taskId}-${label}.txt`);
  fs.writeFileSync(file, `Adherence copy ${label}.`);
  const id = randomUUID();
  db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path) VALUES(?,?,'file',?,?)", [id, taskId, label, file]);
  attempts.linkDeliverableToExecution(taskId, id);
  return { id, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}

/** Root persona_used report: REAL manifest + artifacts + methods account. */
function report(taskId: string, agent: string, executionId: string, artifacts: { id: string; sha256: string }[], methods = 'Applied Section-4A voice and appendix-7B method. No deviations.') {
  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [taskId])!.bundle_json);
  db.run("INSERT INTO task_activities(id,task_id,agent_id,activity_type,message,metadata) VALUES(?,?,?,'completed','Persona evidence',?)", [
    randomUUID(), taskId, agent,
    JSON.stringify({
      kind: 'persona_used', execution_id: executionId, ...conformance.expectedPersonaManifest(stored),
      conformance_passed: true,
      artifacts: artifacts.map((a) => ({ deliverable_id: a.id, sha256: a.sha256 })),
    }),
  ]);
}

/** Independent QC authority row (llm path, passed) — the reviewer, not the producer. */
function independentPass(taskId: string) {
  db.run("INSERT INTO task_qc_results(id,task_id,score,passed,scoring_path,qc_agent_id,attempt,scored_at,reason,gaps) VALUES(?,?,?,?,?,?,?, ?,?,?)",
    [randomUUID(), taskId, 9.0, 1, 'llm', randomUUID(), 1, now, 'independent review pass', '[]']);
}

function fullInputs(exec: string, taskId: string, methods = 'Applied Section-4A voice and appendix-7B method. No deviations.') {
  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [taskId])!.bundle_json);
  return {
    loadReport: {
      execution_id: exec,
      bundle_sha: conformance.expectedPersonaManifest(stored).bundle_sha,
      loaded_sections: [...SECTIONS],
    },
    methodsAccount: methods,
  };
}

// ── 1. Full evidence: all five items pass ────────────────────────────

test('complete evidence with independent review passes all five items', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  const art = deliverable(id, 'full');
  report(id, agent, exec, [art]);
  independentPass(id);
  const v = adherence.reviewPersonaAdherence(id, exec, fullInputs(exec, id));
  assert.equal(v.pass, true, v.reason);
  assert.equal(v.items.length, 5);
  assert.ok(v.items.every((i) => i.pass));
  settle(exec);
});

// ── 2. A40: matching identifiers WITHOUT load evidence still fails ──

test('matching identity alone never passes without blueprint load (A40)', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  const art = deliverable(id, 'noload');
  report(id, agent, exec, [art]);
  independentPass(id);
  const v = adherence.reviewPersonaAdherence(id, exec, {
    methodsAccount: 'Applied the voice. No deviations.',
    // no loadReport: identity matches, load unchecked
  });
  assert.equal(v.pass, false);
  assert.ok(v.reason.includes('blueprint_load_unreported'), v.reason);
  settle(exec);
});

// ── 3. A42: producer self-report is never the authority ──────────────

test('full producer evidence without independent review fails (A42)', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  const art = deliverable(id, 'noreview');
  report(id, agent, exec, [art]);
  // NO independentPass: the producer did everything right and says so.
  const v = adherence.reviewPersonaAdherence(id, exec, fullInputs(exec, id));
  assert.equal(v.pass, false);
  assert.ok(v.reason.includes('independent_review_missing'), v.reason);
  settle(exec);
});

// ── 3b. A42 CONTROL: heuristic-only QC never counts as review ────────

test('heuristic QC row does not count as independent review (A42)', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  const art = deliverable(id, 'heur');
  report(id, agent, exec, [art]);
  db.run("INSERT INTO task_qc_results(id,task_id,score,passed,scoring_path,qc_agent_id,attempt,scored_at,reason,gaps) VALUES(?,?,?,?,?,?,?, ?,?,?)",
    [randomUUID(), id, 7.0, 0, 'heuristic', randomUUID(), 1, now, 'no-key heuristic', '[]']);
  const v = adherence.reviewPersonaAdherence(id, exec, fullInputs(exec, id));
  assert.equal(v.pass, false);
  assert.ok(v.reason.includes('independent_review_not_passed'), v.reason);
  settle(exec);
});

// ── 4. Missing methods account fails closed ──────────────────────────

test('absent methods account fails the account item', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  const art = deliverable(id, 'noms');
  report(id, agent, exec, [art]);
  independentPass(id);
  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [id])!.bundle_json);
  const v = adherence.reviewPersonaAdherence(id, exec, {
    loadReport: {
      execution_id: exec,
      bundle_sha: conformance.expectedPersonaManifest(stored).bundle_sha,
      loaded_sections: [...SECTIONS],
    },
    // methodsAccount absent
  });
  assert.equal(v.pass, false);
  assert.ok(v.reason.includes('methods_account_missing'), v.reason);
  settle(exec);
});

// ── 5. Noted deviations are recorded, not hidden ─────────────────────

test('methods account noting deviations passes with the deviation reason', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  const art = deliverable(id, 'dev');
  report(id, agent, exec, [art]);
  independentPass(id);
  const v = adherence.reviewPersonaAdherence(id, exec, fullInputs(exec, id, 'Applied appendix-7B with one deviation: swapped the example.'));
  assert.equal(v.pass, true, v.reason);
  assert.equal(v.items.find((i) => i.name === 'methods_account')!.reason, 'methods_account_with_noted_deviations');
  settle(exec);
});

// ── 6. Unreported identifiers fail even with everything else ─────────

test('no producer report fails the identifiers item', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  deliverable(id, 'norep');
  independentPass(id);
  const v = adherence.reviewPersonaAdherence(id, exec, fullInputs(exec, id));
  assert.equal(v.pass, false);
  assert.ok(v.reason.includes('used_identifiers_not_reported'), v.reason);
  settle(exec);
});
