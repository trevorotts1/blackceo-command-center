/**
 * execution-contract.ts — RR-018: the SUPPORTED external-rescue execution
 * contract for the Command Center.
 *
 * ── WHY THIS MODULE EXISTS ──────────────────────────────────────────────────
 * The supplied legacy adapter (ONB rescue_cc_board.py:315-382) moves a CC card
 * with `PATCH /api/tasks/{id} {"status":..., "note":...}` — status and prose
 * only. It carries NO execution identity, NO registered deliverable, NO
 * independent-QC actor, and NO structured blocker fields. Against current CC
 * main that is not a weak adapter, it is an UNESTABLISHABLE one: every one of
 * those omissions is a fact a current CC gate either requires or refuses to
 * infer, so a 200 from it proves nothing about the rescue.
 *
 * This module is the supported contract an external rescue flow uses instead.
 * It is deliberately NOT a new route (the U052 write-scope census, the
 * middleware webhook/bearer lists and the U99 raw-status-writer guard all stay
 * exactly as they are): it is a library the ingest door and the operator paths
 * call, and every status it advances goes through the ONE funnel,
 * `transition()` in task-lifecycle.ts.
 *
 * ── THE OBSERVE-VS-EXECUTE CHOICE (RR-018's explicit decision) ──────────────
 * An incident has EXACTLY ONE fixer. CC therefore makes an explicit, recorded
 * choice per incident and persists it on the correlation row:
 *
 *   'external_observed' — an external owner (the Rescue Rangers flow) holds the
 *     fixer. CC tracks correlation, evidence, milestones and projection. It
 *     MUST NOT dispatch a second fixer, and it does not rely on a policy
 *     promise to achieve that: the bind writes `dispatch_hold = 1` with a
 *     structured `routing_reason`, which is the flag FOUR independent dispatch
 *     entry points already refuse on —
 *       • reserveExecution()            (execution-attempts.ts) — refuses on
 *         `task.dispatch_hold` before any execution row is minted;
 *       • beginExecutionSend()          — refuses again at the send boundary;
 *       • autoDispatchTask() GUARD 2    — a master/CEO executor is refused
 *         unless the routing_reason is `[catch-all]` AND the workspace is a
 *         catch-all workspace; this module's marker is neither;
 *       • commitIntakeAssignment() / the intake-advance sweep SQL — CAS on
 *         `COALESCE(dispatch_hold,0)=0` and skip the row entirely.
 *     A second fixer is therefore not "discouraged", it is unreachable from
 *     every door that can start one.
 *
 *   'cc_owned' — CC holds the fixer. This requires a REAL owner: a resolved
 *     department worker, or the scoped General/CEO/operator fallback
 *     (resolveRescueDepartmentOwner below). "No owner" is not a state this
 *     contract can persist — an unowned card is parked as recoverable
 *     operator work with a named next action, never left looking assigned.
 *
 * ── MACHINE FAILURES ARE RECOVERABLE WORK, NOT HUMAN BLOCKERS ───────────────
 * recordStructuredBlocker() takes a class. A 'machine' blocker (transport
 * failure, gateway acknowledgement unknown, missing runtime, board ack lost)
 * is recoverable work: it is recorded with an owner, a requested action and a
 * bounded next retry, and it NEVER sets `blocked_on_human` — because writing a
 * fictional human blocker for a machine fault is a lie that pages a person to
 * do something no person can do. Only a genuine decision/approval/credential
 * need is classed 'human', and that path carries the non-blank `ask` the
 * blocked-ask invariant (migration 104 triggers) already demands.
 */

import { getDb, queryOne, queryAll, run } from '@/lib/db';
import { transition, TransitionError, type LifecycleState } from '@/lib/task-lifecycle';
import { registerDeliverable, type DeliverableRegistration } from '@/lib/task-lifecycle';
import type Database from 'better-sqlite3';
import type { Task } from '@/lib/types';

/** Persisted on every row this contract writes; a projector can refuse a
 *  revision it does not understand instead of guessing at the shape. */
export const RESCUE_EXECUTION_SCHEMA_VERSION = 1;

/** The routing_reason prefix that marks a card CC OBSERVES but does not run.
 *  Deliberately NOT `[catch-all]`: catch-all is the ONE reason that authorizes
 *  a master/CEO to execute, and an observed rescue must never be executable. */
export const EXTERNAL_RESCUE_ROUTING_PREFIX = '[external-rescue-observed]';

export type ExecutionOwnership = 'external_observed' | 'cc_owned';

/** SPEC §2 — these are SEPARATE recorded milestones. No promise, timeout, page
 *  ceiling, dryrun, HTTP200 or nonempty prose may stand in for any of them. */
export const RESCUE_MILESTONES = [
  'transport_delivery',
  'actual_repair',
  'symptom_verification',
  'independent_qc',
  'client_result',
  'board_projection',
] as const;
export type RescueMilestone = (typeof RESCUE_MILESTONES)[number];

export type BlockerClass = 'machine' | 'human';

