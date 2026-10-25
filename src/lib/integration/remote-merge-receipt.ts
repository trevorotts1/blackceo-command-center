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
 *      a passing conclusion (CHECK_NOT_PASSING). Every check claim is then
 *      cross-read against `RemoteEvidence.check_runs`: a claim the remote never
 *      reported is CHECK_NOT_REMOTE, one the remote reported red is
 *      CHECK_REMOTE_NOT_PASSING, and a red the remote reported on a named head
 *      must stay owned (RED_CHECK_UNOWNED). The same binding holds for
 *      `ci_receipts` (CI_RECEIPT_NOT_REMOTE / _NOT_PASSING), for
 *      `independent_review` (INDEPENDENT_REVIEW_NOT_PASSING / _STALE), for
 *      `dependencies` (DEPENDENCY_UNPROVEN / DEPENDENCY_CONTRACT_UNPROVEN) and
 *      for `publication_order_edges` (PUBLICATION_ORDER_INVALID /
 *      PUBLICATION_ORDER_UNKNOWN_CANDIDATE). A named repair after a
 *      baseline merge needs its OWN sha and its OWN remote proof: a baseline
 *      head sha re-used as "the repair" is refused (REPAIR_BASELINE_NOT_PROOF),
 *      per BC-08 — the earlier merge proves nothing about the repair.
 *
 * Timestamps are compared as INSTANTS, never as strings: ISO-8601 permits both
 * `...T10:20Z` and `...T10:20:30Z`, and lexically the minute-only form sorts
 * AFTER the second-precision one. An instant must also read back as the date
 * that was written: `Date.parse` rolls `2026-02-30` over to `2026-03-02`.
 *
 * Paths are compared in ONE spelling: `./package.json`, `src/../package.json`
 * and `package.json/` are all `package.json`, and a path that is absolute or
 * climbs out of the repo is refused (CANDIDATE_FILE_INVALID), never ignored.
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
import { posix } from 'node:path';

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

/** Closed vocabularies: the TS union is not enforced on JSON read from a remote. */
export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
export const PROOF_METHODS = ['ancestry', 'tree_equality', 'content_equivalence'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];
export type ProofMethod = (typeof PROOF_METHODS)[number];
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
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  // Date.parse rolls 02-30 over to 03-02 and hour 24 into the next day. The
  // instant must read back as the date and time that was written.
  const back = new Date(ms).toISOString();
  return back.slice(0, 16) === value.slice(0, 16) && (value[16] !== ':' || back.slice(16, 19) === value.slice(16, 19));
}

/**
 * A run id is a positive integer or a non-empty string, compared with `===`.
 * Absent, null, `{}` and `1`-vs-`"1"` never bind a claim to a remote run.
 */
function isRunId(value: unknown): value is string | number {
  return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || isNonEmpty(value);
}

/**
 * The one spelling of a repo-relative path, or null when the value is not one
 * (absolute, climbs out of the repo, empty, or the repo root itself).
 */
export function normalizeRepoPath(value: unknown): string | null {
  if (!isNonEmpty(value) || value.startsWith('/')) return null;
  const path = posix.normalize(value).replace(/\/+$/, '');
  if (path === '' || path === '.' || path === '..' || path.startsWith('../')) return null;
  return path;
}

/** Every valid path a candidate changes, in its one spelling. */
function candidatePaths(candidate: CandidateRecord): string[] {
  const files = Array.isArray(candidate.files) ? candidate.files : [];
  return files.map(normalizeRepoPath).filter((file): file is string => file !== null);
}

/**
 * A lease window is a pair of INSTANTS. ISO-8601 lets one caller write
 * `...T10:20Z` and another `...T10:20:30Z`, and comparing those as strings
 * inverts the order ('Z' is 0x5A, ':' is 0x3A, so the minute-only form sorts
 * AFTER the second-precision one). Never order timestamps lexically — parse
 * them first. Returns null when the value is not a real instant.
 */
