/**
 * Unit tests — local Ollama mode (SOP_EMBEDDING_PROVIDER=ollama) for the in-memory
 * matchers: department-router semantic ranking and the context-pack skill match.
 *
 * Proves (global.fetch faked — zero network):
 *   1. Local mode embeds with the configured local model at <url>/api/embed, task text
 *      with the embeddinggemma query prefix, department / skill text with the document
 *      prefix, and never calls Google even when a Google key is present.
 *   2. A Google box sends the exact same raw texts as before (no prefix).
 *   3. Ollama down + the box's own Google key: router and skill matcher re-embed with Gemini (0.55 floor);
 *      Ollama down + no key: keyword, no Google call (v7.6.108: Ollama down used to mean keyword even with a key).
 *
 * Run: node --import tsx --test tests/unit/local-embed-router-skills.test.ts
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const GEMMA = 'embeddinggemma-2:740m';
const ENV_KEYS = [
  'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_AI_STUDIO_API_KEY', 'GEMINI_API_KEY',
  'SOP_EMBEDDING_PROVIDER', 'SOP_EMBEDDING_OLLAMA_URL', 'SOP_EMBEDDING_MODEL', 'SOP_EMBEDDING_DIMS',
  'CC_SKILL_ROOTS', 'CC_SKILL_DEPARTMENT_MAP', 'MIN_ROUTING_CONFIDENCE', 'SOP_EMBEDDING_GEMINI_FALLBACK', 'HOME',
];
const GOOGLE_KEY = 'AIza-test-key-long-enough-1234567890';
const LOCAL = {
  SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_MODEL: GEMMA, SOP_EMBEDDING_DIMS: '768',
  SOP_EMBEDDING_OLLAMA_URL: 'http://127.0.0.1:11434', GOOGLE_API_KEY: GOOGLE_KEY,
};

// Skills fixture (keyword-distinct so the fallback is deterministic).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-local-embed-'));
for (const [name, desc] of [
  ['invoice-bot', 'Generate and send customer invoice reminders.'],
  ['campaign-writer', 'Write marketing campaign copy.'],
]) {
  fs.mkdirSync(path.join(TMP, name), { recursive: true });
  fs.writeFileSync(path.join(TMP, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n`);
}
fs.writeFileSync(path.join(TMP, 'map.json'), '{}');

/** One-hot by topic word, so a task and its department/skill text have cosine 1. */
function topicVec(text: string, dims: number): number[] {
  const v = new Array(dims).fill(0);
  const t = text.toLowerCase();
  v[t.includes('invoice') ? 1 : t.includes('campaign') ? 2 : 3] = 1;
  return v;
}

type Call = { url: string; model?: string; input: string };
let calls: Call[] = [];
let ollamaDown = false;
/** Optional per-test vector override for the fake Ollama. */
let vecOverride: ((input: string) => number[]) | null = null;

/** Task = e1; text naming `hit` sits at cosine `c` from it; anything else is orthogonal. */
function cosineFixture(hit: string, c: number): (input: string) => number[] {
  return (input: string) => {
    const v = new Array(768).fill(0);
    if (input.startsWith('task: search result | query: ')) v[0] = 1;
    else if (input.includes(hit)) { v[0] = c; v[1] = Math.sqrt(1 - c * c); }
    else v[2] = 1;
    return v;
  };
}
const ORIGINAL_FETCH = global.fetch;