export interface RescueCorrelation {
  id: string;
  task_id: string;
  company_id: string;
  enrollment_id: string;
  runtime_id: string | null;
  incident_id: string;
  execution_ownership: ExecutionOwnership;
  owner: string;
  requested_department: string | null;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

export interface StructuredBlocker {
  blocker_class: BlockerClass;
  reason: string;
  owner: string;
  requested_action: string;
  /** Bounded next attempt for a machine fault. Recoverable work is scheduled,
   *  never parked behind a human who has nothing to decide. */
  next_retry_at?: string | null;
}

// ---------------------------------------------------------------------------
// The ownership decision — pure, so the projector and the ingest door cannot
// disagree about who owns the fixer.
// ---------------------------------------------------------------------------

export interface OwnershipInput {
  /** Did an external runner already claim this incident's fixer? */
  externalOwnerClaimed: boolean;
  /** The external owner's identity when claimed (never a display label used
   *  for routing — it is recorded, and the incident id remains the key). */
  externalOwner?: string | null;
  /** Can CC resolve a REAL worker for this rescue's department? */
  ccOwnerResolvable: boolean;
}

export interface OwnershipDecision {
  ownership: ExecutionOwnership;
  owner: string;
  /** True when CC must persist the no-dispatch hold. */
  holdDispatch: boolean;
  reason: string;
}

/**
 * Decide, once, who runs this rescue.
 *
 * The order is not a preference, it is a precedence: an ALREADY CLAIMED
 * external fixer wins, because the alternative is a second fixer racing the
 * first on the same incident — the exact defect this contract exists to make
 * unreachable. CC-owned is only returned when CC can actually name a worker.
 */
export function chooseExecutionOwnership(input: OwnershipInput): OwnershipDecision {
  if (input.externalOwnerClaimed) {
    return {
      ownership: 'external_observed',
      owner: (input.externalOwner && input.externalOwner.trim()) || 'external-rescue-owner',
      holdDispatch: true,
      reason:
        'An external owner already holds this incident\'s fixer. Command Center observes: ' +
        'it records correlation, evidence, milestones and projection, and holds dispatch so ' +
        'no second fixer can be started for the same incident.',
    };
  }
  if (input.ccOwnerResolvable) {
    return {
      ownership: 'cc_owned',
      owner: 'command-center',
      holdDispatch: false,
      reason: 'No external owner is claimed and a real Command Center worker is resolvable; CC owns this fix.',
    };
  }
  return {
    ownership: 'cc_owned',
    owner: 'operator',
    holdDispatch: false,
    reason:
      'No external owner is claimed and no department worker is resolvable. CC still owns the work ' +
      'under the scoped operator fallback: it is recoverable work with a named owner and a next ' +
      'action, never an unowned card and never a fictional human blocker.',
  };
}

// ---------------------------------------------------------------------------
// Scoped General / CEO / operator fallback for a MISSING Rescue department
// ---------------------------------------------------------------------------

export interface RescueWorkspaceRow {
  id: string;
  slug: string;
  name: string;
}

export interface RescueDepartmentResolution {
  workspaceId: string | null;
  resolvedBy: string;
  /** The real owner recorded for the work. Always non-empty: the fallback
   *  chain ends at the operator, who is a real owner, not a placeholder. */
  owner: string;
  department: string | null;
}

const RESCUE_DEPARTMENT_SLUGS = new Set(['rescue', 'rescue-rangers', 'rescue-rangers-dept', 'rescue_rangers']);

/** Is the requested department the Rescue department (under any spelling)? */
export function isRescueDepartmentSlug(slug: string | null | undefined): boolean {
  if (typeof slug !== 'string') return false;
  const s = slug.trim().toLowerCase().replace(/^dept-/, '').replace(/_/g, '-');
  return RESCUE_DEPARTMENT_SLUGS.has(s);
}

/**
 * Resolve the owner for a rescue card whose department may not exist.
 *
 * SCOPED ON PURPOSE. This runs ONLY for the Rescue department. Extending the
 * generic unrecognized-slug path would silently re-home every typo'd
 * department on every box; the rescue flow is the one that must keep moving
 * while its own lane is unprovisioned, so it is the one that gets a fallback.
 *
 * Chain, in order, each a REAL owner for AUTHORIZED SAFE WORK:
 *   1. the Rescue department workspace (when it exists and is unambiguous);
 *   2. General Task  — the mandatory catch-all department;
 *   3. the CEO / master-orchestrator workspace;
 *   4. the OPERATOR  — no workspace at all, so the card is parked as
 *      recoverable operator work with a named next action rather than being
 *      left looking assigned.
 *
 * The vocabulary deliberately reuses the words the ingest door already emits
 * (`general-task-fallback`, `ceo-fallback`, `no-workspace-fallback`) so the
 * two callers describe the same facts with the same strings.
 */
export function resolveRescueDepartmentOwner(
  rows: RescueWorkspaceRow[],
  requestedDepartment?: string | null,
): RescueDepartmentResolution {
  const live = rows.filter((w) => w && typeof w.slug === 'string');
  const requested = (requestedDepartment ?? '').trim();

  const match = live.filter(
    (w) => w.slug.toLowerCase() === requested.toLowerCase() || w.id.toLowerCase() === requested.toLowerCase(),
  );
  if (match.length === 1) {
    return {
      workspaceId: match[0].id,
      resolvedBy: `department_slug:${requested}`,
      owner: `department:${match[0].slug}`,
      department: match[0].slug,
    };
  }

  const general =
    live.find((w) => ['general-task', 'dept-general-task', 'general'].includes(w.slug.toLowerCase())) ||
    (live.filter((w) => w.name.trim().toLowerCase() === 'general task').length === 1
      ? live.find((w) => w.name.trim().toLowerCase() === 'general task')
      : undefined);
  if (general) {
    return {
      workspaceId: general.id,
      resolvedBy: 'rescue-department-missing->general-task-fallback',
      owner: `department:${general.slug}`,
      department: general.slug,
    };
  }

  const ceo = live.find((w) => ['master-orchestrator', 'ceo', 'dept-ceo'].includes(w.slug.toLowerCase()));
  if (ceo) {
    return {
      workspaceId: ceo.id,
      resolvedBy: 'rescue-department-missing->ceo-fallback',
      owner: `department:${ceo.slug}`,
      department: ceo.slug,
    };
  }

  return {
    workspaceId: null,
    resolvedBy: 'rescue-department-missing->operator-fallback',
    owner: 'operator',
    department: null,
  };
}

// ---------------------------------------------------------------------------
// Correlation persistence
// ---------------------------------------------------------------------------

export interface BindRescueInput {
  taskId: string;
  companyId: string;
  /** The enrollment-bound identity. Never a display label, never a caller
   *  return address (RR-020 policy) — those are forbidden routing keys. */
  enrollmentId: string;
  incidentId: string;
  runtimeId?: string | null;
  requestedDepartment?: string | null;
  decision: OwnershipDecision;
}

export interface BindRescueResult {
  linkId: string;
  correlation: RescueCorrelation;
  /** True when the no-dispatch hold was persisted (observed rescues only). */
  dispatchHeld: boolean;
}

function requireNonEmpty(value: string | null | undefined, field: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new Error(`rescue_execution_contract: ${field} is required`);
  return v;
}

/**
 * Persist company / task / execution / attempt correlation and, for an OBSERVED
 * rescue, the no-dispatch hold — in ONE transaction, so a card can never exist
 * in the observed state without the hold that makes observation true.
 *
 * Idempotent per task: re-binding updates the existing row (the requested
 * department may be corrected later) and never mints a second correlation for
 * the same task.
 */
export function bindRescueExecution(input: BindRescueInput, db: Database.Database = getDb()): BindRescueResult {
  const taskId = requireNonEmpty(input.taskId, 'taskId');
  const companyId = requireNonEmpty(input.companyId, 'companyId');
  const enrollmentId = requireNonEmpty(input.enrollmentId, 'enrollmentId');
  const incidentId = requireNonEmpty(input.incidentId, 'incidentId');

  return db.transaction(() => {
    const task = db.prepare('SELECT id, workspace_id, department FROM tasks WHERE id = ?').get(taskId) as
      | { id: string; workspace_id: string | null; department: string | null }
      | undefined;
    if (!task) throw new Error(`rescue_execution_contract: task ${taskId} not found`);

    const now = new Date().toISOString();
    const existing = db
      .prepare('SELECT * FROM rescue_execution_links WHERE task_id = ?')
      .get(taskId) as RescueCorrelation | undefined;

    let linkId: string;
    if (existing) {
      db.prepare(
        `UPDATE rescue_execution_links
            SET company_id = ?, enrollment_id = ?, incident_id = ?, runtime_id = ?,
                execution_ownership = ?, owner = ?, requested_department = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        companyId,
        enrollmentId,
        incidentId,
        input.runtimeId ?? null,
        input.decision.ownership,
        input.decision.owner,
        input.requestedDepartment ?? null,
        now,
        existing.id,
      );
      linkId = existing.id;
    } else {
      linkId = randomId();
      db.prepare(
        `INSERT INTO rescue_execution_links
           (id, task_id, company_id, enrollment_id, runtime_id, incident_id, execution_ownership,
            owner, requested_department, schema_version, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        linkId,
        taskId,
        companyId,
        enrollmentId,
        input.runtimeId ?? null,
        incidentId,
        input.decision.ownership,
        input.decision.owner,
        input.requestedDepartment ?? null,
        RESCUE_EXECUTION_SCHEMA_VERSION,
        now,
        now,
      );
    }

    let dispatchHeld = false;
    if (input.decision.holdDispatch) {
      const reason =
        `${EXTERNAL_RESCUE_ROUTING_PREFIX} ${input.decision.reason} ` +
        `Incident ${incidentId} (enrollment ${enrollmentId}) is observed by Command Center.`;
      // NOTE (U99): this UPDATE names dispatch_hold / routing_* only. It does
      // NOT assign `status`, so it is not a raw status writer and the task's
      // lifecycle still moves exclusively through transition().
      const changed = db
        .prepare(
          `UPDATE tasks
              SET dispatch_hold = 1, routing_reason = ?, routing_wait_owner = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(reason, input.decision.owner, now, taskId);
      dispatchHeld = (changed.changes ?? 0) > 0;
      db.prepare(
        `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?,?,?,?,?)`,
      ).run(randomId(), 'rescue_execution_observed', taskId, reason, now);
    }

    const correlation = db
      .prepare('SELECT * FROM rescue_execution_links WHERE id = ?')
      .get(linkId) as RescueCorrelation;
    return { linkId, correlation, dispatchHeld };
  }).immediate();
}

/** Read the correlation for a task (null when this task is not a rescue card). */
export function getRescueCorrelation(taskId: string, db: Database.Database = getDb()): RescueCorrelation | null {
  try {
    return (db.prepare('SELECT * FROM rescue_execution_links WHERE task_id = ?').get(taskId) as
      | RescueCorrelation
      | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Is this card held against dispatch by the external-rescue contract? */
export function isObservedRescue(taskId: string, db: Database.Database = getDb()): boolean {
  const link = getRescueCorrelation(taskId, db);
  return link?.execution_ownership === 'external_observed';
}

// ---------------------------------------------------------------------------
// Milestones — separate, evidenced, never inferred from one another
// ---------------------------------------------------------------------------

export interface MilestoneInput {
  milestone: RescueMilestone;
  state: 'pending' | 'satisfied' | 'failed';
  /** before/after state persisted for the milestone (SPEC §3). */
  beforeState?: string | null;
  afterState?: string | null;
  evidenceKind?: string | null;
  evidenceDigest?: string | null;
  evidenceRef?: string | null;
  qcActor?: string | null;
  qcRevision?: number | null;
  actor: string;
  detail?: string | null;
}

export const MILESTONE_ORDER: RescueMilestone[] = [...RESCUE_MILESTONES];

/**
 * Record ONE milestone. Rejects a QC or client-result milestone with no
 * evidence reference: "a milestone was reached" is a claim, and each of these
 * is exactly the class of claim the legacy adapter made with nothing behind it.
 */
export function recordRescueMilestone(
  taskId: string,
  input: MilestoneInput,
  db: Database.Database = getDb(),
): { id: string; created: boolean } {
  const link = getRescueCorrelation(taskId, db);
  if (!link) throw new Error(`rescue_execution_contract: task ${taskId} has no rescue correlation`);
  if (!RESCUE_MILESTONES.includes(input.milestone)) {
    throw new Error(`rescue_execution_contract: unknown milestone ${String(input.milestone)}`);
  }
  if (!requireActor(input.actor)) {
    throw new Error('rescue_execution_contract: a milestone must name the actor that recorded it');
  }
  if (
    (input.milestone === 'independent_qc' ||
      input.milestone === 'actual_repair' ||
      input.milestone === 'symptom_verification' ||
      input.milestone === 'client_result' ||
      input.milestone === 'board_projection') &&
    input.state === 'satisfied' &&
    !(input.evidenceRef || input.evidenceDigest)
  ) {
    throw new Error(
      `rescue_execution_contract: milestone '${input.milestone}' cannot be satisfied without an evidence reference. ` +
        'A milestone with no evidence behind it is the claim the legacy adapter made and this contract exists to replace.',
    );
  }
  if (input.milestone === 'independent_qc' && input.state === 'satisfied' && !requireActor(input.qcActor)) {
    throw new Error(
      'rescue_execution_contract: the independent_qc milestone must name the QC actor that scored it',
    );
  }

  const now = new Date().toISOString();
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM rescue_execution_milestones WHERE link_id = ? AND milestone = ?')
      .get(link.id, input.milestone) as { id: string } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE rescue_execution_milestones
            SET state = ?, before_state = ?, after_state = ?, evidence_kind = ?, evidence_digest = ?,
                evidence_ref = ?, qc_actor = ?, qc_revision = ?, actor = ?, detail = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.state,
        input.beforeState ?? null,
        input.afterState ?? null,
        input.evidenceKind ?? null,
        input.evidenceDigest ?? null,
        input.evidenceRef ?? null,
        input.qcActor ?? null,
        input.qcRevision ?? null,
        input.actor,
        input.detail ?? null,
        now,
        existing.id,
      );
      return { id: existing.id, created: false };
    }
    const id = randomId();
    db.prepare(
      `INSERT INTO rescue_execution_milestones
         (id, link_id, task_id, milestone, state, before_state, after_state, evidence_kind,
          evidence_digest, evidence_ref, qc_actor, qc_revision, actor, schema_version, detail,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      link.id,
      taskId,
      input.milestone,
      input.state,
      input.beforeState ?? null,
      input.afterState ?? null,
      input.evidenceKind ?? null,
      input.evidenceDigest ?? null,
      input.evidenceRef ?? null,
      input.qcActor ?? null,
      input.qcRevision ?? null,
      input.actor,
      RESCUE_EXECUTION_SCHEMA_VERSION,
      input.detail ?? null,
      now,
      now,
    );
    return { id, created: true };
  }).immediate();
}

export interface MilestoneRow {
  milestone: string;
  state: string;
  evidence_ref: string | null;
  evidence_digest: string | null;
  /** The independent QC actor, for the `independent_qc` milestone. */
  qc_actor: string | null;
  /** The actor that RECORDED the milestone (SPEC §3 requires the actor be
   *  persisted; it is surfaced here so a reader can attribute every claim). */
  actor: string;
  qc_revision: number | null;
  before_state: string | null;
  after_state: string | null;
}

export function listRescueMilestones(taskId: string, db: Database.Database = getDb()): MilestoneRow[] {
  try {
    return db
      .prepare(
        `SELECT milestone, state, evidence_ref, evidence_digest, qc_actor, actor, qc_revision, before_state, after_state
           FROM rescue_execution_milestones WHERE task_id = ? ORDER BY created_at, rowid`,
      )
      .all(taskId) as MilestoneRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Registered evidence — real deliverables, not prose
// ---------------------------------------------------------------------------

export interface EvidenceRegistration extends DeliverableRegistration {
  /** 'file' requires an existing non-empty file; 'url' requires a valid http(s)
   *  address. Both are the same rules collectCompletionEvidence() applies, so a
   *  registration that clears this clears the done gate for the same reason. */
  deliverableType?: 'file' | 'artifact' | 'image' | 'url';
}

/**
 * Register ACTUAL evidence for a rescue card and record the delivery receipt as
 * a milestone. Registration is the real thing — it writes task_deliverables
 * rows (the rows `collectCompletionEvidence()` reads at the done gate), not a
 * note claiming a file exists.
 */
export function registerRescueEvidence(
  taskId: string,
  registrations: EvidenceRegistration[],
  db: Database.Database = getDb(),
): { deliverableIds: string[]; milestones: string[] } {
  const link = getRescueCorrelation(taskId, db);
  if (!link) throw new Error(`rescue_execution_contract: task ${taskId} has no rescue correlation`);
  const deliverableIds: string[] = [];
  const milestones: string[] = [];
  for (const reg of registrations) {
    const id = registerDeliverable(taskId, reg);
    deliverableIds.push(id);
    milestones.push(
      recordRescueMilestone(
        taskId,
        {
          milestone: 'actual_repair',
          state: 'satisfied',
          evidenceKind: reg.deliverableType ?? 'artifact',
          evidenceDigest: reg.sha256 ?? null,
          evidenceRef: reg.path,
          actor: 'external-rescue-contract',
          detail: `Registered deliverable ${id} (${reg.title ?? reg.path}).`,
        },
        db,
      ).id,
    );
  }
  return { deliverableIds, milestones };
}

// ---------------------------------------------------------------------------
// Independent QC — a builder may never advance its own card out of review
// ---------------------------------------------------------------------------

export interface QcVerdict {
  ok: boolean;
  reason: string;
  actor: string | null;
  score: number | null;
  revision: number | null;
}

/**
 * The independent-QC precondition for `done`.
 *
 * Independent means: a QC row exists, it PASSED, and the actor that produced it
 * is not the card's builder. A null qc_agent_id is a SYSTEM-scored row and
 * counts as independent (that is the auto-scorer, which is not the builder) —
 * but the builder's own row NEVER counts, no matter what role it holds.
 */
export function requireIndependentQc(taskId: string, db: Database.Database = getDb()): QcVerdict {
  const task = db
    .prepare('SELECT id, assigned_agent_id, created_by_agent_id FROM tasks WHERE id = ?')
    .get(taskId) as { id: string; assigned_agent_id: string | null; created_by_agent_id: string | null } | undefined;
  if (!task) return { ok: false, reason: 'task_not_found', actor: null, score: null, revision: null };

  const rows = queryAll<{ qc_agent_id: string | null; score: number; passed: number; attempt: number | null }>(
    `SELECT qc_agent_id, score, passed, attempt FROM task_qc_results
      WHERE task_id = ? ORDER BY scored_at DESC, rowid DESC`,
    [taskId],
  );
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'independent_qc_missing',
      actor: null,
      score: null,
      revision: null,
    };
  }
  const latest = rows[0];
  const actor = latest.qc_agent_id ?? null;
  const builderIds = [task.assigned_agent_id, task.created_by_agent_id].filter(Boolean) as string[];
  if (actor && builderIds.includes(actor)) {
    return {
      ok: false,
      reason: 'independent_qc_self_grade',
      actor,
      score: latest.score,
      revision: latest.attempt ?? null,
    };
  }
  if (latest.passed !== 1) {
    return {
      ok: false,
      reason: 'independent_qc_failed',
      actor,
      score: latest.score,
      revision: latest.attempt ?? null,
    };
  }
  return { ok: true, reason: 'independent_qc_passed', actor, score: latest.score, revision: latest.attempt ?? null };
}

// ---------------------------------------------------------------------------
// Legal-state advancement — through transition(), never around it
// ---------------------------------------------------------------------------

export interface AdvanceRescueInput {
  to: LifecycleState;
  actor: string;
  reason?: string;
  /** Required for any advancement out of the builder's own lane: a stale
   *  execution identity can never finish a newer attempt. */
  expectedExecutionId?: string;
  expectedFrom?: LifecycleState;
  /** Independent-QC actor, recorded on the milestone when `to === 'done'`. */
  qcActor?: string | null;
  qcRevision?: number | null;
  operatorOverride?: boolean;
}

/**
 * Advance a rescue card through the ONE lifecycle funnel.
 *
 * `done` additionally requires the independent-QC verdict here, in this
 * contract, so the requirement is a property of the CONTRACT and not merely of
 * whichever route a caller happened to use. This is an ADDITIONAL gate: the
 * existing CC guards (completion evidence, persona conformance, the PATCH
 * route's self-grade and CF-Access gates) all still run inside transition() —
 * nothing here bypasses or relaxes any of them.
 */
export async function advanceRescueState(
  taskId: string,
  input: AdvanceRescueInput,
  db: Database.Database = getDb(),
): Promise<Task> {
  const link = getRescueCorrelation(taskId, db);
  if (!link) throw new Error(`rescue_execution_contract: task ${taskId} has no rescue correlation`);
  if (!requireActor(input.actor)) {
    throw new Error('rescue_execution_contract: a state advancement must name its actor');
  }

  const before = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);

  if (input.to === 'done') {
    const qc = requireIndependentQc(taskId, db);
    if (!qc.ok) {
      throw new TransitionError(
        'PRECONDITION_EVIDENCE',
        `Independent QC is required before done (${qc.reason}). ` +
          'The builder may never advance its own card out of review: a separate QC authority must score the ' +
          'registered deliverables first.',
      );
    }
    // An anonymous verdict is not an independent one. Checked HERE, before the
    // transition commits, so a card can never reach done on a nameless score
    // and then fail to record who authorized it.
    if (!requireActor(qc.actor)) {
      throw new TransitionError(
        'PRECONDITION_EVIDENCE',
        'Independent QC is required before done (independent_qc_actor_missing). ' +
          'The passing verdict carries no QC actor, so the contract cannot record WHO authorized this completion.',
      );
    }
    input = { ...input, qcActor: input.qcActor ?? qc.actor, qcRevision: input.qcRevision ?? qc.revision };
  }

  const task = await transition(taskId, input.to, {
    actor: input.actor,
    reason: input.reason,
    expectedFrom: input.expectedFrom,
    expectedExecutionId: input.expectedExecutionId,
    operatorOverride: input.operatorOverride,
  });

  // One transition, its OWN milestone. The six milestones of SPEC §2 stay
  // separate recorded facts rather than collapsing into "the card moved":
  //
  //   in_progress (from review) -> actual_repair      (the repair attempt)
  //   in_progress (else)        -> transport_delivery (the card was dispatched)
  //   review                    -> symptom_verification (artifact under review)
  //   done                      -> independent_qc     (the verdict that
  //                               authorized leaving review, named actor and
  //                               revision attached)
  //
  // `client_result` and `board_projection` are deliberately NOT recorded here.
  // No client was told and no board row was produced by a status UPDATE, and
  // recording them from a transition would be the exact unearned claim this
  // contract exists to refuse. Their real callers record them with their own
  // delivery / projection receipt.
  const milestone: RescueMilestone =
    input.to === 'done'
      ? 'independent_qc'
      : input.to === 'review'
        ? 'symptom_verification'
        : input.to === 'in_progress' && before?.status === 'review'
          ? 'actual_repair'
          : 'transport_delivery';

  recordRescueMilestone(
    taskId,
    {
      milestone,
      state: input.to === 'blocked' ? 'failed' : 'satisfied',
      beforeState: before?.status ?? null,
      afterState: input.to,
      evidenceKind: 'lifecycle_transition',
      evidenceRef: `${before?.status ?? 'unknown'}->${input.to}`,
      qcActor: milestone === 'independent_qc' ? input.qcActor ?? null : null,
      qcRevision: milestone === 'independent_qc' ? input.qcRevision ?? null : null,
      actor: input.actor,
      detail: input.reason ?? null,
    },
    db,
  );

  return task;
}

/**
 * The review half of the QC loop, spelled out so a caller cannot improvise it:
 * the builder moves the card to `review`, independent QC scores it, and a FAIL
 * returns the card to `in_progress` for REPAIR — with the repair attempt
 * recorded — before a second review. `transition()` already refuses
 * review→done from the builder and enforces the review evidence gate; this
 * helper adds the repaired-attempt bookkeeping and the no-duplicate-dispatch
 * guarantee (a repair is only dispatched once per failed review revision).
 */
export async function returnToRepair(
  taskId: string,
  qc: { actor: string; score: number; revision?: number | null; reason?: string },
  db: Database.Database = getDb(),
): Promise<{ task: Task; attempt: number; stale: boolean }> {
  const link = getRescueCorrelation(taskId, db);
  if (!link) throw new Error(`rescue_execution_contract: task ${taskId} has no rescue correlation`);
  if (!requireActor(qc.actor)) throw new Error('rescue_execution_contract: a QC verdict must name its actor');

  const task = queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId]);
  if (!task) throw new Error(`rescue_execution_contract: task ${taskId} not found`);
  if (task.status !== 'review') {
    // A verdict for a revision that is no longer in review is STALE. It must not
    // manufacture a repair dispatch for work that has already moved on.
    const current = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!current) throw new Error(`rescue_execution_contract: task ${taskId} not found`);
    return { task: current, attempt: 0, stale: true };
  }

  const attempt = (queryOne<{ n: number | null }>(
    `SELECT MAX(attempt) AS n FROM task_qc_results WHERE task_id = ?`,
    [taskId],
  )?.n ?? 0) + 1;

  const updated = await transition(taskId, 'in_progress', {
    actor: qc.actor,
    reason:
      `QC FAIL (${qc.score}/10) on review revision ${qc.revision ?? 'unknown'} — returned for repair ` +
      `(attempt ${attempt}). ${qc.reason ?? ''}`.trim(),
    expectedFrom: 'review',
  });

  recordRescueMilestone(
    taskId,
    {
      milestone: 'independent_qc',
      state: 'failed',
      beforeState: 'review',
      afterState: 'in_progress',
      evidenceKind: 'qc_verdict',
      evidenceRef: `qc_fail:${qc.score}`,
      qcActor: qc.actor,
      qcRevision: qc.revision ?? attempt,
      actor: qc.actor,
      detail: qc.reason ?? null,
    },
    db,
  );

  return { task: updated, attempt, stale: false };
}

