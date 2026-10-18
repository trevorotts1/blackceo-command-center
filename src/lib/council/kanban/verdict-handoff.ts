/**
 * WER-024: the verdict -> intended action-task set handoff (v2.4 plan).
 *
 * The council's advisory output is NOT work. A validated verdict is
 * converted into an intended action-task set through the existing
 * action-plan service, and only then through its separate approval
 * authority:
 *
 *   verdict --(create_tasks: propose)--> plan (intended set)
 *           --(approve_plan: one decision per item)--> approved plan
 *           --(execute: materialize)--> HELD action tasks under ONE parent
 *
 * What this module guarantees:
 * - Conversion reads the verdict's own `action_proposals`. Advisor
 *   cards (`council_cards`) are never read here, so 27 advisor cards
 *   can never become 27 tasks. An advisory council vote is not an
 *   execution credential, and a plan approval is not an execution
 *   credential either: materialization creates tasks born behind the
 *   council assembly hold and this layer releases and dispatches
 *   nothing.
 * - Exactly ONE parent task exists per session (the canonical parent
 *   adapter owns that identity); every action task links to it and to
 *   the exact verdict revision and plan hash through the existing
 *   `council_task_links` operation identity.
 * - Durable idempotency: the plan is idempotent on its hash, and the
 *   handoff receipt is journaled as a committed session fact. A
 *   replayed conversion returns the SAME receipt and creates no second
 *   plan, parent or task. Export/replay reads never create anything.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { canonicalHash, validateVerdict, type Verdict } from '../contracts';
import type { CouncilPrincipal } from '../auth';
import { CouncilRepositories } from '../store';
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
  type MaterializePlanResult,
} from './plan-service';

/** The committed receipt of one verdict-to-intended-set conversion. */
export interface IntendedActionTaskSetReceipt {
  handoff_id: string;
  session_id: string;
  tenant_id: string;
  company_id: string;
  plan_id: string;
  plan_hash: string;
  verdict_revision: number;
  /** The verdict content hash the set is bound to. */
  verdict_sha256: string;
  /** The ONE session parent task, or null for a private session. */
  parent_task_id: string | null;
  action_ids: string[];
  action_item_count: number;
  /** True when this delivery replayed an already-committed handoff. */
  replayed: boolean;
  /** An advisory verdict and its plan approval never authorize execution. */
  execution_authorized: false;
  /** Proposing the intended set creates no action task. */
  creates_tasks: 0;
  recorded_at: string;
}

export interface MaterializedActionTaskSetReceipt {
  plan_id: string;
  plan_hash: string;
  parent_task_id: string;
  links: Array<{ action_id: string; task_id: string; operation_id: string; created: boolean }>;
  created_count: number;
  linked_count: number;
  /** Tasks are born held; this layer releases and dispatches nothing. */
  released_count: 0;
  execution_authorized: false;
}

export type VerdictHandoffMaterializeResult =
  | ({ kind: 'materialized' } & MaterializedActionTaskSetReceipt)
  | { kind: 'not_materialized'; reason: 'private_session'; plan_id: string; plan_hash: string };

export interface CouncilVerdictHandoffDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  planService?: CouncilActionPlanService;
  parentAdapter?: CanonicalParentTaskAdapter;
  now?: () => string;
  newId?: () => string;
}

export const VERDICT_HANDOFF_JOURNAL_ACTION = 'verdict_handoff_intended';

export class CouncilVerdictHandoff {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly planService: CouncilActionPlanService;
  private readonly parentAdapter: CanonicalParentTaskAdapter;
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(deps: CouncilVerdictHandoffDeps = {}) {
    this.db = deps.db ?? getDb();
    this.repositories = deps.repositories ?? new CouncilRepositories();
    this.parentAdapter =
      deps.parentAdapter ??
      new CanonicalParentTaskAdapter({
        repositories: this.repositories,
        db: this.db,
        now: deps.now,
        newId: deps.newId,
      });
    this.planService =
      deps.planService ??
      new CouncilActionPlanService({
        repositories: this.repositories,
        db: this.db,
        parentAdapter: this.parentAdapter,
        now: deps.now,
        newId: deps.newId,
      });
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
  }

