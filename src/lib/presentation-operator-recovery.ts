/**
 * One-time, pre-engine recovery for a signed operator presentation contract.
 *
 * This is deliberately separate from U061's human Resume.  It does not alter
 * the task's dispatch counter: the historical exhausted budget remains on the
 * task, while this immutable row records the single post-repair launch that
 * the server authorized.
 */
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, transaction } from '@/lib/db';
import { loadOperatorPresentationContract } from '@/lib/presentation-operator-contract';

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
    const existing = queryOne<PreEngineRecovery>('SELECT * FROM presentation_operator_preengine_recoveries WHERE task_id=?', [taskId]);
    if (existing) {
      if (existing.contract_sha256 !== input.contract_sha256 || existing.execution_id !== input.execution_id || existing.repair_key !== input.repair_key) throw new Error('pre_engine_recovery_already_issued');
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
