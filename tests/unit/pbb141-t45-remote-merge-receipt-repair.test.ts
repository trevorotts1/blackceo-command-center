/**
 * tests/unit/pbb141-t45-remote-merge-receipt-repair.test.ts
 *
 * PBB-141 / T-45 repair round — the defects the T-45 QC verdict named, each
 * written as a case that FAILS against the previous module and PASSES against
 * the repaired one. The old suite (pbb126-t45-remote-merge-receipt.test.ts) is
 * left untouched: it is the proof that no previously proven clause was
 * weakened, and its inverse cases are re-asserted here too.
 *
 *   D1  lease window ordering compared ISO strings, so mixed-precision
 *       timestamps (`...T10:20Z` vs `...T10:20:30Z`) inverted the order and a
 *       reversed window / a 30 s real overlap rendered green.
 *   D2  check_receipts were never tied to RemoteEvidence.check_runs: a claim
 *       the remote never reported, or one on the post-promotion result sha with
 *       zero remote runs, rendered green; a remote red was never owned.
 *   D3  independent_review was declared and never read.
 *   D4  ci_receipts, dependencies and publication_order_edges were declared and
 *       never read.
 *   D5  proof_evidence.remote_sha was never bound to the remote read-back.
 *   D6  a named repair's proof.remote_sha was only isSha-checked, never bound.
 *   D7  receipt.id was checked by prefix only, not as `M-command-center-<iso>`.
 *   D8  two batch receipts sharing one id collapsed to a single byReceipt key.
 *
 * Pure logic: no network, no merge, no writes.
 *
 *   node --import tsx --test tests/unit/pbb141-t45-remote-merge-receipt-repair.test.ts
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH (C8 guard).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CC_CANONICAL_REMOTE,
  CC_LEASE_REF,
  staleEventContractFingerprint,
  verifyCohortBatch,
  verifyMergeReceipt,
  type BatchVerdict,
  type MergeReceipt,
  type RemoteEvidence,
} from '../../src/lib/integration/remote-merge-receipt';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const REPAIR = 'd'.repeat(40);
const FOREIGN = 'e'.repeat(40);
const CONTRACT = 'src/lib/integration/remote-merge-receipt.ts';

function receipt(): MergeReceipt {
  return {
    schema_version: 1,
    id: 'M-command-center-2026-10-24T10:00:00Z',
    repo_alias: 'command-center',
    canonical_remote: CC_CANONICAL_REMOTE,
    target_branch: 'main',
    base_sha_before: BASE,
    target_sha_after: TARGET,
    merge_method: 'merge',
    publication_order_edges: [],
    candidates: [
      {
        task_id: 'T-45',
        head_sha: HEAD,
        content_digest: 'sha256:1111',
        task_branch: 'pb/PBB-141/t-45',
        files: [CONTRACT],
      },
    ],
    cohort: { members: ['T-45'], compatibility_cases: [], shared_files_resolved_by: null },
    dependencies: [],
    check_receipts: [{ context: 'qc-cc', head_sha: HEAD, conclusion: 'success', run_id: 1 }],
    ci_receipts: [{ workflow: 'qc-cc', run_id: 1, conclusion: 'success' }],
    independent_review: { native_agent_id: 'opus-chain', verdict: 'PASS', exact_head_sha: HEAD },
    repairs_incorporated: [],
    lease: {
      lease_ref: CC_LEASE_REF,
      holder: 'deepseek-chain',
      generation: 1,
      acquired_at: '2026-10-24T10:00:00Z',
      released_at: '2026-10-24T10:05:00Z',
    },
    proof_method: 'ancestry',
    proof_evidence: { remote_sha: TARGET, observed: 'ahead' },
    force_push_or_deletion: false,
    cleanup_dispatched: [],
    open_obligations: [],
    consumer_contracts: { stale_events: staleEventContractFingerprint() },
  };
}

function evidence(): RemoteEvidence {
  return {
    source: 'remote',
    base_sha: BASE,
    target_sha: TARGET,
    declared_required_contexts: ['qc-cc'],
    check_runs: [{ context: 'qc-cc', head_sha: HEAD, conclusion: 'success', run_id: 1 }],
    contained_shas: [HEAD],
    observed_proof_value: null,
  };
}

function codes(input: MergeReceipt, facts: RemoteEvidence = evidence()): string[] {
  return verifyMergeReceipt(input, facts).findings.map((f) => f.code);
}

/** A second receipt for the same target, for the batch-level cases. */
function second(over: Partial<MergeReceipt['lease']> = {}): MergeReceipt {
  const r = receipt();
  r.id = 'M-command-center-2026-10-24T11:00:00Z';
  r.lease = {
    lease_ref: CC_LEASE_REF,
    holder: 'deepseek-chain',
    generation: 2,
    acquired_at: '2026-10-24T11:00:00Z',
    released_at: '2026-10-24T11:05:00Z',
    ...over,
  };
  return r;
}

