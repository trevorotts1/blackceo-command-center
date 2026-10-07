/**
 * Routing accuracy toward 95%: department profiles, the decide-every-case model pick (top 5 candidates with
 * profiles, example SOP titles and the earlier pickers' guesses), and correction learning (a person moving a
 * task to another department's agent is remembered and outvotes the SOPs). Offline: a fake Ollama /api/embed
 * answers with 8-dim bucket vectors, HOME is a temp dir.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFixture, seedFloorWorkspaces, seedSops, EVAL_COMPANY } from '../../scripts/eval-department-routing';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-route95-'));
const URL_ = 'http://route95.invalid';
Object.assign(process.env, {
  CC_TEST_FIXTURE_ROOT: root, OPENCLAW_ROOT: path.join(root, 'oc'), OC_CONFIG: path.join(root, 'oc'), HOME: root,
  DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1', OWNER_NOTIFY_TELEGRAM_DISABLED: '1', OPENCLAW_CLI_BIN: '/usr/bin/false',
  DECISION_ENGINE_MODE: 'off', SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_OLLAMA_URL: URL_, SOP_EMBEDDING_MODEL: 'embeddinggemma-2:740m',
  SOP_EMBEDDING_DIMS: '8', SOP_EMBEDDING_GEMINI_FALLBACK: '0',
});
for (const k of ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];

const e = (...v: number[]) => { const a = new Array(8).fill(0); v.forEach((x, i) => { a[i] = x; }); return a; };
/** Text -> bucket vector: 'retainer' -> axis 3, 'invoice' -> a vector 0.6 off axis 0 (below the vote's 0.72 floor), else axis 7. */
const embed = (t: string) => (/retainer/i.test(t) ? e(0, 0, 0, 1) : /invoice/i.test(t) ? e(0.6, 0, 0, 0, 0, 0, 0, 0.8) : e(0, 0, 0, 0, 0, 0, 0, 1));
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).startsWith(URL_)) throw new Error(`no network: ${String(url)}`);
  return new Response(JSON.stringify({ embeddings: [embed(JSON.parse(String(init?.body)).input)] }), { status: 200 });
}) as typeof fetch;

type Router = typeof import('../../src/lib/routing/department-router');
let router: Router;
let departments: import('../../src/lib/routing/departments.config').DepartmentConfig[];
let db: ReturnType<typeof import('../../src/lib/db')['getDb']>;
const catalog = loadFixture().catalog;

test.before(async () => {
  db = (await import('../../src/lib/db')).getDb();
  seedFloorWorkspaces(db, catalog);
  seedSops(db, [
    { id: 's1', name: 'Billing: Invoice Reminder Cadence', department: 'billing', task_keywords: null, vec: Float32Array.from(e(1)) },
    { id: 's2', name: 'Billing: Late Payment Follow-up', department: 'billing-finance', task_keywords: null, vec: Float32Array.from(e(0.9, 0, 0, 0, 0, 0, 0, 0.1)) },
    { id: 's3', name: 'Roles — how-to.md (stub)  [PENDING — FILL FROM LIBRARY]', department: 'billing', task_keywords: null, vec: Float32Array.from(e(0.95)) },
    { id: 's4', name: 'Billing: Retainer Renewal Notice', department: 'billing', task_keywords: null, vec: Float32Array.from(e(0, 0, 0, 0.8, 0, 0, 0, 0.6)) },
  ], 'embeddinggemma-2:740m', 8);
  departments = (await import('../../src/lib/routing/departments.config')).loadDepartments(EVAL_COMPANY);
  router = await import('../../src/lib/routing/department-router');
});

test('every standard department has a profile that says what it does NOT handle; General Task excludes personal and cross-department work', async () => {
  const { DEPARTMENT_PROFILES, profileText } = await import('../../src/lib/routing/department-profiles');
  for (const [slug] of catalog.filter(([x]) => x !== 'master-orchestrator')) assert.ok(DEPARTMENT_PROFILES[slug]?.not.length > 20 && DEPARTMENT_PROFILES[slug].owns.length > 20, `profile for ${slug}`);
  const g = router.GENERAL_TASK_DESCRIPTION;
  assert.equal(g, profileText({ id: 'general-task', purpose: '' } as never));
  assert.match(g, /Personal Assistant/);
  assert.match(g, /Project Architecture Office/);
});

