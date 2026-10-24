/**
 * PBB-126 / T-45 — remote merge receipts for Command Center cohorts.
 *
 * WHAT THIS IS
 * ------------
 * The integrator's proof-of-record for one promotion to `main`. It is a PURE
 * validator: it never reads the network, never writes, and never merges. The
 * caller supplies the facts it read FROM THE REMOTE (`RemoteEvidence`), and
 * this module decides whether the receipt's claims are actually proven by
 * those facts. Every refusal is a named code so a consumer can say what is
 * wrong without re-deriving it.
 *
 * The acceptance it implements, clause by clause:
 *
 *   1. SINGLE SHARED TARGET OWNER — the only exclusion this repo family has is
 *      a remote ref used as a compare-and-swap (PREP-MERGE §4.2:
 *      `refs/heads/lease/<repo>/main`). A receipt that names a JSON file, a
 *      worktree, a pidfile, or `gh pr merge` as its owner is refused
 *      (TARGET_OWNER_NOT_DISTRIBUTED), and two overlapping holders on the same
 *      target are refused at batch level (TARGET_OWNER_CONFLICT).
 *
 *   2. COMPATIBLE COMMAND CENTER CONSUMERS AND STALE-EVENT CONTRACT — the
 *      accepted upstream modules are the contract. T-35's
 *      `src/lib/board/lifecycle-projection.ts` defines the board lanes and the
 *      live/stale/unknown vocabulary; R2's `src/lib/stage-receipts.ts` defines
 *      the six delivery stages. A receipt pins those with
 *      `consumer_contracts.stale_events` (a fingerprint of the real
 *      vocabulary); if the accepted contract has moved, the receipt is stale
 *      and refused (CONSUMER_CONTRACT_DRIFT). A candidate that edits a contract
 *      file without an explicit reader/writer trace is refused
 *      (CONSUMER_READER_TRACE_MISSING).
 *
 *   3. REQUIRED CHECKS AND NAMED REPAIR REMOTE CONTENT PROOF — every declared
 *      required context must appear exactly once, on a head the remote
 *      reported (CHECK_MISSING / CHECK_DUPLICATE / CHECK_STALE), and must have
 *      a passing conclusion (CHECK_NOT_PASSING). A named repair after a
 *      baseline merge needs its OWN sha and its OWN remote proof: a baseline
 *      head sha re-used as "the repair" is refused (REPAIR_BASELINE_NOT_PROOF),
 *      per BC-08 — the earlier merge proves nothing about the repair.
 *
 * Fail-closed everywhere: a missing fact is a finding, never a pass. There is
 * no branch in this file where "not measured" renders green.
 *
 * DB-FREE ON PURPOSE. The accepted contract constants are restated below
 * instead of imported, because importing `@/lib/board/lifecycle-projection`
 * pulls `@/lib/db` -> better-sqlite3 into a read-only checker. The test file
 * imports BOTH and asserts they still match, so drift fails a test rather
 * than silently pinning a stale copy.
 *
 * ponytail: constants duplicated from the two accepted modules.
 * Ceiling — a contract change lands green here until the test catches it.
 * Upgrade path: lift the four constants into a pure module both sides import.
 */

import { createHash } from 'node:crypto';

// ─── Ownership ──────────────────────────────────────────────────────────────

/** This task owns Command Center integration only. Other repos are refused. */
export const CC_REPO_ALIAS = 'command-center';
export const CC_CANONICAL_REMOTE = 'trevorotts1/blackceo-command-center';
export const CC_TARGET_BRANCH = 'main';

/** The one exclusion that exists across clones (PREP-MERGE §4.2). */
export const CC_LEASE_REF = `refs/heads/lease/${CC_REPO_ALIAS}/${CC_TARGET_BRANCH}`;

export const MERGE_RECEIPT_SCHEMA_VERSION = 1;

// ─── Check verdicts ─────────────────────────────────────────────────────────

