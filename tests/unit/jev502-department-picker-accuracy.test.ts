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
import { authorizedTiebreak } from '../../src/lib/routing/tiebreak-adapter';
import os from 'node:os';
import path from 'node:path';
import {
  EVAL_COMPANY, RECORDING_PATH, chatTaskKey, composeBefore, dequantize, loadFixture, score, score3, seedFloorWorkspaces, seedSops, sha1,
  type PickerName, type SopRecord, type Standalone,
} from '../../scripts/eval-department-routing';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jev502-'));
const REPLAY_URL = 'http://jev502-replay.invalid';
Object.assign(process.env, {
  CC_TEST_FIXTURE_ROOT: root, OC_CONFIG: path.join(root, 'oc'), DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1', OPENCLAW_CLI_BIN: '/usr/bin/false',
  SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_OLLAMA_URL: REPLAY_URL, SOP_EMBEDDING_MODEL: 'embeddinggemma-2:740m', SOP_EMBEDDING_DIMS: '768', SOP_EMBEDDING_GEMINI_FALLBACK: '0',
  DECISION_ENGINE_MODE: 'auto',
});
for (const k of ['MIN_ROUTING_CONFIDENCE', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'OPENAI_API_KEY', 'OPENCLAW_DECISION_ENGINE_MODE']) delete process.env[k];

const recording = JSON.parse(fs.readFileSync(RECORDING_PATH, 'utf8')) as {
  vectors: Record<string, { s: number; q: string }>;
  jev: Record<string, { department: string | null; confidence: number }>;
  sops: Record<string, SopRecord>;
  chats: Record<string, string>;
  model: string;
  dims: number;
};
const MODEL_NAME = 'glm-5.3-flash:cloud'; // the model the recorded replies came from

// Fake Ollama: serves recorded vectors; a miss is recorded, never guessed.
const misses: string[] = [];
let ollamaDown = false;
let embedCalls = 0;
let chatCalls = 0;
let chatMode: 'replay' | 'timeout' = 'replay';
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  if (!String(url).startsWith(REPLAY_URL)) throw new Error(`JEV-502 fixture forbids network: ${String(url)}`);
  if (String(url).endsWith('/v1/chat/completions')) {
    chatCalls++;
    if (chatMode === 'timeout') throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    const reply = recording.chats[chatTaskKey(String(init?.body))];
    if (reply === undefined) { misses.push(`chat:${String(init?.body).slice(0, 120)}`); return new Response('not recorded', { status: 500 }); }
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), { status: 200 });
  }
  if (ollamaDown) throw new Error('connect ECONNREFUSED (ollama down)');
  embedCalls++;
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
type SopVote = typeof import('../../src/lib/routing/sop-vote');
let sopVote: SopVote;
let router: Router;
let departments: import('../../src/lib/routing/departments.config').DepartmentConfig[];
let canonical: (s: string) => string;
const { cases } = loadFixture();

test.before(async () => {
  const db = await import('../../src/lib/db');
  seedFloorWorkspaces(db.getDb(), loadFixture().catalog);
  // The box's SOP index: the recorded nearest SOPs of every fixture case (see --record in the eval script).
  seedSops(db.getDb(), Object.values(recording.sops).map((r) => ({ ...r, vec: Float32Array.from(dequantize(r)) })), recording.model, recording.dims);
  departments = (await import('../../src/lib/routing/departments.config')).loadDepartments(EVAL_COMPANY);
  canonical = (await import('../../src/lib/routing/canonical-slug')).canonicalDeptSlug;
  router = await import('../../src/lib/routing/department-router');
  sopVote = await import('../../src/lib/routing/sop-vote');
});

const slug = (d?: { slug?: string; id: string } | null) => (d ? canonical(d.slug || d.id) : null);
type Pick = import('../../src/lib/routing/department-router').DepartmentPick;
type Tail = readonly import('../../src/lib/routing/department-router').DepartmentTailName[];
// The model pick, replayed: the real adapter against the fake chat endpoint (recorded replies).
const seam = () => ({ model: MODEL_NAME, permissionOverride: true, tiebreak: (req: Parameters<typeof authorizedTiebreak>[0]) => authorizedTiebreak({ ...req, apiKey: 'local', endpoint: `${REPLAY_URL}/v1/chat/completions` }) });
async function run(order?: readonly PickerName[], tail?: Tail, withModel = false) {
  const out: Pick[] = [];
  for (const c of cases) out.push(await router.pickDepartment({ title: c.m }, departments, { ...(order ? { order } : {}), ...(tail ? { tail } : {}), ...(withModel ? { tiebreakSeam: seam() } : {}) }));
  return out;
}

