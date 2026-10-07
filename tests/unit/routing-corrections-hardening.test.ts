/**
 * Correction hardening: (1) ONE correction cannot outvote SOPs that clearly place a task, two agreeing ones can;
 * (2) the corrections table is bounded (newest N per department, age limit) and pruned on insert.
 * Offline: fake Ollama /api/embed with 8-dim bucket vectors, HOME is a temp dir.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFixture, seedFloorWorkspaces, seedSops, EVAL_COMPANY } from '../../scripts/eval-department-routing';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-corr-hard-'));
const URL_ = 'http://corrhard.invalid';
Object.assign(process.env, {
  CC_TEST_FIXTURE_ROOT: root, OPENCLAW_ROOT: path.join(root, 'oc'), OC_CONFIG: path.join(root, 'oc'), HOME: root,
  DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1', OWNER_NOTIFY_TELEGRAM_DISABLED: '1', OPENCLAW_CLI_BIN: '/usr/bin/false',
  DECISION_ENGINE_MODE: 'off', SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_OLLAMA_URL: URL_, SOP_EMBEDDING_MODEL: 'embeddinggemma-2:740m',
  SOP_EMBEDDING_DIMS: '8', SOP_EMBEDDING_GEMINI_FALLBACK: '0',
});
for (const k of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
const e = (...v: number[]) => { const a = new Array(8).fill(0); v.forEach((x, i) => { a[i] = x; }); return a; };
/** Every text mentioning "contract" sits on axis 5, anything else on axis 7. */
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).startsWith(URL_)) throw new Error(`no network: ${String(url)}`);
  return new Response(JSON.stringify({ embeddings: [/contract/i.test(JSON.parse(String(init?.body)).input) ? e(0, 0, 0, 0, 0, 1) : e(0, 0, 0, 0, 0, 0, 0, 1)] }), { status: 200 });
}) as typeof fetch;

let db: ReturnType<typeof import('../../src/lib/db')['getDb']>;
let departments: import('../../src/lib/routing/departments.config').DepartmentConfig[];
const catalog = loadFixture().catalog;
const corr = () => import('../../src/lib/routing/corrections');
const sopVote = () => import('../../src/lib/routing/sop-vote');

test.before(async () => {
  db = (await import('../../src/lib/db')).getDb();
  seedFloorWorkspaces(db, catalog);
  seedSops(db, [
    { id: 'l1', name: 'Legal: Contract Review', department: 'legal', task_keywords: null, vec: Float32Array.from(e(0, 0, 0, 0, 0, 0.95, 0, 0.31)) },
    { id: 'l2', name: 'Legal: Contract Redlining', department: 'legal', task_keywords: null, vec: Float32Array.from(e(0, 0, 0, 0, 0, 0.9, 0, 0.44)) },
  ], 'embeddinggemma-2:740m', 8);
  departments = (await import('../../src/lib/routing/departments.config')).loadDepartments(EVAL_COMPANY);
});

test('ONE wrong correction does not flip a task the SOPs clearly place; a second agreeing correction does', async () => {
  const c = await corr(); const v = await sopVote();
  const rank = async () => (await v.rankDepartmentsBySops('contract review draft', departments))!;
  assert.equal((await rank()).ranked[0].department.id, 'legal', 'the SOPs alone place it in Legal');

  assert.equal(c.recordCorrection('contract review draft', 'sales'), true); // one mistaken correction of a near-duplicate
  const one = await rank();
  assert.equal(one.ranked[0].department.id, 'legal', 'a single correction must not override two agreeing SOPs');
  assert.equal(v.decideSopVote(one)?.department.id ?? null, null, 'and it must not let Sales win the vote outright');

  assert.equal(c.recordCorrection('contract renewal draft', 'sales'), true); // a second, distinct person decision
  const two = await rank();
  assert.equal(two.ranked[0].department.id, 'sales', 'two agreeing corrections are learned');
  assert.ok(two.examples.get('sales')!.some((x) => /corrected by a person/.test(x)));
});

test('the corrections table is bounded: newest N per department kept, older than the age limit dropped, pruned on insert', async () => {
  const c = await corr();
  db.prepare('DELETE FROM routing_department_corrections').run();
  const N = c.CORRECTIONS_KEEP_PER_DEPT;
  for (let i = 0; i < N + 5; i++) c.recordCorrection(`task number ${i}`, 'marketing');
  c.recordCorrection('other dept task', 'legal');
  const n = (d: string) => (db.prepare('SELECT COUNT(*) AS n FROM routing_department_corrections WHERE department = ?').get(d) as { n: number }).n;
  assert.equal(n('marketing'), N, 'capped at N per department');
  assert.equal(n('legal'), 1, 'another department is untouched');
  const texts = (db.prepare("SELECT text FROM routing_department_corrections WHERE department = 'marketing'").all() as { text: string }[]).map((r) => r.text);
  assert.ok(texts.includes(`task number ${N + 4}`), 'the newest is kept');
  assert.ok(!texts.includes('task number 0'), 'the oldest is dropped');

  db.prepare("UPDATE routing_department_corrections SET updated_at = datetime('now', '-400 days') WHERE department = 'legal'").run();
  c.recordCorrection('fresh task', 'sales');
  assert.equal(n('legal'), 0, 'rows older than the age limit are pruned on the next insert');
});
