/**
 * tests/unit/pbb181-t45-remote-merge-receipt-round3.test.ts
 *
 * PBB-181 / T-45 repair round 3 — the holes the qc3-t-45 verdict found in the
 * PBB-141 repair (commit 6eeead8490). Every D9-D17 case FAILS against that
 * commit's module and PASSES against this one; every (inv) case passes on
 * both, so the repair is not just stricter. D18 is coverage: codes the
 * changelog names that no test exercised.
 *
 *   D9   Date.parse rolls invalid calendar dates over (2026-02-30 -> 03-02),
 *        so a lease window or receipt id dated 30 February read as proven.
 *   D10  candidate paths were exact strings: './package.json',
 *        './presentation_job/x' and './src/lib/board/lifecycle-projection.ts'
 *        evaded the singleton, generated-tree and consumer-contract rules.
 *   D11  a check/CI run binding never required a run id and String()-coerced
 *        it: undefined, null, {} and 1-vs-"1" all matched; a CI receipt could
 *        relabel a reported run under a workflow name the remote never ran.
 *   D12  merge_method / proof_method were never validated at runtime; any
 *        value other than 'merge' was silently classed as squash/rebase.
 *   D13  a promotion of zero candidates was proven green.
 *   D14  a cyclic publication order was accepted.
 *   D15  shared_files_resolved_by could name a task outside the promotion.
 *   D16  two candidate records with one task_id collapsed into one identity.
 *   D17  byReceipt still collapsed on a crafted id (`X#1`, `__proto__`).
 *   D18  named refusal codes with zero test coverage.
 *
 * Pure logic: no network, no merge, no writes.
 *
 *   node --import tsx --test tests/unit/pbb181-t45-remote-merge-receipt-round3.test.ts
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
  type MergeMethod,
  type MergeReceipt,
  type ProofMethod,
  type RemoteEvidence,
} from '../../src/lib/integration/remote-merge-receipt';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const OTHER = 'd'.repeat(40);
const THIRD = 'f'.repeat(40);
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
      { task_id: 'T-45', head_sha: HEAD, content_digest: 'sha256:1111', task_branch: 'pb/PBB-141/t-45', files: [CONTRACT] },
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

/** Two (or three) candidates, all contained, cohort listed. */
function cohort(filesA: string[], filesB: string[], filesC?: string[]): { r: MergeReceipt; f: RemoteEvidence } {
  const r = receipt();
  r.candidates = [
    { task_id: 'T-45', head_sha: HEAD, content_digest: 'sha256:1', task_branch: 'pb/a', files: filesA },
    { task_id: 'T-46', head_sha: OTHER, content_digest: 'sha256:2', task_branch: 'pb/b', files: filesB },
  ];
  if (filesC) {
    r.candidates.push({ task_id: 'T-47', head_sha: THIRD, content_digest: 'sha256:3', task_branch: 'pb/c', files: filesC });
  }
  r.cohort.members = r.candidates.map((c) => c.task_id);
  const f = evidence();
  f.contained_shas = r.candidates.map((c) => c.head_sha);
  return { r, f };
}

/** A tree-proof promotion whose observed value IS the remote value. */
function treeProof(merge: string, proof: string): { r: MergeReceipt; f: RemoteEvidence } {
  const r = receipt();
  r.merge_method = merge as MergeMethod;
  r.proof_method = proof as ProofMethod;
  r.proof_evidence = { remote_sha: TARGET, observed: 'sha256:tree' };
  const f = evidence();
  f.observed_proof_value = 'sha256:tree';
  return { r, f };
}

// ── D9 a rolled-over calendar date is not an instant ────────────────────────

test('(D9a) a lease window dated 30 February is refused', () => {
  const r = receipt();
  r.lease.acquired_at = '2026-02-30T10:00:00Z';
  r.lease.released_at = '2026-03-02T10:00:00Z';
  assert.ok(codes(r).includes('TARGET_OWNER_ACQUIRED_AT_INVALID'), 'Date.parse rolled 02-30 to 03-02 and it passed');

  const late = receipt();
  late.lease.released_at = '2026-10-24T24:00:00Z';
  assert.ok(codes(late).includes('TARGET_OWNER_RELEASED_AT_INVALID'), 'hour 24 is not a written instant');
});