function toInstant(value: unknown): number | null {
  return isIsoUtc(value) ? Date.parse(value) : null;
}

/** The remote vocabulary for a review that counts as a pass. */
export const PASSING_REVIEW_VERDICTS = ['pass', 'passed', 'approved', 'approve'] as const;

function isPassingConclusion(value: unknown): boolean {
  return (PASSING_CHECK_CONCLUSIONS as readonly string[]).includes(value as string);
}

function isPassingReview(value: unknown): boolean {
  return (PASSING_REVIEW_VERDICTS as readonly string[]).includes(
    typeof value === 'string' ? value.trim().toLowerCase() : '',
  );
}

function push(findings: Finding[], code: string, detail: string): void {
  findings.push({ code, detail });
}

/** A candidate touches a generated tree? */
export function touchesGenerated(candidate: CandidateRecord): boolean {
  return candidatePaths(candidate).some((file) =>
    GENERATED_PREFIXES.some((prefix) => file === prefix.replace(/\/$/, '') || file.startsWith(prefix)),
  );
}

/** Every path two candidates both change. */
export function sharedPaths(a: CandidateRecord, b: CandidateRecord): string[] {
  const right = new Set(candidatePaths(b));
  return [...new Set(candidatePaths(a))].filter((file) => right.has(file));
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
  const obligations = new Set(receipt.open_obligations ?? []);

  // ── Candidates: at least one, one record per task, real paths ───────────
  if (!Array.isArray(receipt.candidates) || receipt.candidates.length === 0) {
    push(findings, 'CANDIDATE_SET_EMPTY', 'a promotion of no candidate proves nothing');
  }
  const seenTasks = new Set<string>();
  for (const candidate of receipt.candidates ?? []) {
    if (seenTasks.has(candidate.task_id)) {
      push(findings, 'CANDIDATE_DUPLICATE', `task ${candidate.task_id} has more than one candidate record`);
    }
    seenTasks.add(candidate.task_id);
    const files: unknown[] = Array.isArray(candidate.files) ? candidate.files : [];
    const bad = files.filter((file) => normalizeRepoPath(file) === null);
    if (files.length === 0 || bad.length > 0) {
      push(
        findings,
        'CANDIDATE_FILE_INVALID',
        `${candidate.task_id} must list the repo-relative paths it changes; refused: ${JSON.stringify(files.length === 0 ? candidate.files ?? null : bad)}`,
      );
    }
  }

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
  const idPrefix = `M-${CC_REPO_ALIAS}-`;
  if (!isNonEmpty(receipt.id) || !receipt.id.startsWith(idPrefix) || !isIsoUtc(receipt.id.slice(idPrefix.length))) {
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
  } else {
    // Instants, never strings: `...T10:00Z` is EARLIER than `...T10:00:05Z`.
    const releasedInstant = toInstant(receipt.lease.released_at);
    const acquiredInstant = toInstant(receipt.lease.acquired_at);
    if (releasedInstant !== null && acquiredInstant !== null && releasedInstant < acquiredInstant) {
      push(findings, 'TARGET_OWNER_WINDOW_INVALID', 'lease.released_at precedes acquired_at');
    }
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
  // The promotion's own proof may only name the sha the remote read back. A
  // foreign `proof_evidence.remote_sha` is a local claim wearing a remote coat.
  if (!isSha(receipt.proof_evidence?.remote_sha) || receipt.proof_evidence.remote_sha !== evidence.target_sha) {
    push(
      findings,
      'PROOF_NOT_REMOTE',
      `proof_evidence.remote_sha "${receipt.proof_evidence?.remote_sha ?? 'nothing'}" is not the remote read-back ${evidence.target_sha}`,
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
  const remoteRuns = evidence.check_runs ?? [];
  for (const check of receipt.check_receipts) {
    if (!provableHeads.has(check.head_sha)) {
      push(
        findings,
        'CHECK_STALE',
        `context "${check.context}" ran on ${check.head_sha}, which this promotion does not name`,
      );
    }
    if (!isPassingConclusion(check.conclusion)) {
      push(
        findings,
        'CHECK_NOT_PASSING',
        `context "${check.context}" concluded "${check.conclusion}"`,
      );
    }
    // A check claim is only proof if the REMOTE reported that run. Anything
    // else is a check nobody ran, and it renders green only if we stay blind.
    // The run id is required and compared exactly: no id binds nothing.
    if (!isRunId(check.run_id)) {
      push(findings, 'CHECK_RUN_ID_INVALID', `context "${check.context}" names no run id`);
    }
    const backing = remoteRuns.filter(
      (run) => run.context === check.context && run.head_sha === check.head_sha,
    );
    if (backing.length !== 1 || !isRunId(check.run_id) || backing[0].run_id !== check.run_id) {
      push(
        findings,
        'CHECK_NOT_REMOTE',
        `context "${check.context}" on ${check.head_sha} (run ${check.run_id}) is not the single run the remote reported`,
      );
    } else if (!isPassingConclusion(backing[0].conclusion)) {
      push(
        findings,
        'CHECK_REMOTE_NOT_PASSING',
        `the remote reported "${backing[0].conclusion}" for context "${check.context}" on ${check.head_sha}`,
      );
    }
  }
  // A red the remote reported on a head this promotion names stays owned.
  for (const run of remoteRuns) {
    if (!provableHeads.has(run.head_sha)) continue;
    if (isPassingConclusion(run.conclusion)) continue;
    if (!obligations.has(run.context)) {
      push(
        findings,
        'RED_CHECK_UNOWNED',
        `failing remote check "${run.context}" on ${run.head_sha} is not carried in open_obligations`,
      );
    }
  }

  // ── Declared proofs must also be MEASURED ────────────────────────────────
  // independent_review: a named reviewer, a pass, on a head this promotion names.
  const review = receipt.independent_review;
  if (!isNonEmpty(review?.native_agent_id)) {
    push(findings, 'INDEPENDENT_REVIEW_INVALID', 'independent_review.native_agent_id is required');
  }
  if (!isPassingReview(review?.verdict)) {
    push(
      findings,
      'INDEPENDENT_REVIEW_NOT_PASSING',
      `independent_review concluded "${review?.verdict ?? 'nothing'}"`,
    );
  }
  if (!isSha(review?.exact_head_sha) || !provableHeads.has(review.exact_head_sha)) {
    push(
      findings,
      'INDEPENDENT_REVIEW_STALE',
      `independent_review covers ${review?.exact_head_sha ?? 'no head'}, which this promotion does not name`,
    );
  }

  // ci_receipts: a run the remote reported, and one that passed.
  for (const ci of receipt.ci_receipts ?? []) {
    if (!isNonEmpty(ci?.workflow) || !isRunId(ci.run_id)) {
      push(findings, 'CI_RECEIPT_INVALID', 'every ci_receipt needs a workflow and a run_id');
      continue;
    }
    if (!isPassingConclusion(ci.conclusion)) {
      push(
        findings,
        'CI_RECEIPT_NOT_PASSING',
        `workflow "${ci.workflow}" concluded "${ci.conclusion}"`,
      );
    }
    // Bound by run id AND name: a reported run relabelled as another workflow
    // is a workflow nobody ran.
    const backingRun = remoteRuns.find((run) => run.run_id === ci.run_id && run.context === ci.workflow);
    if (!backingRun) {
      push(
        findings,
        'CI_RECEIPT_NOT_REMOTE',
        `workflow "${ci.workflow}" run ${ci.run_id} is not a run the remote reported under that name`,
      );
    } else if (!isPassingConclusion(backingRun.conclusion)) {
      push(
        findings,
        'CI_RECEIPT_NOT_PASSING',
        `the remote reported "${backingRun.conclusion}" for workflow "${ci.workflow}" run ${ci.run_id}`,
      );
    }
  }

  // dependencies: named against candidates this promotion proved, and against
  // a contract that actually exists.
  const candidateIds = new Set(receipt.candidates.map((c) => c.task_id));
  const changedPaths = new Set(receipt.candidates.flatMap(candidatePaths));
  for (const dep of receipt.dependencies ?? []) {
    if (!isNonEmpty(dep?.depends_on_candidate) || !candidateIds.has(dep.depends_on_candidate)) {
      push(
        findings,
        'DEPENDENCY_UNPROVEN',
        `dependency on "${dep?.depends_on_candidate ?? 'nothing'}" is not a candidate this promotion proved`,
      );
      continue;
    }
    const ref = dep.accepted_contract_ref;
    const refPath = normalizeRepoPath(ref);
    const knownContract =
      isNonEmpty(ref) &&
      (ref === staleEventContractFingerprint() ||
        (refPath !== null && (CONSUMER_CONTRACT_FILES.includes(refPath) || changedPaths.has(refPath))));
    if (!knownContract) {
      push(
        findings,
        'DEPENDENCY_CONTRACT_UNPROVEN',
        `accepted_contract_ref "${ref ?? 'nothing'}" names no accepted contract`,
      );
    }
  }

  // publication_order_edges: "<task>-><task>", both ends proved here.
  const seenEdges = new Set<string>();
  for (const edge of receipt.publication_order_edges ?? []) {
    const parts = typeof edge === 'string' ? edge.split('->') : [];
    if (parts.length !== 2 || !isNonEmpty(parts[0]) || !isNonEmpty(parts[1])) {
      push(findings, 'PUBLICATION_ORDER_INVALID', `publication order edge "${edge}" must be <task>-><task>`);
      continue;
    }
    const [from, to] = parts;
    if (from === to || seenEdges.has(edge)) {
      push(findings, 'PUBLICATION_ORDER_INVALID', `publication order edge "${edge}" is a self-loop or a duplicate`);
      continue;
    }
    seenEdges.add(edge);
    for (const id of [from, to]) {
      if (!candidateIds.has(id)) {
        push(
          findings,
          'PUBLICATION_ORDER_UNKNOWN_CANDIDATE',
          `publication order edge "${edge}" names ${id}, which this promotion did not prove`,
        );
      }
    }
  }
  // An order is a DAG: peel off every task with nothing left before it (Kahn).
  // Whatever cannot be peeled sits on a cycle and has no publishable order.
  const before = new Map<string, Set<string>>();
  for (const edge of seenEdges) {
    const [from, to] = edge.split('->');
    if (!before.has(from)) before.set(from, new Set());
    if (!before.has(to)) before.set(to, new Set());
    before.get(to)!.add(from);
  }
  let peeled = true;
  while (peeled) {
    peeled = false;
    for (const [task, preds] of before) {
      if ([...preds].some((pred) => before.has(pred))) continue;
      before.delete(task);
      peeled = true;
    }
  }
  if (before.size > 0) {
    push(
      findings,
      'PUBLICATION_ORDER_CYCLE',
      `publication order is cyclic through ${[...before.keys()].sort().join(', ')} — no task can publish first`,
    );
  }

  // ── Proof method must match how the promotion actually landed ───────────
  // A value outside the vocabulary is refused, never classed as a rewrite.
  if (!(MERGE_METHODS as readonly string[]).includes(receipt.merge_method)) {
    push(findings, 'MERGE_METHOD_INVALID', `merge_method "${receipt.merge_method}" is not one of ${MERGE_METHODS.join('/')}`);
  }
  if (!(PROOF_METHODS as readonly string[]).includes(receipt.proof_method)) {
    push(findings, 'PROOF_METHOD_INVALID', `proof_method "${receipt.proof_method}" is not one of ${PROOF_METHODS.join('/')}`);
  }
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
      repair.proof?.remote_sha !== evidence.target_sha ||
      !isNonEmpty(repair.proof?.observed)
    ) {
      push(
        findings,
        'REPAIR_PROOF_MISSING',
        `${repair.repair_id} has no own remote proof at the promotion's method, bound to the remote read-back`,
      );
    }
  }

  // ── Cohort membership / shared files / reader-writer compatibility ──────
  const memberIds = new Set(receipt.cohort?.members ?? []);
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
  // The single combined owner is a candidate of THIS promotion that itself
  // writes the shared file — not any name, and not a bystander.
  const resolver = receipt.candidates.find((c) => c.task_id === receipt.cohort?.shared_files_resolved_by);
  const resolverPaths = new Set(resolver ? candidatePaths(resolver) : []);
  for (let i = 0; i < receipt.candidates.length; i += 1) {
    for (let j = i + 1; j < receipt.candidates.length; j += 1) {
      const left = receipt.candidates[i];
      const right = receipt.candidates[j];
      const shared = sharedPaths(left, right);
      if (shared.length === 0) continue;
      const pairKey = [left.task_id, right.task_id].sort().join('|');
      const unowned = shared.filter((file) => SINGLETON_SHARED_FILES.includes(file) && !resolverPaths.has(file));
      if (unowned.length > 0) {
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
    candidatePaths(candidate).some((file) => CONSUMER_CONTRACT_FILES.includes(file)),
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
  /**
   * Findings keyed by receipt id, so a caller can act per receipt. A receipt id
   * used more than once is a defect in its own right, and those entries are
   * keyed `<id>#1`, `<id>#2` and so on, so one can never swallow the other;
   * a key already taken (an id that itself spells `<id>#1`) steps to the next
   * free ordinal. The object has no prototype, so `__proto__` is a plain key.
   */
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
  // Own keys only: an id of "__proto__" is an entry, never the prototype.
  const byReceipt: Record<string, Finding[]> = Object.create(null);

  const idTotals = new Map<string, number>();
  for (const { receipt } of entries) {
    idTotals.set(receipt.id, (idTotals.get(receipt.id) ?? 0) + 1);
  }

  const idOrdinals = new Map<string, number>();
  for (const entry of entries) {
    const verdict = verifyMergeReceipt(entry.receipt, entry.evidence);
    const total = idTotals.get(entry.receipt.id) ?? 1;
    const ordinal = (idOrdinals.get(entry.receipt.id) ?? 0) + 1;
    idOrdinals.set(entry.receipt.id, ordinal);
    if (total > 1) {
      verdict.findings.push({
        code: 'RECEIPT_ID_DUPLICATE',
        detail: `receipt id "${entry.receipt.id}" is used by ${total} receipts in this batch - identity must be unique`,
      });
    }
    // A crafted id may already spell `<id>#1`; step past any taken key so no
    // entry can ever overwrite another.
    let key = total > 1 ? `${entry.receipt.id}#${ordinal}` : String(entry.receipt.id);
    let next = ordinal;
    while (key in byReceipt) {
      next += 1;
      key = `${entry.receipt.id}#${next}`;
    }
    byReceipt[key] = verdict.findings;
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
    // Instants again: `...T10:20Z` acquires BEFORE `...T10:20:30Z`, whatever
    // the strings say. An unreadable timestamp sorts where it can do harm, so
    // it can only ever add a refusal, never hide one.
    const ordered = [...receipts].sort((a, b) => {
      const left = toInstant(a.lease?.acquired_at) ?? Number.NEGATIVE_INFINITY;
      const right = toInstant(b.lease?.acquired_at) ?? Number.NEGATIVE_INFINITY;
      if (left !== right) return left < right ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    for (let i = 1; i < ordered.length; i += 1) {
      const previous = ordered[i - 1];
      const current = ordered[i];
      // An unreleased lease still holds the target: its window ends at +Infinity.
      const prevReleased = toInstant(previous.lease?.released_at) ?? Number.POSITIVE_INFINITY;
      const currentAcquired = toInstant(current.lease?.acquired_at) ?? Number.NEGATIVE_INFINITY;
      if (currentAcquired < prevReleased) {
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
