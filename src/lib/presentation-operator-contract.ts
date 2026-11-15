/**
 * Server-side contract for a trusted operator-delegated Presentations intake.
 * This is deliberately distinct from task messages and approvals: it records
 * only the execution request already authenticated at task ingest.
 */
import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, transaction } from '@/lib/db';

export const OPERATOR_PRESENTATION_CONTRACT_VERSION = 1;
type YesNo = 'yes' | 'no';
type DeliveryDestinations = string | string[];
/**
 * PD-013 interview pace. The build run mode (`run_mode`) is a separate axis and
 * never selects the interview depth.
 */
export type OperatorInterviewDepth = 'quick' | 'in_depth';
/**
 * PD-013/PD-004b default provenance. The signed operator contract carries the
 * real owner message in which the client accepted the QUICK defaults, so the
 * bridge can prove every defaulted answer under `enforce` instead of inventing
 * one. Absent means no defaults were accepted -> QUICK runs fail closed.
 */
export type OperatorDefaultAcceptance = { msg_id: string; chat_id: string; text: string };
export type OperatorPresentationIntake = {
  version: 1; source: 'operator-delegated';
  title: string; presentation_type: 'from_scratch'; run_mode: 'ultra' | 'standard' | 'economy';
  workhorse_model: 'deepseek-flash@deepseek-direct'; slide_count: number;
  pitch_included: boolean;
  deliverable_set: string;
  want_teleprompter: YesNo; want_speech_script: YesNo;
  want_audio_deliverable: YesNo; want_audio_demo: boolean;
  want_ghl_upload: YesNo; delivery_destinations: DeliveryDestinations;
  want_sales_checkout: YesNo; want_vsl_page: YesNo;
  answers: Record<string, string>;
  interview_depth?: OperatorInterviewDepth;
  default_acceptance?: OperatorDefaultAcceptance;
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
  if (raw.presentation_type !== 'from_scratch' || (raw.run_mode !== 'ultra' && raw.run_mode !== 'standard' && raw.run_mode !== 'economy') || raw.workhorse_model !== 'deepseek-flash@deepseek-direct') throw new Error('presentation_intake contains unsupported execution selection');
  if (!Number.isInteger(raw.slide_count) || (raw.slide_count as number) < 1 || (raw.slide_count as number) > 200) throw new Error('presentation_intake slide_count is invalid');
  const yesNo = (field: string): YesNo => {
    const fieldValue = raw[field];
    if (fieldValue !== 'yes' && fieldValue !== 'no') throw new Error(`presentation_intake ${field} is invalid`);
    return fieldValue;
  };
  const deliverableSet = typeof raw.deliverable_set === 'string' ? raw.deliverable_set.trim() : '';
  if (!deliverableSet || deliverableSet.length > 500) throw new Error('presentation_intake deliverable_set is invalid');
  const destinations = raw.delivery_destinations;
  const validDestination = (item: unknown): item is string => typeof item === 'string' && item.trim().length > 0 && item.trim().length <= 500;
  if (!(validDestination(destinations) || (Array.isArray(destinations) && destinations.length > 0 && destinations.length <= 20 && destinations.every(validDestination)))) throw new Error('presentation_intake delivery_destinations is invalid');
  if (typeof raw.pitch_included !== 'boolean' || typeof raw.want_audio_demo !== 'boolean') throw new Error('presentation_intake applicability fields are invalid');
  if (!raw.answers || typeof raw.answers !== 'object' || Array.isArray(raw.answers) || Object.values(raw.answers).some(v => typeof v !== 'string' || v.length > 4000)) throw new Error('presentation_intake answers are invalid');
  if ('task_id' in raw || 'execution_id' in raw) throw new Error('presentation_intake task_id and execution_id are server-issued');
  const depthRaw = raw.interview_depth;
  if (depthRaw !== undefined && depthRaw !== 'quick' && depthRaw !== 'in_depth') throw new Error('presentation_intake interview_depth is invalid');
  const acceptanceRaw = raw.default_acceptance;
  let defaultAcceptance: OperatorDefaultAcceptance | undefined;
  if (acceptanceRaw !== undefined) {
    if (!acceptanceRaw || typeof acceptanceRaw !== 'object' || Array.isArray(acceptanceRaw)) throw new Error('presentation_intake default_acceptance is invalid');
    const acceptance = acceptanceRaw as Record<string, unknown>;
    const msgId = typeof acceptance.msg_id === 'string' ? acceptance.msg_id.trim() : '';
    const chatId = typeof acceptance.chat_id === 'string' ? acceptance.chat_id.trim() : '';
    const text = typeof acceptance.text === 'string' ? acceptance.text.trim() : '';
    if (!msgId || msgId.length > 256) throw new Error('presentation_intake default_acceptance msg_id is invalid');
    if (!chatId || chatId.length > 256) throw new Error('presentation_intake default_acceptance chat_id is invalid');
    if (!text || text.length > 4000) throw new Error('presentation_intake default_acceptance text is invalid');
    defaultAcceptance = { msg_id: msgId, chat_id: chatId, text };
  }
  const parsed: OperatorPresentationIntake = { version: 1, source: 'operator-delegated', title, presentation_type: 'from_scratch', run_mode: raw.run_mode, workhorse_model: 'deepseek-flash@deepseek-direct', slide_count: raw.slide_count as number, pitch_included: raw.pitch_included, deliverable_set: deliverableSet, want_teleprompter: yesNo('want_teleprompter'), want_speech_script: yesNo('want_speech_script'), want_audio_deliverable: yesNo('want_audio_deliverable'), want_audio_demo: raw.want_audio_demo, want_ghl_upload: yesNo('want_ghl_upload'), delivery_destinations: Array.isArray(destinations) ? destinations.map(item => item.trim()) : destinations.trim(), want_sales_checkout: yesNo('want_sales_checkout'), want_vsl_page: yesNo('want_vsl_page'), answers: raw.answers as Record<string, string> };
  // Optional fields are added only when present so the canonical receipt bytes
  // of a pre-provenance contract stay exactly what its HMAC was signed over.
  if (depthRaw !== undefined) parsed.interview_depth = depthRaw;
  if (defaultAcceptance) parsed.default_acceptance = defaultAcceptance;
  return parsed;
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