function batch(entries: { receipt: MergeReceipt; evidence: RemoteEvidence }[]): BatchVerdict {
  return verifyCohortBatch(entries);
}

function batchCodes(found: BatchVerdict): string[] {
  return found.findings.map((f) => f.code);
}

// ── Inverse: the compliant receipt still passes end to end ───────────────────

test('(inv) the compliant receipt is still green in both entry points', () => {
  assert.deepEqual(verifyMergeReceipt(receipt(), evidence()), { ok: true, findings: [] });
  assert.deepEqual(batch([{ receipt: receipt(), evidence: evidence() }]).findings, []);
});

// ── D1 lease windows are instants, never strings ────────────────────────────

test('(D1a) released_at before acquired_at is refused even at mixed precision', () => {
  const r = receipt();
  r.lease.acquired_at = '2026-10-24T10:00:05Z';
  r.lease.released_at = '2026-10-24T10:00Z';
  assert.ok(
    codes(r).includes('TARGET_OWNER_WINDOW_INVALID'),
    'release 10:00:00 precedes acquire 10:00:05 and the window still passed',
  );
});

test('(D1b) a 30 s real overlap hidden by mixed precision is refused at batch level', () => {
  // h1 holds [10:00:00, 10:20:30]; h2 acquires at 10:20:00 -> 30 s of overlap.
  // Lexicographically "10:20:30Z" < "10:20Z" is false only by luck of 'Z' > ':'.
  const first = receipt();
  first.lease = { ...first.lease, holder: 'h1', acquired_at: '2026-10-24T10:00:00Z', released_at: '2026-10-24T10:20:30Z' };
  const secondHolder = second({ holder: 'h2', acquired_at: '2026-10-24T10:20Z', released_at: '2026-10-24T10:25Z' });

  const found = batchCodes(
    batch([
      { receipt: first, evidence: evidence() },
      { receipt: secondHolder, evidence: evidence() },
    ]),
  );
  assert.ok(found.includes('TARGET_OWNER_CONFLICT'), `30 s overlap rendered green: ${JSON.stringify(found)}`);
});

test('(D1c) sequential mixed-precision windows still pass — the comparator is not just stricter', () => {
  const first = receipt();
  first.lease = { ...first.lease, acquired_at: '2026-10-24T10:00Z', released_at: '2026-10-24T10:05:00Z' };
  const next = second({ acquired_at: '2026-10-24T10:05:00Z', released_at: '2026-10-24T10:10Z' });

  const found = batchCodes(
    batch([
      { receipt: first, evidence: evidence() },
      { receipt: next, evidence: evidence() },
    ]),
  );
  assert.ok(!found.includes('TARGET_OWNER_CONFLICT'), `back-to-back windows must not collide: ${JSON.stringify(found)}`);
});

// ── D2 every check claim is backed by a remote check run ─────────────────────

test('(D2a) a check the remote never reported is refused', () => {
  const r = receipt();
  const f = evidence();
  f.declared_required_contexts = [];
  f.check_runs = [{ context: 'qc-cc', head_sha: HEAD, conclusion: 'failure', run_id: 999 }];
  r.check_receipts = [{ context: 'made-up-context', head_sha: HEAD, conclusion: 'success', run_id: 1 }];

  assert.ok(
    codes(r, f).includes('CHECK_NOT_REMOTE'),
    'the receipt fabricated a context the remote never reported and still passed',
  );
});

