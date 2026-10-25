/**
 * T-33 / cc-conversation-operations — pause / retry / handoff controls.
 *
 * Every control is:
 *   - TENANT-SCOPED: the caller's tenant/company/workspace must match the task's
 *     own workspace, and a mismatch is indistinguishable from absence;
 *   - EXPECTED-VERSIONED: the caller must name the exact state version it acted
 *     on. Absent, non-integer, stale, or replayed versions are refused and change
 *     nothing — there is no "latest wins" path;
 *   - THROUGH THE OWNER: only a verified owner principal may move the state, and
 *     a handoff must name the accepted owner, a backup owner, the due action and
 *     the context. The bot stays fenced (handed_off) until an explicit release.
 *
 * Each applied step writes a receipt whose proof is a sha256 over the exact
 * transition, so the sequence is provable step by step.
 */
import { createHash, randomUUID } from 'node:crypto';
import type DatabaseType from 'better-sqlite3';
import { getDb } from '../db';

export type FulfillmentOperationState = 'active' | 'paused' | 'handed_off';
export type FulfillmentControlStep = 'pause' | 'retry' | 'handoff';

export interface FulfillmentControlEnvelope {
  tenantId: string;
  companyId: string;
  workspaceId: string;
  /** Only a verified owner may control a thread. */
  actor: 'owner' | string;
  ownerId: string;
}

export interface ExpectedVersionInput {
  expectedVersion?: unknown;
  expected_version?: unknown;
  now?: Date;
}

export interface PauseInput extends ExpectedVersionInput {
  reason?: string | null;
}

export interface RetryInput extends ExpectedVersionInput {
  reason?: string | null;
}

export interface HandoffInput extends ExpectedVersionInput {
  /** The accepted human owner the thread is handed to (not the caller). */
  targetOwnerId: string;
  /** Required backup owner — the handoff must survive the primary being away. */
  backupOwnerId: string;
  /** The concrete action the owner owes. */
  dueAction: string;
  /** Conversation context the owner needs to act. */
  context: string;
}

export interface FulfillmentOperationReceipt {
  taskId: string;
  step: FulfillmentControlStep;
  fromState: FulfillmentOperationState;
  toState: FulfillmentOperationState;
  stateVersion: number;
  ownerId: string;
  proof: string;
  idempotentReplay: boolean;
}

export type FulfillmentOperationErrorCode =
  | 'SCOPE_REQUIRED'
  | 'OWNER_REQUIRED'
  | 'NOT_FOUND'
  | 'VERSION_REQUIRED'
  | 'VERSION_INVALID'
  | 'VERSION_MISMATCH'
  | 'ILLEGAL_TRANSITION'
  | 'HANDOFF_INCOMPLETE';

export class FulfillmentOperationError extends Error {
  readonly code: FulfillmentOperationErrorCode;
  readonly status: number;
  constructor(code: FulfillmentOperationErrorCode, message: string, status: number) {
    super(message);
    this.name = 'FulfillmentOperationError';
    this.code = code;
    this.status = status;
  }
}

interface OperationRow {
  task_id: string;
  tenant_id: string;
  company_id: string;
  workspace_id: string;
  state: FulfillmentOperationState;
  state_version: number;
  retry_count: number;
  handoff_owner_id: string | null;
  handoff_backup_owner_id: string | null;
  handoff_due_action: string | null;
  handoff_context: string | null;
  updated_at: string;
}

function requireScope(envelope: FulfillmentControlEnvelope): void {
  for (const value of [envelope?.tenantId, envelope?.companyId, envelope?.workspaceId]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new FulfillmentOperationError(
        'SCOPE_REQUIRED',
        'A fulfillment control must carry tenantId, companyId and workspaceId; an unscoped control is refused.',
        400,
      );
    }
  }
}

function requireOwner(envelope: FulfillmentControlEnvelope): string {
  if (envelope?.actor !== 'owner' || typeof envelope.ownerId !== 'string' || !envelope.ownerId.trim()) {
    throw new FulfillmentOperationError(
      'OWNER_REQUIRED',
      'A fulfillment control must come from a verified owner principal; the transition was not applied.',
      403,
    );
  }
  return envelope.ownerId.trim();
}

