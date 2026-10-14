/**
 * CWE-036 execution guards (Sections 17.6, 19.5, 19.7, 25; T095).
 *
 * Plan approval is not an execution credential. A created council
 * action task is released from the council_plan_assembling hold only
 * when EVERY guard below passes for THAT task, evaluated at release
 * time against committed records:
 *
 * - the plan is current (not superseded) and its approval coverage is
 *   complete, bound to the exact plan hash and item revisions;
 * - the task link binds the task to this exact plan hash and Section
 *   19.6 operation identity;
 * - the task still carries the council layer's own typed handler
 *   identity (council_action); a task naming any other handler is
 *   rejected, never coerced;
 * - a standing execution grant resolves ACTIVE for this session
 *   through the Section 25.6 port, and the port ADMITS this task's
 *   exact operation id (a grant that does not admit the operation
 *   does not release the task; without a matching grant every task
 *   stays held, with no repeated prompting and no bypass);
 * - every dependency edge is satisfied by the dependency task's real
 *   lifecycle `done` state (Section 19.7: never a model assertion);
 * - every source condition carries a committed verification record
 *   whose status is satisfied (or waived by the owner) with named
 *   evidence, recorded through recordConditionVerification.
 *
 * Release is per task, never a blanket unhold: releaseReadyTasks
 * evaluates each task independently and releases only the ones whose
 * own checks pass. The release write itself is deliberately narrow:
 * it clears only the council assembly hold (dispatch_hold and the
 * council routing reason, on a task whose source is 'council' and
 * whose hold this layer set), journaled in the same transaction. The
 * task then re-enters the board's ordinary intake flow as an
 * unassigned backlog task; this layer never assigns an agent and
 * never dispatches anything.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { isKnownPersonaId } from '@/lib/persona-library';
import type { CouncilPrincipal } from '../auth';
import { CouncilRepositories } from '../store';
import { CouncilActionError } from './action-errors';
import {
  dependencyStatesFor,
  listPlanTaskLinks,
  topologicalActionOrder,
  type DependencyState,
} from './action-dependencies';
import { COUNCIL_PLAN_ASSEMBLING_HOLD, COUNCIL_TASK_SOURCE, councilActionOperationId } from './constants';
import {
  assertKanbanSessionNotDeleted,
  authorizeKanbanOperation,
  type KanbanAuthOptions,
} from './context';
import { CouncilKanbanError } from './errors';
import { appendKanbanJournalEvent, listKanbanJournalEntries } from './journal';
import { withKeyedLock } from './mutex';
import { CouncilActionPlanService, type CouncilActionPlan } from './plan-service';
import {
  UnavailableRunAuthorizationPort,
  type CouncilRunAuthorizationPort,
} from './run-authorization-port';

/** The typed handler identity CWE-035 stamps on every action task. */
export const COUNCIL_ACTION_HANDLER = 'council_action';

export type ConditionVerificationStatus = 'satisfied' | 'failed' | 'waived_by_owner';

export interface ConditionVerificationInput {
  condition_id: string;
  status: ConditionVerificationStatus;
  verification_method: string;
  evidence_refs: string[];
}

export interface ConditionState {
  condition_id: string;
  status: ConditionVerificationStatus | 'unverified';
  verification_method: string | null;
  evidence_refs: string[];
  recorded_by: string | null;
  recorded_at: string | null;
  /** Satisfied, or waived by the owner with the waiver on record. */
  verified: boolean;
}

export interface TaskReleaseChecks {
  plan_current: boolean;
  approval_complete: boolean;
  link_matches_plan: boolean;
  handler_supported: boolean;
  grant_active: boolean;
  operation_admitted: boolean;
  dependencies_satisfied: boolean;
  prerequisites_verified: boolean;
}

export interface TaskReleaseDecision {
  plan_id: string;
  plan_hash: string;
  action_id: string;
  task_id: string;
  operation_id: string;
  releasable: boolean;
  already_released: boolean;
  grant_ref: string | null;
  grant_status: string;
  checks: TaskReleaseChecks;
  reasons: string[];
  dependencies: DependencyState[];
  conditions: ConditionState[];
  evaluated_at: string;
}