test('the chosen order puts the measured-better picker (JEV) first; unsure goes to the SOP vote, then the model pick', () => {
  assert.deepEqual([...router.DEPARTMENT_PICKER_ORDER], ['jev', 'semantic', 'keyword']);
  assert.deepEqual([...router.DEPARTMENT_FALLBACK_TAIL], ['sop', 'model']);
});

test('chosen order: >=90% of fixture tasks land in an acceptable department or General Task', async () => {
  const picks = await run();
  assert.deepEqual(misses, [], 'replay miss — re-run: npx tsx scripts/eval-department-routing.ts --onboarding <clone> --record');
  assert.equal(departments.length, 24, 'standard floor catalog');
  const s = score(cases, picks.map((p) => slug(p.department)));
  assert.ok(s.lenient >= 0.9, `acceptable-or-General ${(s.lenient * 100).toFixed(1)}% < 90%; wrong: ${JSON.stringify(s.wrong)}`);
  // Guard the other direction: the bar must not be met by dumping everything on General Task.
  assert.ok(s.strict >= 0.3, `strict ${(s.strict * 100).toFixed(1)}% < 30% — the picker stopped placing work`);
  assert.ok(picks.filter((p) => p.method === 'jev').length >= 50, 'JEV must be deciding');
  assert.equal(picks.filter((p) => p.method === 'semantic').length, 0, 'semantic only runs when JEV is unavailable');
});

