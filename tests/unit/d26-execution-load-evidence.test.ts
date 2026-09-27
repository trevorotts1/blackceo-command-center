/**
 * D26 load-evidence tests (spec 11.2-11.3, A39/A40).
 *
 * Own helper: src/lib/execution-load-evidence.ts. Uses ONLY existing
 * artifact paths (persona-conformance dispatch snapshot, real bundle load).
 * No tasks.ts / dispatch / auto-route / execution-attempts edits.
 *
 * Each test builds a real governed card in an isolated DB, reserves a REAL
 * execution via execution-attempts.reserveExecution, stamps the REAL dispatch
 * snapshot via renderPersonaConformanceInstructions, then captures/verifies.
 * No self-approval: the failure controls below FAIL if the helper degrades
 * to identity-only checking.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd26-load-'));
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
let evidence: typeof import('../../src/lib/execution-load-evidence');

const now = new Date().toISOString();

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb();
  db.run("INSERT OR IGNORE INTO companies(id,name,slug,config,created_at,updated_at) VALUES('default','Default','default','{}',?,?)", [now, now]);
  db.run("INSERT OR IGNORE INTO workspaces(id,name,slug,description,icon,company_id,sort_order,created_at,updated_at) VALUES('marketing','Marketing','marketing','','M','default',10,?,?)", [now, now]);
  selectors = await import('../../src/lib/persona-selector');
  conformance = await import('../../src/lib/persona-conformance');
  attempts = await import('../../src/lib/execution-attempts');
  evidence = await import('../../src/lib/execution-load-evidence');
});
test.after(() => { db.closeDb(); fs.rmSync(TEMP, { recursive: true, force: true }); });

function bundle(sections: string[] = ['section-4A','section-4B','appendix-7B']) {
  return {
    confirm_required: false,
    voice: { audience_persona: { id: 'voice-one', why: 'voice' }, topic_persona: { id: 'topic-one', why: 'topic' }, collapsed: false },
    resolved_audience: { label: 'Audience A', candidates: ['Audience A'], source: 'asked', confidence: 0.9 },
    blend_directive: 'Write for Audience A.',
    task_personas: [{ seq: 1, persona_id: 'task-one', why: 'fit' }],
    catalog_version: 'test-catalog-v3',
    blueprintSections: { required: sections },
  } as never;
}

function card(sections?: string[]): { id: string; agent: string } {
  const id = randomUUID(), agent = randomUUID();
  db.run("INSERT INTO agents(id,name,role,workspace_id,model) VALUES(?,?,'builder','marketing','ollama-cloud/deepseek-v4-pro:0813')", [agent, `Writer ${agent.slice(0, 8)}`]);
  db.run("INSERT INTO tasks(id,title,description,status,department,workspace_id,created_at,updated_at) VALUES(?,'Write the launch email','Draft the announcement email.','assigned','marketing','marketing',?,?)", [id, now, now]);
  db.run('UPDATE tasks SET assigned_agent_id=?,persona_contract_version=1 WHERE id=?', [agent, id]);
  selectors.persistPersonaBundle(id, bundle(sections));
  return { id, agent };
}

function attempt(taskId: string, agent: string): string {
  db.run("UPDATE tasks SET status='assigned' WHERE id=?", [taskId]);
  const claim = attempts.reserveExecution(db.queryOne('SELECT * FROM tasks WHERE id=?', [taskId])!, `agent:scope:${randomUUID()}`, randomUUID());
  assert.ok(claim.execution, `fixture must reserve an execution: ${claim.reason}`);
  attempts.beginExecutionSend(claim.execution!);
  conformance.renderPersonaConformanceInstructions(taskId, claim.execution!.id, agent, 'http://localhost:4000');
  return claim.execution!.id;
}

function settle(executionId: string) {
  db.run("UPDATE task_executions SET state='succeeded' WHERE id=?", [executionId]);
}

// ── 1. Capture: real revision hash + blueprint versions ──────────────

test('capture records the real decision revision, catalog version, and required sections', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  const cap = evidence.captureExecutionLoadEvidence(id, exec);
  assert.equal(cap.status, 'captured');
  assert.ok(/^[0-9a-f]{64}$/.test(cap.revision_sha), 'revision must be the real sha256 bundle hash');
  assert.equal(cap.catalog_version, 'test-catalog-v3');
  assert.deepEqual(cap.entries[0].required_sections, ['section-4A','section-4B','appendix-7B']);
  const row = db.queryOne<{ revision_sha: string; catalog_version: string }>('SELECT revision_sha, catalog_version FROM execution_load_evidence WHERE execution_id=?', [exec])!;
  assert.equal(row.revision_sha, cap.revision_sha);
  settle(exec);
});

// ── 2. Verify PASS: identity + all sections loaded ───────────────────

test('full load report with matching identity verifies', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  evidence.captureExecutionLoadEvidence(id, exec);
  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [id])!.bundle_json);
  const v = evidence.verifyExecutionLoadEvidence(id, exec, {
    execution_id: exec,
    bundle_sha: conformance.expectedPersonaManifest(stored).bundle_sha,
    loaded_sections: ['section-4A','section-4B','appendix-7B'],
  });
  assert.equal(v.pass, true, v.reason);
  settle(exec);
});

// ── 3. A40 CONTROL: same sha, missing section still fails ────────────

test('matching identity with an unloaded required section still fails (A40)', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  evidence.captureExecutionLoadEvidence(id, exec);
  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [id])!.bundle_json);
  const v = evidence.verifyExecutionLoadEvidence(id, exec, {
    execution_id: exec,
    bundle_sha: conformance.expectedPersonaManifest(stored).bundle_sha,
    loaded_sections: ['section-4A','section-4B'], // appendix-7B never loaded
  });
  assert.equal(v.pass, false);
  assert.equal(v.reason, 'blueprint_required_sections_unloaded');
  settle(exec);
});

// ── 4. A39 CONTROL: stale execution identity fails ───────────────────

test('report naming a superseded execution fails (A39)', () => {
  const { id, agent } = card();
  const first = attempt(id, agent);
  evidence.captureExecutionLoadEvidence(id, first);
  settle(first);
  const second = attempt(id, agent);
  evidence.captureExecutionLoadEvidence(id, second);
  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [id])!.bundle_json);
  const v = evidence.verifyExecutionLoadEvidence(id, second, {
    execution_id: first, // stale: names the finished attempt, not the current one
    bundle_sha: conformance.expectedPersonaManifest(stored).bundle_sha,
    loaded_sections: ['section-4A','section-4B','appendix-7B'],
  });
  assert.equal(v.pass, false);
  assert.equal(v.reason, 'execution_identity_mismatch');
  settle(second);
});

// ── 5. A39 CONTROL: wrong-task capture binding fails ─────────────────

test('capture bound to another task fails the identity gate (A39)', () => {
  const a = card(), b = card();
  const execA = attempt(a.id, a.agent);
  evidence.captureExecutionLoadEvidence(a.id, execA);
  const stored = JSON.parse(db.queryOne<{ bundle_json: string }>('SELECT bundle_json FROM task_persona_bundle WHERE task_id=?', [a.id])!.bundle_json);
  const v = evidence.verifyExecutionLoadEvidence(b.id, execA, {
    execution_id: execA,
    bundle_sha: conformance.expectedPersonaManifest(stored).bundle_sha,
    loaded_sections: ['section-4A','section-4B','appendix-7B'],
  });
  assert.equal(v.pass, false);
  assert.equal(v.reason, 'execution_identity_mismatch');
  settle(execA);
});

// ── 6. Deliverable registration: correct execution binding ───────────

test('deliverable registered under the current execution resolves in currentExecutionDeliverables', () => {
  const { id, agent } = card();
  const exec = attempt(id, agent);
  const file = path.join(TEMP, `${id}-d26.txt`);
  fs.writeFileSync(file, 'D26 evidence bytes.');
  const did = randomUUID();
  db.run("INSERT INTO task_deliverables(id,task_id,deliverable_type,title,path) VALUES(?,?,'file','D26 output',?)", [did, id, file]);
  attempts.linkDeliverableToExecution(id, did);
  const scoped = conformance.currentExecutionDeliverables(id, exec).map((r) => r.id);
  assert.deepEqual(scoped, [did]);
  settle(exec);
});

// ── 7. Unknown execution: fail closed, never a ghost row ────────────

test('capture on an unknown execution throws execution_unknown', () => {
  const { id } = card();
  assert.throws(() => evidence.captureExecutionLoadEvidence(id, randomUUID()), /execution_unknown/);
});