test('(D9b) a receipt id dated 30 February is refused', () => {
  const r = receipt();
  r.id = 'M-command-center-2026-02-30T10:00:00Z';
  assert.ok(codes(r).includes('RECEIPT_ID_INVALID'));
});

test('(D9c inv) real dates still pass: leap day, minute-only, fractional seconds', () => {
  const r = receipt();
  r.id = 'M-command-center-2028-02-29T10:00Z';
  r.lease.acquired_at = '2028-02-29T10:00Z';
  r.lease.released_at = '2028-02-29T10:05:00.250Z';
  assert.deepEqual(codes(r), []);
});

// ── D10 one path, one spelling ──────────────────────────────────────────────

test('(D10a) a consumer contract file spelled with ./ still needs a reader trace', () => {
  const r = receipt();
  r.candidates[0].files = ['./src/lib/board/lifecycle-projection.ts'];
  assert.ok(codes(r).includes('CONSUMER_READER_TRACE_MISSING'));
});

test('(D10b) a generated-tree hand edit spelled with ./ is refused', () => {
  const r = receipt();
  r.candidates[0].files = ['./presentation_job/index.ts'];
  assert.ok(codes(r).includes('GENERATED_FILE_HAND_EDIT'));
});

test('(D10c) a singleton collision hidden behind ./ or x/.. is refused', () => {
  for (const spelling of ['./package.json', 'src/../package.json', 'package.json/']) {
    const { r, f } = cohort(['package.json'], [spelling]);
    r.cohort.compatibility_cases = [{ candidates: ['T-45', 'T-46'], case: 'BC-02' }];
    assert.ok(codes(r, f).includes('SHARED_FILE_COLLISION'), `${spelling} evaded the singleton rule`);
  }
});

test('(D10d) a path that is not repo-relative is refused, never ignored', () => {
  for (const bad of ['/package.json', '../outside.ts', '', '.']) {
    const r = receipt();
    r.candidates[0].files = [bad];
    assert.ok(codes(r).includes('CANDIDATE_FILE_INVALID'), `"${bad}" was read as a repo path`);
  }
  const missing = receipt();
  delete (missing.candidates[0] as { files?: string[] }).files;
  assert.ok(codes(missing).includes('CANDIDATE_FILE_INVALID'), 'a candidate with no file list hides every collision');
});

test('(D10e inv) distinct plain paths still pass', () => {
  const { r, f } = cohort(['src/a.ts'], ['./src/b.ts']);
  assert.deepEqual(codes(r, f), []);
});

// ── D11 a run binding needs a real run id, compared exactly ─────────────────

test('(D11a) a check with no run id on either side is refused', () => {
  for (const absent of [undefined, null, {}]) {
    const r = receipt();
    const f = evidence();
    r.check_receipts[0].run_id = absent as unknown as number;
    f.check_runs[0].run_id = absent as unknown as number;
    assert.ok(codes(r, f).includes('CHECK_RUN_ID_INVALID'), `run_id ${JSON.stringify(absent)} rendered green`);
  }
});

test('(D11b) a run id that only matches after String() coercion is refused', () => {
  const r = receipt();
  r.check_receipts[0].run_id = '1';
  assert.ok(codes(r).includes('CHECK_NOT_REMOTE'), 'receipt "1" matched remote 1');
});

test('(D11c) a CI receipt whose run id is an object is refused', () => {
  const r = receipt();
  const f = evidence();
  r.ci_receipts = [{ workflow: 'qc-cc', run_id: {} as unknown as number, conclusion: 'success' }];
  f.check_runs.push({ context: 'ci', head_sha: HEAD, conclusion: 'success', run_id: {} as unknown as number });
  assert.ok(codes(r, f).includes('CI_RECEIPT_INVALID'));
});

test('(D11e) a CI receipt relabelling a reported run as another workflow is refused', () => {
  const r = receipt();
  r.ci_receipts = [{ workflow: 'security-scan', run_id: 1, conclusion: 'success' }];
  assert.ok(codes(r).includes('CI_RECEIPT_NOT_REMOTE'), 'run 1 is "qc-cc" on the remote, not "security-scan"');
});

