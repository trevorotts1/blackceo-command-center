/**
 * JEV-502 — department picking is measured, and the better picker goes first.
 *
 * Replays scripts/eval-department-routing.ts's recording (local nomic-embed-text
 * vectors + the onboarding decision engine's routes for the 169-case labeled
 * fixture) through the REAL pickDepartment(), offline: embeddings come from a
 * fake Ollama /api/embed, the decision engine from a fake core that answers
 * from the recording. A replay miss means the fixture, the floor catalog or a
 * department's embed text changed: re-run the script with --record.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EVAL_COMPANY, RECORDING_PATH, composeBefore, dequantize, loadFixture, score, seedFloorWorkspaces, sha1,
  type PickerName, type Standalone,
} from '../../scripts/eval-department-routing';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jev502-'));
const REPLAY_URL = 'http://jev502-replay.invalid';
Object.assign(process.env, {
  CC_TEST_FIXTURE_ROOT: root, OC_CONFIG: path.join(root, 'oc'), DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1', OPENCLAW_CLI_BIN: '/usr/bin/false',
  SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_OLLAMA_URL: REPLAY_URL, SOP_EMBEDDING_MODEL: 'nomic-embed-text', SOP_EMBEDDING_DIMS: '768',
  DECISION_ENGINE_MODE: 'auto',
});
for (const k of ['MIN_ROUTING_CONFIDENCE', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'OPENAI_API_KEY', 'OPENCLAW_DECISION_ENGINE_MODE']) delete process.env[k];

const recording = JSON.parse(fs.readFileSync(RECORDING_PATH, 'utf8')) as {
  vectors: Record<string, { s: number; q: string }>;
  jev: Record<string, { department: string | null; confidence: number }>;
};

// Fake Ollama: serves recorded vectors; a miss is recorded, never guessed.
const misses: string[] = [];
let ollamaDown = false;
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).startsWith(REPLAY_URL)) throw new Error(`JEV-502 fixture forbids network: ${String(url)}`);
  if (ollamaDown) throw new Error('connect ECONNREFUSED (ollama down)');
  const input = JSON.parse(String(init?.body)).input as string;
  const hit = recording.vectors[sha1(input)];
  if (!hit) { misses.push(input); return new Response('not recorded', { status: 500 }); }
  return new Response(JSON.stringify({ embeddings: [dequantize(hit)] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

// Fake decision-engine core answering from the recording (department null = fallback=true).
const routesPath = path.join(root, 'routes.json');
fs.writeFileSync(routesPath, JSON.stringify(recording.jev));
const core = path.join(root, 'fake-core.py');
fs.writeFileSync(core, `import json, sys
if "--capability" in sys.argv:
    print(json.dumps({"schemaVersion": "1.1.0"})); sys.exit(0)
req = json.loads(sys.stdin.read())
r = json.load(open(${JSON.stringify(routesPath)})).get(req["taskDescription"]) or {"department": None, "confidence": 0.0}
print(json.dumps({"schemaVersion": "1.1.0", "configRevision": req.get("configRevision"),
  "recommendation": {"roleId": "none_suitable", "confidence": 0.0, "rationale": "replay"},
  "evaluatedAt": "2026-09-29T00:00:00.000Z", "intent": "task_request", "intentSource": "heuristic",
  "route": {"action": "route", "department": r["department"] or "general-task", "confidence": r["confidence"],
            "fallback": r["department"] is None, "catalog": "request"}}))
`);
process.env.DECISION_ENGINE_CORE_PATH = core;

type Router = typeof import('../../src/lib/routing/department-router');
let router: Router;
let departments: import('../../src/lib/routing/departments.config').DepartmentConfig[];
let canonical: (s: string) => string;
const { cases } = loadFixture();

test.before(async () => {
  const db = await import('../../src/lib/db');
  seedFloorWorkspaces(db.getDb(), loadFixture().catalog);
  departments = (await import('../../src/lib/routing/departments.config')).loadDepartments(EVAL_COMPANY);
  canonical = (await import('../../src/lib/routing/canonical-slug')).canonicalDeptSlug;
  router = await import('../../src/lib/routing/department-router');
});

const slug = (d?: { slug?: string; id: string } | null) => (d ? canonical(d.slug || d.id) : null);
async function run(order?: readonly PickerName[]) {
  const out: import('../../src/lib/routing/department-router').DepartmentPick[] = [];
  for (const c of cases) out.push(await router.pickDepartment({ title: c.m }, departments, order ? { order } : {}));
  return out;
}

test('the chosen order puts the measured-better picker (semantic) first', () => {
  assert.deepEqual([...router.DEPARTMENT_PICKER_ORDER], ['semantic', 'jev', 'keyword']);
});

test('chosen order: >=90% of fixture tasks land in an acceptable department or General Task', async () => {
  const picks = await run();
  assert.deepEqual(misses, [], 'replay miss — re-run: npx tsx scripts/eval-department-routing.ts --onboarding <clone> --record');
  assert.equal(departments.length, 24, 'standard floor catalog');
  const s = score(cases, picks.map((p) => slug(p.department)));
  assert.ok(s.lenient >= 0.9, `acceptable-or-General ${(s.lenient * 100).toFixed(1)}% < 90%; wrong: ${JSON.stringify(s.wrong)}`);
  // Guard the other direction: the bar must not be met by dumping everything on General Task.
  assert.ok(s.strict >= 0.3, `strict ${(s.strict * 100).toFixed(1)}% < 30% — the picker stopped placing work`);
  assert.ok(picks.filter((p) => p.method === 'semantic').length >= 50, 'semantic (local Ollama) must be deciding');
});

test('the chosen order beats the v7.6.89 order and the decision engine alone', async () => {
  const standalone: Record<PickerName, Standalone[]> = { semantic: [], jev: [], keyword: [] };
  for (const p of ['semantic', 'jev', 'keyword'] as PickerName[]) {
    for (const r of await run([p])) standalone[p].push({ gated: slug(r.department), lean: slug(r.department ?? r.candidate), confidence: r.confidence });
  }
  const chosen = score(cases, (await run()).map((p) => slug(p.department)));
  const before = score(cases, composeBefore(standalone, false)); // v7.6.89 skipped semantic on local Ollama
  const jevAlone = score(cases, standalone.jev.map((x) => x.lean));
  assert.ok(chosen.wrong.length < before.wrong.length / 2, `chosen wrong ${chosen.wrong.length} vs before ${before.wrong.length}`);
  assert.ok(chosen.lenient > jevAlone.lenient + 0.15, `chosen ${chosen.lenient} vs decision engine alone ${jevAlone.lenient}`);
});

test('no embeddings: the decision engine is the fallback, then keyword; nothing throws', async () => {
  process.env.SOP_EMBEDDING_PROVIDER = 'openai'; // no key → semantic unavailable
  try {
    const withJev = await run();
    assert.ok(withJev.some((p) => p.method === 'jev') && !withJev.some((p) => p.method === 'semantic'));
    const s = score(cases, withJev.map((p) => slug(p.department)));
    assert.ok(s.lenient >= 0.85, `offline with decision engine ${(s.lenient * 100).toFixed(1)}% (measured 87.0%)`);
    process.env.DECISION_ENGINE_MODE = 'off';
    const kw = await run();
    assert.ok(kw.every((p) => p.method === 'keyword' || p.method === 'general'));
    const k = score(cases, kw.map((p) => slug(p.department)));
    assert.ok(k.lenient >= 0.9, `offline keyword-only ${(k.lenient * 100).toFixed(1)}% (measured 92.9%)`);
  } finally {
    process.env.SOP_EMBEDDING_PROVIDER = 'ollama';
    process.env.DECISION_ENGINE_MODE = 'auto';
  }
});

test('landmine 8: local Ollama embeddings route semantically; an Ollama outage falls through, never throws', async () => {
  const press = await router.pickDepartment({ title: 'Draft a press release about the launch' }, departments);
  assert.equal(press.method, 'semantic');
  assert.equal(slug(press.department), 'communications');
  ollamaDown = true;
  try {
    const down = await router.pickDepartment({ title: 'Draft a press release about the launch' }, departments);
    assert.equal(down.method, 'jev', 'outage → the decision engine decides');
    assert.equal(slug(down.department), 'communications');
  } finally {
    ollamaDown = false;
  }
});

test('an unsure picker sends the task to General Task instead of a weaker picker', async () => {
  const r = await router.pickDepartment({ title: 'Zorblax the quintessential frobnicator' }, departments);
  assert.equal(r.department, null);
  assert.equal(r.method, 'general');
  assert.match(r.note, /semantic picker unsure/);
});
