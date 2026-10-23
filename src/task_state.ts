/**
 * task_state.ts — W11B: Command Center consumer/UI task state and
 * concurrent-update handling for the GHL board (GHL-DELIVERY-SPEC.md,
 * "Command Center (W11)" + "Board events (W11 contract)").
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The pure, side-effect-free state layer shared by the Command Center consumer
 * routes and the board UI. It models parent+child tasks with stable IDs,
 * applies producer board events idempotently, and makes simultaneous updates
 * safe: a stale or concurrent write can NEVER overwrite newer state.
 *
 * It does NOT own:
 *   - the wire/event schema (W11A owns the normative version; `BoardEventInput`
 *     is this consumer's projection of it and must be reconciled when W11A
 *     lands — PROVISIONAL INTEGRATION, see W11B note below).
 *   - the DB status gate (src/lib/task-lifecycle.ts transition() remains THE
 *     sole status gate for persisted rows; this module guards the consumer/UI
 *     projection and the rollup invariants only).
 *   - the durable outbox (W11C). Instead applyEvent() returns
 *     `shouldEmitEffects` so a board retry never re-fires downstream GHL
 *     writes or purchases: effects are emitted on FIRST application only.
 *
 * HARD INVARIANTS (spec, Command Center section)
 * ---------------------------------------------
 *  1. "A completed page cannot complete the site" — completing one child never
 *     completes its parent; a parent 'complete' event is accepted only when
 *     EVERY child is already done.
 *  2. "A blocked branch cannot erase finished work" — 'block' never touches a
 *     done task (done is terminal; reopen is the only way out and is an
 *     explicit, flag-guarded act), never un-completes siblings, and never
 *     rolls a completed parent back.
 *  3. "simultaneous updates never overwrite newer state" — per-task monotonic
 *     producer `seq` plus consumer CAS `revision`. A lower seq that has not
 *     been applied before is rejected as stale; a write carrying a stale
 *     expected revision is rejected as a conflict with zero state change.
 *  4. "idempotent events" — an event replayed by its idempotency key applies
 *     zero additional change and emits zero effects.
 *
 * COUNTS
 * ------
 * progressCounts() shows the five spec-mandated measures SEPARATELY —
 * code built / remote-incorporated / configured-object / published /
 * owner-accepted — each with an explicit denominator and with scope additions
 * tracked apart from the baseline scope (a scope that grows is never silently
 * re-based into an earlier count).
 *
 * STATUS UNION
 * ------------
 * LOCKSTEP: mirrors the canonical 10-status TaskStatus union in
 * src/lib/types.ts:24 (same pattern as src/app/api/tasks/[id]/status/route.ts).
 * Keep in sync. Import is type-only, so this module runs standalone under
 * `tsx`/`node` with zero runtime dependencies.
 */

import type { TaskStatus } from './lib/types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Producer lifecycle event kinds (W11 board-events contract surface). */
export type EventKind = 'create' | 'assign' | 'start' | 'block' | 'complete';

/** The five spec-mandated delivery measures, reported SEPARATELY. */
export type DeliveryStage =
  | 'code_built'
  | 'remote_incorporated'
  | 'configured_object'
  | 'published'
  | 'owner_accepted';

export const DELIVERY_STAGES: readonly DeliveryStage[] = [
  'code_built',
  'remote_incorporated',
  'configured_object',
  'published',
  'owner_accepted',
];

/**
 * Consumer-side projection of a producer board event.
 *
 * PROVISIONAL INTEGRATION (W11B): W11A owns the normative wire schema. This
 * shape carries exactly what the consumer/UI state needs — stable task id,
 * idempotency key, producer-monotonic seq — and must be closed against W11A's
 * contract when that unit lands. Nothing here invents wire fields beyond that
 * minimum.
 */
export interface BoardEventInput {
  /** Stable idempotency key. Replaying the same key never re-applies. */
  idempotencyKey: string;
  /** Stable task ID (create/reuse key). */
  taskId: string;
  kind: EventKind;
  /** Producer-monotonic sequence per task. Must strictly increase to apply. */
  seq: number;
  /** For kind 'create': parent task id (stable), null/undefined for root tasks. */
  parentTaskId?: string | null;
  title?: string;
  actor?: string;
  note?: string;
  /** Optional delivery-stage advance carried with this event. Monotonic. */
  stage?: DeliveryStage;
  at?: string;
}

export interface TaskRecord {
  id: string;
  parentTaskId: string | null;
  title: string;
  status: TaskStatus;
  /** Consumer CAS revision: bumps on EVERY applied change, nothing else. */
  revision: number;
  /** Highest producer seq applied to this task. */
  lastSeq: number;
  /** Delivery stages reached (monotonic — only ever grows). */
  stages: DeliveryStage[];
  createdAt: string;
  updatedAt: string;
}