/**
 * The expected version is mandatory. A missing value is NOT "any version", and a
 * string / float / NaN / boolean is not silently coerced.
 */
function requireExpectedVersion(input: ExpectedVersionInput): number {
  const hasCamel = Object.prototype.hasOwnProperty.call(input ?? {}, 'expectedVersion');
  const hasSnake = Object.prototype.hasOwnProperty.call(input ?? {}, 'expected_version');
  if (!hasCamel && !hasSnake) {
    throw new FulfillmentOperationError(
      'VERSION_REQUIRED',
      'expectedVersion is required; the control was not applied. Reload the thread and retry with the version you read.',
      400,
    );
  }
  const value = hasCamel ? input.expectedVersion : input.expected_version;
  if (hasCamel && hasSnake && input.expectedVersion !== input.expected_version) {
    throw new FulfillmentOperationError(
      'VERSION_INVALID',
      'expectedVersion and expected_version disagree; the control was not applied.',
      400,
    );
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new FulfillmentOperationError(
      'VERSION_INVALID',
      `expectedVersion must be a positive integer; received ${JSON.stringify(value)}. The control was not applied.`,
      400,
    );
  }
  return value;
}

interface TaskScopeRow {
  id: string;
  workspace_id: string;
  company_id: string;
}

/** Cross-tenant and absent are the SAME result — no existence oracle. */
function loadTask(db: DatabaseType.Database, envelope: FulfillmentControlEnvelope, taskId: string): TaskScopeRow {
  const row = db
    .prepare(
      `SELECT t.id, t.workspace_id, w.company_id
         FROM tasks t
         JOIN workspaces w ON w.id = t.workspace_id
        WHERE t.id = ?
          AND t.workspace_id = ?
          AND w.company_id = ?
          AND t.archived_at IS NULL`,
    )
    .get(taskId, envelope.workspaceId, envelope.companyId) as TaskScopeRow | undefined;
  if (!row) {
    throw new FulfillmentOperationError(
      'NOT_FOUND',
      `Fulfillment task ${taskId} does not exist in this tenant scope, or is not visible to the caller.`,
      404,
    );
  }
  return row;
}

function loadOperation(
  db: DatabaseType.Database,
  envelope: FulfillmentControlEnvelope,
  taskId: string,
): OperationRow {
  const row = db
    .prepare(`SELECT * FROM fulfillment_operations WHERE task_id = ?`)
    .get(taskId) as OperationRow | undefined;
  if (row) {
    if (
      row.tenant_id !== envelope.tenantId ||
      row.company_id !== envelope.companyId ||
      row.workspace_id !== envelope.workspaceId
    ) {
      throw new FulfillmentOperationError(
        'NOT_FOUND',
        `Fulfillment task ${taskId} does not exist in this tenant scope, or is not visible to the caller.`,
        404,
      );
    }
    return row;
  }
  return {
    task_id: taskId,
    tenant_id: envelope.tenantId,
    company_id: envelope.companyId,
    workspace_id: envelope.workspaceId,
    state: 'active',
    state_version: 1,
    retry_count: 0,
    handoff_owner_id: null,
    handoff_backup_owner_id: null,
    handoff_due_action: null,
    handoff_context: null,
    updated_at: new Date(0).toISOString(),
  };
}

function assertVersion(current: OperationRow, expected: number): void {
  if (current.state_version !== expected) {
    throw new FulfillmentOperationError(
      'VERSION_MISMATCH',
      `Fulfillment task ${current.task_id} is at state version ${current.state_version}, not ${expected}. ` +
        'The control was not applied; reload and retry.',
      409,
    );
  }
}

