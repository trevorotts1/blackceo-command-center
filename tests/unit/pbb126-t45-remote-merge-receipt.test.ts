/**
 * tests/unit/pbb126-t45-remote-merge-receipt.test.ts
 *
 * PBB-126 / T-45 — Command Center cohort integration receipts.
 *
 * One clause per group, and every clause is proven BOTH ways: the compliant
 * receipt passes, and the exact refusal fires when the clause is violated.
 *
 *   (1) single shared target owner — only the remote lease ref counts, and two
 *       overlapping holders on one target are refused at batch level;
 *   (2) compatible Command Center consumers + stale-event contract — the
 *       restated vocabulary is pinned to the REAL accepted modules (T-35
 *       lifecycle projection, R2 stage receipts), drift is refused, and a
 *       contract file edit needs a BC-04/BC-05 reader trace;
 *   (3) required checks — missing, duplicate, stale and non-passing are
 *       separate refusals;
 *   (4) remote content proof — inferred/local evidence never passes, and the
 *       proof method must match how the promotion landed;
 *   (5) named repairs after a baseline merge carry their OWN sha and proof
 *       (BC-08): a baseline head reused as "the repair" is refused;
 *   (6) shared-file/reader-writer batch compatibility (F-20) — generated trees
 *       and singleton collisions are refused;
 *   (7) force push/deletion, unowned red items and surviving merged branches
 *       are refused.
 *
 * Pure logic: no network, no merge, no writes. The DB-backed upstream modules
 * are imported only to pin the contract constants, hence `_isolated-db` first.
 *
 *   node --import tsx --test tests/unit/pbb126-t45-remote-merge-receipt.test.ts
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH (C8 guard).
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_COLUMN_IDS,
  DEFAULT_STALE_AFTER_MS,
  TERMINAL_BOARD_COLUMNS,
} from '../../src/lib/board/lifecycle-projection';
import { STAGE_ORDER } from '../../src/lib/stage-receipts';
import {
  CC_CANONICAL_REMOTE,
  CC_LEASE_REF,
  CONSUMER_CONTRACT_FILES,
  STALE_EVENT_CONTRACT,
  staleEventContractFingerprint,
  verifyCohortBatch,
  verifyMergeReceipt,
  type MergeReceipt,
  type RemoteEvidence,
} from '../../src/lib/integration/remote-merge-receipt';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const REPAIR = 'd'.repeat(40);
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
        task_branch: 'pb/PBB-126/t-45',
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

// ── (0) the accepted contract, pinned to the REAL modules ───────────────────

test('(0) restated consumer vocabulary still matches the accepted T-35 + R2 modules', () => {
  assert.deepEqual([...STALE_EVENT_CONTRACT.board_columns], [...BOARD_COLUMN_IDS]);
  assert.deepEqual([...STALE_EVENT_CONTRACT.terminal_columns], [...TERMINAL_BOARD_COLUMNS]);
  assert.equal(STALE_EVENT_CONTRACT.default_stale_after_ms, DEFAULT_STALE_AFTER_MS);
  assert.deepEqual([...STALE_EVENT_CONTRACT.stage_order], [...STAGE_ORDER]);
  assert.match(staleEventContractFingerprint(), /^sha256:[0-9a-f]{64}$/);

  for (const file of CONSUMER_CONTRACT_FILES) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `accepted consumer contract file is missing: ${file}`);
  }
});

// ── (1) single shared target owner ──────────────────────────────────────────

test('(1a) the compliant receipt passes end to end', () => {
  assert.deepEqual(verifyMergeReceipt(receipt(), evidence()), { ok: true, findings: [] });
});

test('(1b) a file/worktree/PR is not an owner — only the remote lease ref is', () => {
  const r = receipt();
  r.lease.lease_ref = 'scratch/merge.lock';
  assert.ok(codes(r).includes('TARGET_OWNER_NOT_DISTRIBUTED'));
});

test('(1c) an unreleased lease is refused', () => {
  const r = receipt();
  r.lease.released_at = null;
  assert.ok(codes(r).includes('TARGET_OWNER_NOT_RELEASED'));
});

test('(1d) two overlapping holders on one target are refused at batch level', () => {
  const first = receipt();
  first.id = 'M-command-center-2026-10-24T10:00:00Z';
  const second = receipt();
  second.id = 'M-command-center-2026-10-24T10:03:00Z';
  second.lease = {
    ...second.lease,
    holder: 'other-integrator',
    generation: 1,
    acquired_at: '2026-10-24T10:03:00Z',
    released_at: '2026-10-24T10:09:00Z',
  };

  const verdict = verifyCohortBatch([
    { receipt: first, evidence: evidence() },
    { receipt: second, evidence: evidence() },
  ]);

  const found = verdict.findings.map((f) => f.code);
  assert.ok(found.includes('TARGET_OWNER_CONFLICT'), 'overlapping windows must not share the target');
  assert.ok(found.includes('TARGET_OWNER_GENERATION_REUSED'), 'a second holder may not reuse generation 1');
});

test('(1e) sequential windows from one owner pass the batch check', () => {
  const first = receipt();
  const second = receipt();
  second.id = 'M-command-center-2026-10-24T11:00:00Z';
  second.lease = {
    ...second.lease,
    generation: 2,
    acquired_at: '2026-10-24T11:00:00Z',
    released_at: '2026-10-24T11:05:00Z',
  };
  assert.deepEqual(
    verifyCohortBatch([
      { receipt: first, evidence: evidence() },
      { receipt: second, evidence: evidence() },
    ]).findings,
    [],
  );
});

// ── (2) compatible consumers + stale-event contract ─────────────────────────

test('(2a) a receipt whose pinned contract has drifted is refused', () => {
  const r = receipt();
  r.consumer_contracts.stale_events = 'sha256:' + '0'.repeat(64);
  assert.ok(codes(r).includes('CONSUMER_CONTRACT_DRIFT'));
});

test('(2b) editing an accepted consumer contract file needs a BC-04/BC-05 reader trace', () => {
  const r = receipt();
  r.candidates[0].files = ['src/lib/board/lifecycle-projection.ts'];

  const noCase = codes(r);
  assert.ok(noCase.includes('CONSUMER_READER_TRACE_MISSING'));

  r.cohort.compatibility_cases = [
    { candidates: ['T-45', 'T-45'], case: 'BC-01' },
  ];
  const wrongCase = codes(r);
  assert.ok(wrongCase.includes('CONSUMER_CASE_INVALID'));

  r.cohort.compatibility_cases = [
    {
      candidates: ['T-45', 'T-45'],
      case: 'BC-04',
      reader_writer_trace: 'old reader ignores the additive field; new reader requires it',
    },
  ];
  // The self-pair is only checked against the contract rule here; the pair
  // loop skips i === j. Nothing in this receipt is left unproven.
  assert.deepEqual(codes(r), []);
});

// ── (3) required checks ─────────────────────────────────────────────────────

test('(3a) a declared required context with no receipt is refused', () => {
  const facts = evidence();
  facts.declared_required_contexts = ['qc-cc', 'shell-syntax'];
  assert.ok(codes(receipt(), facts).includes('CHECK_MISSING'));
});

test('(3b) a duplicated context is refused — ambiguity never passes', () => {
  const r = receipt();
  r.check_receipts.push({ context: 'qc-cc', head_sha: HEAD, conclusion: 'failure', run_id: 2 });
  assert.ok(codes(r).includes('CHECK_DUPLICATE'));
});

test('(3c) a check on a head this promotion does not name is STALE', () => {
  const r = receipt();
  r.check_receipts[0].head_sha = 'e'.repeat(40);
  assert.ok(codes(r).includes('CHECK_STALE'));
});

test('(3d) a non-passing conclusion is refused; skipped still passes', () => {
  const failing = receipt();
  failing.check_receipts[0].conclusion = 'neutral';
  assert.ok(codes(failing).includes('CHECK_NOT_PASSING'));

  const skipped = receipt();
  skipped.check_receipts[0].conclusion = 'skipped';
  assert.deepEqual(codes(skipped), []);
});

test('(3e) a receipt with no check at all is refused', () => {
  const r = receipt();
  r.check_receipts = [];
  assert.ok(codes(r).includes('CHECK_SET_EMPTY'));
});

// ── (4) remote content proof ────────────────────────────────────────────────

test('(4a) local/inferred evidence is never remote proof', () => {
  const facts = evidence();
  (facts as { source: string }).source = 'local';
  assert.ok(codes(receipt(), facts).includes('PROOF_NOT_REMOTE'));
});

test('(4b) a target sha read back different from the claim is refused', () => {
  const facts = evidence();
  facts.target_sha = 'f'.repeat(40);
  assert.ok(codes(receipt(), facts).includes('TARGET_SHA_UNVERIFIED'));
});

test('(4c) a moved base invalidates the receipt', () => {
  const facts = evidence();
  facts.base_sha = '9'.repeat(40);
  assert.ok(codes(receipt(), facts).includes('BASE_MOVED'));
});

test('(4d) proof method must match how the promotion landed', () => {
  const mergeWithTreeProof = receipt();
  mergeWithTreeProof.proof_method = 'tree_equality';
  mergeWithTreeProof.proof_evidence = { remote_sha: TARGET, observed: 'sha256:tree' };
  assert.ok(codes(mergeWithTreeProof).includes('PROOF_METHOD_MISMATCH'));

  const squashWithAncestry = receipt();
  squashWithAncestry.merge_method = 'squash';
  assert.ok(codes(squashWithAncestry).includes('PROOF_METHOD_MISMATCH'));
});

test('(4e) ancestry is only proven by the remote containment list', () => {
  const facts = evidence();
  facts.contained_shas = [];
  assert.ok(codes(receipt(), facts).includes('ANCESTRY_UNPROVEN'));
});

test('(4f) squash proof must be the value the remote returned', () => {
  const r = receipt();
  r.merge_method = 'squash';
  r.proof_method = 'tree_equality';
  r.proof_evidence = { remote_sha: TARGET, observed: 'sha256:local' };

  const facts = evidence();
  facts.observed_proof_value = 'sha256:remote';
  assert.ok(codes(r, facts).includes('PROOF_NOT_REMOTE'));
});

// ── (5) named repair remote content proof (BC-08) ───────────────────────────

test('(5a) a repair with its own sha and own proof passes', () => {
  const r = receipt();
  r.repairs_incorporated = [
    {
      repair_id: 'R-T45-1',
      commit_sha: REPAIR,
      proof: { method: 'ancestry', remote_sha: TARGET, observed: 'ahead' },
    },
  ];
  const facts = evidence();
  facts.contained_shas = [HEAD, REPAIR];
  assert.deepEqual(verifyMergeReceipt(r, facts), { ok: true, findings: [] });
});

test('(5b) re-using a baseline head as "the repair" is refused', () => {
  const r = receipt();
  r.repairs_incorporated = [
    {
      repair_id: 'R-T45-1',
      commit_sha: HEAD,
      proof: { method: 'ancestry', remote_sha: TARGET, observed: 'ahead' },
    },
  ];
  assert.ok(codes(r).includes('REPAIR_BASELINE_NOT_PROOF'));
});

test('(5c) an uncontained repair sha is refused', () => {
  const r = receipt();
  r.repairs_incorporated = [
    {
      repair_id: 'R-T45-1',
      commit_sha: REPAIR,
      proof: { method: 'ancestry', remote_sha: TARGET, observed: 'ahead' },
    },
  ];
  assert.ok(codes(r).includes('REPAIR_SHA_NOT_CONTAINED'));
});

test('(5d) a repair borrowing the promotion proof is refused', () => {
  const r = receipt();
  r.repairs_incorporated = [
    {
      repair_id: 'R-T45-1',
      commit_sha: REPAIR,
      proof: { method: 'ancestry', remote_sha: '', observed: '' },
    },
  ];
  const facts = evidence();
  facts.contained_shas = [HEAD, REPAIR];
  assert.ok(codes(r, facts).includes('REPAIR_PROOF_MISSING'));
});

// ── (6) shared-file / reader-writer batch compatibility (F-20) ──────────────

function twoCandidates(filesA: string[], filesB: string[]): MergeReceipt {
  const r = receipt();
  r.candidates = [
    { task_id: 'T-45', head_sha: HEAD, content_digest: 'sha256:1', task_branch: 'pb/a', files: filesA },
    { task_id: 'T-46', head_sha: REPAIR, content_digest: 'sha256:2', task_branch: 'pb/b', files: filesB },
  ];
  r.cohort.members = ['T-45', 'T-46'];
  return r;
}

function twoFacts(): RemoteEvidence {
  const facts = evidence();
  facts.contained_shas = [HEAD, REPAIR];
  return facts;
}

test('(6a) two candidates writing one singleton file need a single combined owner', () => {
  const r = twoCandidates(['package.json'], ['package.json']);
  r.cohort.compatibility_cases = [{ candidates: ['T-45', 'T-46'], case: 'BC-02' }];
  assert.ok(codes(r, twoFacts()).includes('SHARED_FILE_COLLISION'));

  r.cohort.shared_files_resolved_by = 'T-45';
  assert.ok(!codes(r, twoFacts()).includes('SHARED_FILE_COLLISION'));
});

test('(6b) a shared file with no BC-0x case is refused', () => {
  const r = twoCandidates(['src/a.ts'], ['src/a.ts']);
  assert.ok(codes(r, twoFacts()).includes('COMPATIBILITY_CASE_UNDECLARED'));
});

test('(6c) a hand edit under the generated presentation_job tree is refused', () => {
  const r = receipt();
  r.candidates[0].files = ['presentation_job/index.ts'];
  assert.ok(codes(r).includes('GENERATED_FILE_HAND_EDIT'));
});

test('(6d) a cohort member with no candidate record is refused', () => {
  const r = receipt();
  r.cohort.members = ['T-45', 'T-99'];
  assert.ok(codes(r).includes('COHORT_MEMBERS_MISMATCH'));
});

// ── (7) force, ownership of red, cleanup ────────────────────────────────────

test('(7a) a force push or deletion is a defect, never a method', () => {
  const r = receipt();
  r.force_push_or_deletion = true;
  assert.ok(codes(r).includes('FORCE_PUSH_OR_DELETION'));
});

test('(7b) a red candidate and a failing context must stay in open_obligations', () => {
  const r = receipt();
  const facts = evidence();
  facts.failed_candidates = ['T-99'];
  facts.failing_contexts = ['shell-syntax'];
  const found = codes(r, facts);
  assert.ok(found.includes('RED_CANDIDATE_UNOWNED'));
  assert.ok(found.includes('RED_CHECK_UNOWNED'));

  r.open_obligations = ['T-99', 'shell-syntax'];
  assert.deepEqual(codes(r, facts), []);
});

test('(7c) a merged branch still present on the remote is a cleanup refusal', () => {
  const facts = evidence();
  facts.merged_branches_still_present = ['pb/PBB-126/t-45'];
  assert.ok(codes(receipt(), facts).includes('CLEANUP_BRANCH_STILL_PRESENT'));
});

test('(7d) a receipt for another repo is outside this task ownership', () => {
  const r = receipt();
  r.repo_alias = '999';
  assert.ok(codes(r).includes('RECEIPT_REPO_NOT_OWNED'));
});
