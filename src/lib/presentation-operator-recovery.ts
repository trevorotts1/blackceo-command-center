/**
 * One-time, pre-engine recovery for a signed operator presentation contract.
 *
 * This is deliberately separate from U061's human Resume.  It does not alter
 * the task's dispatch counter: the historical exhausted budget remains on the
 * task, while this immutable row records the single post-repair launch that
 * the server authorized.
 *
 * PD-TEST-050 — ONE RECEIPTED ATTEMPT PER DISTINCT REPAIR, NOT ONE PER TASK.
 *
 * The original design keyed the recovery row on `task_id` alone. That was
 * correct only while the authorised attempt either succeeded or failed for a
 * cause that had already been repaired. On 2026-09-14T23:38Z the ONE permitted
 * recovery (row 96932757, repair_key `pd038-notify-env-and-pd039-recovery-counter`)
 * was legitimately consumed and the engine then died on a DIFFERENT
 * deterministic pre-engine defect (PD-TEST-049, the F1 requester-shape bug).
 * With the row present, a repair_key that differed was refused 409
 * `pre_engine_recovery_already_issued`, the same repair_key replayed
 * idempotently WITHOUT re-dispatching (the claim only matches
 * `dispatch_started_at IS NULL`), and both ordinary sweeps gate on
 * `dispatch_attempts < MAX_DISPATCH_ATTEMPTS` while the counter had already
 * moved 5 -> 6. The run had no supported re-drive path.
 *
 * The invariant enforced here is:
 *
 *   A task may hold at most PREENGINE_RECOVERY_MAX_PER_TASK (default 3)
 *   pre-engine recovery receipts, EVER. Each receipt is claimable by exactly
 *   ONE bridge dispatch. A further receipt for a DIFFERENT repair_key is
 *   issued only while every prior receipt has already been claimed AND the run
 *   is provably engine-artifact-free AND the task's dispatch counter proves a
 *   NEW recorded dispatch failure happened after the previous receipt.
 *
 * The abuse case this closes: "invent a fresh repair_key string to buy an
 * unlimited retry budget". A second key is no longer obtainable from the mere
 * EXISTENCE of a first row. It must be paid for — by a claimed prior dispatch,
 * a real recorded failure that raised `dispatch_attempts` above the high-water
 * mark recorded on the prior row, a task that is blocked again, and a run that
 * has still produced NO engine work at all. And it is hard-bounded: once the
 * per-task receipt budget is spent, no further key is issuable by anyone.
 * As soon as the engine writes `state.json`, takes a CC execution row, or gets
 * a verification receipt, the pre-engine lane is closed for good — that is what
 * stops a task that has actually begun producing engine work from being
 * retried through an exception meant only for runs that never started.
 */
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run, transaction } from '@/lib/db';
import { loadOperatorPresentationContract } from '@/lib/presentation-operator-contract';
import { operatorPresentationRunDir } from '@/lib/presentation-run-roots';

export type PreEngineRecoveryEvidence = {
  contract_sha256: string;
  execution_id: string;
  repair_key: string;
  prior_failure_code: string;
  bridge_state: 'launch_pending';
  retry_attempt: number;
  engine_execution_id: null;
  no_engine_artifacts: true;
};

