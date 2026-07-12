/**
 * Unit tests — department-embedding cache (P4-03 step 6)
 *
 * Proves that department-router.ts::semanticRankDepartments() no longer
 * re-embeds every department's (name + purpose + keywords) text on EVERY
 * comDispatch() call. PRE-FIX: N+1 embed calls per dispatch (1 task text +
 * N department texts, EVERY time). POST-FIX: 1 call for the live task text
 * always, plus ONLY the uncached/stale department deltas (0 on a warm cache).
 *
 * Uses the Google provider (SOP_EMBEDDING_PROVIDER=google) because Google's
 * embedContent API is one-HTTP-call-per-text (sop-embeddings.ts
 * fetchEmbeddingsGoogle) — so "number of fetch() calls" is a direct,
 * unambiguous proxy for "number of texts embedded", which is exactly the
 * quantity P4-03's QC break-it probe counts ("count embedding calls in one
 * comDispatch() before/after the cache (N+1 → 1, quoted)").
 *
 * global.fetch is monkey-patched (no external mocking library needed — this
 * matches how the rest of this codebase already isolates OS env / DB state
 * for tests, e.g. _isolated-db.ts) to a deterministic in-memory fake so the
 * suite makes ZERO real network calls and needs no real API key.
 *
 * Runs via Node built-in test runner under tsx (`npm run test:unit`).
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

let fetchCallCount = 0;
let fetchInputTextCount = 0;

/** A deterministic fake Google embedContent response — one HTTP call per text. */
function installFakeGoogleFetch(): void {
  fetchCallCount = 0;
  fetchInputTextCount = 0;
  // @ts-expect-error — test-only global fetch override
  global.fetch = async (url: string, _init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com') && url.includes('embedContent')) {
      fetchCallCount += 1;
      fetchInputTextCount += 1; // Google is always 1 text per call
      const values = Array.from({ length: 3072 }, (_, i) => ((fetchCallCount * 7 + i) % 97) / 97);
      return new Response(JSON.stringify({ embedding: { values } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch() call in test: ${url}`);
  };
}

function restoreFetch(): void {
  global.fetch = ORIGINAL_FETCH;
}

function restoreEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function makeAgent(id: string, role: string) {
  return {
    id,
    name: id,
    role,
    status: 'active' as const,
    workspace_id: id,
    is_master: false,
    active_tasks: 0,
    department: role,
    description: '',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    model: 'test',
    persona: null,
  };
}

function makeDept(id: string, name: string, purpose: string, keywords: string[] = []) {
  return { id, name, purpose, keywords, agentRoles: [name + ' Specialist'], priority: 5 };
}

test('department-embedding cache: first dispatch embeds task + every dept, second dispatch embeds ONLY the task', async (t) => {
  process.env.SOP_EMBEDDING_PROVIDER = 'google';
  process.env.GOOGLE_API_KEY = 'test-fake-google-key-not-real-0123456789';
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  installFakeGoogleFetch();

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  // Dynamic imports AFTER env is set (provider resolution reads env per-call,
  // but importing after keeps this test hermetic and order-independent).
  const { comDispatch, _resetDeptVectorCacheForTests, _deptVectorCacheSizeForTests } = await import(
    '../../src/lib/routing/department-router'
  );

  _resetDeptVectorCacheForTests();
  assert.equal(_deptVectorCacheSizeForTests(), 0, 'cache must start empty');

  const departments = [
    makeDept('marketing', 'Marketing', 'Campaigns, brand, email, SEO.', ['marketing', 'campaign']),
    makeDept('sales', 'Sales', 'Pipeline, prospects, deals.', ['sales', 'pipeline']),
    makeDept('finance', 'Finance', 'Bookkeeping, invoices, payroll.', ['finance', 'invoice']),
  ];
  const agents = [
    makeAgent('mkt-agent', 'Marketing Specialist'),
    makeAgent('sales-agent', 'Sales Specialist'),
    makeAgent('fin-agent', 'Finance Specialist'),
  ];

  // ── Dispatch 1: cold cache — 3 departments + 1 task text = 4 texts / 4 calls ──
  await comDispatch({ title: 'Launch a new campaign', description: 'brand awareness push', priority: 'medium' }, agents, departments);

  assert.equal(
    fetchInputTextCount,
    4,
    `first dispatch (cold cache) must embed exactly 4 texts (3 departments + 1 task) — got ${fetchInputTextCount}`,
  );
  assert.equal(_deptVectorCacheSizeForTests(), 3, 'all 3 departments must be cached after dispatch 1');

  const callsAfterFirstDispatch = fetchInputTextCount;

  // ── Dispatch 2: warm cache, SAME departments — only the task text embeds ──
  await comDispatch({ title: 'Chase overdue invoices', description: 'collections follow-up', priority: 'medium' }, agents, departments);

  const callsDuringSecondDispatch = fetchInputTextCount - callsAfterFirstDispatch;
  assert.equal(
    callsDuringSecondDispatch,
    1,
    `second dispatch (warm cache, unchanged departments) must embed exactly 1 text (task only, N+1 → 1) — got ${callsDuringSecondDispatch}`,
  );
});

test('department-embedding cache: editing a department invalidates ONLY that department', async (t) => {
  process.env.SOP_EMBEDDING_PROVIDER = 'google';
  process.env.GOOGLE_API_KEY = 'test-fake-google-key-not-real-0123456789';
  delete process.env.OPENAI_API_KEY;
  installFakeGoogleFetch();

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const { comDispatch, _resetDeptVectorCacheForTests } = await import('../../src/lib/routing/department-router');
  _resetDeptVectorCacheForTests();

  const departments = [
    makeDept('marketing', 'Marketing', 'Campaigns, brand, email, SEO.', ['marketing']),
    makeDept('sales', 'Sales', 'Pipeline, prospects, deals.', ['sales']),
  ];
  const agents = [makeAgent('mkt-agent', 'Marketing Specialist'), makeAgent('sales-agent', 'Sales Specialist')];

  await comDispatch({ title: 'Run a campaign', description: '', priority: 'medium' }, agents, departments);
  const afterFirst = fetchInputTextCount;

  // Edit ONLY the marketing department's purpose — sales is untouched.
  const editedDepartments = [
    makeDept('marketing', 'Marketing', 'COMPLETELY NEW purpose text after an operator edit.', ['marketing', 'rebrand']),
    departments[1],
  ];

  await comDispatch({ title: 'Chase invoices', description: '', priority: 'medium' }, agents, editedDepartments);
  const secondDispatchCalls = fetchInputTextCount - afterFirst;

  // Expect: 1 (task) + 1 (marketing re-embedded, hash changed) = 2. Sales must
  // NOT re-embed (hash unchanged).
  assert.equal(
    secondDispatchCalls,
    2,
    `editing one department must re-embed ONLY that department + the task (2 texts), not the whole roster — got ${secondDispatchCalls}`,
  );
});

test('department-embedding cache: distinct department ids never collide in the cache', async (t) => {
  process.env.SOP_EMBEDDING_PROVIDER = 'google';
  process.env.GOOGLE_API_KEY = 'test-fake-google-key-not-real-0123456789';
  delete process.env.OPENAI_API_KEY;
  installFakeGoogleFetch();

  t.after(() => {
    restoreFetch();
    restoreEnv();
  });

  const { comDispatch, _resetDeptVectorCacheForTests, _deptVectorCacheSizeForTests } = await import(
    '../../src/lib/routing/department-router'
  );
  _resetDeptVectorCacheForTests();

  const departments = [
    makeDept('ops-a', 'Operations Alpha', 'Alpha ops.', ['alpha']),
    makeDept('ops-b', 'Operations Beta', 'Beta ops.', ['beta']),
  ];
  const agents = [makeAgent('a', 'Operations Alpha Specialist'), makeAgent('b', 'Operations Beta Specialist')];

  await comDispatch({ title: 'Handle alpha task', description: '', priority: 'medium' }, agents, departments);
  assert.equal(_deptVectorCacheSizeForTests(), 2);
});
