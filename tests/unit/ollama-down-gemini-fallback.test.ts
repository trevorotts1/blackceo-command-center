/**
 * Local Ollama DOWN -> the box's OWN paid Gemini key (Trevor 2026-10-07).
 * Department semantic picker, skill-matcher cache, and the nearest-SOP vote all re-embed BOTH sides with Gemini
 * (gemini-embedding-2, floor 0.55, its own cache keys, its own SOP set), then keyword when Gemini fails or there is
 * no key. A Gemini query is never compared with a local vector. All HTTP is mocked.
 */
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFixture, seedFloorWorkspaces, EVAL_COMPANY, seedSops } from '../../scripts/eval-department-routing';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gemini-fallback-'));
const OLLAMA = 'http://ollama-down.invalid';
Object.assign(process.env, {
  CC_TEST_FIXTURE_ROOT: root, OC_CONFIG: path.join(root, 'oc'), DISABLE_CRON: '1', DISABLE_BRIDGE_BOOTSTRAP: '1',
  OWNER_NOTIFY_TELEGRAM_DISABLED: '1', OPENCLAW_CLI_BIN: '/usr/bin/false', DECISION_ENGINE_MODE: 'off',
  SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_OLLAMA_URL: OLLAMA, SOP_EMBEDDING_MODEL: 'test-local', SOP_EMBEDDING_DIMS: '4',
  GOOGLE_API_KEY: 'test-gemini-key-0123456789',
  HOME: root, // the real ~/.openclaw secret stores must never be read by a test
});
delete process.env.SOP_EMBEDDING_GEMINI_FALLBACK;
delete process.env.MIN_ROUTING_CONFIDENCE;

// 4-dim "embeddings": billing, website, other. Same text -> same vector in both providers' mocks, but the
// LOCAL mock puts everything about invoices on axis 3 and Gemini on axis 0, so mixing spaces can never match by accident.
const axis = (t: string, billing: number, web: number, other: number) => {
  const s = t.toLowerCase();
  const v = [0, 0, 0, 0];
  v[/invoice|billing/.test(s) ? billing : /website|link/.test(s) ? web : other] = 1;
  return v;
};
let ollamaUp = false;
let ollamaCalls = 0;
let googleCalls = 0;
let googleMode: 'ok' | 'error' = 'ok';
const googleBodies: string[] = [];
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (u.startsWith(OLLAMA)) {
    ollamaCalls++;
    if (!ollamaUp) throw new Error('connect ECONNREFUSED (ollama down)');
    return new Response(JSON.stringify({ embeddings: [axis(body.input, 3, 1, 2)] }), { status: 200 });
  }
  if (u.includes('generativelanguage.googleapis.com') && u.includes(':embedContent')) {
    googleCalls++;
    googleBodies.push(String(init?.body));
    if (googleMode === 'error') return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ embedding: { values: axis(body.content.parts[0].text, 0, 1, 2) } }), { status: 200 });
  }
  throw new Error(`fixture forbids network: ${u}`);
}) as typeof fetch;

type Router = typeof import('../../src/lib/routing/department-router');
let router: Router;
let sopVote: typeof import('../../src/lib/routing/sop-vote');
let emb: typeof import('../../src/lib/sop-embeddings');
let departments: import('../../src/lib/routing/departments.config').DepartmentConfig[];
let db: typeof import('../../src/lib/db');

test.before(async () => {
  db = await import('../../src/lib/db');
  seedFloorWorkspaces(db.getDb(), loadFixture().catalog);
  departments = (await import('../../src/lib/routing/departments.config')).loadDepartments(EVAL_COMPANY);
  router = await import('../../src/lib/routing/department-router');
  sopVote = await import('../../src/lib/routing/sop-vote');
  emb = await import('../../src/lib/sop-embeddings');
});
const reset = () => { emb.__resetEmbedFallback(); router._resetDeptVectorCacheForTests(); sopVote.__resetSopVoteIndex(); ollamaCalls = 0; googleCalls = 0; googleBodies.length = 0; googleMode = 'ok'; };
const task = { title: 'Send the invoice to the client' };
const sem = (tail: readonly never[] = []) => router.pickDepartment(task, departments, { order: ['semantic'], tail });

