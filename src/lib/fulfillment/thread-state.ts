/**
 * T-33 / cc-conversation-operations — conversation, fulfillment and follow-up
 * read model.
 *
 * The canonical sequence is fixed and ordered. Every step is proven from a
 * real engine record: an absent record renders NO RECORD, a record that exists
 * but cannot prove the step renders UNKNOWN naming the malformed field, and the
 * offending value is ALWAYS shown whole (never sliced into a digest-looking
 * prefix). The read is tenant-scoped: a caller must name the workspace it is
 * reading, and rows from any other workspace are never returned.
 */
import fs from 'node:fs';
import path from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { getDb } from '../db';

export const FULFILLMENT_SEQUENCE = [
  'contacted',
  'replied',
  'gift_promised',
  'gift_delivered',
  'gift_failed',
  'follow_up_due',
  'follow_up_done',
] as const;

export type FulfillmentStep = (typeof FULFILLMENT_SEQUENCE)[number];
export type FulfillmentVerdict = 'recorded' | 'no_record' | 'unknown';

export interface FulfillmentStepProof {
  step: FulfillmentStep;
  verdict: FulfillmentVerdict;
  /** The record's own proof value, untruncated. Null when nothing proves it. */
  proof: string | null;
  /** The engine table that must own this step. */
  producer: string;
  /** Set only for UNKNOWN: which field is malformed / which producer is absent. */
  detail?: string;
}

export interface FulfillmentThread {
  taskId: string;
  title: string;
  department: string | null;
  status: string;
  isGiftTask: boolean;
  states: Record<FulfillmentStep, FulfillmentStepProof>;
}

export interface FulfillmentScope {
  tenantId?: string;
  companyId?: string;
  workspaceId: string;
}

export interface BuildFulfillmentThreadsInput {
  now?: Date;
  workspaceId?: string;
  tenant?: Partial<FulfillmentScope>;
  scope?: Partial<FulfillmentScope>;
}

export class FulfillmentScopeError extends Error {
  readonly code = 'SCOPE_REQUIRED';
  readonly status = 400;
  constructor() {
    super('A fulfillment read must name the workspace (tenant scope) it is reading; an unscoped read is refused.');
    this.name = 'FulfillmentScopeError';
  }
}

interface TaskRow {
  id: string;
  title: string | null;
  description: string | null;
  status: string;
  department: string | null;
  due_date: string | null;
  completed_at: string | null;
  workspace_id: string;
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;
const GIFT_VOCABULARY = /\b(gift|gifts|present|presents|bonus|surprise|thank[\s-]?you)\b/i;

function cell(
  step: FulfillmentStep,
  verdict: FulfillmentVerdict,
  proof: string | null,
  producer: string,
  detail?: string,
): FulfillmentStepProof {
  return detail === undefined
    ? { step, verdict, proof, producer }
    : { step, verdict, proof, producer, detail };
}

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function hasTable(db: DatabaseType.Database, table: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as
    | { name: string }
    | undefined;
  return Boolean(row);
}

function latestActivity(
  db: DatabaseType.Database,
  taskId: string,
  types: string[],
): { activity_type: string; message: unknown } | undefined {
  if (!hasTable(db, 'task_activities')) return undefined;
  const placeholders = types.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT activity_type, message FROM task_activities
        WHERE task_id = ? AND activity_type IN (${placeholders})
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId, ...types) as { activity_type: string; message: unknown } | undefined;
}

function latestEvent(
  db: DatabaseType.Database,
  taskId: string,
  toStatuses: string[],
): { to_status: string; reason: string | null } | undefined {
  if (!hasTable(db, 'task_events')) return undefined;
  const placeholders = toStatuses.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT to_status, reason FROM task_events
        WHERE task_id = ? AND to_status IN (${placeholders})
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId, ...toStatuses) as { to_status: string; reason: string | null } | undefined;
}

