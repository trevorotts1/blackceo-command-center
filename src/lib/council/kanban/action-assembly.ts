/**
 * CWE-036 plan assembly under the Section 17.6 dispatch barrier.
 *
 * Assembly is the ONLY path this unit exposes for turning an approved
 * plan into board tasks, and it follows the directive's sequence
 * literally, in order, journaling each stage into the session's
 * hash-chained journal:
 *
 *   1. verify the exact plan approval (current plan, complete
 *      coverage bound to the plan hash) and validate the dependency
 *      graph before anything is created;
 *   2. persist the plan assembly identity and barrier;
 *   3. create or reuse the approved tasks through the canonical core
 *      (createTaskCore) in the nondispatching held mode, one item at
 *      a time, so a dispatcher sweep can be injected between creates;
 *   4. persist the task mappings (council_task_links);
 *   5. resolve and validate every dependency edge to real task IDs;
 *   6. confirm SOP/persona/destination readiness;
 *   7. mark assembly complete;
 *   8. release only the tasks whose standing execution grants,
 *      dependencies, and prerequisites permit (the execution guard).
 *
 * The per-item create below reproduces CWE-035 materializePlanTasks'
 * construction exactly (same description, same operation identity,
 * same idempotency fingerprint, same link row), because T159 requires
 * a sweep point between individual creates, which the service's
 * batch call cannot offer. Both paths check the same link table and
 * the same createTaskCore idempotency identity first, so mixing them
 * converges on one task per action; the CWE-036 suites assert the
 * parity. CWE-050 may retire this mirror if the service grows a
 * single-item materialize surface.
 *
 * Cancelling assembly mid-way never deletes a task and never
 * dispatches one: created tasks that were not released are moved to
 * the lifecycle's visible `blocked` state through transition() (the
 * host lifecycle has no cancelled state; blocked is its visible,
 * non-executing safety-valve state), with the council hold intact.
 * Already-released tasks are authorized downstream work and are not
 * cancelled by implication (Section 19.8).
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { createTaskCore } from '@/lib/tasks';
import { taskRequestFingerprint } from '@/lib/task-request-identity';
import { TransitionError, transition, type LifecycleState } from '@/lib/task-lifecycle';
import type { CouncilPrincipal } from '../auth';
import { CouncilRepositories } from '../store';
import { CouncilActionError } from './action-errors';
import {
  assertActionGraphValid,
  listPlanTaskLinks,
  resolvePlanEdges,
  type ResolvedDependencyEdge,
} from './action-dependencies';
import {
  COUNCIL_PLAN_ASSEMBLING_HOLD,
  COUNCIL_TASK_SOURCE,
  councilActionOperationId,
  councilSourceSessionTag,
} from './constants';
import {
  assertKanbanSessionNotDeleted,
  authorizeKanbanOperation,
  type KanbanAuthOptions,
} from './context';
import { CouncilKanbanError } from './errors';
import { appendKanbanJournalEvent, listKanbanJournalEntries } from './journal';
import { withKeyedLock } from './mutex';
import { CanonicalParentTaskAdapter } from './parent-task';
import {
  CouncilActionPlanService,
  type CouncilActionPlan,
  type PlanItemState,
} from './plan-service';
import {
  COUNCIL_ACTION_HANDLER,
  CouncilActionExecutionGuard,
  type TaskReleaseOutcome,
} from './action-execution';

export type AssemblyStepName =
  | 'approval_verified'
  | 'barrier_persisted'
  | 'task_created'
  | 'edges_resolved'
  | 'readiness_confirmed'
  | 'assembly_completed'
  | 'task_release_evaluated';

export interface AssemblyStepEvent {
  step: AssemblyStepName;
  action_id?: string;
}

export interface AssemblyLinkRecord {
  action_id: string;
  task_id: string;
  operation_id: string;
  created: boolean;
}

export type CouncilPlanAssemblyResult =
  | {
      kind: 'assembled';
      assembly_id: string;
      plan_id: string;
      plan_hash: string;
      parent_task_id: string;
      links: AssemblyLinkRecord[];
      edges: ResolvedDependencyEdge[];
      releases: TaskReleaseOutcome[];
    }
  | { kind: 'not_assembled'; reason: 'private_session'; plan_id: string; plan_hash: string };

export interface AssemblyCancelOutcome {
  action_id: string;
  task_id: string;
  outcome:
    | 'blocked'
    | 'already_blocked'
    | 'already_released'
    | 'already_done'
    | 'transition_refused';
  detail?: string;
}

export interface CouncilPlanAssemblyDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  planService?: CouncilActionPlanService;
  parentAdapter?: CanonicalParentTaskAdapter;
  executionGuard?: CouncilActionExecutionGuard;
  now?: () => string;
  newId?: () => string;
}

export class CouncilPlanAssembly {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly planService: CouncilActionPlanService;
  private readonly parentAdapter: CanonicalParentTaskAdapter;
  private readonly executionGuard: CouncilActionExecutionGuard;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: CouncilPlanAssemblyDeps = {}) {
    this.db = deps.db ?? getDb();
    this.repositories = deps.repositories ?? new CouncilRepositories();
    this.planService =
      deps.planService ??
      new CouncilActionPlanService({
        repositories: this.repositories,
        db: this.db,
        now: deps.now,
        newId: deps.newId,
      });
    this.parentAdapter =
      deps.parentAdapter ??
      new CanonicalParentTaskAdapter({
        repositories: this.repositories,
        db: this.db,
        now: deps.now,
        newId: deps.newId,
      });
    this.executionGuard =
      deps.executionGuard ??
      new CouncilActionExecutionGuard({
        repositories: this.repositories,
        db: this.db,
        planService: this.planService,
        now: deps.now,
        newId: deps.newId,
      });
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  /** The latest assembly identity recorded for a plan, if any. */
  assemblyRecord(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    planId: string,
  ): { assembly_id: string; completed: boolean } | null {
    const entries = listKanbanJournalEntries(this.db, scope, sessionId);
    let assemblyId: string | null = null;
    let completed = false;
    for (const entry of entries) {
      if (entry.payload.plan_id !== planId) continue;
      if (entry.action === 'assembly_started' && typeof entry.payload.assembly_id === 'string') {
        assemblyId = entry.payload.assembly_id;
        completed = false;
      }
      if (entry.action === 'assembly_completed' && entry.payload.assembly_id === assemblyId) {
        completed = true;
      }
    }
    return assemblyId ? { assembly_id: assemblyId, completed } : null;
  }

  /**
   * Run the full Section 17.6 assembly for one fully approved plan.
   * Idempotent: re-running after a mid-batch failure creates only the
   * missing tasks and preserves every already-created task ID (T093).
   */
  async assemblePlan(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    opts: {
      grant_ref?: string | null;
      auth?: KanbanAuthOptions;
      onStep?: (event: AssemblyStepEvent) => Promise<void> | void;
      /**
       * CWE-045 composition hook: invoked with every release outcome
       * the guard chain produces in step 8, in evaluation order. The
       * composed route layer binds CWE-037's recordReleaseOutcomes
       * here so refused releases become recorded session state.
       */
      onReleaseOutcome?: (outcome: TaskReleaseOutcome) => Promise<void> | void;
    } = {},
  ): Promise<CouncilPlanAssemblyResult> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'mutate',
      opts.auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const onStep = opts.onStep ?? (() => undefined);

    // Step 1: verify the exact plan approval before creating anything.
    const view = await this.planService.getPlan(principal, sessionId, planId, opts.auth);
    const plan = view.plan;
    if (plan.status === 'superseded') {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_SUPERSEDED',
        `Plan ${planId} was superseded; assembly binds to the current plan only.`,
        409,
      );
    }
    if (!view.coverage.complete) {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_NOT_FULLY_APPROVED',
        'Plan tasks are created only after every selected item carries a current approval.',
        409,
        { coverage: view.coverage as unknown as Record<string, unknown> },
      );
    }
    assertActionGraphValid(plan.items);
    await onStep({ step: 'approval_verified' });

    const lockKey = `${scope.tenant_id}:${scope.company_id}:${sessionId}:materialize:${plan.plan_hash}`;
    return withKeyedLock(lockKey, async () => {
      const parent = await this.parentAdapter.ensureParentTask(principal, sessionId, opts.auth);
      if (parent.kind === 'none') {
        return {
          kind: 'not_assembled',
          reason: 'private_session',
          plan_id: plan.plan_id,
          plan_hash: plan.plan_hash,
        } as CouncilPlanAssemblyResult;
      }

      // Step 2: persist the assembly identity and barrier.
      const existingAssembly = this.assemblyRecord(scope, sessionId, planId);
      const assemblyId = existingAssembly?.assembly_id ?? this.newId();
      if (!existingAssembly) {
        this.db
          .transaction(() => {
            appendKanbanJournalEvent(this.db, scope, sessionId, {
              eventId: this.newId(),
              actorSubject: principal.subject,
              action: 'assembly_started',
              createdAt: this.now(),
              data: {
                assembly_id: assemblyId,
                plan_id: plan.plan_id,
                plan_hash: plan.plan_hash,
                barrier: COUNCIL_PLAN_ASSEMBLING_HOLD,
                operation_ids: plan.required_execution_grant.operation_ids,
                authorization: { permission: 'execute' },
              },
            });
          })
          .immediate();
      }
      await onStep({ step: 'barrier_persisted' });

      // Steps 3-4: create or reuse each task through the canonical
      // core in the nondispatching held mode; persist each mapping.
      const links: AssemblyLinkRecord[] = [];
      for (const item of plan.items) {
        const link = await this.ensureActionTask(scope, sessionId, plan, item, parent.task_id);
        links.push(link);
        await onStep({ step: 'task_created', action_id: item.action_id });
      }
      appendKanbanJournalEvent(this.db, scope, sessionId, {
        eventId: this.newId(),
        actorSubject: principal.subject,
        action: 'plan_tasks_materialized',
        createdAt: this.now(),
        data: {
          plan_id: plan.plan_id,
          plan_hash: plan.plan_hash,
          parent_task_id: parent.task_id,
          assembly_id: assemblyId,
          created_count: links.filter((link) => link.created).length,
          linked_count: links.filter((link) => !link.created).length,
          task_ids: links.map((link) => link.task_id),
          authorization: { permission: 'execute' },
        },
      });

      // Step 5: resolve and validate every dependency edge.
      const edges: ResolvedDependencyEdge[] = [];
      for (const item of plan.items) {
        const itemEdges = resolvePlanEdges(this.db, scope, sessionId, planId, [item]);
        for (const edge of itemEdges) {
          if (!edge.task_id || !edge.depends_on_task_id) {
            throw new CouncilActionError(
              'COUNCIL_DEPENDENCY_INVALID',
              `Dependency edge ${item.action_id} -> ${edge.depends_on_action_id} did not resolve to created tasks.`,
              422,
            );
          }
          edges.push(edge);
        }
        await onStep({ step: 'edges_resolved', action_id: item.action_id });
      }
      appendKanbanJournalEvent(this.db, scope, sessionId, {
        eventId: this.newId(),
        actorSubject: principal.subject,
        action: 'assembly_edges_resolved',
        createdAt: this.now(),
        data: { assembly_id: assemblyId, plan_id: plan.plan_id, edges },
      });

      // Step 6: confirm SOP/persona/destination readiness.
      const readiness = this.executionGuard.confirmDestinationReadiness(scope, plan);
      if (!readiness.ok) {
        appendKanbanJournalEvent(this.db, scope, sessionId, {
          eventId: this.newId(),
          actorSubject: principal.subject,
          action: 'assembly_readiness_failed',
          createdAt: this.now(),
          data: {
            assembly_id: assemblyId,
            plan_id: plan.plan_id,
            failures: readiness.failures,
          },
        });
        throw new CouncilActionError(
          'COUNCIL_ASSEMBLY_READINESS_FAILED',
          'Assembly readiness confirmation failed; created tasks remain held and nothing was released.',
          422,
          { failures: readiness.failures as unknown as Record<string, unknown> },
        );
      }
      await onStep({ step: 'readiness_confirmed' });

      // Step 7: mark assembly complete.
      this.db
        .transaction(() => {
          appendKanbanJournalEvent(this.db, scope, sessionId, {
            eventId: this.newId(),
            actorSubject: principal.subject,
            action: 'assembly_completed',
            createdAt: this.now(),
            data: {
              assembly_id: assemblyId,
              plan_id: plan.plan_id,
              plan_hash: plan.plan_hash,
              task_ids: links.map((link) => link.task_id),
              authorization: { permission: 'execute' },
            },
          });
        })
        .immediate();
      await onStep({ step: 'assembly_completed' });

      // Step 8: release only what the guards permit, per task.
      const releases = await this.executionGuard.releaseReadyTasks(
        principal,
        sessionId,
        planId,
        {
          grant_ref: opts.grant_ref ?? null,
          auth: opts.auth,
          onTask: async (outcome) => {
            await onStep({ step: 'task_release_evaluated', action_id: outcome.action_id });
            if (opts.onReleaseOutcome) await opts.onReleaseOutcome(outcome);
          },
        },
      );

      return {
        kind: 'assembled',
        assembly_id: assemblyId,
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        parent_task_id: parent.task_id,
        links,
        edges,
        releases,
      } as CouncilPlanAssemblyResult;
    });
  }

  /**
   * Cancel an assembly. Created tasks that were never released are
   * moved to the visible blocked state through transition(); released
   * tasks are downstream work already authorized and stay untouched;
   * nothing is deleted and nothing is dispatched.
   */
  async cancelAssembly(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    auth?: KanbanAuthOptions,
  ): Promise<{ plan_id: string; outcomes: AssemblyCancelOutcome[] }> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'mutate',
      auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const links = listPlanTaskLinks(this.db, scope, sessionId, planId);
    const releasedOps = new Set(
      listKanbanJournalEntries(this.db, scope, sessionId)
        .filter((entry) => entry.action === 'action_task_released')
        .map((entry) => entry.payload.operation_id),
    );
    const outcomes: AssemblyCancelOutcome[] = [];
    for (const link of links) {
      const task = this.db
        .prepare('SELECT id, status FROM tasks WHERE id = ?')
        .get(link.task_id) as { id: string; status: string } | undefined;
      if (!task) continue;
      if (releasedOps.has(link.operation_id)) {
        outcomes.push({ action_id: link.action_id, task_id: link.task_id, outcome: 'already_released' });
        continue;
      }
      if (task.status === 'done') {
        outcomes.push({ action_id: link.action_id, task_id: link.task_id, outcome: 'already_done' });
        continue;
      }
      if (task.status === 'blocked') {
        outcomes.push({ action_id: link.action_id, task_id: link.task_id, outcome: 'already_blocked' });
        continue;
      }
      try {
        await transition(link.task_id, 'blocked', {
          actor: 'council-plan-assembly',
          reason: 'Council plan assembly cancelled before this task was released',
          expectedFrom: task.status as LifecycleState,
        });
        outcomes.push({ action_id: link.action_id, task_id: link.task_id, outcome: 'blocked' });
      } catch (err) {
        outcomes.push({
          action_id: link.action_id,
          task_id: link.task_id,
          outcome: 'transition_refused',
          detail: err instanceof TransitionError ? err.code : (err as Error).message,
        });
      }
    }
    appendKanbanJournalEvent(this.db, scope, sessionId, {
      eventId: this.newId(),
      actorSubject: principal.subject,
      action: 'assembly_cancelled',
      createdAt: this.now(),
      data: {
        plan_id: planId,
        outcomes,
        authorization: { permission: 'execute' },
      },
    });
    return { plan_id: planId, outcomes };
  }

  // ---------------------------------------------------------- internals

  /**
   * Create or reuse ONE action task through createTaskCore, mirroring
   * CWE-035 materializePlanTasks' per-item construction exactly (see
   * the module header for why this mirror exists and how parity is
   * proven). Born held behind council_plan_assembling, tagged with
   * the source-session recursion tag, linked in council_task_links.
   */
  private async ensureActionTask(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    plan: CouncilActionPlan,
    item: PlanItemState,
    parentTaskId: string,
  ): Promise<AssemblyLinkRecord> {
    const operationId = councilActionOperationId({
      sessionId,
      verdictRevision: plan.verdict_revision,
      actionId: item.action_id,
      planHash: plan.plan_hash,
    });
    const existingLink = this.db
      .prepare(
        `SELECT task_id FROM council_task_links
          WHERE tenant_id = ? AND company_id = ? AND operation_id = ?`,
      )
      .get(scope.tenant_id, scope.company_id, operationId) as { task_id: string } | undefined;
    if (existingLink) {
      return {
        action_id: item.action_id,
        task_id: existingLink.task_id,
        operation_id: operationId,
        created: false,
      };
    }
    const description = [
      councilSourceSessionTag(sessionId),
      `Handler: ${COUNCIL_ACTION_HANDLER}`,
      `Session: /council/sessions/${sessionId}`,
      `Plan: ${plan.plan_hash}`,
      `Operation: ${operationId}`,
      `Action: ${item.action_id} (revision ${item.item_revision})`,
      '',
      item.description,
      '',
      `Rationale: ${item.rationale}`,
      ...(item.acceptance_criteria.length > 0
        ? ['', 'Acceptance criteria:', ...item.acceptance_criteria.map((c) => `- ${c}`)]
        : []),
      ...(item.source_condition_ids.length > 0
        ? ['', `Source conditions: ${item.source_condition_ids.join(', ')}`]
        : []),
      '',
      'Execution authorization required: yes. This task is held behind ' +
        'council_plan_assembling and dispatches only under a separate ' +
        'execution grant; council approval alone never executes it.',
    ].join('\n');
    const result = await createTaskCore({
      title: item.title,
      description,
      source: COUNCIL_TASK_SOURCE,
      sop_id: item.sop_id ?? undefined,
      parent_task_id: parentTaskId,
      routing_hold_reason: COUNCIL_PLAN_ASSEMBLING_HOLD,
      idempotency_company_id: scope.company_id,
      idempotency_key: operationId,
      idempotency_payload_hash: taskRequestFingerprint({
        kind: 'council_action_task',
        operation_id: operationId,
        plan_hash: plan.plan_hash,
        item_sha256: item.item_sha256,
      }),
      skipWindowDedup: true,
    });
    if (!result) {
      throw new CouncilKanbanError(
        'COUNCIL_PARENT_CREATE_FAILED',
        `createTaskCore did not return a task for council action ${item.action_id}.`,
        500,
      );
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO council_task_links
           (tenant_id, company_id, session_id, id, parent_session_task_id, action_proposal_id,
            action_id, plan_hash, operation_id, task_id, task_board_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.tenant_id,
        scope.company_id,
        sessionId,
        this.newId(),
        parentTaskId,
        plan.plan_id,
        item.action_id,
        plan.plan_hash,
        operationId,
        result.task.id,
        result.task.status,
        this.now(),
      );
    return {
      action_id: item.action_id,
      task_id: result.task.id,
      operation_id: operationId,
      created: !result.deduped,
    };
  }
}