test('(D2b) a check on the post-promotion result sha with zero remote runs is refused', () => {
  const r = receipt();
  const f = evidence();
  f.check_runs = [];
  r.check_receipts = [{ context: 'qc-cc', head_sha: TARGET, conclusion: 'success', run_id: 1 }];

  assert.ok(
    codes(r, f).includes('CHECK_NOT_REMOTE'),
    'a check on the result sha counted as proved with no remote check run at all',
  );
});

test('(D2c) a remote red on a named head must stay owned in open_obligations', () => {
  const f = evidence();
  f.check_runs = [
    { context: 'qc-cc', head_sha: HEAD, conclusion: 'success', run_id: 1 },
    { context: 'shell-syntax', head_sha: HEAD, conclusion: 'failure', run_id: 2 },
  ];

  assert.ok(
    codes(receipt(), f).includes('RED_CHECK_UNOWNED'),
    'the remote reported a failing check and the receipt dropped it',
  );

  const owned = receipt();
  owned.open_obligations = ['shell-syntax'];
  assert.deepEqual(codes(owned, f), []);
});

test('(D2d) a check the remote confirmed at the same run still passes', () => {
  assert.deepEqual(codes(receipt()), []);
});

// ── D3 the independent review is read ───────────────────────────────────────

test('(D3a) an independent review that says FAIL is refused', () => {
  const r = receipt();
  r.independent_review = { native_agent_id: 'opus-chain', verdict: 'FAIL', exact_head_sha: HEAD };
  assert.ok(codes(r).includes('INDEPENDENT_REVIEW_NOT_PASSING'));
});

test('(D3b) an independent review of a head this promotion never named is refused', () => {
  const r = receipt();
  r.independent_review = { native_agent_id: 'opus-chain', verdict: 'PASS', exact_head_sha: FOREIGN };
  assert.ok(codes(r).includes('INDEPENDENT_REVIEW_STALE'));
});

test('(D3c) an independent review with no reviewer is refused', () => {
  const r = receipt();
  r.independent_review = { native_agent_id: '', verdict: 'PASS', exact_head_sha: HEAD };
  assert.ok(codes(r).includes('INDEPENDENT_REVIEW_INVALID'));
});

// ── D4 ci_receipts, dependencies and publication order are read ─────────────

test('(D4a) a failing CI receipt is refused', () => {
  const r = receipt();
  r.ci_receipts = [{ workflow: 'qc-cc', run_id: 1, conclusion: 'failure' }];
  assert.ok(codes(r).includes('CI_RECEIPT_NOT_PASSING'));
});

test('(D4b) a CI receipt the remote never reported is refused', () => {
  const r = receipt();
  r.ci_receipts = [{ workflow: 'qc-cc', run_id: 42, conclusion: 'success' }];
  assert.ok(codes(r).includes('CI_RECEIPT_NOT_REMOTE'));
});

test('(D4c) a dependency on a candidate this promotion never proved is refused', () => {
  const r = receipt();
  r.dependencies = [{ depends_on_candidate: 'T-99', accepted_contract_ref: CONTRACT }];
  assert.ok(codes(r).includes('DEPENDENCY_UNPROVEN'));
});

test('(D4d) a dependency naming no accepted contract is refused', () => {
  const r = receipt();
  r.dependencies = [{ depends_on_candidate: 'T-45', accepted_contract_ref: 'nope' }];
  assert.ok(codes(r).includes('DEPENDENCY_CONTRACT_UNPROVEN'));
});

test('(D4e) a publication order edge naming an unknown candidate is refused', () => {
  const r = receipt();
  r.publication_order_edges = ['T-99->T-45'];
  assert.ok(codes(r).includes('PUBLICATION_ORDER_UNKNOWN_CANDIDATE'));
});

test('(D4f) a malformed publication order edge is refused', () => {
  const r = receipt();
  r.publication_order_edges = ['nonsense'];
  assert.ok(codes(r).includes('PUBLICATION_ORDER_INVALID'));
});

