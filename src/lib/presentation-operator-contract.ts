/**
 * Server-side contract for a trusted operator-delegated Presentations intake.
 * This is deliberately distinct from task messages and approvals: it records
 * only the execution request already authenticated at task ingest.
 */
import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, transaction } from '@/lib/db';

export const OPERATOR_PRESENTATION_CONTRACT_VERSION = 1;
export type OperatorPresentationIntake = {
  version: 1; source: 'operator-delegated';
  title: string; presentation_type: 'from_scratch'; run_mode: 'ultra' | 'standard' | 'quick';
  workhorse_model: 'deepseek-flash@deepseek-direct'; slide_count: number;
  pitch_included: boolean; want_sales_checkout: 'yes' | 'no'; want_vsl_page: 'yes' | 'no';
  answers: Record<string, string>;
};
export type OperatorPresentationContract = OperatorPresentationIntake & { task_id: string; execution_id: string };

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${name} must be a UUID`);
  return value;
}
export function parseOperatorPresentationContract(value: unknown): OperatorPresentationIntake {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('presentation_intake must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== OPERATOR_PRESENTATION_CONTRACT_VERSION || raw.source !== 'operator-delegated') throw new Error('presentation_intake requires current operator-delegated source');
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title || title.length > 500) throw new Error('presentation_intake title is invalid');
  if (raw.presentation_type !== 'from_scratch' || (raw.run_mode !== 'ultra' && raw.run_mode !== 'standard' && raw.run_mode !== 'quick') || raw.workhorse_model !== 'deepseek-flash@deepseek-direct') throw new Error('presentation_intake contains unsupported execution selection');
  if (!Number.isInteger(raw.slide_count) || (raw.slide_count as number) < 1 || (raw.slide_count as number) > 200) throw new Error('presentation_intake slide_count is invalid');
  if (typeof raw.pitch_included !== 'boolean' || (raw.want_sales_checkout !== 'yes' && raw.want_sales_checkout !== 'no') || (raw.want_vsl_page !== 'yes' && raw.want_vsl_page !== 'no')) throw new Error('presentation_intake applicability fields are invalid');
  if (!raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers) || Object.values(raw.answers).some(v => typeof v !== 'string' || v.length > 4000)) throw new Error('presentation_intake answers are invalid');
  if ('task_id' in raw || 'execution_id' in raw) throw new Error('presentation_intake task_id and execution_id are server-issued');
  return { version: 1, source: 'operator-delegated', title, presentation_type: 'from_scratch', run_mode: raw.run_mode, workhorse_model: 'deepseek-flash@deepseek-direct', slide_count: raw.slide_count as number, pitch_included: raw.pitch_included, want_sales_checkout: raw.want_sales_checkout, want_vsl_page: raw.want_vsl_page, answers: raw.answers as Record<string, string> };
}

export function bindOperatorPresentationContract(taskId: string, intake: OperatorPresentationIntake): OperatorPresentationContract {
  return { ...intake, task_id: uuid(taskId, 'task_id'), execution_id: uuidv4() };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function bridgeReceipt(contract: OperatorPresentationContract): { receipt_version: 1; contract: OperatorPresentationContract; receipt_hmac: string } {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error('WEBHOOK_SECRET is required for operator presentation receipt');
  return { receipt_version: 1, contract, receipt_hmac: createHmac('sha256', secret).update(canonical(contract), 'utf8').digest('hex') };
}

export function saveOperatorPresentationContract(taskId: string, contract: OperatorPresentationContract): void {
  if (contract.task_id !== taskId) throw new Error('presentation_intake task_id does not match created task');
  const task = queryOne<{ id: string; source: string | null }>('SELECT id, source FROM tasks WHERE id = ?', [taskId]);
  if (!task || task.source !== 'operator-delegated') throw new Error('presentation_intake requires an operator-delegated task record');
  const serialized = JSON.stringify(contract);
  const existing = queryOne<{ execution_id: string; contract_json: string }>(
    'SELECT execution_id, contract_json FROM presentation_operator_contracts WHERE task_id = ?', [taskId]);
  if (existing) {
    if (existing.execution_id !== contract.execution_id || existing.contract_json !== serialized) {
      throw new Error('presentation_intake is immutable after first accepted contract');
    }
    return;
  }
  run(`INSERT INTO presentation_operator_contracts (task_id, execution_id, contract_json, created_at)
       VALUES (?, ?, ?, datetime('now'))`, [taskId, contract.execution_id, serialized]);
}
export function loadOperatorPresentationContract(taskId: string): OperatorPresentationContract | null {
  const row = queryOne<{ contract_json: string }>('SELECT contract_json FROM presentation_operator_contracts WHERE task_id = ?', [taskId]);
  if (!row) return null;
  const raw = JSON.parse(row.contract_json) as Record<string, unknown>;
  const storedTaskId = uuid(raw.task_id, 'task_id');
  const executionId = uuid(raw.execution_id, 'execution_id');
  const { task_id: _task, execution_id: _execution, ...intake } = raw;
  return { ...parseOperatorPresentationContract(intake), task_id: storedTaskId, execution_id: executionId };
}

export function ensureOperatorPresentationContract(taskId: string, intake: OperatorPresentationIntake): OperatorPresentationContract {
  return transaction(() => {
    const existing = loadOperatorPresentationContract(taskId);
    if (existing) {
      const { task_id: _task, execution_id: _execution, ...prior } = existing;
      if (canonical(prior) !== canonical(intake)) throw new Error('presentation_intake is immutable after first accepted contract');
      return existing;
    }
    const task = queryOne<{ source: string | null; status: string }>('SELECT source, status FROM tasks WHERE id=?', [taskId]);
    if (!task || task.source !== 'operator-delegated' || task.status !== 'backlog') throw new Error('presentation_intake recovery requires an undispatched operator task');
    const dispatched = queryOne<{ id: string }>("SELECT id FROM events WHERE task_id=? AND type='task_dispatched' LIMIT 1", [taskId]);
    if (dispatched) throw new Error('presentation_intake recovery refused after dispatch');
    const contract = bindOperatorPresentationContract(taskId, intake);
    saveOperatorPresentationContract(taskId, contract);
    return contract;
  });
}
