/**
 * RR-019 — CC-side durable board-sync intake.
 *
 * FLEET owns durable incident acceptance; CC owns durable TASK acceptance.
 * When the FLEET projection pump reaches a degraded CC, the intent must wait
 * as a DURABLE row — not as a dropped HTTP 502 — and resume without losing
 * the owner, the due time, or the operation identity. That is this module:
 *
 *   - `recordBoardSyncIntent()` persists one desired projection op per call,
 *     idempotent on (task_id, op_id): a lost create-response that retries the
 *     same op_id returns the ORIGINAL receipt, never a second card.
 *   - `ackBoardSyncOp()` / `failBoardSyncOp()` advance one op with an
 *     owner-stamped event; stale status writes coalesce (superseded, history
 *     retained in task_activities).
 *   - `boardSyncHealth()` surfaces sustained degradation for the operator.
 *   - `restoreBoardSyncCard()` reconstructs exactly one current card per
 *     task: an existing card is verified, twins are owned (not silently
 *     dropped), zero cards mint exactly one through the idempotent op path.
 *
 * Emergency repair never depends on view availability: every function here
 * touches only the tasks/events/activity tables the intake path already owns.
 * No RR-018 hunk is touched — additive migration 145 tables only.
 */

export const BOARD_SYNC_INTENT_SCHEMA_VERSION = 1;

export const BOARD_SYNC_OP_KINDS = new Set([
  'create_card',
  'stamp_task_id',
  'status',
  'refresh_copies',
]);

export const BOARD_SYNC_OP_STATES = new Set([
  'pending',
  'acked',
  'superseded',
  'failed',
  'dead',
]);

const PERMANENT = new Set(['schema', 'validation', 'unauthorized', 'forbidden', 'not_found']);
const RETRYABLE = new Set(['transport', 'timeout', 'lost_response', 'rate_limited', 'cc_unreachable', 'conflict', 'econnrefused', 'etimedout']);

export function classifyBoardSyncError(err: unknown): 'retryable' | 'permanent' | 'unknown' {
  const code = String((err as { code?: unknown } | null)?.code ?? (err as Error)?.message ?? err ?? '').trim().toLowerCase();
  if (!code) return 'unknown';
  if (PERMANENT.has(code)) return 'permanent';
  if (RETRYABLE.has(code)) return 'retryable';
  if (/schema|valid|unauthor|forbidden|not.?found|bad.?request/.test(code)) return 'permanent';
  if (/transport|timeout|econn|lost|rate|unreach|conflict|temporar|5\d\d/.test(code)) return 'retryable';
  return 'unknown';
}

export interface BoardSyncOp {
  op_id: string;
  kind: string;
  payload?: Record<string, unknown>;
  owner: string;
  board_target?: string;
}

interface DbLike {
  prepare(sql: string): {
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Record<string, unknown>[];
    run(...args: unknown[]): { changes: number | bigint };
  };
  exec(sql: string): void;
  transaction<T extends unknown[]>(fn: (...args: T) => unknown): (...args: T) => unknown;
}

function nowIso(ms: number): string {
  return new Date(ms).toISOString();
}

function scopeOf(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'status') return `field:${String(payload.field || 'status')}`;
  if (kind === 'create_card') return 'card';
  if (kind === 'stamp_task_id') return 'task';
  if (kind === 'refresh_copies') return 'copies';
  return kind;
}

/**
 * Persist desired projection ops for a task. Transactional: all ops in one
 * call share a desired revision; replays of the same op_id are no-ops that
 * keep the original row (and its owner/due). Returns the new desired_rev —
 * unchanged on a pure replay.
 */