export interface TaskReleaseOutcome {
  action_id: string;
  task_id: string;
  released: boolean;
  already_released: boolean;
  decision: TaskReleaseDecision;
}

export interface ReadinessFailure {
  action_id: string;
  field: 'assigned_agent_id' | 'sop_id' | 'persona_id';
  value: string;
  reason: string;
}

export interface CouncilActionExecutionDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  planService?: CouncilActionPlanService;
  runAuthorization?: CouncilRunAuthorizationPort;
  now?: () => string;
  newId?: () => string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  source: string | null;
  description: string | null;
  dispatch_hold: number | null;
  routing_reason: string | null;
  assigned_agent_id: string | null;
}

export class CouncilActionExecutionGuard {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly planService: CouncilActionPlanService;
  private readonly runAuthorization: CouncilRunAuthorizationPort;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: CouncilActionExecutionDeps = {}) {
    this.db = deps.db ?? getDb();
    this.repositories = deps.repositories ?? new CouncilRepositories();
    this.runAuthorization = deps.runAuthorization ?? new UnavailableRunAuthorizationPort();
    this.planService =
      deps.planService ??
      new CouncilActionPlanService({
        repositories: this.repositories,
        db: this.db,
        runAuthorization: this.runAuthorization,
        now: deps.now,
        newId: deps.newId,
      });
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  // ------------------------------------------------------- conditions

  /**
   * Record the verification outcome for one source condition, with
   * the method used and the evidence it rests on (Section 19.7). A
   * 'satisfied' record without evidence is refused: conditions are
   * verified by method and evidence, never by assertion.
   */
  async recordConditionVerification(
    principal: CouncilPrincipal,
    sessionId: string,
    input: ConditionVerificationInput,
    auth?: KanbanAuthOptions,
  ): Promise<ConditionState> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'mutate',
      auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    if (!input || typeof input.condition_id !== 'string' || input.condition_id.trim() === '') {
      throw new CouncilActionError(
        'COUNCIL_CONDITION_EVIDENCE_INVALID',
        'A condition verification requires a condition_id.',
      );
    }
    if (!['satisfied', 'failed', 'waived_by_owner'].includes(input.status)) {
      throw new CouncilActionError(
        'COUNCIL_CONDITION_EVIDENCE_INVALID',
        `Unknown condition verification status: ${String(input.status)}.`,
      );
    }
    if (typeof input.verification_method !== 'string' || input.verification_method.trim() === '') {
      throw new CouncilActionError(
        'COUNCIL_CONDITION_EVIDENCE_INVALID',
        'A condition verification must name the verification method used.',
      );
    }
    const evidenceRefs = Array.isArray(input.evidence_refs)
      ? input.evidence_refs.filter((ref) => typeof ref === 'string' && ref.trim() !== '')
      : [];
    if (input.status === 'satisfied' && evidenceRefs.length === 0) {
      throw new CouncilActionError(
        'COUNCIL_CONDITION_EVIDENCE_INVALID',
        'A condition cannot be recorded as satisfied without evidence references.',
      );
    }
    const recordedAt = this.now();
    const record = {
      condition_id: input.condition_id,
      status: input.status,
      verification_method: input.verification_method,
      evidence_refs: evidenceRefs,
      recorded_by: principal.subject,
    };
    this.db
      .transaction(() => {
        appendKanbanJournalEvent(this.db, scope, sessionId, {
          eventId: this.newId(),
          actorSubject: principal.subject,
          action: 'condition_verified',
          createdAt: recordedAt,
          data: { ...record, authorization: { permission: 'execute' } },
        });
      })
      .immediate();
    return {
      ...record,
      recorded_at: recordedAt,
      verified: input.status === 'satisfied' || input.status === 'waived_by_owner',
    };
  }

  /** The latest committed verification state per condition id. */
  conditionStates(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
  ): Map<string, ConditionState> {
    const states = new Map<string, ConditionState>();
    for (const entry of listKanbanJournalEntries(this.db, scope, sessionId)) {
      if (entry.action !== 'condition_verified') continue;
      const payload = entry.payload;
      if (typeof payload.condition_id !== 'string') continue;
      const status = payload.status as ConditionVerificationStatus;
      states.set(payload.condition_id, {
        condition_id: payload.condition_id,
        status,
        verification_method:
          typeof payload.verification_method === 'string' ? payload.verification_method : null,
        evidence_refs: Array.isArray(payload.evidence_refs)
          ? (payload.evidence_refs as string[])
          : [],
        recorded_by: typeof payload.recorded_by === 'string' ? payload.recorded_by : null,
        recorded_at: entry.created_at,
        verified: status === 'satisfied' || status === 'waived_by_owner',
      });
    }
    return states;
  }

  // -------------------------------------------------------- readiness

  /**
   * Confirm the plan items' destination references resolve inside
   * this scope (assembly step: confirm SOP/persona/readiness). Null
   * foreign keys stay null and enter normal preparation; a non-null
   * reference that does not resolve is rejected, never coerced into a
   * valid-looking substitute.
   */
  confirmDestinationReadiness(
    scope: { tenant_id: string; company_id: string },
    plan: CouncilActionPlan,
  ): { ok: boolean; failures: ReadinessFailure[] } {
    const failures: ReadinessFailure[] = [];
    for (const item of plan.items) {
      if (item.assigned_agent_id !== null) {
        const agent = this.db
          .prepare(
            `SELECT a.id FROM agents a
               JOIN workspaces w ON w.id = a.workspace_id
              WHERE a.id = ? AND w.company_id = ?`,
          )
          .get(item.assigned_agent_id, scope.company_id) as { id: string } | undefined;
        if (!agent) {
          failures.push({
            action_id: item.action_id,
            field: 'assigned_agent_id',
            value: item.assigned_agent_id,
            reason:
              'The assigned agent does not resolve to an agent of this company; ' +
              'foreign scope references are rejected, never coerced.',
          });
        }
      }
      if (item.sop_id !== null) {
        const sop = this.db.prepare('SELECT id FROM sops WHERE id = ?').get(item.sop_id) as
          | { id: string }
          | undefined;
        if (!sop) {
          failures.push({
            action_id: item.action_id,
            field: 'sop_id',
            value: item.sop_id,
            reason: 'The named SOP does not exist in the installed SOP registry.',
          });
        }
      }
      if (item.persona_id !== null && !isKnownPersonaId(item.persona_id)) {
        failures.push({
          action_id: item.action_id,
          field: 'persona_id',
          value: item.persona_id,
          reason: 'The named persona does not exist in the installed persona catalog.',
        });
      }
    }
    return { ok: failures.length === 0, failures };
  }

  // ------------------------------------------------------- evaluation

  /** Evaluate one task's release guards without changing any state. */
  async evaluateTaskRelease(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    actionId: string,
    opts: { grant_ref?: string | null; auth?: KanbanAuthOptions } = {},
  ): Promise<TaskReleaseDecision> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'read',
      opts.auth,
    );
    return this.decide(principal, scope, sessionId, planId, actionId, opts.grant_ref ?? null, opts.auth);
  }

  // ------------------------------------------------------------ release

  /**
   * Release ONE task when its own guards pass. Returns the decision
   * either way; a task that fails any check is left exactly as it was.
   */
  async releaseTask(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    actionId: string,
    opts: { grant_ref?: string | null; auth?: KanbanAuthOptions } = {},
  ): Promise<TaskReleaseOutcome> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'mutate',
      opts.auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const lockKey = `${scope.tenant_id}:${scope.company_id}:${sessionId}:release:${planId}`;
    return withKeyedLock(lockKey, async () => {
      const decision = await this.decide(principal, scope, sessionId, planId, actionId, opts.grant_ref ?? null, opts.auth);
      if (decision.already_released) {
        return { action_id: actionId, task_id: decision.task_id, released: true, already_released: true, decision };
      }
      if (!decision.releasable) {
        return { action_id: actionId, task_id: decision.task_id, released: false, already_released: false, decision };
      }
      const releasedAt = this.now();
      this.db
        .transaction(() => {
          const changed = this.db
            .prepare(
              `UPDATE tasks SET dispatch_hold = 0, routing_reason = NULL,
                      routing_wait_owner = NULL, updated_at = ?
                WHERE id = ? AND source = ? AND dispatch_hold = 1 AND routing_reason = ?`,
            )
            .run(releasedAt, decision.task_id, COUNCIL_TASK_SOURCE, COUNCIL_PLAN_ASSEMBLING_HOLD);
          if (changed.changes !== 1) {
            throw new CouncilActionError(
              'COUNCIL_TASK_NOT_RELEASABLE',
              `Task ${decision.task_id} no longer carries the council assembly hold; release was not applied.`,
              409,
            );
          }
          appendKanbanJournalEvent(this.db, scope, sessionId, {
            eventId: this.newId(),
            actorSubject: principal.subject,
            action: 'action_task_released',
            createdAt: releasedAt,
            data: {
              plan_id: planId,
              plan_hash: decision.plan_hash,
              action_id: actionId,
              task_id: decision.task_id,
              operation_id: decision.operation_id,
              grant_ref: decision.grant_ref,
              checks: decision.checks,
              authorization: { permission: 'execute' },
            },
          });
        })
        .immediate();
      return { action_id: actionId, task_id: decision.task_id, released: true, already_released: false, decision };
    });
  }

  /**
   * Evaluate every task of a plan in dependency order and release
   * exactly those whose own guards pass. This is never a blanket
   * unhold: each task's outcome carries its own decision and reasons.
   */
  async releaseReadyTasks(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    opts: {
      grant_ref?: string | null;
      auth?: KanbanAuthOptions;
      onTask?: (outcome: TaskReleaseOutcome) => Promise<void> | void;
    } = {},
  ): Promise<TaskReleaseOutcome[]> {
    const view = await this.planService.getPlan(principal, sessionId, planId, opts.auth);
    const outcomes: TaskReleaseOutcome[] = [];
    for (const item of topologicalActionOrder(view.plan.items)) {
      const outcome = await this.releaseTask(principal, sessionId, planId, item.action_id, opts);
      outcomes.push(outcome);
      if (opts.onTask) await opts.onTask(outcome);
    }
    return outcomes;
  }

  // --------------------------------------------------------- internals

  private async decide(
    principal: CouncilPrincipal,
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    planId: string,
    actionId: string,
    grantRef: string | null,
    auth?: KanbanAuthOptions,
  ): Promise<TaskReleaseDecision> {
    const view = await this.planService.getPlan(principal, sessionId, planId, auth);
    const plan = view.plan;
    const item = plan.items.find((entry) => entry.action_id === actionId);
    if (!item) {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_ITEM_NOT_FOUND',
        `Plan ${planId} has no action ${actionId}.`,
        404,
      );
    }
    const operationId = councilActionOperationId({
      sessionId,
      verdictRevision: plan.verdict_revision,
      actionId,
      planHash: plan.plan_hash,
    });
    const links = listPlanTaskLinks(this.db, scope, sessionId, planId);
    const link = links.find((entry) => entry.action_id === actionId);
    if (!link) {
      throw new CouncilActionError(
        'COUNCIL_TASK_LINK_NOT_FOUND',
        `Action ${actionId} of plan ${planId} has not been materialized; there is no task to release.`,
        404,
      );
    }
    const task = this.db
      .prepare(
        `SELECT id, title, status, source, description, dispatch_hold, routing_reason, assigned_agent_id
           FROM tasks WHERE id = ?`,
      )
      .get(link.task_id) as TaskRow | undefined;
    if (!task) {
      throw new CouncilActionError(
        'COUNCIL_TASK_LINK_NOT_FOUND',
        `The task ${link.task_id} linked to action ${actionId} no longer exists.`,
        404,
      );
    }

    const reasons: string[] = [];
    const checks: TaskReleaseChecks = {
      plan_current: plan.status !== 'superseded',
      approval_complete: view.coverage.complete,
      link_matches_plan: link.plan_hash === plan.plan_hash && link.operation_id === operationId,
      handler_supported: false,
      grant_active: false,
      operation_admitted: false,
      dependencies_satisfied: false,
      prerequisites_verified: false,
    };
    if (!checks.plan_current) reasons.push('The plan was superseded; its approvals no longer bind current work.');
    if (!checks.approval_complete) reasons.push('The plan approval is not complete for the exact plan hash.');
    if (!checks.link_matches_plan) reasons.push('The task link does not bind this exact plan hash and operation identity.');

    const handlerMatch = /Handler: ([^\n]+)/.exec(task.description ?? '');
    const handler = handlerMatch ? handlerMatch[1].trim() : null;
    checks.handler_supported = handler === COUNCIL_ACTION_HANDLER && task.source === COUNCIL_TASK_SOURCE;
    if (!checks.handler_supported) {
      reasons.push(
        `The task names handler ${handler ?? '(none)'}; only the council layer's typed ` +
          `${COUNCIL_ACTION_HANDLER} handler is supported. Unsupported handlers are rejected, never coerced.`,
      );
    }

    let grantStatus = 'missing';
    let resolvedGrantRef: string | null = null;
    try {
      const resolution = await this.runAuthorization.resolveRunGrant({
        tenant_id: scope.tenant_id,
        company_id: scope.company_id,
        session_id: sessionId,
        grant_ref: grantRef,
      });
      grantStatus = resolution.status;
      resolvedGrantRef = resolution.grant_ref;
      checks.grant_active = resolution.status === 'active' && resolution.session_id === sessionId;
      if (checks.grant_active && resolvedGrantRef) {
        try {
          const admission = await this.runAuthorization.admitOperation({
            tenant_id: scope.tenant_id,
            company_id: scope.company_id,
            session_id: sessionId,
            grant_ref: resolvedGrantRef,
            operation_id: operationId,
          });
          checks.operation_admitted = admission.admitted === true;
        } catch {
          checks.operation_admitted = false;
        }
      }
    } catch {
      grantStatus = 'unavailable';
      checks.grant_active = false;
      checks.operation_admitted = false;
    }
    if (!checks.grant_active) {
      reasons.push(
        `No standing execution grant is active for this session (status: ${grantStatus}); ` +
          'plan approval alone never authorizes execution, so the task stays held.',
      );
    } else if (!checks.operation_admitted) {
      reasons.push('The active grant does not admit this task\'s exact operation identity.');
    }

    const dependencies = dependencyStatesFor(this.db, scope, sessionId, planId, item);
    checks.dependencies_satisfied = dependencies.every((dep) => dep.satisfied);
    if (!checks.dependencies_satisfied) {
      const open = dependencies.filter((dep) => !dep.satisfied);
      reasons.push(
        `Dependencies are not complete: ${open
          .map((dep) => `${dep.depends_on_action_id} is ${dep.status ?? 'not created'}`)
          .join(', ')}. A dependent is released only when its own dependencies permit.`,
      );
    }

    const states = this.conditionStates(scope, sessionId);
    const conditions: ConditionState[] = item.source_condition_ids.map(
      (conditionId) =>
        states.get(conditionId) ?? {
          condition_id: conditionId,
          status: 'unverified' as const,
          verification_method: null,
          evidence_refs: [],
          recorded_by: null,
          recorded_at: null,
          verified: false,
        },
    );
    checks.prerequisites_verified = conditions.every((condition) => condition.verified);
    if (!checks.prerequisites_verified) {
      const open = conditions.filter((condition) => !condition.verified);
      reasons.push(
        `Source conditions lack committed verification evidence: ${open
          .map((condition) => condition.condition_id)
          .join(', ')}. A condition is met only by its verification method and actual evidence (Section 19.7).`,
      );
    }

    const releasedEntry = listKanbanJournalEntries(this.db, scope, sessionId).some(
      (entry) =>
        entry.action === 'action_task_released' && entry.payload.operation_id === operationId,
    );
    const alreadyReleased = releasedEntry && task.dispatch_hold !== 1;

    const releasable =
      checks.plan_current &&
      checks.approval_complete &&
      checks.link_matches_plan &&
      checks.handler_supported &&
      checks.grant_active &&
      checks.operation_admitted &&
      checks.dependencies_satisfied &&
      checks.prerequisites_verified;

    return {
      plan_id: planId,
      plan_hash: plan.plan_hash,
      action_id: actionId,
      task_id: task.id,
      operation_id: operationId,
      releasable,
      already_released: alreadyReleased,
      grant_ref: resolvedGrantRef,
      grant_status: grantStatus,
      checks,
      reasons,
      dependencies,
      conditions,
      evaluated_at: this.now(),
    };
  }
}