test('model pick: top 5 candidates plus General Task, each with its profile, example SOP titles (no stubs) and what the SOP vote guessed; the model decides every case', async () => {
  let seen: Parameters<import('../../src/lib/routing/tiebreak-adapter').TiebreakFn>[0] | null = null;
  const tiebreak = async (req: NonNullable<typeof seen>) => { seen = req; return { decided: true, departmentId: 'general-task', provenance: 'test' }; };
  const r = await router.pickDepartment({ title: 'chase the invoice' }, departments, { order: [], tail: ['sop', 'model'], tiebreakSeam: { companyId: EVAL_COMPANY, model: 'm', permissionOverride: true, tiebreak } });
  assert.equal(r.generalBy, 'decision', r.note);
  assert.ok(seen);
  const s = seen as NonNullable<typeof seen>;
  const depts = s.candidates.filter((c) => c.id !== 'general-task');
  assert.equal(depts.length, 5, 'top 5 departments');
  assert.equal(s.candidates.at(-1)!.id, 'general-task');
  const billing = depts.find((c) => c.id === 'billing-finance')!;
  assert.match(billing.purpose, /Typical:/);
  assert.match(billing.purpose, /Not /);
  assert.ok(billing.examples!.includes('Billing: Invoice Reminder Cadence'));
  assert.ok(!billing.examples!.some((x) => /stub/i.test(x)), 'boilerplate titles are not examples');
  assert.ok(s.guesses!.some((g) => /nearest SOPs lean to Billing/.test(g)), JSON.stringify(s.guesses));
  assert.equal(depts.length + 1 <= 6, true);
});

test('the decide prompt names departments by id and accepts GENERAL; a reply naming a department outside the candidates is no answer', async () => {
  const { authorizedTiebreak } = await import('../../src/lib/routing/tiebreak-adapter');
  const c = [{ id: 'sales', name: 'Sales', purpose: 'x' }, { id: 'general-task', name: 'General Task', purpose: 'y' }];
  const run = (reply: string) => authorizedTiebreak({ taskText: 't', candidates: c, model: 'm', guesses: ['a'], permission: { permitted: true, reason: 'r' }, complete: async () => reply });
  assert.equal((await run('sales')).departmentId, 'sales');
  assert.equal((await run('`GENERAL`')).departmentId, 'general-task');
  assert.equal((await run('legal')).decided, false);
});

test('correction learning: a person reassigning a task is recorded, ignored when an agent or the same department did it, and the correction outvotes the SOPs next time', async () => {
  const corr = await import('../../src/lib/routing/corrections');
  const sopVote = await import('../../src/lib/routing/sop-vote');
  db.prepare("INSERT OR IGNORE INTO agents (id, name, role, workspace_id) VALUES ('a-sales', 'Sam', 'Sales Lead', 'sales')").run();
  const task = { title: 'retainer reminder', description: null, department: 'billing-finance', workspace_id: 'billing-finance' };

  const before = await sopVote.rankDepartmentsBySops('retainer reminder', departments);
  assert.equal(before!.ranked[0].department.id, 'billing-finance', 'the SOPs alone say billing');

  assert.equal(corr.noteReassignment(task, 'a-sales', false), false, 'a change that is not by a verified person is not a correction');
  assert.equal(corr.noteReassignment({ ...task, department: 'sales' }, 'a-sales', true), false, 'same department is not a correction');
  assert.equal(corr.noteReassignment(task, null, true), false);
  assert.equal(corr.noteReassignment(task, 'a-sales', true), true);
  assert.deepEqual(db.prepare('SELECT text, department FROM routing_department_corrections').all(), [{ text: 'retainer reminder', department: 'sales' }]);

  const after = await sopVote.rankDepartmentsBySops('retainer reminder', departments);
  assert.equal(after!.ranked[0].department.id, 'sales', 'the lone correction (weight 1) beats the single weak SOP neighbour (0.8)');
  assert.ok(after!.examples.get('sales')!.some((x) => /corrected by a person: retainer reminder/.test(x)));

  // The same text corrected again replaces its department; an unrelated task is not pulled to Sales.
  corr.recordCorrection('retainer reminder', 'legal');
  assert.deepEqual(db.prepare('SELECT department FROM routing_department_corrections').all(), [{ department: 'legal' }]);
  const other = await sopVote.rankDepartmentsBySops('weekly invoice run', departments);
  assert.notEqual(other!.ranked[0].department.id, 'sales');
});