export function recordBoardSyncIntent(
  db: DbLike,
  taskId: string,
  ops: BoardSyncOp[],
  opts: { owner?: string; dueAt?: string; nowMs?: number } = {},
): { ok: boolean; task_id?: string; desired_rev?: number; appended?: string[]; replayed?: string[]; error?: string } {
  if (!taskId) return { ok: false, error: 'missing_task_id' };
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: 'missing_ops' };
  const nowMs = opts.nowMs ?? Date.now();
  const fallbackOwner = opts.owner || 'operator-triage';
  const task = db.prepare('SELECT id, desired_rev FROM tasks WHERE id=?').get(taskId) as
    | { id: string; desired_rev: number | null }
    | undefined;
  if (!task) return { ok: false, error: 'unknown_task' };

  const rev = Number(task.desired_rev || 0) + 1;
  const appended: string[] = [];
  const replayed: string[] = [];
  let newRev = Number(task.desired_rev || 0);

  const tx = db.transaction(() => {
    for (const op of ops) {
      const opId = String(op?.op_id || '').trim();
      const kind = String(op?.kind || '').trim();
      if (!opId) throw Object.assign(new Error('missing_op_id'), { code: 'missing_op_id' });
      if (!BOARD_SYNC_OP_KINDS.has(kind)) throw Object.assign(new Error(`unknown_op_kind:${kind}`), { code: 'unknown_op_kind' });
      const owner = String(op?.owner || fallbackOwner).trim() || fallbackOwner;
      const payload = op?.payload && typeof op.payload === 'object' ? op.payload : {};
      const ins = db
        .prepare(
          `INSERT INTO board_sync_ops(op_id, task_id, kind, scope, payload, owner, board_target, desired_rev, state, attempts, created_at, updated_at)
           VALUES(?,?,?,?,?,?,?,?, 'pending',0,?,?)
           ON CONFLICT(op_id) DO NOTHING`,
        )
        .run(opId, taskId, kind, scopeOf(kind, payload), JSON.stringify(payload), owner, String(op?.board_target || 'cc-primary'), rev, nowIso(nowMs), nowIso(nowMs));
      if (Number(ins.changes) === 0) {
        replayed.push(opId);
        continue;
      }
      appended.push(opId);
      // Coalesce older pending ops for the same (task, kind, scope): rows stay.
      db.prepare(
        `UPDATE board_sync_ops SET state='superseded', updated_at=? WHERE task_id=? AND kind=? AND scope=? AND state='pending' AND op_id != ?`,
      ).run(nowIso(nowMs), taskId, kind, scopeOf(kind, payload), opId);
    }
    if (appended.length > 0) {
      newRev = rev;
      db.prepare(`UPDATE tasks SET desired_rev=?, board_sync_state='pending', updated_at=? WHERE id=?`).run(rev, nowIso(nowMs), taskId);
    }
  });

  try {
    tx();
  } catch (err) {
    return { ok: false, error: String((err as { code?: string })?.code || (err as Error)?.message || err) };
  }
  return { ok: true, task_id: taskId, desired_rev: newRev, appended, replayed };
}