test('Ollama down + a key: the semantic picker re-embeds both sides with Gemini at the Gemini floor, and does not wait on the dead server again', async () => {
  reset(); ollamaUp = false;
  const r = await sem();
  assert.equal(r.method, 'semantic', r.note);
  assert.equal(r.department?.id, 'billing-finance');
  assert.ok(googleCalls >= 25, `task + 24 department texts embedded with Gemini (got ${googleCalls})`);
  assert.ok(googleBodies.every((b) => !/task: search result|title: none/.test(b)), 'Gemini gets raw text, no embeddinggemma prefixes');
  const ollamaBefore = ollamaCalls;
  await sem();
  assert.equal(ollamaCalls, ollamaBefore, 'inside the cool-down the dead local server is not asked again');
});

test('vector caches are per provider: Gemini and local department vectors never mix', async () => {
  reset(); ollamaUp = false;
  await sem();
  assert.equal(router._deptVectorCacheSizeForTests(), departments.length, 'Gemini vectors cached');
  emb.__resetEmbedFallback(); ollamaUp = true; googleCalls = 0;
  const r = await sem();
  assert.equal(googleCalls, 0, 'local is up: no Gemini call');
  assert.equal(r.department?.id, 'billing-finance');
  assert.equal(router._deptVectorCacheSizeForTests(), departments.length * 2, 'two separate entries per department (local and Gemini)');
});

test('Ollama down + no key: keyword, and no Gemini call', async () => {
  reset(); ollamaUp = false;
  const key = process.env.GOOGLE_API_KEY; delete process.env.GOOGLE_API_KEY;
  try {
    const r = await router.pickDepartment({ title: 'invoice billing payment refund' }, departments, { order: ['semantic', 'keyword'], tail: [] });
    assert.notEqual(r.method, 'semantic');
    assert.equal(googleCalls, 0);
  } finally { process.env.GOOGLE_API_KEY = key; }
});

test('Ollama down + Gemini errors: keyword, never a crash', async () => {
  reset(); ollamaUp = false; googleMode = 'error';
  const r = await router.pickDepartment({ title: 'invoice billing payment refund' }, departments, { order: ['semantic', 'keyword'], tail: [] });
  assert.notEqual(r.method, 'semantic');
  assert.ok(googleCalls >= 1, 'Gemini was tried');
});

test('a Gemini box never calls Ollama (and a local box that is up never calls Gemini)', async () => {
  reset();
  process.env.SOP_EMBEDDING_PROVIDER = 'google';
  try {
    await sem();
    assert.equal(ollamaCalls, 0, 'google primary: Ollama is never contacted');
    assert.ok(googleCalls > 0);
  } finally { process.env.SOP_EMBEDDING_PROVIDER = 'ollama'; }
});

