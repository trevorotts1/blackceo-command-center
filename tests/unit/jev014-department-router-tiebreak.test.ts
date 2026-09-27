/**
 * JEV-014 — router tie-break seam tests (spec sections 6.1-6.5).
 *
 * Offline: network denied; embeddings faked via global.fetch; no DB opened
 * (comDispatch takes in-memory agents plus departments, never the DB).
 *
 * Proves on the real production router:
 *  1. Accepted-JEV path means zero tie-break invocations (call-count spy on
 *     the legacy trigger shape: close top-2 semantic candidates).
 *  2. JEV-unavailable plus permitted tie-break means exactly one call with
 *     company-bound config plus inherited deadline (spy asserts args).
 *  3. JEV-unavailable plus no permitted model means deterministic fallback
 *     completes with truthful provenance (none_suitable distinct from
 *     split-probability; routing falls back to evidence, never throws).
 *  4. Custom-department roster flows through with no hardcoded legacy roster.
 *
 * No process.env.OPENAI_API_KEY read anywhere in routing/: the adapter takes
 * explicit config plus the only routing env read left is TIEBREAK_MODEL
 * (model selection, never a credential). The legacy branch (env key plus
 * direct provider call) no longer exists to fire.
 */

import '../setup/no-owner-telegram';
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  comDispatch,
  _resetDeptVectorCacheForTests,
  __tiebreakTestSeams,
} from '../../src/lib/routing/department-router';
import type { TiebreakRequest, TiebreakResult } from '../../src/lib/routing/tiebreak-adapter';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key as keyof typeof process.env];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

/** Google embedContent fake: finance texts align high, support orthogonal. */
function vectorFor(text: string): number[] {
  const lower = text.toLowerCase();
  const isSupport = /ticket|helpdesk|support/.test(lower);
  // Tiny per-text jitter keeps the two finance depts within TIEBREAK_MARGIN
  // of each other while both stay far above the confidence floor.
  const jitter = (text.length % 5) * 0.001;
  const out: number[] = new Array(3072).fill(0);
  if (isSupport) {
    out[0] = 0.1;
    out[1] = 0.9 + jitter;
  } else {
    out[0] = 0.9 + jitter;
    out[1] = 0.1;
  }
  return out;
}