test('(D11d inv) string run ids that match exactly still pass', () => {
  const r = receipt();
  const f = evidence();
  r.check_receipts[0].run_id = '12345';
  r.ci_receipts[0].run_id = '12345';
  f.check_runs[0].run_id = '12345';
  assert.deepEqual(codes(r, f), []);
});

// ── D12 merge and proof methods are a closed vocabulary ─────────────────────

test('(D12a) an unknown merge method is refused, not classed as squash', () => {
  for (const method of ['fast-forward', 'rebase-ff']) {
    const { r, f } = treeProof(method, 'tree_equality');
    assert.ok(codes(r, f).includes('MERGE_METHOD_INVALID'), `${method} passed as a rewrite`);
  }
});

test('(D12b) an unknown proof method is refused', () => {
  const { r, f } = treeProof('squash', 'content_equiv');
  assert.ok(codes(r, f).includes('PROOF_METHOD_INVALID'));
});

test('(D12c inv) squash/tree and rebase/content proofs still pass', () => {
  for (const [merge, proof] of [['squash', 'tree_equality'], ['rebase', 'content_equivalence']]) {
    const { r, f } = treeProof(merge, proof);
    assert.deepEqual(codes(r, f), [], `${merge}/${proof}`);
  }
});

// ── D13 a promotion of nothing proves nothing ───────────────────────────────

test('(D13a) a receipt with zero candidates is refused', () => {
  const r = receipt();
  r.candidates = [];
  r.cohort.members = [];
  r.check_receipts = [{ context: 'qc-cc', head_sha: TARGET, conclusion: 'success', run_id: 1 }];
  r.independent_review.exact_head_sha = TARGET;
  const f = evidence();
  f.contained_shas = [];
  f.check_runs = [{ context: 'qc-cc', head_sha: TARGET, conclusion: 'success', run_id: 1 }];
  assert.ok(codes(r, f).includes('CANDIDATE_SET_EMPTY'));
});

// ── D14 publication order is a DAG ──────────────────────────────────────────

test('(D14a) a cyclic publication order is refused', () => {
  const two = cohort(['src/a.ts'], ['src/b.ts']);
  two.r.publication_order_edges = ['T-45->T-46', 'T-46->T-45'];
  assert.ok(codes(two.r, two.f).includes('PUBLICATION_ORDER_CYCLE'));

  const three = cohort(['src/a.ts'], ['src/b.ts'], ['src/c.ts']);
  three.r.publication_order_edges = ['T-45->T-46', 'T-46->T-47', 'T-47->T-45'];
  assert.ok(codes(three.r, three.f).includes('PUBLICATION_ORDER_CYCLE'));
});

test('(D14b inv) a chain and a diamond still pass', () => {
  const { r, f } = cohort(['src/a.ts'], ['src/b.ts'], ['src/c.ts']);
  r.publication_order_edges = ['T-45->T-46', 'T-45->T-47', 'T-46->T-47'];
  assert.deepEqual(codes(r, f), []);
});

// ── D15 the combined owner is a candidate that writes the file ──────────────

test('(D15a) a combined owner outside the promotion does not resolve a collision', () => {
  const { r, f } = cohort(['package.json'], ['package.json']);
  r.cohort.compatibility_cases = [{ candidates: ['T-45', 'T-46'], case: 'BC-02' }];
  r.cohort.shared_files_resolved_by = 'T-99';
  assert.ok(codes(r, f).includes('SHARED_FILE_COLLISION'));
});

test('(D15b) a participant that never writes the file is not its combined owner', () => {
  const { r, f } = cohort(['package.json'], ['package.json'], ['src/c.ts']);
  r.cohort.compatibility_cases = [{ candidates: ['T-45', 'T-46'], case: 'BC-02' }];
  r.cohort.shared_files_resolved_by = 'T-47';
  assert.ok(codes(r, f).includes('SHARED_FILE_COLLISION'));
});