// ── SOP vote against the separate Gemini set ──────────────────────────────────────────────────────
function seedIndexes() {
  const d = db.getDb();
  d.prepare('DELETE FROM sops').run();
  const sop = (id: string, dept: string, name: string) => d.prepare("INSERT INTO sops (id, name, slug, department, steps) VALUES (?, ?, ?, ?, '[]')").run(id, name, id, dept);
  sop('s1', 'billing', 'Send an invoice'); sop('s2', 'billing', 'Chase an unpaid invoice'); sop('s3', 'web-development', 'Fix a website link');
  const vec = (v: number[]) => Buffer.from(new Float32Array(v).buffer);
  // LOCAL index (test-local @4): deliberately WRONG for the Gemini query axis, so any cross-space comparison is visible.
  const local = d.prepare("INSERT OR REPLACE INTO sop_embeddings (sop_id, embedding, embedding_model, embedding_dims) VALUES (?, ?, 'test-local', 4)");
  local.run('s1', vec([0, 0, 0, 1])); local.run('s2', vec([0, 0, 0, 1])); local.run('s3', vec([0, 1, 0, 0]));
  return { vec };
}
function seedGeminiSet(vec: (v: number[]) => Buffer) {
  const d = db.getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS sop_embeddings_gemini_fallback (sop_id TEXT PRIMARY KEY REFERENCES sops(id) ON DELETE CASCADE,
    embedding BLOB NOT NULL, embedding_model TEXT NOT NULL, embedding_dims INTEGER NOT NULL, embedded_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  d.prepare('DELETE FROM sop_embeddings_gemini_fallback').run();
  const g = d.prepare("INSERT INTO sop_embeddings_gemini_fallback (sop_id, embedding, embedding_model, embedding_dims) VALUES (?, ?, 'gemini-embedding-2', 3072)");
  g.run('s1', vec([1, 0, 0, 0])); g.run('s2', vec([1, 0, 0, 0])); g.run('s3', vec([0, 1, 0, 0]));
}

test('SOP vote, Ollama down + key: embeds with Gemini and votes against the Gemini set only (never the local vectors)', async () => {
  reset(); ollamaUp = false;
  const { vec } = seedIndexes(); seedGeminiSet(vec);
  const r = await sopVote.rankDepartmentsBySops(task.title, departments);
  assert.ok(r, 'a ranking');
  assert.equal(r!.provider.name, 'google');
  assert.equal(r!.ranked[0].department.id, 'billing-finance');
  assert.equal(sopVote.decideSopVote(r)?.department.id, 'billing-finance');
  assert.ok(googleCalls >= 1);
});

test('SOP vote, Ollama up: uses the local index (the local vectors answer, Gemini is not called)', async () => {
  reset(); ollamaUp = true;
  const { vec } = seedIndexes(); seedGeminiSet(vec);
  const r = await sopVote.rankDepartmentsBySops(task.title, departments);
  assert.equal(r!.provider.name, 'ollama');
  assert.equal(googleCalls, 0);
});

test('SOP vote, Ollama down: no Gemini set provisioned, or no key -> null (next picker), no Gemini embed call without a set to compare', async () => {
  reset(); ollamaUp = false;
  const { vec } = seedIndexes(); seedGeminiSet(vec);
  db.getDb().exec('DROP TABLE sop_embeddings_gemini_fallback');
  sopVote.__resetSopVoteIndex();
  assert.ok((await sopVote.rankDepartmentsBySops(task.title, departments)) === null);
  assert.equal(googleCalls, 0, 'no set, so no paid embedding');
  seedGeminiSet(vec); sopVote.__resetSopVoteIndex(); emb.__resetEmbedFallback();
  const key = process.env.GOOGLE_API_KEY; delete process.env.GOOGLE_API_KEY;
  try { assert.ok((await sopVote.rankDepartmentsBySops(task.title, departments)) === null); } finally { process.env.GOOGLE_API_KEY = key; }
});

test('skill-matcher cache is per provider; Gemini uses the 0.55 floor', async () => {
  const cp = await import('../../src/lib/context-pack');
  const local = { name: 'ollama', model: 'embeddinggemma-2:740m', dims: 768, apiKey: null } as const;
  const gem = emb.resolveGeminiFallbackProvider()!;
  assert.equal(cp.skillMatchFloor(local as never), 0.74);
  assert.equal(cp.skillMatchFloor(gem), 0.55);
  cp.clearEmbeddingCache();
  let a = 0; let b = 0;
  await cp.embedTextsCached(['same text'], async () => { a++; return [{ index: 0, embedding: [1, 0] }]; }, local as never);
  await cp.embedTextsCached(['same text'], async () => { b++; return [{ index: 0, embedding: [0, 1] }]; }, gem);
  assert.deepEqual([a, b], [1, 1], 'the Gemini lookup did not reuse the local vector');
  await cp.embedTextsCached(['same text'], async () => { a++; return []; }, local as never);
  assert.equal(a, 1, 'the local entry is still its own cache hit');
});

test.after(() => { db?.closeDb(); fs.rmSync(root, { recursive: true, force: true }); });

test('the Gemini key found ONLY in ~/.openclaw/secrets/.env is used by the fallback (router, SOP vote, skill cache)', async () => {
  reset(); ollamaUp = false;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-secrets-home-'));
  const prevHome = process.env.HOME;
  const keyVars = ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY'] as const;
  const saved = Object.fromEntries(keyVars.map((k) => [k, process.env[k]]));
  keyVars.forEach((k) => delete process.env[k]);
  fs.mkdirSync(path.join(home, '.openclaw', 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(home, '.openclaw', 'secrets', '.env'), 'GEMINI_API_KEY=secrets-file-only-key-0123456789\n');
  process.env.HOME = home;
  try {
    assert.equal(emb.resolveGoogleKey(), null, 'precondition: not in the process env');
    const r = await sem();
    assert.equal(r.method, 'semantic', r.note);
    assert.ok(googleCalls >= 1, 'Gemini was used');
    assert.ok(googleBodies.length > 0);
  } finally {
    process.env.HOME = prevHome;
    keyVars.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