/**
 * `skipped` passes a required status check on GitHub; `neutral` does not.
 * Nothing else is a pass — a missing/unknown conclusion is a finding.
 */
export const PASSING_CHECK_CONCLUSIONS = ['success', 'skipped'] as const;

// ─── Cohort / shared-file classes (PREP-MERGE §3.1) ─────────────────────────

/** Single-writer files: two candidates touching one is a BC-02 collision. */
export const SINGLETON_SHARED_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'src/lib/db/migrations.ts',
  'CHANGELOG.md',
  'MERGE-LOG.md',
  'QC.md',
];

/** Generated trees. A hand edit is a cohort reject, never a fix. */
export const GENERATED_PREFIXES: readonly string[] = ['presentation_job/'];

// ─── Accepted consumer contract (T-35 + R2), restated and fingerprinted ─────

/** Files that carry an accepted consumer contract. Editing one needs a trace. */
export const CONSUMER_CONTRACT_FILES: readonly string[] = [
  'src/lib/board/lifecycle-projection.ts',
  'src/lib/board-projection.ts',
  'src/lib/stage-receipts.ts',
  'src/lib/types.ts',
];

/**
 * The accepted stale-event + delivery vocabulary. Mirrors
 * `BOARD_COLUMN_IDS` / `DEFAULT_STALE_AFTER_MS` / `TERMINAL_BOARD_COLUMNS`
 * (T-35) and `STAGE_ORDER` (R2 stage receipts). Pinned by test to the real
 * modules.
 */
export const STALE_EVENT_CONTRACT = {
  version: 1,
  card_states: ['live', 'stale', 'unknown'],
  stale_reasons: ['source_missing', 'stream_stalled'],
  board_columns: ['backlog', 'todo', 'in_progress', 'review', 'blocked', 'done'],
  terminal_columns: ['done'],
  default_stale_after_ms: 6 * 60 * 60 * 1000,
  stage_order: [
    'source_merged',
    'package_built',
    'target_installed',
    'agent_selected',
    'runtime_adopted',
    'live_outcome',
  ],
} as const;