export type EventOutcome = 'applied' | 'duplicate' | 'rejected';

export type RejectReason =
  | 'unknown_task'
  | 'id_exists'
  | 'bad_parent'
  | 'self_parent'
  | 'stale_seq'
  | 'terminal_no_erase'
  | 'children_incomplete'
  | 'bad_input';

export interface EventApplyResult {
  outcome: EventOutcome;
  reason?: RejectReason;
  /** Post-state of the task (copy), when the task exists. */
  task?: TaskRecord;
  /**
   * True ONLY on first application of an idempotency key. A board retry
   * (duplicate) or a rejected event must never re-fire GHL writes or
   * purchases — callers gate side effects on this flag.
   */
  shouldEmitEffects: boolean;
  /** True when kind 'create' actually created the row (false = reuse). */
  created?: boolean;
}

export interface UpdatePatch {
  status?: TaskStatus;
  title?: string;
  stage?: DeliveryStage;
  /**
   * Explicit reopen flag. Without it, any patch that would move a done task
   * off 'done' is rejected — finished work is never erased by an ordinary
   * update (spec invariant 2).
   */
  allowReopen?: boolean;
}

export type UpdateOutcome = 'applied' | 'conflict' | 'rejected';

export interface UpdateResult {
  outcome: UpdateOutcome;
  reason?: RejectReason | 'stale_revision';
  task?: TaskRecord;
  /** On conflict: the revision actually observed, so the UI can re-read. */
  currentRevision?: number;
}

export interface ParentCompletionCheck {
  ok: boolean;
  incompleteChildren: string[];
}

export interface StageCount {
  reached: number;
  /** Explicit denominator for this measure (same scope as the others). */
  denominator: number;
}

export interface ProgressCounts {
  scope: {
    /** Explicit denominator: tasks currently in scope. */
    denominator: number;
    /** Scope size frozen at the first count — the baseline denominator. */
    baseline: number;
    /** Tasks added to scope AFTER the baseline (reported, never folded in). */
    scopeAdditions: number;
  };
  stages: Record<DeliveryStage, StageCount>;
}

export interface MergeConflict {
  id: string;
  reason: 'equal_revision_divergent';
  keptRevision: number;
}