function proofOf(parts: (string | number | null)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function writeReceipt(
  db: DatabaseType.Database,
  row: OperationRow,
  step: FulfillmentControlStep,
  fromState: FulfillmentOperationState,
  ownerId: string,
  at: string,
): string {
  const proof = proofOf([row.task_id, step, fromState, row.state, row.state_version, ownerId, at]);
  db.prepare(
    `INSERT INTO fulfillment_operation_receipts
       (id, task_id, tenant_id, company_id, step, from_state, to_state, state_version, actor_owner_id, proof, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    row.task_id,
    row.tenant_id,
    row.company_id,
    step,
    fromState,
    row.state,
    row.state_version,
    ownerId,
    proof,
    at,
  );
  return proof;
}

function persist(
  db: DatabaseType.Database,
  before: OperationRow,
  next: Partial<OperationRow> & { state: FulfillmentOperationState },
  at: string,
): OperationRow {
  const stateVersion = before.state_version + 1;
  if (before.updated_at === new Date(0).toISOString()) {
    db.prepare(
      `INSERT INTO fulfillment_operations
         (task_id, tenant_id, company_id, workspace_id, state, state_version, retry_count,
          handoff_owner_id, handoff_backup_owner_id, handoff_due_action, handoff_context, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      before.task_id,
      before.tenant_id,
      before.company_id,
      before.workspace_id,
      next.state,
      stateVersion,
      next.retry_count ?? before.retry_count,
      next.handoff_owner_id ?? null,
      next.handoff_backup_owner_id ?? null,
      next.handoff_due_action ?? null,
      next.handoff_context ?? null,
      at,
    );
  } else {
    db.prepare(
      `UPDATE fulfillment_operations
          SET state = ?, state_version = ?, retry_count = ?, handoff_owner_id = ?,
              handoff_backup_owner_id = ?, handoff_due_action = ?, handoff_context = ?, updated_at = ?
        WHERE task_id = ? AND tenant_id = ? AND company_id = ? AND state_version = ?`,
    ).run(
      next.state,
      stateVersion,
      next.retry_count ?? before.retry_count,
      next.handoff_owner_id ?? before.handoff_owner_id,
      next.handoff_backup_owner_id ?? before.handoff_backup_owner_id,
      next.handoff_due_action ?? before.handoff_due_action,
      next.handoff_context ?? before.handoff_context,
      at,
      before.task_id,
      before.tenant_id,
      before.company_id,
      before.state_version,
    );
    const after = db
      .prepare(`SELECT state_version FROM fulfillment_operations WHERE task_id = ?`)
      .get(before.task_id) as { state_version: number } | undefined;
    if (!after || after.state_version !== stateVersion) {
      throw new FulfillmentOperationError(
        'VERSION_MISMATCH',
        `Fulfillment task ${before.task_id} changed underneath this writer (expected ${before.state_version}). ` +
          'The control was not applied; reload and retry.',
        409,
      );
    }
  }
  return { ...before, ...next, state_version: stateVersion, updated_at: at };
}

function clock(input: { now?: Date }): string {
  return (input.now ?? new Date()).toISOString();
}

/** Pause a thread at a safe boundary. Idempotent only for the SAME version. */
export function pauseFulfillment(
  envelope: FulfillmentControlEnvelope,
  taskId: string,
  input: PauseInput = {},
  db: DatabaseType.Database = getDb(),
): FulfillmentOperationReceipt {
  requireScope(envelope);
  const ownerId = requireOwner(envelope);
  const expected = requireExpectedVersion(input);
  const apply = db.transaction((): FulfillmentOperationReceipt => {
    loadTask(db, envelope, taskId);
    const before = loadOperation(db, envelope, taskId);
    assertVersion(before, expected);
    if (before.state === 'paused') {
      return {
        taskId,
        step: 'pause',
        fromState: before.state,
        toState: before.state,
        stateVersion: before.state_version,
        ownerId,
        proof: proofOf([before.task_id, 'pause', before.state, before.state, before.state_version, ownerId, 'replay']),
        idempotentReplay: true,
      };
    }
    if (before.state === 'handed_off') {
      throw new FulfillmentOperationError(
        'ILLEGAL_TRANSITION',
        `Fulfillment task ${taskId} is handed off to an owner; the bot is fenced and cannot pause it. Nothing was changed.`,
        409,
      );
    }
    const at = clock(input);
    const after = persist(db, before, { state: 'paused' }, at);
    const proof = writeReceipt(db, after, 'pause', before.state, ownerId, at);
    return {
      taskId,
      step: 'pause',
      fromState: before.state,
      toState: after.state,
      stateVersion: after.state_version,
      ownerId,
      proof,
      idempotentReplay: false,
    };
  });
  return apply();
}

/** Retry a paused thread. A handoff is NOT released by retry. */
export function retryFulfillment(
  envelope: FulfillmentControlEnvelope,
  taskId: string,
  input: RetryInput = {},
  db: DatabaseType.Database = getDb(),
): FulfillmentOperationReceipt {
  requireScope(envelope);
  const ownerId = requireOwner(envelope);
  const expected = requireExpectedVersion(input);
  const apply = db.transaction((): FulfillmentOperationReceipt => {
    loadTask(db, envelope, taskId);
    const before = loadOperation(db, envelope, taskId);
    assertVersion(before, expected);
    if (before.state !== 'paused') {
      throw new FulfillmentOperationError(
        'ILLEGAL_TRANSITION',
        `Cannot retry fulfillment task ${taskId} from state ${before.state}; only a paused thread may retry. ` +
          'A handed-off thread stays fenced until the owner releases it. Nothing was changed.',
        409,
      );
    }
    const at = clock(input);
    const after = persist(db, before, { state: 'active', retry_count: before.retry_count + 1 }, at);
    const proof = writeReceipt(db, after, 'retry', before.state, ownerId, at);
    return {
      taskId,
      step: 'retry',
      fromState: before.state,
      toState: after.state,
      stateVersion: after.state_version,
      ownerId,
      proof,
      idempotentReplay: false,
    };
  });
  return apply();
}

/** Hand the thread to a human owner. The bot is fenced until an explicit release. */
export function handoffFulfillment(
  envelope: FulfillmentControlEnvelope,
  taskId: string,
  input: HandoffInput,
  db: DatabaseType.Database = getDb(),
): FulfillmentOperationReceipt {
  requireScope(envelope);
  const ownerId = requireOwner(envelope);
  const expected = requireExpectedVersion(input);
  const field = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  const targetOwnerId = field(input.targetOwnerId);
  const backupOwnerId = field(input.backupOwnerId);
  const dueAction = field(input.dueAction);
  const context = field(input.context);
  if (!targetOwnerId || !backupOwnerId || !dueAction || !context) {
    throw new FulfillmentOperationError(
      'HANDOFF_INCOMPLETE',
      'A handoff requires the accepted owner, a backup owner, the due action and the context. Nothing was changed.',
      400,
    );
  }
  if (targetOwnerId === ownerId || backupOwnerId === targetOwnerId) {
    throw new FulfillmentOperationError(
      'HANDOFF_INCOMPLETE',
      'A handoff must name a different accepted owner and a distinct backup owner. Nothing was changed.',
      400,
    );
  }
  const apply = db.transaction((): FulfillmentOperationReceipt => {
    loadTask(db, envelope, taskId);
    const before = loadOperation(db, envelope, taskId);
    assertVersion(before, expected);
    if (before.state === 'handed_off') {
      throw new FulfillmentOperationError(
        'ILLEGAL_TRANSITION',
        `Fulfillment task ${taskId} is already handed off; the bot stays fenced. Nothing was changed.`,
        409,
      );
    }
    const at = clock(input);
    const after = persist(
      db,
      before,
      {
        state: 'handed_off',
        handoff_owner_id: targetOwnerId,
        handoff_backup_owner_id: backupOwnerId,
        handoff_due_action: dueAction,
        handoff_context: context,
      },
      at,
    );
    const proof = writeReceipt(db, after, 'handoff', before.state, ownerId, at);
    return {
      taskId,
      step: 'handoff',
      fromState: before.state,
      toState: after.state,
      stateVersion: after.state_version,
      ownerId,
      proof,
      idempotentReplay: false,
    };
  });
  return apply();
}