// ---------------------------------------------------------------------------
// Structured blockers
// ---------------------------------------------------------------------------

export interface BlockerResult {
  id: string;
  recoverable: boolean;
  blockedOnHuman: 'owner' | 'operator' | null;
  ask: string | null;
}

/**
 * Record a STRUCTURED blocker: reason, owner, requested action — and a class.
 *
 * A 'machine' blocker is RECOVERABLE WORK. It is persisted with a bounded next
 * retry and it does NOT set `blocked_on_human`: paging a human for a fault no
 * human can cure is a fabricated blocker, which is how a real queue fills with
 * un-clearable cards. The card is moved to `blocked` (so it is visible and stops
 * being dispatched) but the blocked state carries the MACHINE audience, and the
 * blocker row records the retry — the work resumes by itself.
 *
 * A 'human' blocker is a genuine decision/approval/credential need. It names the
 * human and MUST carry a non-blank `ask` — the same invariant migration 104's
 * triggers enforce at the DB level, so a blank ask here would be rejected by the
 * database anyway; this function refuses it earlier with a clearer message.
 */
export function recordStructuredBlocker(
  taskId: string,
  blocker: StructuredBlocker,
  db: Database.Database = getDb(),
): BlockerResult {
  const link = getRescueCorrelation(taskId, db);
  if (!link) throw new Error(`rescue_execution_contract: task ${taskId} has no rescue correlation`);
  if (blocker.blocker_class !== 'machine' && blocker.blocker_class !== 'human') {
    throw new Error(`rescue_execution_contract: unknown blocker class ${String(blocker.blocker_class)}`);
  }
  const reason = requireNonEmpty(blocker.reason, 'reason');
  const owner = requireNonEmpty(blocker.owner, 'owner');
  const action = requireNonEmpty(blocker.requested_action, 'requested_action');

  const now = new Date().toISOString();
  const recoverable = blocker.blocker_class === 'machine';
  const blockedOnHuman: 'owner' | 'operator' | null = recoverable ? null : owner === 'owner' ? 'owner' : 'operator';

  if (!recoverable && action.trim().length === 0) {
    throw new Error('rescue_execution_contract: a human blocker must carry a requested action (a non-blank ask)');
  }

  return db.transaction(() => {
    const id = randomId();
    const attempt =
      (db
        .prepare('SELECT COUNT(*) AS n FROM rescue_execution_blockers WHERE link_id = ? AND blocker_class = ?')
        .get(link.id, blocker.blocker_class) as { n: number }).n + 1;
    db.prepare(
      `INSERT INTO rescue_execution_blockers
         (id, link_id, task_id, blocker_class, reason, owner, requested_action, attempt,
          next_retry_at, recoverable, actor, schema_version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      link.id,
      taskId,
      blocker.blocker_class,
      reason,
      owner,
      action,
      attempt,
      blocker.next_retry_at ?? null,
      recoverable ? 1 : 0,
      'external-rescue-contract',
      RESCUE_EXECUTION_SCHEMA_VERSION,
      now,
      now,
    );
    return { id, recoverable, blockedOnHuman, ask: recoverable ? null : action };
  }).immediate();
}

export interface BlockerRow {
  blocker_class: string;
  reason: string;
  owner: string;
  requested_action: string;
  attempt: number;
  next_retry_at: string | null;
  recoverable: number;
  resolved_at: string | null;
}

export function listOpenRescueBlockers(taskId: string, db: Database.Database = getDb()): BlockerRow[] {
  try {
    return db
      .prepare(
        `SELECT blocker_class, reason, owner, requested_action, attempt, next_retry_at, recoverable, resolved_at
           FROM rescue_execution_blockers WHERE task_id = ? AND resolved_at IS NULL ORDER BY created_at, rowid`,
      )
      .all(taskId) as BlockerRow[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Projection — operator and client views are PROVED separately, not asserted
// ---------------------------------------------------------------------------

export interface RescueProjectionRow {
  taskId: string;
  incidentId: string | null;
  enrollmentId: string | null;
  companyId: string | null;
  ownership: ExecutionOwnership | 'unbound';
  owner: string | null;
  status: string;
  milestones: MilestoneRow[];
  openBlockers: BlockerRow[];
  triage: boolean;
}

export interface ProjectionViews {
  operator: { seesTriage: true; rows: RescueProjectionRow[] };
  client: {
    keysOn: 'enrollment-bound identity';
    seesTriage: false;
    seesForeignRows: false;
    rows: RescueProjectionRow[];
  };
}

/**
 * Build the TWO views. The client view is filtered by the enrollment-bound
 * identity of the requested client and by nothing else — never a display name,
 * never a caller return address (RR-020 policy, imported verbatim as the rule
 * this function implements). Triage rows are structurally absent from it.
 */
export function projectRescueViews(
  all: RescueProjectionRow[],
  clientEnrollmentId: string,
): ProjectionViews {
  return {
    operator: { seesTriage: true, rows: all },
    client: {
      keysOn: 'enrollment-bound identity',
      seesTriage: false,
      seesForeignRows: false,
      rows: all.filter((r) => !r.triage && r.enrollmentId === clientEnrollmentId),
    },
  };
}

// ---------------------------------------------------------------------------

function requireActor(actor: string | null | undefined): boolean {
  return typeof actor === 'string' && actor.trim().length > 0;
}

function randomId(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID } = require('crypto') as typeof import('crypto');
  return randomUUID();
}

// ---------------------------------------------------------------------------
// The INGEST door — where the observation/execution choice is actually made
// ---------------------------------------------------------------------------

export interface RescueIngestEnvelope {
  /** Structured incident identity. An envelope is recognized only when BOTH the
   *  incident id and the enrollment-bound identity are present: a producer that
   *  sends one without the other has not identified an incident, and treating a
   *  half-envelope as one would mint a correlation keyed on nothing. */
  incidentId: string;
  enrollmentId: string;
  runtimeId?: string | null;
  /** The external runner that already holds this incident's fixer, if any. */
  externalOwner?: string | null;
  /** The department the caller asked for (may not exist on this box). */
  requestedDepartment?: string | null;
}

/** Read a rescue envelope out of an ingest body. Returns null for a body that
 *  is not a rescue call at all — every non-rescue ingest path is unchanged. */
export function parseRescueIngestEnvelope(body: Record<string, unknown>): RescueIngestEnvelope | null {
  const block = body.rescue_observation;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const b = block as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const incidentId = str(b.incident_id);
  const enrollmentId = str(b.enrollment_id);
  if (!incidentId || !enrollmentId) return null;
  return {
    incidentId,
    enrollmentId,
    runtimeId: str(b.runtime_id) || null,
    externalOwner: str(b.external_owner) || str(b.owner) || null,
    requestedDepartment: str(b.requested_department) || null,
  };
}

export interface RescueIngestPlan {
  /** Workspace the card must land in — the rescue department, or the fallback. */
  workspaceId: string | null;
  resolvedBy: string;
  /** The hold reason to hand createTaskCore; NON-NULL for an observed rescue,
   *  which is what makes the no-second-fixer guarantee reach the dispatch
   *  guards (createTaskCore writes dispatch_hold=1 + this reason). */
  routingHoldReason: string | null;
  decision: OwnershipDecision;
  correlation: Omit<BindRescueInput, 'taskId'>;
  /** Real owner recorded for the card. Never empty. */
  owner: string;
}

/**
 * Turn a rescue envelope into the routing decision the ingest door applies.
 *
 * `ccOwnerResolvable` is passed in by the caller after it has asked the router
 * whether a real worker exists — this function never guesses. When CC can name
 * a worker the rescue is CC-owned (normal dispatch); when it cannot, the scoped
 * General/CEO/operator fallback names a REAL owner and the work continues
 * instead of parking under a fictional owner.
 */
export function planRescueIngest(input: {
  envelope: RescueIngestEnvelope;
  companyId: string;
  workspaceRows: RescueWorkspaceRow[];
  /** Did an external runner already claim this incident's fixer? */
  externalOwnerClaimed: boolean;
  /** Can CC resolve a real worker for this rescue? */
  ccOwnerResolvable: boolean;
}): RescueIngestPlan {
  const requested = input.envelope.requestedDepartment ?? 'rescue';
  const fallback = resolveRescueDepartmentOwner(input.workspaceRows, requested);

  const decision = chooseExecutionOwnership({
    externalOwnerClaimed: input.externalOwnerClaimed,
    externalOwner: input.envelope.externalOwner,
    ccOwnerResolvable: input.ccOwnerResolvable,
  });

  // An observed rescue is owned by the EXTERNAL runner, so the department
  // fallback must not re-home it: the card is parked where the external flow
  // can see it, with the rescue department as requested and the fallback owner
  // recorded. A CC-owned rescue with no resolvable worker parks on the
  // fallback workspace so authorized safe work continues under a real owner.
  const workspaceId = fallback.workspaceId;
  const owner = decision.ownership === 'external_observed' ? decision.owner : fallback.owner;

  return {
    workspaceId,
    resolvedBy: fallback.resolvedBy,
    routingHoldReason: decision.holdDispatch
      ? `${EXTERNAL_RESCUE_ROUTING_PREFIX} ${decision.reason}`
      : null,
    decision,
    owner,
    correlation: {
      companyId: input.companyId,
      enrollmentId: input.envelope.enrollmentId,
      incidentId: input.envelope.incidentId,
      runtimeId: input.envelope.runtimeId ?? null,
      requestedDepartment: requested,
      decision: { ...decision, owner },
    },
  };
}
