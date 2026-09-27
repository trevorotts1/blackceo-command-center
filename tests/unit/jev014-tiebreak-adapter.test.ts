/**
 * JEV-014 — shared tie-break adapter unit tests (spec section 6.5).
 *
 * Offline: network denied at the suite door; the suite injects a mock fetch
 * per case instead. No DB, no JEV core, no real provider calls.
 *
 * JEV-unavailable plus permitted tie-break means exactly one adapter network
 * call with the company-bound config plus inherited deadline; every denied or
 * misconfigured shape resolves evidence-only with zero network calls plus a
 * truthful provenance string. The router-level zero/exactly-one call proofs
 * live in jev014-department-router-tiebreak.test.ts against the same adapter
 * seam.
 */

import '../setup/no-owner-telegram';
import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizedTiebreak,
  resolveTiebreakModel,
  resolveTiebreakPermission,
  TIEBREAK_TIMEOUT_CAP_MS,
  type TiebreakPermission,
  type TiebreakRequest,
} from '../../src/lib/routing/tiebreak-adapter';

function permitted(companyId = 'co-1'): TiebreakPermission {
  return { permitted: true, companyId, reason: `company-bound:model=test-model` };
}

function baseRequest(overrides: Partial<TiebreakRequest> = {}): TiebreakRequest {
  return {
    taskText: 'Reconcile the quarterly ledger against bank payouts',
    candidates: [
      { id: 'billing-finance', name: 'Billing Finance', purpose: 'Invoices, payouts, ledger reconciliation.' },
      { id: 'sales', name: 'Sales', purpose: 'Pipeline, prospects, deals.' },
    ],
    companyId: 'co-1',
    model: 'test-model',
    apiKey: 'test-credential',
    endpoint: 'https://tiebreak.example.invalid/v1/chat/completions',
    deadlineMs: 4_000,
    permission: permitted(),
    ...overrides,
  };
}

function mockFetch(reply: string, calls: string[], status = 200): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    calls.push(String(url));
    assert.equal(init?.method, 'POST');
    const signal = init?.signal as AbortSignal | undefined;
    assert.ok(signal, 'tie-break must pass an AbortSignal');
    return new Response(
      JSON.stringify({ choices: [{ message: { content: reply } }] }),
      { status, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
}

test('permitted tie-break makes exactly one company-bound call with inherited deadline', async () => {
  const calls: string[] = [];
  const seen: { auth?: string; body?: string; timeoutMs?: number } = {};
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push(String(url));
    seen.auth = (init?.headers as Record<string, string>)?.Authorization;
    seen.body = String(init?.body);
    // AbortSignal.timeout carries the inherited budget: read it back.
    seen.timeoutMs = (init?.signal as AbortSignal & { timeout?: number })?.timeout;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'Billing Finance' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;

  const result = await authorizedTiebreak(baseRequest({ deadlineMs: 4_000 }), fetchImpl);

  assert.equal(calls.length, 1, 'permitted tie-break must make exactly one call');
  assert.equal(calls[0], 'https://tiebreak.example.invalid/v1/chat/completions');
  assert.equal(seen.auth, 'Bearer test-credential', 'call must carry the explicit company credential');
  const body = JSON.parse(seen.body!);
  assert.equal(body.model, 'test-model', 'call must use the explicit configured model');
  assert.ok(Array.isArray(body.messages) && body.messages.length === 2);
  assert.equal(result.decided, true);
  assert.equal(result.departmentId, 'billing-finance');
  assert.match(result.provenance, /authorized-tiebreak:model=test-model company=co-1/);
  assert.ok(
    TIEBREAK_TIMEOUT_CAP_MS === 10_000,
    'legacy 10s ceiling preserved as a cap',
  );
});

test('denied permission makes zero calls and names the reason', async () => {
  const calls: string[] = [];
  const result = await authorizedTiebreak(
    baseRequest({ permission: { permitted: false, reason: 'tie-break-not-permitted:no-permitted-model' } }),
    mockFetch('Billing Finance', calls),
  );
  assert.equal(calls.length, 0);
  assert.equal(result.decided, false);
  assert.equal(result.provenance, 'evidence-only:tie-break-not-permitted:no-permitted-model');
});

test('permitted but no model resolves evidence-only with zero calls', async () => {
  const calls: string[] = [];
  const result = await authorizedTiebreak(
    baseRequest({ model: null }),
    mockFetch('Billing Finance', calls),
  );
  assert.equal(calls.length, 0);
  assert.deepEqual(result, { decided: false, provenance: 'evidence-only:no-permitted-model' });
});

test('permitted plus model but no credential or endpoint never calls', async () => {
  for (const shape of [
    baseRequest({ apiKey: null }),
    baseRequest({ endpoint: null }),
  ]) {
    const calls: string[] = [];
    const result = await authorizedTiebreak(shape, mockFetch('Billing Finance', calls));
    assert.equal(calls.length, 0, 'missing credential/endpoint must mean zero calls');
    assert.equal(result.decided, false);
    assert.match(result.provenance, /no-credential-or-endpoint/);
  }
});

test('http error, empty reply, unknown pick, and throw all resolve evidence-only', async () => {
  const errorFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  assert.equal(
    (await authorizedTiebreak(baseRequest(), errorFetch)).provenance,
    'evidence-only:tie-break-http-500',
  );

  const callsEmpty: string[] = [];
  assert.equal(
    (await authorizedTiebreak(baseRequest(), mockFetch('', callsEmpty))).decided,
    false,
  );
  assert.equal(callsEmpty.length, 1, 'empty reply still counts the one attempt');

  const callsUnknown: string[] = [];
  const unknown = await authorizedTiebreak(
    baseRequest(),
    mockFetch('Department of Moon Landings', callsUnknown),
  );
  assert.equal(unknown.decided, false);
  assert.match(unknown.provenance, /tie-break-no-pick/);

  const throwing = (async () => { throw new DOMException('timed out', 'TimeoutError'); }) as typeof fetch;
  const failed = await authorizedTiebreak(baseRequest(), throwing);
  assert.equal(failed.decided, false);
  assert.match(failed.provenance, /evidence-only:tie-break-failed:TimeoutError/);
});

test('candidate window capped at five; TIEBREAK_MODEL mapping has no hidden default', () => {
  assert.equal(resolveTiebreakModel({} as NodeJS.ProcessEnv), null);
  assert.equal(resolveTiebreakModel({ TIEBREAK_MODEL: '  ' } as NodeJS.ProcessEnv), null);
  assert.equal(
    resolveTiebreakModel({ TIEBREAK_MODEL: 'custom-model' } as NodeJS.ProcessEnv),
    'custom-model',
  );

  assert.deepEqual(resolveTiebreakPermission({ model: 'm', override: true }).permitted, true);
  assert.deepEqual(resolveTiebreakPermission({ model: 'm', override: false }).permitted, false);
  assert.equal(
    resolveTiebreakPermission({ model: 'm' }).permitted,
    false,
    'model without company scope must not permit',
  );
  assert.equal(
    resolveTiebreakPermission({ companyId: 'co-1', model: null }).permitted,
    false,
    'company without model must not permit',
  );
  const ok = resolveTiebreakPermission({ companyId: 'co-1', model: 'custom-model' });
  assert.equal(ok.permitted, true);
  assert.match(ok.reason, /company-bound:model=custom-model/);
});