export type PreEngineRecovery = {
  id: string;
  task_id: string;
  execution_id: string;
  contract_sha256: string;
  prior_dispatch_attempts: number;
  repair_key: string;
  prior_failure_code: string;
  created_at: string;
  dispatch_started_at?: string | null;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Atomically consumes the one authorized post-repair bridge launch. */
export function claimPreEngineRecoveryDispatch(id: string): boolean {
  const result = run(
    'UPDATE presentation_operator_preengine_recoveries SET dispatch_started_at=? WHERE id=? AND dispatch_started_at IS NULL',
    [new Date().toISOString(), id],
  );
  return (result.changes ?? 0) === 1;
}

/** Kinds of durable evidence that this task's run LEFT the pre-engine phase. */
export type PreEngineArtifactKind = 'state_json' | 'task_execution' | 'engine_receipt';

/**
 * Hard ceiling on receipted pre-engine recoveries per task. Exhausting the
 * ordinary dispatch budget (MAX_DISPATCH_ATTEMPTS) buys at most this many
 * separately receipted, separately repaired pre-engine attempts — never an
 * open-ended budget.
 */
export function preEngineRecoveryBudget(): number {
  return Math.max(1, Number.parseInt(process.env.PREENGINE_RECOVERY_MAX_PER_TASK || '3', 10) || 3);
}

/**
 * Server-side proof of "this run never produced engine work".
 *
 * The caller's `no_engine_artifacts: true` assertion in the request body is
 * accepted for schema compatibility but is NOT trusted — the server re-derives
 * it here. Three independent durable signals, all task-scoped:
 *
 *   state_json      the engine's own pinned state file in the operator run
 *                   directory. A real run writes `<runDir>/state.json`; the
 *                   PD-TEST-049 pre-engine death wrote `.mode-plan.json`,
 *                   `.model-plan.json`, `.credit-preflight.json` and the OCR
 *                   probe receipt but NO state.json — which is exactly the
 *                   boundary this endpoint exists to straddle.
 *   task_execution  ANY `task_executions` row for the task, terminal included.
 *                   The operator bridge path writes none (verified against the
 *                   live task: six recorded dispatches, zero execution rows),
 *                   so a row means the board handed this task to a real
 *                   executor and the run is past the pre-engine phase.
 *   engine_receipt  ANY `presentation_verification_receipts` row, active or
 *                   invalidated — the engine produced and registered a proof.
 *
 * The specific existing refusals still take precedence for their own cases:
 * `active_execution_exists` (live execution) and `engine_proof_exists` (active
 * receipt) are evaluated BEFORE this probe, so no previously-documented
 * refusal changes its code. What this probe adds is everything those two miss:
 * a state.json with no execution row and no receipt, a terminal
 * (succeeded/failed) execution row, and an invalidated receipt.
 */
export function preEngineRecoveryEngineArtifacts(taskId: string): PreEngineArtifactKind[] {
  const found: PreEngineArtifactKind[] = [];
  try {
    if (existsSync(path.join(operatorPresentationRunDir(taskId), 'state.json'))) found.push('state_json');
  } catch { /* an unresolvable run root is not engine work */ }
  try {
    if (queryOne<{ id: string }>('SELECT id FROM task_executions WHERE task_id=? LIMIT 1', [taskId])) found.push('task_execution');
  } catch { /* pre-migration DB: no execution table to consult */ }
  try {
    if (queryOne<{ id: string }>('SELECT id FROM presentation_verification_receipts WHERE task_id=? LIMIT 1', [taskId])) found.push('engine_receipt');
  } catch { /* pre-migration DB: no receipt table to consult */ }
  return found;
}

export function operatorContractSha256(contract: unknown): string {
  return createHash('sha256').update(canonical(contract), 'utf8').digest('hex');
}

function validEvidence(value: unknown): value is PreEngineRecoveryEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.contract_sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.contract_sha256)
    && typeof raw.execution_id === 'string' && /^[0-9a-f-]{36}$/i.test(raw.execution_id)
    && typeof raw.repair_key === 'string' && /^[a-z][a-z0-9-]{2,120}$/.test(raw.repair_key)
    && typeof raw.prior_failure_code === 'string' && /^[A-Z][A-Z0-9-]{2,120}$/.test(raw.prior_failure_code)
    && raw.bridge_state === 'launch_pending'
    && Number.isInteger(raw.retry_attempt) && (raw.retry_attempt as number) >= 1 && (raw.retry_attempt as number) <= 20
    && raw.engine_execution_id === null && raw.no_engine_artifacts === true;
}