test('the chosen order beats the v7.6.89 order and the ungated decision engine', async () => {
  const standalone: Record<PickerName, Standalone[]> = { semantic: [], jev: [], keyword: [] };
  for (const p of ['semantic', 'jev', 'keyword'] as PickerName[]) {
    for (const r of await run([p], [])) standalone[p].push({ gated: slug(r.department), lean: slug(r.department ?? r.candidate), confidence: r.confidence });
  }
  const chosen = score(cases, (await run()).map((p) => slug(p.department)));
  const before = score(cases, composeBefore(standalone, false)); // v7.6.89 skipped semantic on local Ollama
  const jevAlone = score(cases, standalone.jev.map((x) => x.lean));
  assert.ok(chosen.wrong.length < before.wrong.length / 2, `chosen wrong ${chosen.wrong.length} vs before ${before.wrong.length}`);
  assert.ok(chosen.lenient > jevAlone.lenient + 0.05, `chosen ${chosen.lenient} vs decision engine alone ${jevAlone.lenient}`);
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

test('JEV first: it decides and semantic is never asked while JEV is available', async () => {
  const before = embedCalls;
  const press = await router.pickDepartment({ title: 'Send an update to our investors about Q3' }, departments);
  assert.equal(press.method, 'jev');
  assert.equal(slug(press.department), 'communications');
  assert.equal(embedCalls, before, 'no embedding call');
});

test('JEV unavailable -> semantic runs; semantic unavailable too -> keyword', async () => {
  process.env.DECISION_ENGINE_MODE = 'off';
  try {
    const before = embedCalls;
    const sem = (await run()).filter((p) => p.method === 'semantic');
    assert.ok(sem.length >= 50, `semantic must decide when JEV is off (got ${sem.length})`);
    assert.ok(embedCalls > before);
    ollamaDown = true;
    try {
      const kw = await router.pickDepartment({ title: 'Send an update to our investors about Q3' }, departments);
      assert.ok(kw.method === 'keyword' || /keyword picker unsure/.test(kw.note), `keyword decided: ${kw.method} ${kw.note}`);
    } finally {
      ollamaDown = false;
    }
  } finally {
    process.env.DECISION_ENGINE_MODE = 'auto';
  }
});

test('JEV unsure (below 0.9 or cannot place): semantic is NOT asked as a picker; the tail decides; nothing sure is General Task', async () => {
  const before = embedCalls;
  // No tail: the old Option A behaviour is still reachable (and still never asks semantic).
  const r = await router.pickDepartment({ title: 'Zorblax the quintessential frobnicator' }, departments, { tail: [] });
  assert.equal(r.department, null);
  assert.equal(r.method, 'general');
  assert.equal(r.generalBy, 'last-resort');
  assert.match(r.note, /jev picker unsure/);
  assert.equal(embedCalls, before, 'semantic must not run after an unsure JEV');
  // Default chain, no model configured: SOP vote cannot place gibberish, the model pick has no model -> General Task, last resort.
  const r2 = await router.pickDepartment({ title: 'Zorblax the quintessential frobnicator' }, departments);
  assert.equal(r2.method, 'general');
  assert.equal(r2.generalBy, 'last-resort');
  // A recorded low-confidence (non-fallback) JEV route is unsure too, not "unavailable", and never decided by semantic.
  const low = cases.find((c) => { const j = recording.jev[c.m]; return j?.department && j.confidence < 0.9; });
  assert.ok(low, 'fixture has a below-gate JEV route');
  assert.notEqual((await router.pickDepartment({ title: low.m }, departments)).method, 'semantic');
});

// ── nearest-SOP vote ─────────────────────────────────────────────────────────────────────────────
test('SOP vote routes: JEV-unsure tasks the SOPs place clearly go to the voted department', async () => {
  const picks = await run(undefined, ['sop']);
  const voted = picks.map((p, i) => ({ p, c: cases[i] })).filter((x) => x.p.method === 'sop');
  assert.ok(voted.length >= 5, `the vote must place work (got ${voted.length})`);
  const right = voted.filter((x) => { const g = slug(x.p.department); return g === x.c.d || x.c.alt.includes(g!); });
  assert.ok(right.length / voted.length >= 0.7, `vote precision ${right.length}/${voted.length}`);
  assert.match(voted[0].p.note, /Nearest-SOP vote chose/);
  assert.deepEqual(misses, []);
});

test('SOP vote gates: a contested or low-similarity vote falls through (uncertain), never routes', async () => {
  const dept = (id: string) => ({ id, name: id, purpose: '', keywords: [], agentRoles: [], priority: 5 });
  const mk = (a: number, b: number, top: number) => ({ ranked: [{ department: dept('x'), weight: a, share: a }, { department: dept('y'), weight: b, share: b }], topSimilarity: top, provider: { name: 'ollama', model: 'embeddinggemma-2:740m', dims: 768, apiKey: null } as never });
  assert.equal(sopVote.decideSopVote(mk(0.55, 0.45, 0.9)), null, 'contested (lead below the margin)');
  assert.equal(sopVote.decideSopVote(mk(0.9, 0.1, 0.3)), null, 'nearest SOP not similar enough');
  assert.equal(sopVote.decideSopVote(mk(0.9, 0.1, 0.9))?.department.id, 'x');
  // Live: when no nearest SOP is similar enough, the pipeline never routes by SOP vote.
  const saved = sopVote.SOP_VOTE.minSim;
  sopVote.SOP_VOTE.minSim = 2;
  try {
    assert.equal((await run(undefined, ['sop'])).filter((p) => p.method === 'sop').length, 0);
  } finally { sopVote.SOP_VOTE.minSim = saved; }
});

test('SOP vote with an empty or foreign-model index falls through without any embedding call', async () => {
  const savedModel = process.env.SOP_EMBEDDING_MODEL;
  process.env.SOP_EMBEDDING_MODEL = 'some-other-model'; // the stored vectors are in another space: unusable
  sopVote.__resetSopVoteIndex();
  const before = embedCalls;
  try {
    const picks = await run(undefined, ['sop']);
    assert.equal(picks.filter((p) => p.method === 'sop').length, 0);
    assert.equal(embedCalls, before, 'no index means no embedding call');
  } finally { process.env.SOP_EMBEDDING_MODEL = savedModel; sopVote.__resetSopVoteIndex(); }
});

// ── model pick ───────────────────────────────────────────────────────────────────────────────────
test('model pick: shown the top 3 candidates and General Task; its choice routes the task', async () => {
  let shown: { id: string; name: string; purpose: string }[] = [];
  const target = cases.find((c) => c.d === 'research')!;
  const r = await router.pickDepartment({ title: target.m }, departments, {
    tail: ['model'],
    tiebreakSeam: { model: 'any', permissionOverride: true, tiebreak: async (req) => { shown = req.candidates; return { decided: true, departmentId: 'research', provenance: 'test' }; } },
  });
  // JEV may decide this one itself; use a task JEV cannot place so the tail runs.
  const unsure = await router.pickDepartment({ title: 'Look into whether we should expand to Canada' }, departments, {
    tail: ['model'],
    tiebreakSeam: { model: 'any', permissionOverride: true, tiebreak: async (req) => { shown = req.candidates; return { decided: true, departmentId: 'research', provenance: 'test' }; } },
  });
  assert.ok(r.department || unsure.department);
  assert.equal(unsure.method, 'model');
  assert.equal(slug(unsure.department), 'research');
  assert.ok(shown.length >= 2 && shown.length <= 4, `3 candidates + General Task, got ${shown.length}`);
  const general = shown[shown.length - 1];
  assert.equal(general.id, 'general-task');
  assert.equal(general.purpose, router.GENERAL_TASK_DESCRIPTION);
});

test('model pick: a clearly general task goes to General Task by a positive decision, with the reason recorded', async () => {
  const r = await router.pickDepartment({ title: 'Zorblax the quintessential frobnicator' }, departments, {
    tail: ['model'],
    tiebreakSeam: { model: 'any', permissionOverride: true, tiebreak: async () => ({ decided: true, departmentId: 'general-task', provenance: 'test-model' }) },
  });
  assert.equal(r.department, null);
  assert.equal(r.method, 'general');
  assert.equal(r.generalBy, 'decision');
  assert.match(r.note, /Model pick chose General Task/);
  // The reason that reaches the card says so ("[catch-all] Model pick chose General Task ...").
  assert.match(fs.readFileSync(path.join(__dirname, '../../src/lib/routing/department-router.ts'), 'utf8'), /Model pick chose General Task: the task fits no listed department/);
});

test('model pick: a timeout, an error or no permitted model falls through to General Task, never a crash', async () => {
  const t = cases.find((c) => c.m === 'Zorblax the quintessential frobnicator')!;
  const asserts = (r: Pick, why: string) => { assert.equal(r.department, null, why); assert.equal(r.generalBy, 'last-resort', why); };
  asserts(await router.pickDepartment({ title: t.m }, departments, { tail: ['model'], tiebreakSeam: { model: 'any', permissionOverride: true, tiebreak: async () => { throw new Error('boom'); } } }), 'throws');
  asserts(await router.pickDepartment({ title: t.m }, departments, { tail: ['model'], tiebreakSeam: { model: 'any', permissionOverride: true, tiebreak: async () => ({ decided: false, provenance: 'evidence-only:tie-break-failed:TimeoutError' }) } }), 'adapter says undecided');
  // The real adapter against an endpoint that times out.
  chatMode = 'timeout';
  try { asserts(await router.pickDepartment({ title: t.m }, departments, { tail: ['model'], tiebreakSeam: seam() }), 'real adapter, endpoint timeout'); } finally { chatMode = 'replay'; }
  // No model configured at all: zero chat calls.
  const before = chatCalls;
  asserts(await router.pickDepartment({ title: t.m }, departments, { tail: ['model'], tiebreakSeam: { model: null } }), 'no model');
  assert.equal(chatCalls, before);
});

// ── the whole chain, measured (three numbers) ────────────────────────────────────────────────────
test('chain: JEV -> SOP vote -> model pick -> General Task reaches 80%+ correct department; wrongs fall', async () => {
  const picks = await run(undefined, undefined, true);
  assert.deepEqual(misses, [], 'replay miss — re-run: npx tsx scripts/eval-department-routing.ts --onboarding <clone> --sops <db> --model glm-5.3-flash:cloud --record');
  const s3 = score3(cases, picks.map((p) => slug(p.department)));
  assert.ok(s3.a >= 0.8, `(a) correct department on department-labeled cases ${(s3.a * 100).toFixed(1)}% < 80% (measured 85.6%)`);
  assert.ok(s3.total <= 40, `(c) total wrong ${s3.total} (measured 26; before this chain 111)`);
  assert.ok(s3.b >= 0.6, `(b) General-labeled cases sent to General ${(s3.b * 100).toFixed(1)}% (measured 66.7%)`);
  assert.ok(picks.filter((p) => p.method === 'jev').length >= 50, 'JEV must still decide first');
});