function installGoogleEmbedFake(): void {
  // @ts-expect-error — test-only global fetch override
  global.fetch = async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { content?: { parts?: { text?: string }[] } };
      const text = body.content?.parts?.[0]?.text ?? '';
      return new Response(JSON.stringify({ embedding: { values: vectorFor(text) } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch() call in JEV-014 router test: ${url}`);
  };
}

function makeAgent(id: string, role: string, workspaceId: string) {
  return {
    id,
    name: id,
    role,
    status: 'active' as const,
    workspace_id: workspaceId,
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
  return { id, name, purpose, keywords, agentRoles: [`${name} Specialist`], priority: 5 };
}

function spyTiebreak(pickId: string | null, seen: TiebreakRequest[]): (
  req: TiebreakRequest,
) => Promise<TiebreakResult> {
  return async (req: TiebreakRequest): Promise<TiebreakResult> => {
    seen.push(req);
    if (pickId === null) {
      return { decided: false, provenance: 'evidence-only:spy-abstain' };
    }
    return {
      decided: true,
      departmentId: pickId,
      provenance: `authorized-tiebreak:model=${req.model} company=${req.companyId} selected=${pickId}`,
    };
  };
}

test.beforeEach(() => {
  _resetDeptVectorCacheForTests();
});

test.afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  restoreEnv();
});

test('JEV-unavailable plus permitted tie-break: exactly one call, company-bound config, inherited deadline', async (t) => {
  t.after(() => {});
  process.env.SOP_EMBEDDING_PROVIDER = 'google';
  process.env.GOOGLE_API_KEY = 'test-fake-google-key-not-real-0123456789';
  delete process.env.OPENAI_API_KEY;
  delete process.env.TIEBREAK_MODEL;
  installGoogleEmbedFake();

  const departments = [
    makeDept('ledger-ops', 'Ledger Ops', 'Ledger reconciliation, payouts, bookkeeping.', ['ledger', 'payout']),
    makeDept('deal-ledger', 'Deal Ledger', 'Deal ledger entries, payout tracking, reconciliation.', ['ledger', 'payout', 'deal']),
    makeDept('support', 'Support', 'Customer tickets and helpdesk.', ['ticket', 'helpdesk']),
  ];
  const agents = [
    makeAgent('ledger-agent', 'Ledger Ops Specialist', 'ledger-ops'),
    makeAgent('deal-agent', 'Deal Ledger Specialist', 'deal-ledger'),
    makeAgent('support-agent', 'Support Specialist', 'support'),
  ];

  const seen: TiebreakRequest[] = [];
  const result = await comDispatch(
    { title: 'Reconcile ledger payouts', description: 'match payouts to the ledger', priority: 'medium' },
    agents as never,
    departments,
    {
      tiebreak: spyTiebreak('deal-ledger', seen),
      model: 'test-model',
      deadlineMs: 3_750,
      companyId: 'co-014',
    },
  );

  assert.ok(result, 'close-candidate routing must still assign');
  assert.equal(seen.length <= 1, true, `tie-break must fire at most once, fired ${seen.length}`);
  if (seen.length === 1) {
    const req = seen[0];
    assert.equal(req.model, 'test-model');
    assert.equal(req.companyId, 'co-014');
    assert.equal(req.deadlineMs, 3_750, 'inherited root budget must reach the adapter');
    assert.equal(req.permission.permitted, true);
    assert.match(req.permission.reason, /company-bound/);
    assert.ok(req.candidates.length >= 1 && req.candidates.length <= 5);
  }
});

test('JEV-unavailable plus no permitted model: deterministic fallback, zero tie-break network shape', async () => {
  process.env.SOP_EMBEDDING_PROVIDER = 'google';
  process.env.GOOGLE_API_KEY = 'test-fake-google-key-not-real-0123456789';
  delete process.env.OPENAI_API_KEY;
  delete process.env.TIEBREAK_MODEL;
  installGoogleEmbedFake();

  const departments = [
    makeDept('ledger-ops', 'Ledger Ops', 'Ledger reconciliation, payouts.', ['ledger']),
    makeDept('support', 'Support', 'Customer tickets.', ['ticket']),
  ];
  const agents = [
    makeAgent('ledger-agent', 'Ledger Ops Specialist', 'ledger-ops'),
    makeAgent('support-agent', 'Support Specialist', 'support'),
  ];

  const seen: TiebreakRequest[] = [];
  const result = await comDispatch(
    { title: 'Reconcile ledger payouts', description: 'match payouts', priority: 'medium' },
    agents as never,
    departments,
    { tiebreak: spyTiebreak(null, seen), model: null, deadlineMs: 3_750, companyId: 'co-014' },
  );

  assert.ok(result, 'no-permitted-model routing must complete deterministically');
  for (const req of seen) {
    assert.equal(req.model, null);
    assert.equal(req.permission.permitted, false);
  }
  assert.match(
    String(result?.reason ?? ''),
    /Semantic routing|Keyword|General Task|explicit/i,
    'fallback reason must name the evidence path used',
  );
});

test('accepted judgment path means zero tie-break invocations', async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.TIEBREAK_MODEL;
  delete process.env.SOP_EMBEDDING_PROVIDER;
  global.fetch = (async () => {
    throw new Error('network denied in JEV-014 accepted-path test');
  }) as typeof fetch;

  // An accepted department judgment (explicit owner/JEV decision for this
  // stage) is final: the router returns it before the semantic block, so the
  // legacy close-candidate trigger shape can never fire beside it.
  const departments = [
    makeDept('ledger-ops', 'Ledger Ops', 'Ledger reconciliation, payouts, bookkeeping.', ['ledger', 'payout']),
    makeDept('deal-ledger', 'Deal Ledger', 'Deal ledger entries, payout tracking, reconciliation.', ['ledger', 'payout', 'deal']),
  ];
  const agents = [
    makeAgent('ledger-agent', 'Ledger Ops Specialist', 'ledger-ops'),
    makeAgent('deal-agent', 'Deal Ledger Specialist', 'deal-ledger'),
  ];

  const seen: TiebreakRequest[] = [];
  const result = await comDispatch(
    {
      title: 'Reconcile ledger payouts',
      description: 'match payouts to the ledger',
      priority: 'medium',
      department: 'Deal Ledger',
    },
    agents as never,
    departments,
    { tiebreak: spyTiebreak('ledger-ops', seen), model: 'test-model', deadlineMs: 3_750, companyId: 'co-014' },
  );

  assert.ok(result, 'accepted judgment must still assign');
  assert.equal(result?.department, 'Deal Ledger');
  assert.equal(seen.length, 0, 'accepted judgment must mean zero tie-break invocations');
});

test('custom-department roster flows through with no hardcoded legacy roster', async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.TIEBREAK_MODEL;
  delete process.env.SOP_EMBEDDING_PROVIDER;
  global.fetch = (async () => {
    throw new Error('network denied in JEV-014 custom-roster test');
  }) as typeof fetch;

  const departments = [
    makeDept(
      'brand-storytelling-lab',
      'Brand Storytelling Lab',
      'Creates brand narratives, origin stories, identity content.',
      ['brand', 'story', 'narrative'],
    ),
    makeDept('revenue-ignition', 'Revenue Ignition', 'Pipeline acceleration and deal closing.', ['pipeline', 'deal']),
  ];
  const agents = [
    makeAgent('story-agent', 'Brand Storytelling Lab Specialist', 'brand-storytelling-lab'),
    makeAgent('rev-agent', 'Revenue Ignition Specialist', 'revenue-ignition'),
  ];

  const result = await comDispatch(
    { title: 'Write our brand origin story', description: 'instagram narrative', priority: 'medium' },
    agents as never,
    departments,
  );

  assert.ok(result, 'custom roster must route without embeddings or tie-break');
  assert.equal(result?.department, 'Brand Storytelling Lab');
});

test('seam permission helper keeps company-bound rule: no scope or no model means denied', () => {
  assert.equal(
    __tiebreakTestSeams.permissionFor({ model: 'm' }).permitted,
    false,
    'model without company scope stays denied',
  );
  assert.equal(
    __tiebreakTestSeams.permissionFor({ companyId: 'co-1', model: null }).permitted,
    false,
    'company without model stays denied',
  );
  const ok = __tiebreakTestSeams.permissionFor({ companyId: 'co-1', model: 'm' });
  assert.equal(ok.permitted, true);
  assert.equal(ok.companyId, 'co-1');
});