export function issuePreEngineRecovery(taskId: string, input: unknown): { recovery: PreEngineRecovery; idempotent: boolean } {
  if (!validEvidence(input)) throw new Error('invalid_pre_engine_recovery_evidence');
  return transaction(() => {
    const task = queryOne<{ id: string; source: string | null; department: string | null; workspace_id: string | null; status: string; dispatch_attempts: number | null }>(
      'SELECT id, source, department, workspace_id, status, dispatch_attempts FROM tasks WHERE id=?', [taskId]);
    if (!task) throw new Error('task_not_found');
    if (task.source !== 'operator-delegated' || (task.department !== 'presentations' && task.workspace_id !== 'presentations')) throw new Error('operator_presentation_scope_required');
    const existing = queryOne<PreEngineRecovery>('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=? AND repair_key=?', [taskId, input.repair_key]);
    if (existing) {
      // Unchanged replay semantics: the SAME repair_key against the SAME bound
      // contract/execution is an idempotent replay of an existing receipt and
      // launches nothing further (the claim below only matches an unclaimed row).
      if (existing.contract_sha256 !== input.contract_sha256 || existing.execution_id !== input.execution_id) throw new Error('pre_engine_recovery_already_issued');
      return { recovery: existing, idempotent: true };
    }
    if (task.status !== 'blocked') throw new Error('blocked_task_required');
    const attempts = task.dispatch_attempts ?? 0;
    const cap = Math.max(1, Number.parseInt(process.env.MAX_DISPATCH_ATTEMPTS || '5', 10) || 5);
    if (attempts < cap) throw new Error('exhausted_dispatch_budget_required');
    const contract = loadOperatorPresentationContract(taskId);
    if (!contract || contract.execution_id !== input.execution_id || operatorContractSha256(contract) !== input.contract_sha256) throw new Error('immutable_contract_mismatch');
    const execution = queryOne<{ id: string }>("SELECT id FROM task_executions WHERE task_id=? AND state IN ('reserved','sending','accepted','running','unknown') LIMIT 1", [taskId]);
    if (execution) throw new Error('active_execution_exists');
    const proof = queryOne<{ id: string }>("SELECT id FROM presentation_verification_receipts WHERE task_id=? AND status='active' LIMIT 1", [taskId]);
    if (proof) throw new Error('engine_proof_exists');
    // ── PD-TEST-050 ledger gate: is a FURTHER receipt owed to this task? ──────
    // Runs after every pre-existing refusal above so none of them changes code
    // or precedence; it can only refuse where the old code would have INSERTed.
    const prior = queryAll<PreEngineRecovery>('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=? ORDER BY created_at ASC, id ASC', [taskId]);
    if (prior.length > 0) {
      // An ISSUED but UNCLAIMED receipt is still outstanding: replay it (same
      // repair_key) instead of minting a second one for the same task.
      if (prior.some((row) => !row.dispatch_started_at)) throw new Error('pre_engine_recovery_already_issued');
      // Hard, per-task ceiling on receipted recoveries — the anti-furnace bound.
      if (prior.length >= preEngineRecoveryBudget()) throw new Error('pre_engine_recovery_budget_exhausted');
      // Each further receipt must be PAID FOR by a new recorded dispatch
      // failure: the task's counter must now exceed the highest value any prior
      // receipt recorded at issue time. Re-blocking a task without a fresh
      // dispatch failure buys nothing.
      const paidThrough = Math.max(...prior.map((row) => row.prior_dispatch_attempts ?? 0));
      if (attempts <= paidThrough) throw new Error('pre_engine_recovery_no_new_dispatch_failure');
    }
    // ── PD-TEST-050 artifact gate: the run must still be pre-engine ──────────
    // Applies to EVERY issuance, the first one included: the request body's
    // `no_engine_artifacts` flag is a claim, and this is the server's proof.
    if (preEngineRecoveryEngineArtifacts(taskId).length > 0) throw new Error('pre_engine_recovery_engine_artifacts_present');
    const recovery: PreEngineRecovery = {
      id: uuidv4(), task_id: taskId, execution_id: contract.execution_id,
      contract_sha256: input.contract_sha256, prior_dispatch_attempts: attempts,
      repair_key: input.repair_key, prior_failure_code: input.prior_failure_code,
      created_at: new Date().toISOString(),
    };
    run(`INSERT INTO presentation_operator_preengine_recoveries
      (id, task_id, execution_id, contract_sha256, prior_dispatch_attempts, repair_key, prior_failure_code, bridge_state, bridge_retry_attempt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [recovery.id, recovery.task_id, recovery.execution_id, recovery.contract_sha256, recovery.prior_dispatch_attempts, recovery.repair_key, recovery.prior_failure_code, input.bridge_state, input.retry_attempt, recovery.created_at]);
    return { recovery, idempotent: false };
  });
}