export interface MergeResult {
  tasks: TaskRecord[];
  conflicts: MergeConflict[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────────────

interface CreateInput {
  id: string;
  parentTaskId?: string | null;
  title?: string;
}

export class TaskStateStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly appliedKeys = new Map<string, { taskId: string; seq: number }>();
  private readonly children = new Map<string, Set<string>>();
  private countsBaseline: number | null = null;
  private readonly now: () => string;

  constructor(opts?: { now?: () => string }) {
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  // ── create / reuse (stable IDs, parent+child) ──────────────────────────────

  /**
   * Create-or-reuse a task by stable ID. A repeat call with the same ID never
   * creates a second row and never mutates the existing one (a mismatched
   * parent on reuse is a hard rejection — identity is immutable).
   */
  createOrReuseTask(input: CreateInput): { task: TaskRecord; created: boolean } {
    const id = requireText(input.id, 'id');
    const existing = this.tasks.get(id);
    if (existing) {
      const wantParent = input.parentTaskId ?? null;
      if (wantParent !== existing.parentTaskId) {
        throw new StateError('bad_parent', `task ${id} already exists with parent ${String(existing.parentTaskId)}`);
      }
      return { task: clone(existing), created: false };
    }
    const parentTaskId = input.parentTaskId ?? null;
    if (parentTaskId !== null) {
      if (parentTaskId === id) throw new StateError('self_parent', `task ${id} cannot parent itself`);
      if (!this.tasks.has(parentTaskId)) {
        throw new StateError('bad_parent', `parent ${parentTaskId} does not exist`);
      }
    }
    const at = this.now();
    const record: TaskRecord = {
      id,
      parentTaskId,
      title: input.title ?? '',
      status: 'inbox',
      revision: 1,
      lastSeq: 0,
      stages: [],
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.set(id, record);
    if (parentTaskId !== null) this.linkChild(parentTaskId, id);
    return { task: clone(record), created: true };
  }

  // ── event application (idempotent, seq-monotonic) ─────────────────────────

  /**
   * Apply one producer board event.
   *
   * Order of checks (each fail-closed, zero state change on rejection):
   *   1. malformed input          → rejected 'bad_input'
   *   2. idempotency key seen     → duplicate (zero change, zero effects)
   *   3. unknown task             → rejected 'unknown_task'
   *      (except 'create', which is create-or-reuse)
   *   4. seq not strictly greater → rejected 'stale_seq'
   *   5. terminal/rollup rules    → rejected 'terminal_no_erase' |
   *                                 'children_incomplete'
   */
  applyEvent(ev: BoardEventInput): EventApplyResult {
    if (
      !ev ||
      typeof ev.idempotencyKey !== 'string' || ev.idempotencyKey === '' ||
      typeof ev.taskId !== 'string' || ev.taskId === '' ||
      !isEventKind(ev.kind) ||
      !Number.isInteger(ev.seq) || ev.seq < 1
    ) {
      return { outcome: 'rejected', reason: 'bad_input', shouldEmitEffects: false };
    }

    const seen = this.appliedKeys.get(ev.idempotencyKey);
    if (seen) {
      // Replay: whatever the seq says, a seen key is a no-op.
      return { outcome: 'duplicate', task: this.peek(ev.taskId), shouldEmitEffects: false };
    }

    if (ev.kind === 'create') {
      return this.applyCreateEvent(ev);
    }

    const task = this.tasks.get(ev.taskId);
    if (!task) {
      this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
      return { outcome: 'rejected', reason: 'unknown_task', shouldEmitEffects: false };
    }

    if (ev.seq <= task.lastSeq) {
      // Stale or out-of-order producer event: older state must never
      // overwrite newer state (spec invariant 3).
      this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
      return { outcome: 'rejected', reason: 'stale_seq', task: clone(task), shouldEmitEffects: false };
    }

    switch (ev.kind) {
      case 'assign':
      case 'start': {
        if (task.status === 'done') {
          this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
          return { outcome: 'rejected', reason: 'terminal_no_erase', task: clone(task), shouldEmitEffects: false };
        }
        this.bump(task, ev.seq, (r) => {
          r.status = ev.kind === 'assign' ? 'assigned' : 'in_progress';
        }, ev);
        return { outcome: 'applied', task: clone(task), shouldEmitEffects: true };
      }
      case 'block': {
        if (task.status === 'done') {
          // Blocked branch cannot erase finished work.
          this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
          return { outcome: 'rejected', reason: 'terminal_no_erase', task: clone(task), shouldEmitEffects: false };
        }
        this.bump(task, ev.seq, (r) => {
          r.status = 'blocked';
        }, ev);
        return { outcome: 'applied', task: clone(task), shouldEmitEffects: true };
      }
      case 'complete': {
        const check = this.canComplete(task);
        if (!check.ok) {
          // A completed page cannot complete the site.
          this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
          return { outcome: 'rejected', reason: 'children_incomplete', task: clone(task), shouldEmitEffects: false };
        }
        if (task.status === 'done') {
          // Already terminal; only a replay (seen key) may repeat, and that is
          // handled above. A fresh key on a done task is not a state change.
          this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
          return { outcome: 'rejected', reason: 'terminal_no_erase', task: clone(task), shouldEmitEffects: false };
        }
        this.bump(task, ev.seq, (r) => {
          r.status = 'done';
        }, ev);
        return { outcome: 'applied', task: clone(task), shouldEmitEffects: true };
      }
    }
  }

  private applyCreateEvent(ev: BoardEventInput): EventApplyResult {
    const existing = this.tasks.get(ev.taskId);
    if (existing) {
      // Create-or-reuse with stable ID: never a second row, never a mutation.
      // No seq consumption — a reuse is not a state change.
      this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
      return { outcome: 'applied', task: clone(existing), shouldEmitEffects: false, created: false };
    }
    const parentTaskId = ev.parentTaskId ?? null;
    if (parentTaskId !== null) {
      if (parentTaskId === ev.taskId) {
        this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
        return { outcome: 'rejected', reason: 'self_parent', shouldEmitEffects: false };
      }
      if (!this.tasks.has(parentTaskId)) {
        this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
        return { outcome: 'rejected', reason: 'bad_parent', shouldEmitEffects: false };
      }
    }
    const at = ev.at ?? this.now();
    const record: TaskRecord = {
      id: ev.taskId,
      parentTaskId,
      title: ev.title ?? '',
      status: 'inbox',
      revision: 1,
      lastSeq: ev.seq,
      stages: ev.stage ? [ev.stage] : [],
      createdAt: at,
      updatedAt: at,
    };
    this.tasks.set(ev.taskId, record);
    if (parentTaskId !== null) this.linkChild(parentTaskId, ev.taskId);
    this.rememberKey(ev.idempotencyKey, ev.taskId, ev.seq);
    return { outcome: 'applied', task: clone(record), shouldEmitEffects: true, created: true };
  }

  // ── concurrent updates (CAS revision) ─────────────────────────────────────

  /**
   * Apply a UI/consumer patch under compare-and-swap. `expectedRevision` is
   * what the caller last observed; if the store has moved on, the result is
   * `conflict` with the current revision and ZERO state change — a
   * simultaneous update never overwrites newer state.
   */
  updateTask(id: string, patch: UpdatePatch, expectedRevision: number): UpdateResult {
    const task = this.tasks.get(id);
    if (!task) return { outcome: 'rejected', reason: 'unknown_task' };
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
      return { outcome: 'rejected', reason: 'bad_input', task: clone(task) };
    }
    if (task.revision !== expectedRevision) {
      return { outcome: 'conflict', reason: 'stale_revision', task: clone(task), currentRevision: task.revision };
    }
    if (patch.status !== undefined && patch.status === task.status && patch.title === undefined && patch.stage === undefined) {
      return { outcome: 'applied', task: clone(task) }; // no-op, revision unchanged
    }
    if (
      task.status === 'done' &&
      patch.status !== undefined &&
      patch.status !== 'done' &&
      patch.allowReopen !== true
    ) {
      return { outcome: 'rejected', reason: 'terminal_no_erase', task: clone(task), currentRevision: task.revision };
    }
    const at = this.now();
    task.revision += 1;
    task.updatedAt = at;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.stage !== undefined) this.addStage(task, patch.stage);
    return { outcome: 'applied', task: clone(task) };
  }

  // ── rollup invariants ─────────────────────────────────────────────────────

  /**
   * "A completed page cannot complete the site": a parent may complete only
   * when every child is done. Returns the offending children so the UI can say
   * which page is still open.
   */
  canCompleteParent(parentId: string): ParentCompletionCheck {
    const task = this.tasks.get(parentId);
    if (!task) return { ok: false, incompleteChildren: [] };
    return this.canComplete(task);
  }

  private canComplete(task: TaskRecord): ParentCompletionCheck {
    const kids = this.children.get(task.id);
    if (!kids || kids.size === 0) return { ok: true, incompleteChildren: [] };
    const incomplete: string[] = [];
    for (const childId of kids) {
      const child = this.tasks.get(childId);
      if (child && child.status !== 'done') incomplete.push(childId);
    }
    incomplete.sort();
    return { ok: incomplete.length === 0, incompleteChildren: incomplete };
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  getTask(id: string): TaskRecord | undefined {
    return this.peek(id);
  }

  listChildren(parentId: string): TaskRecord[] {
    const kids = this.children.get(parentId);
    if (!kids) return [];
    return [...kids].sort().map((id) => clone(this.tasks.get(id)!));
  }

  snapshot(): TaskRecord[] {
    return [...this.tasks.keys()].sort().map((id) => clone(this.tasks.get(id)!));
  }

  // ── counts (five separate measures, explicit denominators) ────────────────

  /**
   * Spec: "Show separate counts: code built / remote-inccorporated /
   * configured-object / published / owner-accepted, with explicit
   * denominators and scope additions." Each stage counts tasks that have
   * REACHED it; the denominator is the current scope size and is printed for
   * every measure. Scope additions after the first count are reported apart
   * from the baseline so growth never quietly re-bases an earlier number.
   */
  progressCounts(): ProgressCounts {
    const denominator = this.tasks.size;
    if (this.countsBaseline === null) this.countsBaseline = denominator;
    const baseline = this.countsBaseline;
    const stages = {} as Record<DeliveryStage, StageCount>;
    for (const stage of DELIVERY_STAGES) {
      let reached = 0;
      for (const task of this.tasks.values()) {
        if (task.stages.includes(stage)) reached += 1;
      }
      stages[stage] = { reached, denominator };
    }
    return {
      scope: { denominator, baseline, scopeAdditions: denominator - baseline },
      stages,
    };
  }

  // ── UI sync (multi-writer merge, newer revision wins) ─────────────────────

  /**
   * Merge two snapshots of the same board (e.g. two open UI tabs, or a UI
   * refresh racing a producer write). Per task the HIGHER revision wins; a
   * lower revision can never overwrite it. Equal revisions with divergent
   * content are kept local and reported as a conflict — never silently
   * overwritten either way.
   */
  static mergeSnapshots(local: TaskRecord[], incoming: TaskRecord[]): MergeResult {
    const byId = new Map<string, TaskRecord>();
    for (const t of local) byId.set(t.id, clone(t));
    const conflicts: MergeConflict[] = [];
    for (const t of incoming) {
      const cur = byId.get(t.id);
      if (!cur) {
        byId.set(t.id, clone(t));
        continue;
      }
      if (t.revision > cur.revision) {
        byId.set(t.id, clone(t));
      } else if (t.revision === cur.revision && !sameContent(cur, t)) {
        conflicts.push({ id: t.id, reason: 'equal_revision_divergent', keptRevision: cur.revision });
      }
      // t.revision < cur.revision → incoming is stale, dropped (invariant 3).
    }
    return { tasks: [...byId.keys()].sort().map((id) => byId.get(id)!), conflicts };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private bump(
    task: TaskRecord,
    seq: number,
    mutate: (r: TaskRecord) => void,
    ev: BoardEventInput,
  ): void {
    task.revision += 1;
    task.lastSeq = seq;
    task.updatedAt = ev.at ?? this.now();
    mutate(task);
    if (ev.stage) this.addStage(task, ev.stage);
    this.rememberKey(ev.idempotencyKey, ev.taskId, seq);
  }

  private addStage(task: TaskRecord, stage: DeliveryStage): void {
    if (!task.stages.includes(stage)) task.stages.push(stage);
  }

  private linkChild(parentId: string, childId: string): void {
    let set = this.children.get(parentId);
    if (!set) {
      set = new Set<string>();
      this.children.set(parentId, set);
    }
    set.add(childId);
  }

  private rememberKey(key: string, taskId: string, seq: number): void {
    this.appliedKeys.set(key, { taskId, seq });
  }

  private peek(id: string): TaskRecord | undefined {
    const t = this.tasks.get(id);
    return t ? clone(t) : undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export class StateError extends Error {
  readonly reason: RejectReason;
  constructor(reason: RejectReason, message: string) {
    super(message);
    this.name = 'StateError';
    this.reason = reason;
  }
}

function isEventKind(k: unknown): k is EventKind {
  return k === 'create' || k === 'assign' || k === 'start' || k === 'block' || k === 'complete';
}

function requireText(v: string, field: string): string {
  if (typeof v !== 'string' || v === '') throw new StateError('bad_input', `${field} must be a non-empty string`);
  return v;
}

function clone(t: TaskRecord): TaskRecord {
  return { ...t, stages: [...t.stages] };
}

function sameContent(a: TaskRecord, b: TaskRecord): boolean {
  return (
    a.status === b.status &&
    a.title === b.title &&
    a.parentTaskId === b.parentTaskId &&
    a.lastSeq === b.lastSeq &&
    a.stages.length === b.stages.length &&
    a.stages.every((s, i) => s === b.stages[i])
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-check (assert-based, zero dependencies) — run:
//   npx tsx src/task_state.ts --selfcheck
// Success prints one OK line and exits 0; any failed assertion exits 1.
// ─────────────────────────────────────────────────────────────────────────────

class Check {
  private n = 0;
  ok(cond: boolean, label: string): void {
    this.n += 1;
    if (!cond) throw new Error(`ASSERTION ${this.n} FAILED: ${label}`);
  }
  eq<T>(got: T, want: T, label: string): void {
    this.ok(got === want, `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
  get count(): number {
    return this.n;
  }
}

export function runSelfCheck(): void {
  const c = new Check();
  let tick = 0;
  const store = new TaskStateStore({ now: () => `2026-10-23T00:00:${String(tick++).padStart(2, '0')}.000Z` });

  // ── 1. create / reuse with stable IDs, parent+child ───────────────────────
  const root = store.createOrReuseTask({ id: 'site-1', title: 'Site' });
  c.ok(root.created, '1a first create returns created=true');
  c.eq(root.task.status, 'inbox', '1b fresh task starts at inbox');
  c.eq(root.task.revision, 1, '1c fresh task revision is 1');
  const reuse = store.createOrReuseTask({ id: 'site-1' });
  c.ok(!reuse.created, '1d reuse with same ID does not create');
  c.eq(reuse.task.revision, 1, '1e reuse does not mutate (revision unchanged)');

  const pageA = store.createOrReuseTask({ id: 'page-a', parentTaskId: 'site-1', title: 'Page A' });
  const pageB = store.createOrReuseTask({ id: 'page-b', parentTaskId: 'site-1', title: 'Page B' });
  c.ok(pageA.created && pageB.created, '2a children created under parent');
  c.eq(store.listChildren('site-1').length, 2, '2b parent lists both children');

  let threw = '';
  try {
    store.createOrReuseTask({ id: 'page-a', parentTaskId: 'other' });
  } catch (e) {
    threw = (e as StateError).reason;
  }
  c.eq(threw, 'bad_parent', '2c reuse with different parent rejected');

  threw = '';
  try {
    store.createOrReuseTask({ id: 'orphan', parentTaskId: 'missing-parent' });
  } catch (e) {
    threw = (e as StateError).reason;
  }
  c.eq(threw, 'bad_parent', '2d child with unknown parent rejected');

  threw = '';
  try {
    store.createOrReuseTask({ id: 'self', parentTaskId: 'self' });
  } catch (e) {
    threw = (e as StateError).reason;
  }
  c.eq(threw, 'self_parent', '2e self-parent rejected');

  // ── 2. idempotent events ─────────────────────────────────────────────────
  const ev1 = store.applyEvent({
    idempotencyKey: 'k-assign-a', taskId: 'page-a', kind: 'assign', seq: 1, actor: 'cc_board',
  });
  c.eq(ev1.outcome, 'applied', '3a first application applied');
  c.ok(ev1.shouldEmitEffects, '3b first application emits effects');
  c.eq(ev1.task?.status, 'assigned', '3c assign maps to assigned');

  const ev1Replay = store.applyEvent({
    idempotencyKey: 'k-assign-a', taskId: 'page-a', kind: 'assign', seq: 1, actor: 'cc_board',
  });
  c.eq(ev1Replay.outcome, 'duplicate', '3d replay with same key is duplicate');
  c.ok(!ev1Replay.shouldEmitEffects, '3e replay emits zero effects (no repeated GHL writes)');
  c.eq(ev1Replay.task?.revision, 2, '3f replay changed nothing (revision still 2)');

  // ── 3. seq monotonicity — stale events never overwrite newer state ───────
  const ev2 = store.applyEvent({ idempotencyKey: 'k-start-a', taskId: 'page-a', kind: 'start', seq: 2 });
  c.eq(ev2.outcome, 'applied', '4a higher seq applies');
  c.eq(ev2.task?.status, 'in_progress', '4b start maps to in_progress');

  const stale = store.applyEvent({ idempotencyKey: 'k-stale-a', taskId: 'page-a', kind: 'block', seq: 2 });
  c.eq(stale.outcome, 'rejected', '4c equal seq with fresh key rejected');
  c.eq(stale.reason, 'stale_seq', '4d rejection reason is stale_seq');
  c.eq(stale.task?.status, 'in_progress', '4e stale event did not overwrite newer state');

  const older = store.applyEvent({ idempotencyKey: 'k-older-a', taskId: 'page-a', kind: 'block', seq: 1 });
  c.eq(older.reason, 'stale_seq', '4f lower seq rejected as stale');

  // ── 4. CAS revisions — concurrent updates never overwrite newer state ────
  const snapBefore = JSON.stringify(store.getTask('page-a'));
  const conflict = store.updateTask('page-a', { title: 'from stale tab' }, 2);
  c.eq(conflict.outcome, 'conflict', '5a stale expected revision conflicts');
  c.eq(conflict.reason, 'stale_revision', '5b conflict reason named');
  c.eq(conflict.currentRevision, 3, '5c conflict reports observed revision');
  c.eq(JSON.stringify(store.getTask('page-a')), snapBefore, '5d conflict wrote zero state');

  const okUpdate = store.updateTask('page-a', { title: 'renamed' }, 3);
  c.eq(okUpdate.outcome, 'applied', '5e matching revision applies');
  c.eq(okUpdate.task?.revision, 4, '5f revision bumps on applied change');

  // Two simulated writers race from the same observed revision.
  const w1 = store.updateTask('page-b', { title: 'writer-1' }, 1);
  c.eq(w1.outcome, 'applied', '6a first racer wins');
  const w2 = store.updateTask('page-b', { title: 'writer-2' }, 1);
  c.eq(w2.outcome, 'conflict', '6b second racer conflicts');
  c.eq(store.getTask('page-b')?.title, 'writer-1', '6c loser never overwrote winner');

  // ── 5. rollup: completed page cannot complete the site ───────────────────
  const doneA = store.applyEvent({ idempotencyKey: 'k-done-a', taskId: 'page-a', kind: 'complete', seq: 3 });
  c.eq(doneA.outcome, 'applied', '7a leaf page completes');
  c.eq(doneA.task?.status, 'done', '7b page-a is done');

  const early = store.applyEvent({ idempotencyKey: 'k-done-site-early', taskId: 'site-1', kind: 'complete', seq: 1 });
  c.eq(early.outcome, 'rejected', '7c parent cannot complete while a child is open');
  c.eq(early.reason, 'children_incomplete', '7d reason names incomplete children');
  c.eq(early.task?.status, 'inbox', '7e parent state untouched by failed completion');
  const check = store.canCompleteParent('site-1');
  c.ok(!check.ok, '7f canCompleteParent reports not-ok');
  c.eq(check.incompleteChildren.join(','), 'page-b', '7g incomplete child named');

  const doneB = store.applyEvent({ idempotencyKey: 'k-done-b', taskId: 'page-b', kind: 'complete', seq: 2 });
  c.eq(doneB.outcome, 'applied', '8a second page completes');
  c.ok(store.canCompleteParent('site-1').ok, '8b parent completable once every child is done');
  const doneSite = store.applyEvent({ idempotencyKey: 'k-done-site', taskId: 'site-1', kind: 'complete', seq: 1 });
  c.eq(doneSite.outcome, 'applied', '8c parent completes when all children done');
  c.eq(doneSite.task?.status, 'done', '8d site is done');

  // ── 6. blocked branch cannot erase finished work ────────────────────────
  const blockDone = store.applyEvent({ idempotencyKey: 'k-block-a', taskId: 'page-a', kind: 'block', seq: 4 });
  c.eq(blockDone.reason, 'terminal_no_erase', '9a block on done task rejected');
  c.eq(store.getTask('page-a')?.status, 'done', '9b done work untouched');

  const lateBlock = store.applyEvent({ idempotencyKey: 'k-block-site', taskId: 'site-1', kind: 'block', seq: 5 });
  c.eq(lateBlock.reason, 'terminal_no_erase', '9c block cannot roll back a completed parent');
  c.eq(store.getTask('site-1')?.status, 'done', '9d parent still done');

  // A blocked NEW branch leaves finished siblings and the completed parent be.
  const pageC = store.createOrReuseTask({ id: 'page-c', parentTaskId: 'site-1', title: 'Page C' });
  c.ok(pageC.created, '10a scope grows with a new child');
  const blockC = store.applyEvent({ idempotencyKey: 'k-block-c', taskId: 'page-c', kind: 'block', seq: 1 });
  c.eq(blockC.outcome, 'applied', '10b live branch may block');
  c.eq(store.getTask('page-c')?.status, 'blocked', '10c page-c blocked');
  c.eq(store.getTask('page-a')?.status, 'done', '10d finished sibling untouched by the block');
  c.eq(store.getTask('site-1')?.status, 'done', '10e completed parent untouched by the block');

  // Explicit reopen is the only way out of done.
  const silentReopen = store.updateTask('page-a', { status: 'in_progress' }, store.getTask('page-a')!.revision);
  c.eq(silentReopen.outcome, 'rejected', '11a done cannot be silently reopened');
  c.eq(silentReopen.reason, 'terminal_no_erase', '11b reason is terminal_no_erase');
  const reopen = store.updateTask(
    'page-a', { status: 'in_progress', allowReopen: true }, store.getTask('page-a')!.revision,
  );
  c.eq(reopen.outcome, 'applied', '11c explicit allowReopen reopens');
  c.eq(reopen.task?.status, 'in_progress', '11d reopened status applied');

  // ── 7. counts: five separate measures, explicit denominators, additions ─
  const counts = store.progressCounts();
  c.eq(counts.scope.denominator, 4, '12a denominator explicit (4 tasks)');
  c.eq(counts.scope.baseline, 4, '12b baseline frozen at first count');
  c.eq(counts.scope.scopeAdditions, 0, '12c no additions yet');
  c.eq(counts.stages.code_built.reached, 0, '12d code_built starts at 0');
  c.eq(counts.stages.published.denominator, 4, '12e every measure carries the explicit denominator');

  store.applyEvent({
    idempotencyKey: 'k-stage-a', taskId: 'page-a', kind: 'start', seq: 6, stage: 'code_built',
  });
  // Stages advance monotonically even on done tasks (owner-accepted lands
  // after completion) — via the CAS update surface, not a lifecycle event.
  store.updateTask('page-b', { stage: 'code_built' }, store.getTask('page-b')!.revision);
  store.updateTask('page-b', { stage: 'published' }, store.getTask('page-b')!.revision);
  const counts2 = store.progressCounts();
  c.eq(counts2.stages.code_built.reached, 2, '13a code_built reached by 2 tasks');
  c.eq(counts2.stages.published.reached, 1, '13b published reported SEPARATELY from code_built');
  c.eq(counts2.stages.owner_accepted.reached, 0, '13c owner_accepted stays its own measure');
  c.eq(counts2.scope.denominator, 4, '13d denominator unchanged');

  store.createOrReuseTask({ id: 'page-d', parentTaskId: 'site-1', title: 'Page D' });
  const counts3 = store.progressCounts();
  c.eq(counts3.scope.denominator, 5, '14a scope grew');
  c.eq(counts3.scope.baseline, 4, '14b baseline still the frozen first count');
  c.eq(counts3.scope.scopeAdditions, 1, '14c scope addition reported apart, not folded in');
  c.eq(counts3.stages.published.denominator, 5, '14d denominators stay explicit as scope grows');

  // Stage monotonicity: re-adding is a no-op.
  store.updateTask('page-b', { stage: 'code_built' }, store.getTask('page-b')!.revision);
  c.eq(store.getTask('page-b')!.stages.filter((s) => s === 'code_built').length, 1, '15a stages never duplicate');

  // ── 8. snapshot merge: newer revision wins, never the reverse ───────────
  const localSnap = store.snapshot();
  const incoming = localSnap.map((t) => ({ ...t, stages: [...t.stages] }));
  const target = incoming.find((t) => t.id === 'page-b')!;
  target.title = 'from other tab';
  target.revision = store.getTask('page-b')!.revision + 3;
  const merged = TaskStateStore.mergeSnapshots(localSnap, incoming);
  c.eq(merged.conflicts.length, 0, '16a no conflicts on clean newer revision');
  c.eq(merged.tasks.find((t) => t.id === 'page-b')!.title, 'from other tab', '16b newer revision wins');

  const staleIncoming = localSnap.map((t) => ({ ...t, stages: [...t.stages] }));
  staleIncoming.find((t) => t.id === 'page-b')!.title = 'stale writer';
  staleIncoming.find((t) => t.id === 'page-b')!.revision = 1;
  const merged2 = TaskStateStore.mergeSnapshots(merged.tasks, staleIncoming);
  c.eq(merged2.tasks.find((t) => t.id === 'page-b')!.title, 'from other tab', '16c stale revision never overwrites newer');

  const divergent = localSnap.map((t) => ({ ...t, stages: [...t.stages] }));
  divergent.find((t) => t.id === 'page-b')!.title = 'divergent same-rev write';
  const merged3 = TaskStateStore.mergeSnapshots(localSnap, divergent);
  c.eq(merged3.conflicts.length, 1, '16d equal-revision divergence reported as conflict');
  c.eq(merged3.tasks.find((t) => t.id === 'page-b')!.title, 'writer-1', '16e conflict keeps local, no silent overwrite');

  // ── 9. negative controls — rejections must leave state byte-identical ───
  const before = JSON.stringify(store.snapshot());
  store.applyEvent({ idempotencyKey: 'neg-1', taskId: 'page-a', kind: 'block', seq: 1 });
  store.applyEvent({ idempotencyKey: 'neg-2', taskId: 'ghost', kind: 'complete', seq: 1 });
  store.applyEvent({ idempotencyKey: 'neg-3', taskId: 'site-1', kind: 'complete', seq: 9 });
  store.updateTask('page-a', { status: 'done' }, 999);
  store.applyEvent({ idempotencyKey: '', taskId: 'page-a', kind: 'start', seq: 99 });
  store.applyEvent({
    idempotencyKey: 'neg-5', taskId: 'page-c', kind: 'create', seq: 7, parentTaskId: 'site-1', title: 'dup id',
  });
  c.eq(JSON.stringify(store.snapshot()), before, '17a every rejected/failed path wrote zero state');
  c.eq(store.getTask('page-c')?.title, 'Page C', '17b create-reuse never mutated the existing row');

  // Bad input fails closed.
  const bad = store.applyEvent({ idempotencyKey: 'neg-6', taskId: 'page-a', kind: 'nonsense' as EventKind, seq: 10 });
  c.eq(bad.reason, 'bad_input', '18a unknown event kind rejected');
  const badSeq = store.applyEvent({ idempotencyKey: 'neg-7', taskId: 'page-a', kind: 'start', seq: 0 });
  c.eq(badSeq.reason, 'bad_input', '18b seq < 1 rejected');

  console.log(`OK W11B-U1 task_state self-check: ${c.count} assertions`);
}

// Minimal process accessor so this module compiles standalone (no @types/node
// required) and still runs under Node/tsx in the repo toolchain.
interface ProcLike {
  argv: string[];
  exit(code: number): void;
}
const proc: ProcLike | undefined = (globalThis as { process?: ProcLike }).process;

if (proc && proc.argv.includes('--selfcheck')) {
  try {
    runSelfCheck();
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    proc.exit(1);
  }
}