test('(D4g) a coherent dependency and publication order still passes', () => {
  const r = receipt();
  r.candidates = [
    { task_id: 'T-45', head_sha: HEAD, content_digest: 'sha256:1', task_branch: 'pb/a', files: ['src/a.ts'] },
    { task_id: 'T-46', head_sha: REPAIR, content_digest: 'sha256:2', task_branch: 'pb/b', files: ['src/b.ts'] },
  ];
  r.cohort.members = ['T-45', 'T-46'];
  r.dependencies = [{ depends_on_candidate: 'T-46', accepted_contract_ref: 'src/lib/types.ts' }];
  r.publication_order_edges = ['T-46->T-45'];

  const f = evidence();
  f.contained_shas = [HEAD, REPAIR];
  assert.deepEqual(codes(r, f), []);
});

// ── D5 the promotion proof names the remote read-back ───────────────────────

test('(D5a) proof_evidence.remote_sha pointing at a foreign sha is refused', () => {
  const r = receipt();
  r.proof_evidence = { remote_sha: FOREIGN, observed: 'ahead' };
  assert.ok(codes(r).includes('PROOF_NOT_REMOTE'));
});

test('(D5b) proof_evidence bound to the remote read-back still passes', () => {
  assert.deepEqual(codes(receipt()), []);
});

// ── D6 a named repair's proof is bound too ──────────────────────────────────

test('(D6a) a repair proof naming a foreign remote sha is refused', () => {
  const r = receipt();
  r.repairs_incorporated = [
    { repair_id: 'R-T45-1', commit_sha: REPAIR, proof: { method: 'ancestry', remote_sha: FOREIGN, observed: 'ahead' } },
  ];
  const f = evidence();
  f.contained_shas = [HEAD, REPAIR];
  assert.ok(codes(r, f).includes('REPAIR_PROOF_MISSING'));
});

test('(D6b) a repair with its own sha and its own proof bound to the target still passes', () => {
  const r = receipt();
  r.repairs_incorporated = [
    { repair_id: 'R-T45-1', commit_sha: REPAIR, proof: { method: 'ancestry', remote_sha: TARGET, observed: 'ahead' } },
  ];
  const f = evidence();
  f.contained_shas = [HEAD, REPAIR];
  assert.deepEqual(codes(r, f), []);
});

// ── D7 the receipt id is an id, not a prefix ────────────────────────────────

test('(D7a) an id with no ISO-8601 suffix is refused', () => {
  const r = receipt();
  r.id = 'M-command-center-';
  assert.ok(codes(r).includes('RECEIPT_ID_INVALID'));
});

test('(D7b) an id whose suffix is not an instant is refused', () => {
  const r = receipt();
  r.id = 'M-command-center-A';
  assert.ok(codes(r).includes('RECEIPT_ID_INVALID'));
});

test('(D7c) the ISO-8601 id still passes', () => {
  assert.deepEqual(codes(receipt()), []);
});

// ── D8 duplicate batch ids never collapse ───────────────────────────────────

test('(D8a) two batch receipts sharing one id are refused and both stay reported', () => {
  const clash = second();
  clash.id = 'M-command-center-2026-10-24T10:00:00Z';

  const verdict = batch([
    { receipt: receipt(), evidence: evidence() },
    { receipt: clash, evidence: evidence() },
  ]);

  assert.ok(batchCodes(verdict).includes('RECEIPT_ID_DUPLICATE'), 'a reused receipt id must be refused');
  assert.equal(
    Object.keys(verdict.byReceipt).length,
    2,
    `both receipts must stay reportable: ${JSON.stringify(Object.keys(verdict.byReceipt))}`,
  );
});

test('(D8b) distinct ids still report one entry each', () => {
  const verdict = batch([
    { receipt: receipt(), evidence: evidence() },
    { receipt: second(), evidence: evidence() },
  ]);
  assert.equal(Object.keys(verdict.byReceipt).length, 2);
  assert.ok(!batchCodes(verdict).includes('RECEIPT_ID_DUPLICATE'));
});