function pathExists(value: string): boolean {
  try {
    const resolved = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

/** A deliverable proves delivery only with a real 64-hex sha256 or an on-disk artifact. */
function deliverableProof(db: DatabaseType.Database, taskId: string): FulfillmentStepProof {
  if (!hasTable(db, 'task_deliverables')) {
    return cell('gift_delivered', 'unknown', null, 'task_deliverables', 'task_deliverables is absent');
  }
  const rows = db
    .prepare(
      `SELECT id, sha256, path FROM task_deliverables
        WHERE task_id = ? AND superseded_at IS NULL
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(taskId) as { id: string; sha256: string | null; path: string | null }[];
  if (rows.length === 0) return cell('gift_delivered', 'no_record', null, 'task_deliverables');
  let malformed: { id: string; value: string } | null = null;
  for (const row of rows) {
    if (typeof row.sha256 === 'string' && SHA256_HEX.test(row.sha256)) {
      return cell('gift_delivered', 'recorded', row.sha256, 'task_deliverables.sha256');
    }
    if (typeof row.path === 'string' && row.path.trim() && pathExists(row.path)) {
      return cell('gift_delivered', 'recorded', row.path, 'task_deliverables.path');
    }
    malformed = { id: row.id, value: row.sha256 ?? row.path ?? '' };
  }
  return cell(
    'gift_delivered',
    'unknown',
    malformed?.value ?? null,
    'task_deliverables',
    `task_deliverables.proof is malformed (row ${malformed?.id ?? 'unknown'})`,
  );
}

function buildStates(db: DatabaseType.Database, task: TaskRow, now: Date): Record<FulfillmentStep, FulfillmentStepProof> {
  // contacted — an agent_message activity, or a trust lifecycle event.
  let contacted: FulfillmentStepProof;
  const message = latestActivity(db, task.id, ['agent_message']);
  if (message) {
    contacted = blank(message.message)
      ? cell('contacted', 'unknown', String(message.message ?? ''), 'task_activities.message', 'task_activities.message is malformed')
      : cell('contacted', 'recorded', String(message.message), 'task_activities.message');
  } else {
    const trust = latestEvent(db, task.id, ['trust_ack', 'trust_progress', 'trust_done']);
    contacted = trust
      ? cell('contacted', 'recorded', trust.to_status, 'task_events.to_status')
      : cell('contacted', 'no_record', null, 'task_activities.agent_message');
  }

  // replied — an owner_message activity; a later real message beats an empty one.
  let replied: FulfillmentStepProof;
  const reply = latestActivity(db, task.id, ['owner_message']);
  if (reply) {
    replied = blank(reply.message)
      ? cell('replied', 'unknown', String(reply.message ?? ''), 'task_activities.message', 'task_activities.message is malformed')
      : cell('replied', 'recorded', String(reply.message), 'task_activities.message');
  } else {
    replied = cell('replied', 'no_record', null, 'task_activities.owner_message');
  }

  // gift promised — gift vocabulary on the task row; title first, description as fallback.
  const isGiftTask = GIFT_VOCABULARY.test(`${task.title ?? ''} ${task.description ?? ''}`);
  let promised: FulfillmentStepProof;
  if (!isGiftTask) {
    promised = cell('gift_promised', 'no_record', null, 'tasks.title');
  } else if (!blank(task.title)) {
    promised = cell('gift_promised', 'recorded', String(task.title), 'tasks.title');
  } else if (!blank(task.description)) {
    promised = cell('gift_promised', 'recorded', String(task.description), 'tasks.description');
  } else {
    promised = cell('gift_promised', 'unknown', '', 'tasks.title', 'tasks.title is malformed');
  }

  // gift failed — blocked task, blocked event, or an error activity.
  let failed: FulfillmentStepProof;
  if (task.status === 'blocked') {
    failed = cell('gift_failed', 'recorded', 'tasks.status=blocked', 'tasks.status');
  } else {
    const blocked = latestEvent(db, task.id, ['blocked']);
    if (blocked) {
      failed = cell('gift_failed', 'recorded', blocked.reason ?? blocked.to_status, 'task_events.to_status');
    } else {
      const error = latestActivity(db, task.id, ['error']);
      if (error) {
        failed = blank(error.message)
          ? cell('gift_failed', 'unknown', String(error.message ?? ''), 'task_activities.message', 'task_activities.message is malformed')
          : cell('gift_failed', 'recorded', String(error.message), 'task_activities.message');
      } else {
        failed = cell('gift_failed', 'no_record', null, 'tasks.status');
      }
    }
  }

  // gift delivered — never rendered delivered while the gift is failed.
  const delivered = failed.verdict === 'recorded'
    ? cell('gift_delivered', 'no_record', null, 'task_deliverables', 'suppressed: the gift failed')
    : deliverableProof(db, task.id);

  // follow-up due — a due date in the past on a task that is not done.
  let due: FulfillmentStepProof;
  const done = task.completed_at != null || task.status === 'done';
  if (done || !task.due_date) {
    due = cell('follow_up_due', 'no_record', null, 'tasks.due_date');
  } else {
    const parsed = Date.parse(task.due_date);
    if (Number.isNaN(parsed)) {
      due = cell('follow_up_due', 'unknown', task.due_date, 'tasks.due_date', 'tasks.due_date is malformed');
    } else if (parsed < now.getTime()) {
      due = cell('follow_up_due', 'recorded', task.due_date, 'tasks.due_date');
    } else {
      due = cell('follow_up_due', 'no_record', null, 'tasks.due_date');
    }
  }

  // follow-up done — completed_at or status done.
  const doneProof = task.completed_at ?? (task.status === 'done' ? 'tasks.status=done' : null);
  const followUpDone = doneProof
    ? cell('follow_up_done', 'recorded', doneProof, task.completed_at ? 'tasks.completed_at' : 'tasks.status')
    : cell('follow_up_done', 'no_record', null, 'tasks.completed_at');

  return {
    contacted,
    replied,
    gift_promised: promised,
    gift_delivered: delivered,
    gift_failed: failed,
    follow_up_due: due,
    follow_up_done: followUpDone,
  };
}

function resolveScope(input: BuildFulfillmentThreadsInput): FulfillmentScope {
  const workspaceId = input.workspaceId ?? input.tenant?.workspaceId ?? input.scope?.workspaceId;
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new FulfillmentScopeError();
  return {
    tenantId: input.tenant?.tenantId ?? input.scope?.tenantId,
    companyId: input.tenant?.companyId ?? input.scope?.companyId,
    workspaceId: workspaceId.trim(),
  };
}

/**
 * Read the canonical fulfillment sequence for every task in ONE workspace.
 * `workspaceId` is required — there is no unscoped variant.
 */
export function buildFulfillmentThreads(
  input: BuildFulfillmentThreadsInput,
  db: DatabaseType.Database = getDb(),
): FulfillmentThread[] {
  const scope = resolveScope(input);
  const now = input.now ?? new Date();
  const companyClause = scope.companyId ? 'AND w.company_id = ?' : '';
  const params: string[] = scope.companyId
    ? [scope.workspaceId, scope.companyId]
    : [scope.workspaceId];
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.status, t.department, t.due_date,
              t.completed_at, t.workspace_id
         FROM tasks t
         JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.workspace_id = ?
          ${companyClause}
          AND (t.archived_at IS NULL)
        ORDER BY t.created_at ASC, t.rowid ASC`,
    )
    .all(...params) as TaskRow[];

  return tasks.map((task) => {
    const states = buildStates(db, task, now);
    const isGiftTask = GIFT_VOCABULARY.test(`${task.title ?? ''} ${task.description ?? ''}`);
    return {
      taskId: task.id,
      title: task.title ?? '',
      department: task.department,
      status: task.status,
      isGiftTask,
      states,
    };
  });
}
