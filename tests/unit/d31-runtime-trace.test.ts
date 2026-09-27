/**
 * JEV-031 D31 runtime trace harness — offline tests (node:test + tsx).
 *
 * Covers spec 16.5 chain assertions + owner-direct reroute + NOT_RUN live gate.
 * Fixtures labelled simulated. No DB, no network, no provider keys.
 *
 * Run (repo root): node --import tsx --test tests/unit/d31-runtime-trace.test.ts
 * tsx binary absent in this worktree; reuse is read-only from sibling checkout.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertTraceChain,
  liveProofStatus,
  makeSimulatedTrace,
} from '../../src/lib/decision-engine/trace';

test('happy chain passes', () => {
  const r = assertTraceChain(makeSimulatedTrace());
  assert.equal(r.pass, true);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.mismatches, []);
});

test('owner-direct reroute passes with named target', () => {
  const r = assertTraceChain(
    makeSimulatedTrace({
      executorKind: 'owner-direct',
      executorId: 'agent-named-7',
      ownerDirectTarget: 'agent-named-7',
      rerouteReason: 'owner-direct: "agent-named-7" pinned by owner, bypass scoring',
    }),
  );
  assert.equal(r.pass, true);
});

test('owner-direct without target fails', () => {
  const r = assertTraceChain(makeSimulatedTrace({ executorKind: 'owner-direct' }));
  assert.equal(r.pass, false);
  assert.ok(r.failures.some((f) => f.includes('ownerDirectTarget')));
});

test('owner-direct reason must name target (no silent reroute)', () => {
  const r = assertTraceChain(
    makeSimulatedTrace({
      executorKind: 'owner-direct',
      ownerDirectTarget: 'agent-named-7',
      rerouteReason: 'routine rebalance',
    }),
  );
  assert.equal(r.pass, false);
});

test('dispatch revision rewrite fails + mismatch surfaced', () => {
  const r = assertTraceChain(makeSimulatedTrace({ dispatchRevision: 'rev-8' }));
  assert.equal(r.pass, false);
  assert.ok(r.mismatches.some((m) => m.field === 'dispatchRevision'));
});

test('dispatch hash rewrite fails + mismatch surfaced', () => {
  const r = assertTraceChain(makeSimulatedTrace({ dispatchHash: 'sha256:evil' }));
  assert.equal(r.pass, false);
  assert.ok(r.mismatches.some((m) => m.field === 'dispatchHash'));
});

test('board vs worker hash disagreement reported, chain still passes', () => {
  const r = assertTraceChain(makeSimulatedTrace({ workerUsedHash: 'sha256:other' }));
  assert.equal(r.pass, true);
  assert.ok(r.mismatches.some((m) => m.field.includes('boardHash')));
});

test('artifact without independent review fails (self-report not proof)', () => {
  const r = assertTraceChain(makeSimulatedTrace({ reviewVerdict: null }));
  assert.equal(r.pass, false);
});

test('non-simulated provenance rejected', () => {
  const r = assertTraceChain(
    makeSimulatedTrace({ provenance: 'live' as unknown as 'simulated' }),
  );
  assert.equal(r.pass, false);
});

test('live proof gate always NOT_RUN with concrete missing access', () => {
  const g = liveProofStatus();
  assert.equal(g.status, 'NOT_RUN');
  assert.ok(g.missing.length >= 3);
  assert.ok(g.missing.some((m) => m.includes('D25')));
});