/** Stable fingerprint of the accepted consumer vocabulary. */
export function staleEventContractFingerprint(): string {
  const canonical = JSON.stringify(STALE_EVENT_CONTRACT);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

// ─── Receipt shapes (PREP-MERGE §3.4) ───────────────────────────────────────

export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type ProofMethod = 'ancestry' | 'tree_equality' | 'content_equivalence';
export type CompatibilityCaseId = 'BC-01' | 'BC-02' | 'BC-03' | 'BC-04' | 'BC-05' | 'BC-06' | 'BC-07' | 'BC-08';

export interface LeaseRecord {
  lease_ref: string;
  holder: string;
  generation: number;
  acquired_at: string;
  released_at: string | null;
}

export interface CandidateRecord {
  task_id: string;
  head_sha: string;
  content_digest: string;
  task_branch: string;
  /** Paths this candidate changes — the input to the collision classes. */
  files: string[];
}

export interface CheckReceipt {
  context: string;
  head_sha: string;
  conclusion: string;
  run_id: string | number;
}

export interface CompatibilityCase {
  candidates: [string, string];
  case: CompatibilityCaseId;
  /** Required whenever a candidate edits a CONSUMER_CONTRACT_FILES path. */
  reader_writer_trace?: string | null;
}

export interface RepairRecord {
  repair_id: string;
  commit_sha: string;
  /** Its OWN proof. A baseline merge's proof is never reused (BC-08). */
  proof: { method: ProofMethod; remote_sha: string; observed: string };
}

export interface MergeReceipt {
  schema_version?: number;
  id: string;
  repo_alias: string;
  canonical_remote: string;
  target_branch: string;
  base_sha_before: string;
  target_sha_after: string;
  merge_method: MergeMethod;
  publication_order_edges: string[];
  candidates: CandidateRecord[];
  cohort: {
    members: string[];
    compatibility_cases: CompatibilityCase[];
    shared_files_resolved_by: string | null;
  };
  dependencies: { depends_on_candidate: string; accepted_contract_ref: string }[];
  check_receipts: CheckReceipt[];
  ci_receipts: { workflow: string; run_id: string | number; conclusion: string }[];
  independent_review: { native_agent_id: string; verdict: string; exact_head_sha: string };
  repairs_incorporated: RepairRecord[];
  lease: LeaseRecord;
  proof_method: ProofMethod;
  proof_evidence: { remote_sha: string; observed: string };
  force_push_or_deletion: boolean;
  cleanup_dispatched: string[];
  open_obligations: string[];
  consumer_contracts: { stale_events: string };
}

/**
 * Facts the caller read from the remote. `source: 'remote'` is mandatory — a
 * local `git rev-parse` or an inferred merge result is not remote proof.
 */
export interface RemoteEvidence {
  source: 'remote';
  /** `GET git/ref/heads/main` read immediately BEFORE promotion. */
  base_sha: string;
  /** `GET git/ref/heads/main` read back AFTER promotion. */
  target_sha: string;
  /** Contexts the remote ruleset declares required (may be empty on CC). */
  declared_required_contexts: string[];
  /** Check runs the remote reported for the heads named in this batch. */
  check_runs: CheckReceipt[];
  /** Heads the remote compare/ancestry reported as contained in target_sha. */
  contained_shas: string[];
  /** Value the remote returned for tree/content proof (squash/rebase). */
  observed_proof_value?: string | null;
  /** Candidates the remote reported red/stale — each stays owned. */
  failed_candidates?: string[];
  /** Contexts the remote reported non-passing — each stays owned. */
  failing_contexts?: string[];
  /** Candidate branches the remote still had after the promotion. */
  merged_branches_still_present?: string[];
}

export interface Finding {
  code: string;
  detail: string;
}

export interface Verdict {
  ok: boolean;
  findings: Finding[];
}

// ─── Small pure helpers ─────────────────────────────────────────────────────

const SHA_RE = /^[0-9a-f]{40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

function isSha(value: unknown): value is string {
  return typeof value === 'string' && SHA_RE.test(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value);
}

function push(findings: Finding[], code: string, detail: string): void {
  findings.push({ code, detail });
}

/** A candidate touches a generated tree? */
export function touchesGenerated(candidate: CandidateRecord): boolean {
  return (candidate.files ?? []).some((file) =>
    GENERATED_PREFIXES.some((prefix) => file === prefix.replace(/\/$/, '') || file.startsWith(prefix)),
  );
}

/** Every path two candidates both change. */
export function sharedPaths(a: CandidateRecord, b: CandidateRecord): string[] {
  const right = new Set(b.files ?? []);
  return (a.files ?? []).filter((file) => right.has(file));
}

// ─── Single receipt ─────────────────────────────────────────────────────────

/**
 * Verify one receipt against the remote facts. Returns every finding, in a
 * deterministic order; `ok` is true only when there are none.
 */
export function verifyMergeReceipt(
  receipt: MergeReceipt,
  evidence: RemoteEvidence,
): Verdict {
  const findings: Finding[] = [];

  // ── Identity / ownership ────────────────────────────────────────────────
  if (receipt.repo_alias !== CC_REPO_ALIAS) {
    push(findings, 'RECEIPT_REPO_NOT_OWNED', `repo_alias "${receipt.repo_alias}" is outside this task's ownership`);
  }
  if (receipt.canonical_remote !== CC_CANONICAL_REMOTE) {
    push(findings, 'CANONICAL_REMOTE_MISMATCH', `expected ${CC_CANONICAL_REMOTE}, got "${receipt.canonical_remote}"`);
  }
  if (receipt.target_branch !== CC_TARGET_BRANCH) {
    push(findings, 'TARGET_BRANCH_MISMATCH', `expected ${CC_TARGET_BRANCH}, got "${receipt.target_branch}"`);
  }
  if (!isNonEmpty(receipt.id) || !receipt.id.startsWith(`M-${CC_REPO_ALIAS}-`)) {
    push(findings, 'RECEIPT_ID_INVALID', 'id must be M-command-center-<iso8601>');
  }
  if (receipt.schema_version !== undefined && receipt.schema_version !== MERGE_RECEIPT_SCHEMA_VERSION) {
    push(findings, 'RECEIPT_SCHEMA_UNSUPPORTED', `schema_version ${receipt.schema_version} is not supported`);
  }

  // ── Single shared target owner ──────────────────────────────────────────
  if (receipt.lease?.lease_ref !== CC_LEASE_REF) {
    push(
      findings,
      'TARGET_OWNER_NOT_DISTRIBUTED',
      `lease_ref must be ${CC_LEASE_REF}; a file, worktree, pidfile or gh-pr-merge is not exclusion`,
    );
  }
  if (!isNonEmpty(receipt.lease?.holder)) {
    push(findings, 'TARGET_OWNER_MISSING', 'lease.holder is required');
  }
  if (!Number.isInteger(receipt.lease?.generation) || receipt.lease.generation < 1) {
    push(findings, 'TARGET_OWNER_GENERATION_INVALID', 'lease.generation must be an integer >= 1');
  }
  if (!isIsoUtc(receipt.lease?.acquired_at)) {
    push(findings, 'TARGET_OWNER_ACQUIRED_AT_INVALID', 'lease.acquired_at must be ISO-8601 UTC');
  }
  if (receipt.lease?.released_at === null || receipt.lease?.released_at === undefined) {
    push(findings, 'TARGET_OWNER_NOT_RELEASED', 'the integrator must release its lease in the same run');
  } else if (!isIsoUtc(receipt.lease.released_at)) {
    push(findings, 'TARGET_OWNER_RELEASED_AT_INVALID', 'lease.released_at must be ISO-8601 UTC');
  } else if (receipt.lease.released_at < receipt.lease.acquired_at) {
    push(findings, 'TARGET_OWNER_WINDOW_INVALID', 'lease.released_at precedes acquired_at');
  }

  // ── Remote read-back (never inferred) ───────────────────────────────────
  if (evidence.source !== 'remote') {
    push(findings, 'PROOF_NOT_REMOTE', 'evidence.source must be "remote"; local reads prove nothing');
  }
  if (!isSha(receipt.base_sha_before) || !isSha(receipt.target_sha_after)) {
    push(findings, 'TARGET_SHA_INVALID', 'base_sha_before and target_sha_after must be 40-hex');
  } else if (receipt.base_sha_before === receipt.target_sha_after) {
    push(findings, 'TARGET_SHA_UNCHANGED', 'a promotion must move the target branch');
  }
  if (evidence.target_sha !== receipt.target_sha_after) {
    push(
      findings,
      'TARGET_SHA_UNVERIFIED',
      `receipt claims ${receipt.target_sha_after}; remote read ${evidence.target_sha}`,
    );
  }
  if (evidence.base_sha !== receipt.base_sha_before) {
    push(
      findings,
      'BASE_MOVED',
      `base moved: receipt ${receipt.base_sha_before}, remote ${evidence.base_sha} — re-run checks`,
    );
  }

  // ── Required checks ─────────────────────────────────────────────────────
  if (receipt.check_receipts.length === 0) {
    push(findings, 'CHECK_SET_EMPTY', 'a receipt must prove at least one check on the promoted heads');
  }
  const seenContexts = new Map<string, number>();
  for (const check of receipt.check_receipts) {
    seenContexts.set(check.context, (seenContexts.get(check.context) ?? 0) + 1);
  }
  for (const [context, count] of seenContexts) {
    if (count > 1) {
      push(findings, 'CHECK_DUPLICATE', `context "${context}" is recorded ${count} times — ambiguous, fail closed`);
    }
  }
  for (const context of evidence.declared_required_contexts) {
    if (!seenContexts.has(context)) {
      push(findings, 'CHECK_MISSING', `required context "${context}" has no receipt`);
    }
  }
  const provableHeads = new Set<string>([
    receipt.target_sha_after,
    ...receipt.candidates.map((c) => c.head_sha),
  ]);
  for (const check of receipt.check_receipts) {
    if (!provableHeads.has(check.head_sha)) {
      push(
        findings,
        'CHECK_STALE',
        `context "${check.context}" ran on ${check.head_sha}, which this promotion does not name`,
      );
    }
    if (!(PASSING_CHECK_CONCLUSIONS as readonly string[]).includes(check.conclusion)) {
      push(
        findings,
        'CHECK_NOT_PASSING',
        `context "${check.context}" concluded "${check.conclusion}"`,
      );
    }
  }

  // ── Proof method must match how the promotion actually landed ───────────
  const ancestryRequired = receipt.merge_method === 'merge';
  if (ancestryRequired && receipt.proof_method !== 'ancestry') {
    push(
      findings,
      'PROOF_METHOD_MISMATCH',
      `merge commit promoted with proof_method "${receipt.proof_method}" — ancestry is required`,
    );
  }
  if (!ancestryRequired && receipt.proof_method === 'ancestry') {
    push(
      findings,
      'PROOF_METHOD_MISMATCH',
      `${receipt.merge_method} rewrites history — ancestry proof is false; use tree/content equivalence`,
    );
  }
  const contained = new Set(evidence.contained_shas ?? []);
  if (receipt.proof_method === 'ancestry') {
    for (const candidate of receipt.candidates) {
      if (!contained.has(candidate.head_sha)) {
        push(
          findings,
          'ANCESTRY_UNPROVEN',
          `remote does not report ${candidate.head_sha} (${candidate.task_id}) as contained`,
        );
      }
    }
  } else {
    if (!isNonEmpty(receipt.proof_evidence?.observed)) {
      push(findings, 'CONTENT_PROOF_MISSING', 'tree/content proof needs its observed digest');
    } else if (receipt.proof_evidence.observed !== evidence.observed_proof_value) {
      push(
        findings,
        'PROOF_NOT_REMOTE',
        `proof_evidence.observed "${receipt.proof_evidence.observed}" is not the remote value`,
      );
    }
    for (const candidate of receipt.candidates) {
      if (!isNonEmpty(candidate.content_digest)) {
        push(findings, 'CONTENT_PROOF_MISSING', `${candidate.task_id} has no content_digest`);
      }
    }
  }

  // ── Named repairs (BC-08) ───────────────────────────────────────────────
  const candidateHeads = new Set(receipt.candidates.map((c) => c.head_sha));
  for (const repair of receipt.repairs_incorporated ?? []) {
    if (!isNonEmpty(repair.repair_id) || !isSha(repair.commit_sha)) {
      push(findings, 'REPAIR_SHA_INVALID', 'every named repair needs a repair_id and a commit_sha');
      continue;
    }
    if (candidateHeads.has(repair.commit_sha)) {
      push(
        findings,
        'REPAIR_BASELINE_NOT_PROOF',
        `${repair.repair_id} re-uses baseline head ${repair.commit_sha} — the baseline merge proves nothing about it`,
      );
    }
    if (!contained.has(repair.commit_sha)) {
      push(
        findings,
        'REPAIR_SHA_NOT_CONTAINED',
        `remote does not report repair ${repair.repair_id} (${repair.commit_sha}) as contained`,
      );
    }
    if (
      repair.proof?.method !== receipt.proof_method ||
      !isSha(repair.proof?.remote_sha) ||
      !isNonEmpty(repair.proof?.observed)
    ) {
      push(
        findings,
        'REPAIR_PROOF_MISSING',
        `${repair.repair_id} has no own remote proof at the promotion's method`,
      );
    }
  }

  // ── Cohort membership / shared files / reader-writer compatibility ──────
  const memberIds = new Set(receipt.cohort?.members ?? []);
  const candidateIds = new Set(receipt.candidates.map((c) => c.task_id));
  for (const id of candidateIds) {
    if (!memberIds.has(id)) {
      push(findings, 'COHORT_MEMBERS_MISMATCH', `candidate ${id} is not listed in cohort.members`);
    }
  }
  for (const id of memberIds) {
    if (!candidateIds.has(id)) {
      push(findings, 'COHORT_MEMBERS_MISMATCH', `cohort.members names ${id} with no candidate record`);
    }
  }

  for (const candidate of receipt.candidates) {
    if (touchesGenerated(candidate)) {
      push(
        findings,
        'GENERATED_FILE_HAND_EDIT',
        `${candidate.task_id} edits a generated tree — regenerate from the pin, never hand-edit`,
      );
    }
  }

  const cases = receipt.cohort?.compatibility_cases ?? [];
  const declaredPairs = new Set(cases.map((c) => [...c.candidates].sort().join('|')));
  for (let i = 0; i < receipt.candidates.length; i += 1) {
    for (let j = i + 1; j < receipt.candidates.length; j += 1) {
      const left = receipt.candidates[i];
      const right = receipt.candidates[j];
      const shared = sharedPaths(left, right);
      if (shared.length === 0) continue;
      const pairKey = [left.task_id, right.task_id].sort().join('|');
      const singletonHit = shared.some((file) => SINGLETON_SHARED_FILES.includes(file));
      if (singletonHit && !isNonEmpty(receipt.cohort?.shared_files_resolved_by)) {
        push(
          findings,
          'SHARED_FILE_COLLISION',
          `${left.task_id} and ${right.task_id} both write ${shared.join(', ')} with no single combined owner`,
        );
      }
      if (!declaredPairs.has(pairKey)) {
        push(
          findings,
          'COMPATIBILITY_CASE_UNDECLARED',
          `pair ${pairKey} shares ${shared.join(', ')} with no BC-0x compatibility case`,
        );
      }
    }
  }

  // ── Compatible Command Center consumers + stale-event contract ──────────
  const pinned = staleEventContractFingerprint();
  if (receipt.consumer_contracts?.stale_events !== pinned) {
    push(
      findings,
      'CONSUMER_CONTRACT_DRIFT',
      `receipt pins "${receipt.consumer_contracts?.stale_events ?? 'nothing'}"; accepted contract is ${pinned}`,
    );
  }
  const contractTouchers = receipt.candidates.filter((candidate) =>
    (candidate.files ?? []).some((file) => CONSUMER_CONTRACT_FILES.includes(file)),
  );
  for (const candidate of contractTouchers) {
    const related = cases.filter((c) => c.candidates.includes(candidate.task_id));
    if (related.length === 0) {
      push(
        findings,
        'CONSUMER_READER_TRACE_MISSING',
        `${candidate.task_id} edits an accepted consumer contract file with no compatibility case`,
      );
      continue;
    }
    for (const item of related) {
      if (item.case !== 'BC-04' && item.case !== 'BC-05') {
        push(
          findings,
          'CONSUMER_CASE_INVALID',
          `${candidate.task_id} changes a consumer contract under ${item.case}; BC-04/BC-05 is required`,
        );
      }
      if (!isNonEmpty(item.reader_writer_trace)) {
        push(
          findings,
          'CONSUMER_READER_TRACE_MISSING',
          `${candidate.task_id} has no old/new reader trace for the contract change`,
        );
      }
    }
  }

  // ── Red stays owned, force is never a method ────────────────────────────
  if (receipt.force_push_or_deletion !== false) {
    push(findings, 'FORCE_PUSH_OR_DELETION', 'a force push or deletion is a defect, not a merge method');
  }
  const obligations = new Set(receipt.open_obligations ?? []);
  for (const id of evidence.failed_candidates ?? []) {
    if (!obligations.has(id)) {
      push(findings, 'RED_CANDIDATE_UNOWNED', `red candidate ${id} is not carried in open_obligations`);
    }
  }
  for (const context of evidence.failing_contexts ?? []) {
    if (!obligations.has(context)) {
      push(findings, 'RED_CHECK_UNOWNED', `failing context "${context}" is not carried in open_obligations`);
    }
  }

  // ── Cleanup recorded, not assumed ───────────────────────────────────────
  const dispatched = new Set<string>();
  for (const item of receipt.cleanup_dispatched ?? []) {
    if (!isNonEmpty(item)) {
      push(findings, 'CLEANUP_ITEM_INVALID', 'cleanup ids must be non-empty strings');
      continue;
    }
    if (dispatched.has(item)) {
      push(findings, 'CLEANUP_DUPLICATE', `cleanup item ${item} is recorded twice`);
    }
    dispatched.add(item);
  }
  const liveBranches = new Set(evidence.merged_branches_still_present ?? []);
  for (const candidate of receipt.candidates) {
    if (liveBranches.has(candidate.task_branch)) {
      push(
        findings,
        'CLEANUP_BRANCH_STILL_PRESENT',
        `${candidate.task_branch} survived the promotion — merged resources are disposed, not kept`,
      );
    }
  }

  return { ok: findings.length === 0, findings };
}

// ─── Batch: one owner per target ────────────────────────────────────────────

export interface BatchVerdict extends Verdict {
  /** Findings keyed by receipt id, so a caller can act per receipt. */
  byReceipt: Record<string, Finding[]>;
}

/**
 * Verify every receipt against its own evidence and, across the set, prove
 * ONE shared target owner per target. Overlapping lease windows with
 * different holders, or a generation reused by a second holder, are refused.
 */
export function verifyCohortBatch(
  entries: { receipt: MergeReceipt; evidence: RemoteEvidence }[],
): BatchVerdict {
  const findings: Finding[] = [];
  const byReceipt: Record<string, Finding[]> = {};

  for (const entry of entries) {
    const verdict = verifyMergeReceipt(entry.receipt, entry.evidence);
    byReceipt[entry.receipt.id] = verdict.findings;
    findings.push(...verdict.findings);
  }

  const targets = new Map<string, MergeReceipt[]>();
  for (const { receipt } of entries) {
    const key = `${receipt.canonical_remote}#${receipt.target_branch}`;
    const bucket = targets.get(key);
    if (bucket) bucket.push(receipt);
    else targets.set(key, [receipt]);
  }

  for (const [target, receipts] of targets) {
    const ordered = [...receipts].sort((a, b) =>
      a.lease.acquired_at < b.lease.acquired_at ? -1 : a.lease.acquired_at > b.lease.acquired_at ? 1 : 0,
    );
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      const prevReleased = previous.lease.released_at ?? '￿';
      if (current.lease.acquired_at < prevReleased) {
        findings.push({
          code: 'TARGET_OWNER_CONFLICT',
          detail: `${target}: ${current.lease.holder} acquired generation ${current.lease.generation} before ${previous.lease.holder} released generation ${previous.lease.generation}`,
        });
      }
      if (
        previous.lease.holder !== current.lease.holder &&
        current.lease.generation <= previous.lease.generation
      ) {
        findings.push({
          code: 'TARGET_OWNER_GENERATION_REUSED',
          detail: `${target}: generation ${current.lease.generation} was already held by ${previous.lease.holder}`,
        });
      }
    }
    const open = ordered.filter((r) => r.lease.released_at === null || r.lease.released_at === undefined);
    if (open.length > 1) {
      findings.push({
        code: 'TARGET_OWNER_CONFLICT',
        detail: `${target}: ${open.length} receipts hold the target at once — one shared owner only`,
      });
    }
  }

  return { ok: findings.length === 0, findings, byReceipt };
}