  // ------------------------------------------------------------ intended

  /**
   * Convert ONE validated verdict into its intended action-task set.
   *
   * Requires the action-plan proposal authority ('create_tasks') and
   * commits a durable handoff receipt. It creates NO action task: only
   * `materializeApprovedActionTasks`, behind the separate approval and
   * execute authorities, ever does. Replaying the conversion returns
   * the committed receipt unchanged.
   */
  async intendActionTaskSet(
    principal: CouncilPrincipal,
    sessionId: string,
    verdict: Verdict,
    opts: { selected_action_ids?: string[]; auth?: KanbanAuthOptions } = {},
  ): Promise<IntendedActionTaskSetReceipt> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'create_tasks',
      'mutate',
      opts.auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const check = validateVerdict(verdict);
    if (!check.ok) {
      throw new CouncilKanbanError(
        'COUNCIL_VERDICT_NOT_VALID',
        'The verdict failed canonical validation and cannot ground an intended action-task set.',
        422,
        { issues: check.issues as unknown as Record<string, unknown> },
      );
    }
    const lockKey = `${scope.tenant_id}:${scope.company_id}:${sessionId}:handoff:${verdict.content_sha256}`;
    return withKeyedLock(lockKey, async () => {
      const plan = await this.planService.proposePlan(principal, sessionId, verdict, {
        selected_action_ids: opts.selected_action_ids,
        auth: opts.auth,
      });
      const prior = this.handoffReceipt(scope, sessionId, plan.plan_id);
      if (prior) return { ...prior, replayed: true };

      const parent = await this.parentAdapter.ensureParentTask(principal, sessionId, opts.auth);
      const parentTaskId = parent.kind === 'linked' ? parent.task_id : null;
      const recordedAt = this.now();
      const receipt: IntendedActionTaskSetReceipt = {
        handoff_id: canonicalHash({
          kind: 'council_verdict_handoff',
          session_id: sessionId,
          plan_id: plan.plan_id,
          plan_hash: plan.plan_hash,
          verdict_sha256: plan.verdict_id,
        }),
        session_id: sessionId,
        tenant_id: scope.tenant_id,
        company_id: scope.company_id,
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        verdict_revision: plan.verdict_revision,
        verdict_sha256: plan.verdict_id,
        parent_task_id: parentTaskId,
        action_ids: plan.items.map((item) => item.action_id),
        action_item_count: plan.items.length,
        replayed: false,
        execution_authorized: false,
        creates_tasks: 0,
        recorded_at: recordedAt,
      };
      this.db
        .transaction(() => {
          appendKanbanJournalEvent(this.db, scope, sessionId, {
            eventId: this.newId(),
            actorSubject: principal.subject,
            action: VERDICT_HANDOFF_JOURNAL_ACTION,
            createdAt: recordedAt,
            data: {
              receipt,
              authorization: { permission: 'create_tasks' },
            },
          });
        })
        .immediate();
      return receipt;
    });
  }

  // ------------------------------------------------------- replay/export

  /**
   * Read one committed handoff (the export/replay path). This creates
   * NO task, no plan, and no journal entry: it only renders committed
   * records. When no handoff receipt was recorded for the plan, the
   * receipt is reconstructed from the plan and the parent link with
   * `replayed: false`; it still creates nothing.
   */
  async exportIntendedActionTaskSet(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    auth?: KanbanAuthOptions,
  ): Promise<IntendedActionTaskSetReceipt> {
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'read', 'read', auth);
    const view = await this.planService.getPlan(principal, sessionId, planId, auth);
    const prior = this.handoffReceipt(scope, sessionId, planId);
    if (prior) return prior;
    const parent = await this.parentAdapter.getParentTask(principal, sessionId, auth);
    return this.receiptFromPlan(scope, view.plan, parent.kind === 'linked' ? parent.task_id : null);
  }

  /** Every committed plan for the session, as intended-set receipts. */
  async listIntendedActionTaskSets(
    principal: CouncilPrincipal,
    sessionId: string,
    auth?: KanbanAuthOptions,
  ): Promise<IntendedActionTaskSetReceipt[]> {
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'read', 'read', auth);
    const plans = await this.planService.listPlans(principal, sessionId, auth);
    const parent = await this.parentAdapter.getParentTask(principal, sessionId, auth);
    const parentTaskId = parent.kind === 'linked' ? parent.task_id : null;
    return plans.map(
      (plan) =>
        this.handoffReceipt(scope, sessionId, plan.plan_id) ??
        this.receiptFromPlan(scope, plan, parentTaskId),
    );
  }

  // -------------------------------------------------------- materialize

  /**
   * Materialize the approved plan's action tasks.
   *
   * Delegates to the existing plan service, which enforces complete
   * item-level approval bound to the exact plan hash/item revisions
   * and the separate 'execute' authority. The created tasks are born
   * held behind the council assembly hold and are never released or
   * dispatched here: council approval does not execute actions.
   */
  async materializeApprovedActionTasks(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    auth?: KanbanAuthOptions,
  ): Promise<VerdictHandoffMaterializeResult> {
    const view = await this.planService.getPlan(principal, sessionId, planId, auth);
    if (!view.coverage.complete) {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_NOT_FULLY_APPROVED',
        'The intended action-task set is materialized only after every item carries its own ' +
          'current approval bound to the plan hash and item revision.',
        409,
        { coverage: view.coverage as unknown as Record<string, unknown> },
      );
    }
    const result: MaterializePlanResult = await this.planService.materializePlanTasks(
      principal,
      sessionId,
      planId,
      auth,
    );
    if (result.kind === 'not_materialized') {
      return {
        kind: 'not_materialized',
        reason: result.reason,
        plan_id: view.plan.plan_id,
        plan_hash: view.plan.plan_hash,
      };
    }
    return {
      kind: 'materialized',
      plan_id: view.plan.plan_id,
      plan_hash: view.plan.plan_hash,
      parent_task_id: result.parent_task_id,
      links: result.links,
      created_count: result.links.filter((link) => link.created).length,
      linked_count: result.links.filter((link) => !link.created).length,
      released_count: 0,
      execution_authorized: false,
    };
  }

  // ------------------------------------------------------------ internals

  private handoffReceipt(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    planId: string,
  ): IntendedActionTaskSetReceipt | null {
    for (const entry of listKanbanJournalEntries(this.db, scope, sessionId)) {
      if (entry.action !== VERDICT_HANDOFF_JOURNAL_ACTION) continue;
      const receipt = entry.payload.receipt;
      if (
        receipt &&
        typeof receipt === 'object' &&
        (receipt as IntendedActionTaskSetReceipt).plan_id === planId
      ) {
        return { ...(receipt as IntendedActionTaskSetReceipt), replayed: false };
      }
    }
    return null;
  }

  private receiptFromPlan(
    scope: { tenant_id: string; company_id: string },
    plan: CouncilActionPlan,
    parentTaskId: string | null,
  ): IntendedActionTaskSetReceipt {
    return {
      handoff_id: canonicalHash({
        kind: 'council_verdict_handoff',
        session_id: plan.session_id,
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        verdict_sha256: plan.verdict_id,
      }),
      session_id: plan.session_id,
      tenant_id: scope.tenant_id,
      company_id: scope.company_id,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      verdict_revision: plan.verdict_revision,
      verdict_sha256: plan.verdict_id,
      parent_task_id: parentTaskId,
      action_ids: plan.items.map((item) => item.action_id),
      action_item_count: plan.items.length,
      replayed: false,
      execution_authorized: false,
      creates_tasks: 0,
      recorded_at: plan.created_at,
    };
  }
}