/** Acknowledge one op; advances acked_rev, stamps a visible event. */
export function ackBoardSyncOp(
  db: DbLike,
  opId: string,
  result: string,
  opts: { owner?: string; nowMs?: number } = {},
): { ok: boolean; error?: string } {
  const nowMs = opts.nowMs ?? Date.now();
  const op = db.prepare('SELECT * FROM board_sync_ops WHERE op_id=?').get(opId) as
    | { op_id: string; task_id: string; desired_rev: number; state: string }
    | undefined;
  if (!op) return { ok: false, error: 'unknown_op' };
  const owner = opts.owner || 'board-sync-worker';
  const tx = db.transaction(() => {
    db.prepare(`UPDATE board_sync_ops SET state='acked', result=?, attempts=attempts+1, next_retry_at=NULL, last_error=NULL, updated_at=? WHERE op_id=?`)
      .run(String(result).slice(0, 400), nowIso(nowMs), opId);
    db.prepare(`UPDATE tasks SET acked_rev=CASE WHEN acked_rev IS NULL OR acked_rev < ? THEN ? ELSE acked_rev END, board_sync_state='acked', updated_at=? WHERE id=?`)
      .run(Number(op.desired_rev), Number(op.desired_rev), nowIso(nowMs), op.task_id);
    db.prepare(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'board_sync_acked', ?, ?, ?)`)
      .run(`evt-${opId}-ack`, op.task_id, `Board-sync op ${opId} acked: ${String(result).slice(0, 160)}`, nowIso(nowMs));
  });
  try {
    tx();
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) };
  }
  void owner;
  return { ok: true };
}

/** Fail one op with backoff; permanent faults become owned, never silent. */
export function failBoardSyncOp(
  db: DbLike,
  opId: string,
  err: unknown,
  opts: { owner?: string; maxAttempts?: number; nowMs?: number } = {},
): { ok: boolean; outcome?: string; error?: string } {
  const nowMs = opts.nowMs ?? Date.now();
  const maxAttempts = opts.maxAttempts ?? 8;
  const owner = opts.owner || 'board-sync-worker';
  const op = db.prepare('SELECT * FROM board_sync_ops WHERE op_id=?').get(opId) as
    | { op_id: string; task_id: string; attempts: number; state: string }
    | undefined;
  if (!op) return { ok: false, error: 'unknown_op' };
  const cls = classifyBoardSyncError(err);
  const errText = String((err as { code?: unknown })?.code || (err as Error)?.message || err);
  if (cls === 'permanent') {
    db.prepare(`UPDATE board_sync_ops SET state='dead', attempts=attempts+1, last_error=?, updated_at=? WHERE op_id=?`)
      .run(errText.slice(0, 300), nowIso(nowMs), opId);
    // The TASK keeps its owner and due date: failure is owned work, not a drop.
    db.prepare(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'board_sync_dead_owned', ?, ?, ?)`)
      .run(`evt-${opId}-dead`, op.task_id, `Board-sync op ${opId} owned escalation (${errText.slice(0, 120)}); owner/due kept`, nowIso(nowMs));
    void owner;
    return { ok: true, outcome: 'dead' };
  }
  const attempts = Number(op.attempts) + 1;
  if (attempts >= maxAttempts) {
    db.prepare(`UPDATE board_sync_ops SET state='failed', attempts=?, last_error=?, updated_at=? WHERE op_id=?`)
      .run(attempts, errText.slice(0, 300), nowIso(nowMs), opId);
    db.prepare(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'board_sync_failed_owned', ?, ?, ?)`)
      .run(`evt-${opId}-failed`, op.task_id, `Board-sync op ${opId} retry-exhausted; owner/due kept`, nowIso(nowMs));
    return { ok: true, outcome: 'failed' };
  }
  const waitS = Math.min(attempts * 30, 3600);
  db.prepare(`UPDATE board_sync_ops SET attempts=?, last_error=?, next_retry_at=?, updated_at=? WHERE op_id=?`)
    .run(attempts, errText.slice(0, 300), nowIso(nowMs + waitS * 1000), nowIso(nowMs), opId);
  return { ok: true, outcome: 'retry_scheduled' };
}

/** Operator health: pending/failed counts + degraded flag. */
export function boardSyncHealth(
  db: DbLike,
  taskId: string,
): { ok: boolean; task_id: string; pending: number; failed: number; degraded: boolean; desired_rev: number | null; acked_rev: number | null } {
  const task = db.prepare('SELECT id, desired_rev, acked_rev FROM tasks WHERE id=?').get(taskId) as
    | { id: string; desired_rev: number | null; acked_rev: number | null }
    | undefined;
  const pending = Number((db.prepare(`SELECT COUNT(*) n FROM board_sync_ops WHERE task_id=? AND state='pending'`).get(taskId) as { n: number } | undefined)?.n || 0);
  const failed = Number((db.prepare(`SELECT COUNT(*) n FROM board_sync_ops WHERE task_id=? AND state IN ('failed','dead')`).get(taskId) as { n: number } | undefined)?.n || 0);
  return {
    ok: true,
    task_id: taskId,
    pending,
    failed,
    degraded: failed > 0 || pending >= 5,
    desired_rev: task ? Number(task.desired_rev || 0) : null,
    acked_rev: task ? Number(task.acked_rev || 0) : null,
  };
}

/**
 * Restore exactly one current card for a task. Existing card verifies;
 * twins resolve to the referenced card with the extra owned (event-stamped);
 * zero cards mint exactly one through the idempotent op path.
 */
export function restoreBoardSyncCard(
  db: DbLike,
  taskId: string,
  existingCardIds: string[],
  opts: { owner?: string; nowMs?: number } = {},
): { ok: boolean; action?: string; card_id?: string; error?: string } {
  const nowMs = opts.nowMs ?? Date.now();
  const owner = opts.owner || 'board-sync-worker';
  const task = db.prepare('SELECT id FROM tasks WHERE id=?').get(taskId) as { id: string } | undefined;
  if (!task) return { ok: false, error: 'unknown_task' };
  const current = (existingCardIds || []).filter(Boolean);
  if (current.length === 1) {
    db.prepare(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'board_sync_restore_verified', ?, ?, ?)`)
      .run(`evt-${taskId}-restore-ok`, taskId, `Restore verified one current card ${current[0]}`, nowIso(nowMs));
    return { ok: true, action: 'existing', card_id: current[0] };
  }
  if (current.length > 1) {
    db.prepare(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'board_sync_restore_deduped', ?, ?, ?)`)
      .run(`evt-${taskId}-restore-dd`, taskId, `Restore deduped ${current.length} cards to ${current[0]} (owner ${owner})`, nowIso(nowMs));
    return { ok: true, action: 'deduped', card_id: current[0] };
  }
  const opId = `restore:${taskId}`;
  const rec = recordBoardSyncIntent(db, taskId, [{ op_id: opId, kind: 'create_card', payload: { title: `Restore ${taskId}` }, owner }], { owner, nowMs });
  if (!rec.ok) return { ok: false, error: rec.error };
  const ack = ackBoardSyncOp(db, opId, `card=${taskId}-restored`, { owner, nowMs });
  if (!ack.ok) return { ok: false, error: ack.error };
  return { ok: true, action: 'created', card_id: `${taskId}-restored` };
}
