/**
 * CC-KIE-2 — KIE balance tile.
 *
 * Joint plan line 1068 / decision 19: keep the numeric balance that
 * `verifyKey()` already fetches from Kie's GET /chat/credit and show
 * "KIE credits: N" on the Intelligence Settings tile.
 *
 * This suite locks down the three honest properties of that build:
 *   1. `verifyKey()` KEEPS the balance it already fetches (`data.credit`) and
 *      reports it on the SmokeTestResult — previously it was discarded.
 *   2. FAIL-CLOSED: a missing/rejected key or a malformed reply yields NO
 *      balance (undefined / null) — never a fabricated number.
 *   3. The EXISTING provider-status read path carries it: the balance is
 *      persisted with the cached proof (`provider_auth_proof_cache.credits`,
 *      migration 170) and returned by `getCachedAuthProof()` /
 *      `getOrProveProviderAuth()` with no extra live call.
 *
 * NO LIVE CALL: `fetch` is stubbed for every case with fixtures shaped like
 * the real /chat/credit envelope (ORCHESTRATOR-MEASURED: `{code, msg, data}`).
 *
 * Runs via the Node built-in test runner (`npm run test:unit`).
 */

// C8 — DB isolation. provider-auth-proof.ts pulls in '@/lib/db' transitively.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { run as dbRun } from '../../src/lib/db';

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = (globalThis as Record<string, unknown>).fetch;
  (globalThis as Record<string, unknown>).fetch = impl;
  return () => {
    if (orig === undefined) delete (globalThis as Record<string, unknown>).fetch;
    else (globalThis as Record<string, unknown>).fetch = orig;
  };
}

function clearKieProof(): void {
  dbRun(`DELETE FROM provider_auth_proof_cache WHERE provider_slug = ?`, ['kie']);
}

// ── 1. verifyKey keeps the balance ───────────────────────────────────────

test('[CC-KIE-2] verifyKey keeps the /chat/credit balance ({code:200,data:{credit:100}}) -> ok:true, credits:100', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  let calledUrl = '';
  const restore = stubFetch(async (url) => {
    calledUrl = String(url);
    return new Response(JSON.stringify({ code: 200, msg: 'ok', data: { credit: 100 } }), { status: 200 });
  });
  try {
    const result = await verifyKey('kie-good');
    assert.equal(result.ok, true);
    assert.equal(result.credits, 100, 'the already-fetched balance must be kept, not discarded');
    assert.match(calledUrl, /\/chat\/credit$/, 'must hit /chat/credit');
  } finally {
    restore();
  }
});

test('[CC-KIE-2] verifyKey: a non-numeric credit is dropped (no fabricated number), ok still true', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ code: 200, data: { credit: 'not-a-number' } }), { status: 200 }),
  );
  try {
    const result = await verifyKey('kie-odd');
    assert.equal(result.ok, true);
    assert.equal(result.credits, undefined, 'a malformed credit must never become a number');
  } finally {
    restore();
  }
});

test('[CC-KIE-2] verifyKey: missing data{} -> ok:true, no credits (fail-closed)', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  const restore = stubFetch(async () => new Response(JSON.stringify({ code: 200 }), { status: 200 }));
  try {
    const result = await verifyKey('kie-nodata');
    assert.equal(result.ok, true);
    assert.equal(result.credits, undefined);
  } finally {
    restore();
  }
});

test('[CC-KIE-2] verifyKey: rejected key ({code:401}) -> ok:false, no credits', async () => {
  const { verifyKey } = await import('../../src/lib/model-providers/kie');
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ code: 401, msg: 'Unauthorized' }), { status: 200 }),
  );
  try {
    const result = await verifyKey('kie-bad');
    assert.equal(result.ok, false);
    assert.equal(result.credits, undefined, 'a rejected key must never surface a balance');
  } finally {
    restore();
  }
});

// ── 2. The read path carries the balance (persist + cache-hit) ────────────

test('[CC-KIE-2] getOrProveProviderAuth persists the balance, and getCachedAuthProof returns it (existing read path)', async () => {
  const { getOrProveProviderAuth, getCachedAuthProof } = await import('../../src/lib/provider-auth-proof');
  clearKieProof();
  let fetchCount = 0;
  const restore = stubFetch(async () => {
    fetchCount += 1;
    return new Response(JSON.stringify({ code: 200, data: { credit: 42 } }), { status: 200 });
  });
  try {
    const proof = await getOrProveProviderAuth('kie', 'kie-good', { force: true });
    assert.equal(proof.ok, true);
    assert.equal(proof.method, 'verify_key');
    assert.equal(proof.credits, 42, 'the proof result must carry the balance');

    const cached = getCachedAuthProof('kie');
    assert.ok(cached, 'the proof must be cached');
    assert.equal(cached!.credits, 42, 'the cache row (read path) must carry the balance');

    // A second, non-forced call is a fresh cache hit — NO new network call.
    const fetchCountAfterFirst = fetchCount;
    const cachedHit = await getOrProveProviderAuth('kie', 'kie-good', {});
    assert.equal(cachedHit.credits, 42, 'a cache hit must still surface the balance');
    assert.equal(fetchCount, fetchCountAfterFirst, 'a fresh cache hit must never re-call the provider');
  } finally {
    restore();
    clearKieProof();
  }
});

test('[CC-KIE-2] a failed proof overwrites credits with null — never a stale or fabricated number', async () => {
  const { getOrProveProviderAuth, getCachedAuthProof } = await import('../../src/lib/provider-auth-proof');
  clearKieProof();
  // Seed a good balance first.
  const restoreGood = stubFetch(async () =>
    new Response(JSON.stringify({ code: 200, data: { credit: 7 } }), { status: 200 }),
  );
  await getOrProveProviderAuth('kie', 'kie-good', { force: true });
  restoreGood();
  assert.equal(getCachedAuthProof('kie')!.credits, 7);

  // Now the key is rejected — the cached balance must go, not linger.
  const restoreBad = stubFetch(async () => new Response(JSON.stringify({ code: 401, msg: 'Unauthorized' }), { status: 200 }));
  try {
    const proof = await getOrProveProviderAuth('kie', 'kie-bad', { force: true });
    assert.equal(proof.ok, false);
    assert.equal(proof.credits, null);
    assert.equal(getCachedAuthProof('kie')!.credits, null, 'a failed proof must clear the cached balance');
  } finally {
    restoreBad();
    clearKieProof();
  }
});