test('(D15c inv) a writing participant as combined owner still clears it', () => {
  const { r, f } = cohort(['package.json'], ['./package.json']);
  r.cohort.compatibility_cases = [{ candidates: ['T-45', 'T-46'], case: 'BC-02' }];
  r.cohort.shared_files_resolved_by = 'T-46';
  assert.deepEqual(codes(r, f), []);
});

// ── D16 one task id, one candidate ──────────────────────────────────────────

test('(D16a) two candidate records wearing one task_id are refused', () => {
  const { r, f } = cohort(['package.json'], ['package.json']);
  r.candidates[1].task_id = 'T-45';
  r.cohort.members = ['T-45'];
  r.cohort.compatibility_cases = [{ candidates: ['T-45', 'T-45'], case: 'BC-02' }];
  r.cohort.shared_files_resolved_by = 'T-45';
  assert.ok(codes(r, f).includes('CANDIDATE_DUPLICATE'));
});

// ── D17 byReceipt never collapses ───────────────────────────────────────────

function at(id: string, hour: string): MergeReceipt {
  const r = receipt();
  r.id = id;
  r.lease.acquired_at = `2026-10-24T${hour}:00:00Z`;
  r.lease.released_at = `2026-10-24T${hour}:05:00Z`;
  return r;
}

test('(D17a) a crafted id spelling another entry key never swallows it', () => {
  const id = 'M-command-center-2026-10-24T10:00:00Z';
  for (const order of [[id, id, `${id}#1`], [`${id}#1`, id, id]]) {
    const entries = order.map((rid, i) => ({ receipt: at(rid, String(10 + i)), evidence: evidence() }));
    const verdict = verifyCohortBatch(entries);
    assert.equal(Object.keys(verdict.byReceipt).length, 3, JSON.stringify(Object.keys(verdict.byReceipt)));
  }
});

test('(D17b) an id of __proto__ is still a reported entry', () => {
  const verdict = verifyCohortBatch([
    { receipt: at('__proto__', '10'), evidence: evidence() },
    { receipt: at('M-command-center-2026-10-24T11:00:00Z', '11'), evidence: evidence() },
  ]);
  assert.equal(Object.keys(verdict.byReceipt).length, 2, JSON.stringify(Object.keys(verdict.byReceipt)));
  assert.ok(verdict.byReceipt['__proto__'].some((f) => f.code === 'RECEIPT_ID_INVALID'));
});

// ── D18 every named code fires (coverage; green before and after) ───────────

test('(D18) each named-but-untested refusal fires on its own violation', () => {
  const cases: [string, (r: MergeReceipt, f: RemoteEvidence) => void][] = [
    ['CHECK_REMOTE_NOT_PASSING', (_r, f) => { f.check_runs[0].conclusion = 'failure'; }],
    ['CI_RECEIPT_INVALID', (r) => { r.ci_receipts[0].workflow = ''; }],
    ['CONTENT_PROOF_MISSING', (r) => { r.merge_method = 'squash'; r.proof_method = 'tree_equality'; r.proof_evidence.observed = ''; }],
    ['TARGET_SHA_UNCHANGED', (r, f) => { r.target_sha_after = BASE; r.proof_evidence.remote_sha = BASE; f.target_sha = BASE; }],
    ['RECEIPT_SCHEMA_UNSUPPORTED', (r) => { r.schema_version = 2; }],
    ['CLEANUP_DUPLICATE', (r) => { r.cleanup_dispatched = ['del pb/a', 'del pb/a']; }],
    ['TARGET_OWNER_GENERATION_INVALID', (r) => { r.lease.generation = 0; }],
    ['REPAIR_SHA_INVALID', (r) => { r.repairs_incorporated = [{ repair_id: 'R-1', commit_sha: 'nope', proof: { method: 'ancestry', remote_sha: TARGET, observed: 'ahead' } }]; }],
    ['TARGET_BRANCH_MISMATCH', (r) => { r.target_branch = 'master'; }],
  ];
  assert.deepEqual(codes(receipt()), [], 'the base receipt is green, so each code below is caused by its own edit');
  for (const [code, mutate] of cases) {
    const r = receipt();
    const f = evidence();
    mutate(r, f);
    assert.ok(codes(r, f).includes(code), `${code} did not fire`);
  }
});
