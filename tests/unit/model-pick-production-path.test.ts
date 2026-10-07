/**
 * The routing model pick runs on the box's OWN existing LLM path (model-pick-llm.ts), with no seam injected:
 * the models in openclaw.json, the registered provider connectors, the client-owned key resolved the way the QC
 * judge resolves it. All HTTP is mocked; HOME is a temp dir (the real ~/.openclaw is never read).
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFixture, seedFloorWorkspaces, EVAL_COMPANY } from '../../scripts/eval-department-routing';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-model-pick-'));
Object.assign(process.env, {
  CC_TEST_FIXTURE_ROOT: root, OPENCLAW_ROOT: path.join(root, 'oc'), OC_CONFIG: path.join(root, 'oc'), HOME: root,
  DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1', OWNER_NOTIFY_TELEGRAM_DISABLED: '1', OPENCLAW_CLI_BIN: '/usr/bin/false',
  DECISION_ENGINE_MODE: 'off', SOP_EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: '',
});
for (const k of ['TIEBREAK_MODEL', 'OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY']) delete process.env[k];
fs.mkdirSync(process.env.OPENCLAW_ROOT!, { recursive: true });
const writeChain = (primary: string, fallbacks: string[] = []) =>
  fs.writeFileSync(path.join(process.env.OPENCLAW_ROOT!, 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: { primary, fallbacks } } } }));

const calls: { url: string; model: string; auth: string | null }[] = [];
let reply: (model: string, body?: { messages: { content: string }[] }) => Response = () => new Response('{}', { status: 500 });
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  calls.push({ url: String(url), model: body.model, auth: new Headers(init?.headers).get('authorization') });
  return reply(body.model, body);
}) as typeof fetch;
/** Answer with the first department the pick lists (the best-evidenced candidate). */
const first = (_m: string, b?: { messages: { content: string }[] }) => ok(/Departments:\n1\. (.+?) — /.exec(b?.messages[1].content ?? '')?.[1] ?? 'General Task')();
const ok = (text: string) => () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }), { status: 200 });

type Router = typeof import('../../src/lib/routing/department-router');
let router: Router;
let departments: import('../../src/lib/routing/departments.config').DepartmentConfig[];
test.before(async () => {
  const db = await import('../../src/lib/db');
  seedFloorWorkspaces(db.getDb(), loadFixture().catalog);
  departments = (await import('../../src/lib/routing/departments.config')).loadDepartments(EVAL_COMPANY);
  router = await import('../../src/lib/routing/department-router');
  router.MODEL_PICK.maxRank = 5; // these tests are about the call path, not the acceptance rank (tested elsewhere)
});
const task = { title: 'Plan the team retreat in March' };
const pick = () => router.pickDepartment(task, departments, { tail: ['model'], tiebreakSeam: { companyId: EVAL_COMPANY } });

test('no seam: the box\'s configured model (small and fast first) makes the pick, over the box\'s local Ollama daemon when no cloud key exists', async () => {
  writeChain('agnes/agnes-3.0-pro', ['ollama/deepseek-v4.1-flash:cloud', 'ollama/big-model:70b']);
  calls.length = 0; reply = ok('General Task');
  const r = await pick();
  assert.equal(r.generalBy, 'decision', r.note);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/chat\/completions$/);
  assert.equal(calls[0].model, 'deepseek-v4.1-flash:cloud', 'the unknown-provider primary is skipped, the flash model is chosen');
});

test('a department answer routes; the model never sees an operator key (no key on the box means the local daemon, no auth header)', async () => {
  writeChain('ollama/some-flash:cloud');
  calls.length = 0; reply = first;
  const r = await pick();
  assert.equal(r.method, 'model');
  assert.ok(r.department);
  assert.equal(calls[0].auth, null);
});

test('error and timeout: the next configured model is tried inside the budget, then General Task; never a crash', async () => {
  writeChain('ollama/first-flash:cloud', ['ollama/second-flash:cloud']);
  calls.length = 0; reply = (m, b) => (m === 'first-flash:cloud' ? new Response('boom', { status: 500 }) : first(m, b));
  const r = await pick();
  assert.ok(r.department);
  assert.deepEqual(calls.map((c) => c.model), ['first-flash:cloud', 'second-flash:cloud']);
  reply = () => new Response('boom', { status: 500 });
  const down = await pick();
  assert.equal(down.department, null); assert.equal(down.generalBy, 'last-resort');
  // A hung endpoint is bounded by the pick's own budget.
  reply = () => new Response('x');
  globalThis.fetch = (() => new Promise(() => {})) as typeof fetch;
  const t0 = Date.now();
  const hung = await router.pickDepartment(task, departments, { tail: ['model'], tiebreakSeam: { companyId: EVAL_COMPANY, deadlineMs: 700 } });
  assert.ok(Date.now() - t0 < 3000, 'bounded');
  assert.equal(hung.generalBy, 'last-resort');
});

test('no model configured on the box: no call, last resort', async () => {
  fs.rmSync(path.join(process.env.OPENCLAW_ROOT!, 'openclaw.json'), { force: true });
  let n = 0; globalThis.fetch = (async () => { n++; return new Response('{}'); }) as typeof fetch;
  const r = await pick();
  assert.equal(n, 0); assert.equal(r.generalBy, 'last-resort');
});
