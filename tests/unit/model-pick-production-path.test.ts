/**
 * The routing model pick runs on the box's OWN LLM path (model-pick-llm.ts) through a FIXED provider chain:
 *   1. glm-5.3-flash:cloud via Ollama Cloud (local daemon when the box has no cloud key), 2. OpenRouter
 *   z-ai/glm-5.3-flash, 3. Agnes agnes-3.0-flash, 4. General Task. Each hop only with the box's own key.
 * All HTTP is mocked; HOME is a temp dir (the real ~/.openclaw is never read).
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
for (const k of ['TIEBREAK_MODEL', 'OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'OPENROUTER_API_KEY', 'AGNES_API_KEY']) delete process.env[k];
fs.mkdirSync(process.env.OPENCLAW_ROOT!, { recursive: true });

const calls: { hop: string; model: string; auth: string | null }[] = [];
const hopOf = (url: string) => (/openrouter/.test(url) ? 'openrouter' : /agnes/.test(url) ? 'agnes' : 'ollama');
const hangSignals: (AbortSignal | null | undefined)[] = [];
let behave: Record<string, 'ok' | 'fail' | 'hang'> = {};
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const hop = hopOf(String(url));
  calls.push({ hop, model: body.model, auth: new Headers(init?.headers).get('authorization') });
  const mode = behave[hop] ?? 'ok';
  if (mode === 'hang') { hangSignals.push(init?.signal); return new Promise<Response>((_, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))); }
  if (mode === 'fail') return new Response('boom', { status: 500 });
  // The decide-every-case prompt: answer with the first listed department id.
  const id = /- id: (\S+)/.exec(body.messages?.[1]?.content ?? '')?.[1] ?? 'GENERAL';
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: id } }] }), { status: 200 });
}) as typeof fetch;

type Router = typeof import('../../src/lib/routing/department-router');
let router: Router;
let departments: import('../../src/lib/routing/departments.config').DepartmentConfig[];
test.before(async () => {
  const db = await import('../../src/lib/db');
  seedFloorWorkspaces(db.getDb(), loadFixture().catalog);
  departments = (await import('../../src/lib/routing/departments.config')).loadDepartments(EVAL_COMPANY);
  router = await import('../../src/lib/routing/department-router');
  (await import('../../src/lib/routing/model-pick-llm')).PICK_HOP.timeoutMs = 400;
});
const task = { title: 'Plan the team retreat in March' };
const pick = () => router.pickDepartment(task, departments, { tail: ['model'], tiebreakSeam: { companyId: EVAL_COMPANY } });
const reset = (b: typeof behave = {}) => { calls.length = 0; behave = b; };
const keys = () => Object.assign(process.env, { OPENROUTER_API_KEY: 'or-test', AGNES_API_KEY: 'ag-test' });

test('hop 1 answers: glm-5.3-flash:cloud on Ollama, no auth header without a cloud key, later hops never called', async () => {
  keys(); reset();
  const r = await pick();
  assert.equal(r.method, 'model', r.note);
  assert.deepEqual(calls.map((c) => [c.hop, c.model]), [['ollama', 'glm-5.3-flash:cloud']]);
  assert.equal(calls[0].auth, null);
});

test('hop 1 fails: OpenRouter z-ai/glm-5.3-flash answers with the box\'s own key', async () => {
  keys(); reset({ ollama: 'fail' });
  const r = await pick();
  assert.equal(r.method, 'model', r.note);
  assert.deepEqual(calls.map((c) => [c.hop, c.model]), [['ollama', 'glm-5.3-flash:cloud'], ['openrouter', 'z-ai/glm-5.3-flash']]);
  assert.equal(calls[1].auth, 'Bearer or-test');
});

test('hops 1 and 2 fail: Agnes agnes-3.0-flash answers', async () => {
  keys(); reset({ ollama: 'fail', openrouter: 'fail' });
  const r = await pick();
  assert.equal(r.method, 'model', r.note);
  assert.deepEqual(calls.map((c) => c.hop), ['ollama', 'openrouter', 'agnes']);
  assert.equal(calls[2].model, 'agnes-3.0-flash');
});

test('every hop fails: General Task as the last resort, in the fixed order, no crash', async () => {
  keys(); reset({ ollama: 'fail', openrouter: 'fail', agnes: 'fail' });
  const r = await pick();
  assert.equal(r.department, null); assert.equal(r.generalBy, 'last-resort');
  assert.deepEqual(calls.map((c) => c.hop), ['ollama', 'openrouter', 'agnes']);
});

test('a hop the box has no key for is skipped, never called', async () => {
  delete process.env.OPENROUTER_API_KEY; process.env.AGNES_API_KEY = 'ag-test'; reset({ ollama: 'fail' });
  const r = await pick();
  assert.equal(r.method, 'model', r.note);
  assert.deepEqual(calls.map((c) => c.hop), ['ollama', 'agnes']);
});

test('a hung hop is bounded by the per-hop timeout and the next hop answers', async () => {
  keys(); reset({ ollama: 'hang' });
  const t0 = Date.now();
  const r = await pick();
  assert.equal(r.method, 'model', r.note);
  assert.deepEqual(calls.map((c) => c.hop), ['ollama', 'openrouter']);
  assert.ok(Date.now() - t0 < 3000);
});

test('openclaw.json models never reorder the chain (no name-based reordering); TIEBREAK_MODEL is tried first', async () => {
  fs.writeFileSync(path.join(process.env.OPENCLAW_ROOT!, 'openclaw.json'), JSON.stringify({ agents: { defaults: { model: { primary: 'agnes/agnes-3.0-flash', fallbacks: ['ollama/deepseek-v4.1-flash:cloud'] } } } }));
  keys(); reset();
  await pick();
  assert.equal(calls[0].model, 'glm-5.3-flash:cloud');
  process.env.TIEBREAK_MODEL = 'openrouter/some/override-model'; reset();
  await pick();
  assert.deepEqual([calls[0].hop, calls[0].model], ['openrouter', 'some/override-model']);
  delete process.env.TIEBREAK_MODEL;
});

test('a timed-out hop is ABORTED (its HTTP request cancelled), not just abandoned, and the next hop answers', async () => {
  keys(); reset({ ollama: 'hang' }); hangSignals.length = 0;
  const r = await pick();
  assert.equal(r.method, 'model', r.note);
  assert.deepEqual(calls.map((c) => c.hop), ['ollama', 'openrouter']);
  assert.equal(hangSignals.length, 1);
  assert.equal(hangSignals[0]?.aborted, true, 'the hung hop\'s request signal was aborted');
});