function installFetch(): void {
  calls = [];
  global.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (String(url).includes('generativelanguage.googleapis.com')) {
      const input = body.content.parts[0].text;
      calls.push({ url: String(url), input });
      return new Response(JSON.stringify({ embedding: { values: topicVec(input, 3072) } }), { status: 200 });
    }
    if (String(url).endsWith('/api/embed')) {
      calls.push({ url: String(url), model: body.model, input: body.input });
      if (ollamaDown) throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
      const vec = vecOverride ? vecOverride(body.input) : topicVec(body.input, 768);
      return new Response(JSON.stringify({ embeddings: [vec] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
}

async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  // HOME is the temp dir: a test must never read the real ~/.openclaw secret stores (the Gemini fallback looks there).
  Object.assign(process.env, { CC_SKILL_ROOTS: TMP, CC_SKILL_DEPARTMENT_MAP: path.join(TMP, 'map.json'), HOME: TMP }, vars);
  installFetch();
  (await import('../../src/lib/sop-embeddings')).__resetEmbedFallback();
  const router = await import('../../src/lib/routing/department-router');
  const cp = await import('../../src/lib/context-pack');
  router._resetDeptVectorCacheForTests();
  cp.clearEmbeddingCache();
  try {
    await fn();
  } finally {
    ollamaDown = false;
    vecOverride = null;
    global.fetch = ORIGINAL_FETCH;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

const DEPTS = [
  { id: 'finance', name: 'Finance', purpose: 'Bookkeeping and invoice collection.', keywords: ['invoice', 'payroll'], agentRoles: ['Finance Specialist'], priority: 5 },
  { id: 'marketing', name: 'Marketing', purpose: 'Brand campaign work.', keywords: ['campaign', 'brand'], agentRoles: ['Marketing Specialist'], priority: 5 },
];
const TASK = { title: 'Chase overdue invoice', description: 'payroll month-end', priority: 'medium' as const };
const TASK_TEXT = 'Chase overdue invoice — payroll month-end';

test('local mode: router embeds with the local model and embeddinggemma prefixes, never Google', async () => {
  await withEnv(LOCAL, async () => {
    const { pickDepartment } = await import('../../src/lib/routing/department-router');
    const pick = await pickDepartment(TASK, DEPTS as never, { order: ['semantic'] });
    assert.equal(pick.method, 'semantic', pick.note);
    assert.equal(pick.department?.id, 'finance');
    assert.ok(calls.length === 3 && calls.every((c) => c.url === 'http://127.0.0.1:11434/api/embed' && c.model === GEMMA), JSON.stringify(calls));
    assert.deepEqual(calls.map((c) => c.input), [
      'title: none | text: Finance. Bookkeeping and invoice collection.. Keywords: invoice, payroll',
      'title: none | text: Marketing. Brand campaign work.. Keywords: campaign, brand',
      `task: search result | query: ${TASK_TEXT}`,
    ]);
  });
});

test('local mode: skill matcher ranks semantically with the local model and prefixes', async () => {
  await withEnv(LOCAL, async () => {
    const { matchSkillsForTask } = await import('../../src/lib/context-pack');
    const m = await matchSkillsForTask({ title: TASK.title, description: TASK.description });
    assert.equal(m[0]?.name, 'invoice-bot');
    assert.equal(m[0]?.matchKind, 'semantic');
    assert.ok(calls.every((c) => c.model === GEMMA && c.url.endsWith('/api/embed')), JSON.stringify(calls));
    assert.equal(calls[0].input, `task: search result | query: ${TASK_TEXT}`);
    assert.ok(calls.slice(1).every((c) => c.input.startsWith('title: none | text: ')));
  });
});

test('Google box: router and skill matcher send the same raw texts as before', async () => {
  await withEnv({ SOP_EMBEDDING_PROVIDER: 'google', GOOGLE_API_KEY: GOOGLE_KEY }, async () => {
    const { pickDepartment } = await import('../../src/lib/routing/department-router');
    const { matchSkillsForTask } = await import('../../src/lib/context-pack');
    const { localEmbedText } = await import('../../src/lib/sop-embeddings');
    const pick = await pickDepartment(TASK, DEPTS as never, { order: ['semantic'] });
    assert.equal(pick.method, 'semantic');
    assert.deepEqual(calls.map((c) => c.input), [
      'Finance. Bookkeeping and invoice collection.. Keywords: invoice, payroll',
      'Marketing. Brand campaign work.. Keywords: campaign, brand',
      TASK_TEXT,
    ]);
    assert.ok(calls.every((c) => c.url.includes('generativelanguage.googleapis.com')));
    calls = [];
    const m = await matchSkillsForTask({ title: TASK.title, description: TASK.description });
    assert.equal(m[0]?.matchKind, 'semantic');
    assert.equal(calls[0].input, TASK_TEXT);
    assert.equal(localEmbedText('x', 'query'), 'x');
  });
  // A local box with SOP_EMBEDDING_MODEL unset is on embeddinggemma (prefixed);
  // an override to another model gets raw text.
  await withEnv({ SOP_EMBEDDING_PROVIDER: 'ollama' }, async () => {
    const { localEmbedText, resolveEmbeddingProvider } = await import('../../src/lib/sop-embeddings');
    assert.equal(resolveEmbeddingProvider().model, GEMMA);
    assert.equal(localEmbedText('x', 'document'), 'title: none | text: x');
  });
  await withEnv({ SOP_EMBEDDING_PROVIDER: 'ollama', SOP_EMBEDDING_MODEL: 'other-embed-model' }, async () => {
    const { localEmbedText } = await import('../../src/lib/sop-embeddings');
    assert.equal(localEmbedText('x', 'document'), 'x');
  });
});

test('Ollama down + the box\'s own Google key: router and skill matcher re-embed with Gemini', async () => {
  await withEnv(LOCAL, async () => {
    ollamaDown = true;
    const { pickDepartment } = await import('../../src/lib/routing/department-router');
    const { matchSkillsForTask } = await import('../../src/lib/context-pack');
    const pick = await pickDepartment(TASK, DEPTS as never, { order: ['semantic', 'keyword'], tail: [] });
    assert.equal(pick.method, 'semantic', pick.note);
    assert.equal(pick.department?.id, 'finance');
    const googleCalls = calls.filter((c) => c.url.includes('googleapis'));
    assert.ok(googleCalls.length >= 3, 'task + both departments embedded with Gemini');
    assert.ok(googleCalls.every((c) => !c.input.startsWith('task: search result') && !c.input.startsWith('title: none')), 'raw text, no embeddinggemma prefixes');
    const m = await matchSkillsForTask({ title: TASK.title, description: TASK.description });
    assert.equal(m[0]?.name, 'invoice-bot');
    assert.equal(m[0]?.matchKind, 'semantic');
  });
});

test('Ollama down + no Google key: router and skill matcher fall back to keyword, no Google call', async () => {
  const { GOOGLE_API_KEY: _drop, ...noKey } = LOCAL;
  void _drop;
  await withEnv(noKey, async () => {
    ollamaDown = true;
    const { pickDepartment } = await import('../../src/lib/routing/department-router');
    const { matchSkillsForTask } = await import('../../src/lib/context-pack');
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); };
    try {
      const pick = await pickDepartment(TASK, DEPTS as never, { order: ['semantic', 'keyword'], tail: [] });
      assert.equal(pick.method, 'keyword', pick.note);
      assert.equal(pick.department?.id, 'finance');
    } finally {
      console.warn = origWarn;
    }
    assert.equal(warns.filter((w) => w.includes('Semantic ranking unavailable')).length, 1, warns.join('\n'));
    const m = await matchSkillsForTask({ title: TASK.title, description: TASK.description });
    assert.equal(m[0]?.name, 'invoice-bot');
    assert.equal(m[0]?.matchKind, 'keyword');
    assert.ok(calls.every((c) => !c.url.includes('googleapis')), 'no key: Google is never called');
  });
});

test('local embeddinggemma: router floor is 0.69 (0.65 → General Task, 0.72 → the department)', async () => {
  await withEnv(LOCAL, async () => {
    const router = await import('../../src/lib/routing/department-router');
    assert.equal(router.ollamaRoutingFloor(GEMMA), 0.69);
    assert.equal(router.ollamaRoutingFloor('other-embed-model'), 0.56);
    vecOverride = cosineFixture('Finance', 0.65);
    const unsure = await router.pickDepartment(TASK, DEPTS as never, { order: ['semantic'] });
    assert.equal(unsure.department, null, `0.65 < 0.69 must be General Task: ${unsure.note}`);
    router._resetDeptVectorCacheForTests();
    vecOverride = cosineFixture('Finance', 0.72);
    const sure = await router.pickDepartment(TASK, DEPTS as never, { order: ['semantic'] });
    assert.equal(sure.method, 'semantic', sure.note);
    assert.equal(sure.department?.id, 'finance');
  });
});

test('local embeddinggemma: skill floor is 0.74 (0.70 → keyword, 0.78 → semantic); Google keeps 0.55', async () => {
  await withEnv(LOCAL, async () => {
    const cp = await import('../../src/lib/context-pack');
    assert.equal(cp.skillMatchFloor(), 0.74);
    vecOverride = cosineFixture('invoice-bot', 0.70);
    const low = await cp.matchSkillsForTask({ title: TASK.title, description: TASK.description });
    assert.equal(low[0]?.matchKind, 'keyword', '0.70 < 0.74 must not count as a semantic match');
    cp.clearEmbeddingCache();
    vecOverride = cosineFixture('invoice-bot', 0.78);
    const high = await cp.matchSkillsForTask({ title: TASK.title, description: TASK.description });
    assert.equal(high[0]?.name, 'invoice-bot');
    assert.equal(high[0]?.matchKind, 'semantic');
  });
  await withEnv({ SOP_EMBEDDING_PROVIDER: 'google', GOOGLE_API_KEY: GOOGLE_KEY }, async () => {
    const cp = await import('../../src/lib/context-pack');
    assert.equal(cp.skillMatchFloor(), 0.55);
  });
});

test('router department-vector cache is keyed on provider + model, not just the text', async () => {
  await withEnv(LOCAL, async () => {
    const { pickDepartment } = await import('../../src/lib/routing/department-router');
    await pickDepartment(TASK, DEPTS as never, { order: ['semantic'] });
    calls = [];
    process.env.SOP_EMBEDDING_MODEL = 'other-embed-model';
    await pickDepartment(TASK, DEPTS as never, { order: ['semantic'] });
    assert.deepEqual(calls.map((c) => c.input), [
      'Finance. Bookkeeping and invoice collection.. Keywords: invoice, payroll',
      'Marketing. Brand campaign work.. Keywords: campaign, brand',
      TASK_TEXT,
    ], 'a model switch must re-embed the departments (raw text for a non-embeddinggemma model)');
    assert.ok(calls.every((c) => c.model === 'other-embed-model'));
  });
});
