/**
 * CWE-035 action plan service (Sections 19.5, 25; plan side of 17.6).
 *
 * A plan is the hash-bound set of action proposals selected from one
 * validated verdict. It lives in the CWE-005 council_action_proposals
 * table, and every lifecycle fact is also written to the session's
 * hash-chained journal (see journal.ts).
 *
 * The Section 25 separations are enforced structurally:
 * - Proposing a plan requires the 'create_tasks' authorization and
 *   executes nothing.
 * - Approving requires the DISTINCT 'approve_plan' authorization, one
 *   explicit decision per actionable item, each bound to the exact
 *   item revision and plan hash (Section 19.5: the approval hash covers
 *   the selected action revisions, dependencies, budgets, destination,
 *   and verdict revision, all inside the item and plan hashes). Editing
 *   an item supersedes the plan and strands every earlier approval.
 * - A council vote is never an execution credential: the plan only
 *   RECORDS the execution grant it would require.
 * - Materializing tasks requires 'execute' and creates the children
 *   born held behind council_plan_assembling; releasing a plan
 *   requires 'execute' plus a complete approval and an active run
 *   grant resolved through the Section 25.6 port, and release only
 *   marks the plan ready. No code path here dispatches a task or lifts
 *   a hold; dispatch belongs to CWE-036 and CWE-050.
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from '@/lib/db';
import { createTaskCore } from '@/lib/tasks';
import { taskRequestFingerprint } from '@/lib/task-request-identity';
import {
  canonicalHash,
  canonicalStringify,
  validateActionProposal,
  validateVerdict,
  type ActionProposal,
  type Verdict,
} from '../contracts';
import type { CouncilPrincipal } from '../auth';
import { CouncilRepositories } from '../store';
import {
  COUNCIL_PLAN_ASSEMBLING_HOLD,
  COUNCIL_TASK_SOURCE,
  councilActionOperationId,
  councilSourceSessionTag,
} from './constants';
import {
  assertKanbanSessionNotDeleted,
  authorizeKanbanOperation,
  isPrivateSessionRow,
  kanbanEnvelope,
  type KanbanAuthOptions,
} from './context';
import { CouncilKanbanError } from './errors';
import { appendKanbanJournalEvent, latestKanbanJournalEntry } from './journal';
import { withKeyedLock } from './mutex';
import { CanonicalParentTaskAdapter } from './parent-task';
import {
  UnavailableRunAuthorizationPort,
  type CouncilRunAuthorizationPort,
} from './run-authorization-port';

export interface PlanItemState extends ActionProposal {
  item_revision: number;
  item_sha256: string;
}

export interface RequiredExecutionGrant {
  kind: 'execution';
  session_id: string;
  plan_hash: string;
  verdict_revision: number;
  operation_ids: string[];
  budgets: Array<{ currency: string; amount_minor: number }>;
  max_cost_minor: number | null;
  currency: string | null;
  note: string;
}

export interface CouncilActionPlan {
  plan_id: string;
  session_id: string;
  tenant_id: string;
  company_id: string;
  /** The verdict's content hash; uniquely identifies the verdict content. */
  verdict_id: string;
  verdict_revision: number;
  plan_hash: string;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded' | 'executed' | 'expired';
  risk_class: string;
  supersedes_id: string | null;
  items: PlanItemState[];
  required_execution_grant: RequiredExecutionGrant;
  created_at: string;
}

export interface PlanItemCoverage {
  action_id: string;
  item_revision: number;
  covered: boolean;
  decision: 'approved' | 'rejected' | null;
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  target_sha256: string | null;
}

export interface CouncilPlanCoverage {
  plan_id: string;
  plan_hash: string;
  complete: boolean;
  items: PlanItemCoverage[];
}

export interface CouncilPlanReleaseEvaluation {
  plan_id: string;
  plan_hash: string;
  releasable: boolean;
  readiness: 'ready_for_execution_dispatch' | 'not_ready';
  conditions: {
    plan_fully_approved: boolean;
    execution_grant_requirement_recorded: boolean;
    run_grant_active: boolean;
    run_grant_ref: string | null;
    run_grant_status: string;
  };
}

export interface CouncilActionPlanView {
  plan: CouncilActionPlan;
  coverage: CouncilPlanCoverage;
  release: CouncilPlanReleaseEvaluation | null;
  released: { grant_ref: string | null; released_at: string; released_by: string } | null;
}

export type MaterializePlanResult =
  | {
      kind: 'materialized';
      parent_task_id: string;
      links: Array<{ action_id: string; task_id: string; operation_id: string; created: boolean }>;
    }
  | { kind: 'not_materialized'; reason: 'private_session' };

export interface CouncilActionPlanDeps {
  repositories?: CouncilRepositories;
  db?: Database.Database;
  parentAdapter?: CanonicalParentTaskAdapter;
  runAuthorization?: CouncilRunAuthorizationPort;
  now?: () => string;
  newId?: () => string;
  /** Default lifetime of an item approval decision (30 days). */
  approvalTtlMs?: number;
}

interface PlanRow {
  id: string;
  verdict_id: string;
  plan_hash: string;
  actions_json: string;
  risk_class: string;
  status: CouncilActionPlan['status'];
  supersedes_id: string | null;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  actor_subject: string;
  scope_proof: string;
  current_plan_hash: string | null;
  issued_at: string;
  expires_at: string;
}

const RISK_ORDER = ['low', 'medium', 'high', 'critical'] as const;
const DEFAULT_APPROVAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MUTABLE_ITEM_FIELDS = [
  'title',
  'description',
  'rationale',
  'source_condition_ids',
  'department_id',
  'assigned_agent_id',
  'sop_id',
  'persona_id',
  'acceptance_criteria',
  'budget_limit',
  'due_at',
  'depends_on_action_ids',
  'risk_class',
] as const;

function itemContent(item: ActionProposal): Record<string, unknown> {
  const { ...rest } = item as unknown as Record<string, unknown>;
  delete rest.item_revision;
  delete rest.item_sha256;
  return rest;
}

function hashItem(item: ActionProposal, itemRevision: number): string {
  return canonicalHash({ action: itemContent(item), item_revision: itemRevision });
}

function computePlanHash(input: {
  sessionId: string;
  verdictRevision: number;
  verdictSha256: string;
  tenantId: string;
  companyId: string;
  items: PlanItemState[];
}): string {
  return canonicalHash({
    kind: 'council_action_plan',
    session_id: input.sessionId,
    verdict_revision: input.verdictRevision,
    verdict_sha256: input.verdictSha256,
    destination: { tenant_id: input.tenantId, company_id: input.companyId },
    items: input.items.map((item) => ({
      action_id: item.action_id,
      item_revision: item.item_revision,
      item_sha256: item.item_sha256,
    })),
  });
}

function requiredGrantFor(plan: {
  session_id: string;
  plan_hash: string;
  verdict_revision: number;
  items: PlanItemState[];
}): RequiredExecutionGrant {
  const byCurrency = new Map<string, number>();
  for (const item of plan.items) {
    if (!item.budget_limit) continue;
    byCurrency.set(
      item.budget_limit.currency,
      (byCurrency.get(item.budget_limit.currency) ?? 0) + item.budget_limit.amount_minor,
    );
  }
  const budgets = [...byCurrency.entries()].map(([currency, amount_minor]) => ({
    currency,
    amount_minor,
  }));
  return {
    kind: 'execution',
    session_id: plan.session_id,
    plan_hash: plan.plan_hash,
    verdict_revision: plan.verdict_revision,
    operation_ids: plan.items.map((item) =>
      councilActionOperationId({
        sessionId: plan.session_id,
        verdictRevision: plan.verdict_revision,
        actionId: item.action_id,
        planHash: plan.plan_hash,
      }),
    ),
    budgets,
    max_cost_minor: budgets.length === 1 ? budgets[0].amount_minor : null,
    currency: budgets.length === 1 ? budgets[0].currency : null,
    note:
      'The execution grant this plan would require. Recording the requirement ' +
      'issues no grant, approves nothing, and executes nothing.',
  };
}

export class CouncilActionPlanService {
  private readonly repositories: CouncilRepositories;
  private readonly db: Database.Database;
  private readonly parentAdapter: CanonicalParentTaskAdapter;
  private readonly runAuthorization: CouncilRunAuthorizationPort;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly approvalTtlMs: number;

  constructor(deps: CouncilActionPlanDeps = {}) {
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
    this.runAuthorization = deps.runAuthorization ?? new UnavailableRunAuthorizationPort();
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? (() => randomUUID());
    this.approvalTtlMs = deps.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  }

  // ------------------------------------------------------------ internals

  private planRow(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    planId: string,
  ): PlanRow {
    const row = this.db
      .prepare(
        `SELECT id, verdict_id, plan_hash, actions_json, risk_class, status, supersedes_id, created_at
           FROM council_action_proposals
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId, planId) as PlanRow | undefined;
    if (!row) {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_NOT_FOUND',
        `Council action plan ${planId} was not found for session ${sessionId}.`,
        404,
      );
    }
    return row;
  }

  private rowToPlan(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    row: PlanRow,
  ): CouncilActionPlan {
    const items = JSON.parse(row.actions_json) as PlanItemState[];
    const first = items[0];
    const base = {
      session_id: sessionId,
      plan_hash: row.plan_hash,
      verdict_revision: first?.verdict_revision ?? 0,
      items,
    };
    return {
      plan_id: row.id,
      session_id: sessionId,
      tenant_id: scope.tenant_id,
      company_id: scope.company_id,
      verdict_id: row.verdict_id,
      verdict_revision: base.verdict_revision,
      plan_hash: row.plan_hash,
      status: row.status,
      risk_class: row.risk_class,
      supersedes_id: row.supersedes_id,
      items,
      required_execution_grant: requiredGrantFor(base),
      created_at: row.created_at,
    };
  }

  private standingDecisions(
    scope: { tenant_id: string; company_id: string },
    plan: CouncilActionPlan,
  ): Map<string, { row: ApprovalRow; proof: Record<string, unknown> }> {
    const rows = this.db
      .prepare(
        `SELECT id, actor_subject, scope_proof, current_plan_hash, issued_at, expires_at
           FROM council_approvals
          WHERE tenant_id = ? AND company_id = ? AND kind = 'action_plan'
            AND action_proposal_id = ? AND status = 'active'
          ORDER BY issued_at ASC`,
      )
      .all(scope.tenant_id, scope.company_id, plan.plan_id) as ApprovalRow[];
    const standing = new Map<string, { row: ApprovalRow; proof: Record<string, unknown> }>();
    for (const row of rows) {
      let proof: Record<string, unknown>;
      try {
        proof = JSON.parse(row.scope_proof) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof proof.action_id === 'string') {
        standing.set(proof.action_id, { row, proof });
      }
    }
    return standing;
  }

  private coverageFor(
    scope: { tenant_id: string; company_id: string },
    plan: CouncilActionPlan,
  ): CouncilPlanCoverage {
    const standing = this.standingDecisions(scope, plan);
    const nowIso = this.now();
    const items: PlanItemCoverage[] = plan.items.map((item) => {
      const entry = standing.get(item.action_id);
      if (!entry) {
        return {
          action_id: item.action_id,
          item_revision: item.item_revision,
          covered: false,
          decision: null,
          decided_by: null,
          decided_at: null,
          expires_at: null,
          target_sha256: null,
        };
      }
      const decision = entry.proof.decision === 'rejected' ? 'rejected' : 'approved';
      const bound =
        entry.proof.item_revision === item.item_revision &&
        entry.proof.plan_hash === plan.plan_hash &&
        entry.row.expires_at > nowIso;
      return {
        action_id: item.action_id,
        item_revision: item.item_revision,
        covered: decision === 'approved' && bound,
        decision: bound ? decision : null,
        decided_by: entry.row.actor_subject,
        decided_at: entry.row.issued_at,
        expires_at: entry.row.expires_at,
        target_sha256: typeof entry.proof.target_sha256 === 'string' ? entry.proof.target_sha256 : null,
      };
    });
    return {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      complete: items.length > 0 && items.every((item) => item.covered),
      items,
    };
  }

  private refreshPlanStatus(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    plan: CouncilActionPlan,
  ): CouncilActionPlan {
    if (plan.status === 'superseded' || plan.status === 'executed' || plan.status === 'expired') {
      return plan;
    }
    const coverage = this.coverageFor(scope, plan);
    let next: CouncilActionPlan['status'] = 'proposed';
    if (coverage.complete) next = 'approved';
    else if (
      coverage.items.length > 0 &&
      coverage.items.every((item) => item.decision === 'rejected')
    ) {
      next = 'rejected';
    }
    if (next !== plan.status) {
      this.db
        .prepare(
          `UPDATE council_action_proposals SET status = ?
            WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?`,
        )
        .run(next, scope.tenant_id, scope.company_id, sessionId, plan.plan_id);
      plan = { ...plan, status: next };
    }
    return plan;
  }

  private async releaseEvaluation(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    plan: CouncilActionPlan,
    coverage: CouncilPlanCoverage,
    grantRef?: string | null,
  ): Promise<CouncilPlanReleaseEvaluation> {
    const resolution = await this.runAuthorization.resolveRunGrant({
      tenant_id: scope.tenant_id,
      company_id: scope.company_id,
      session_id: sessionId,
      grant_ref: grantRef ?? null,
    });
    const conditions = {
      plan_fully_approved: coverage.complete,
      execution_grant_requirement_recorded: plan.required_execution_grant.operation_ids.length > 0,
      run_grant_active: resolution.status === 'active',
      run_grant_ref: resolution.grant_ref,
      run_grant_status: resolution.status,
    };
    const releasable =
      conditions.plan_fully_approved &&
      conditions.execution_grant_requirement_recorded &&
      conditions.run_grant_active;
    return {
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      releasable,
      readiness: releasable ? 'ready_for_execution_dispatch' : 'not_ready',
      conditions,
    };
  }

  private releasedState(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    planId: string,
  ): CouncilActionPlanView['released'] {
    const entry = latestKanbanJournalEntry(this.db, scope, sessionId, 'plan_released');
    if (!entry || entry.payload.plan_id !== planId) return null;
    return {
      grant_ref: typeof entry.payload.grant_ref === 'string' ? entry.payload.grant_ref : null,
      released_at: entry.created_at,
      released_by: entry.actor_subject,
    };
  }

  private async view(
    scope: { tenant_id: string; company_id: string },
    sessionId: string,
    plan: CouncilActionPlan,
  ): Promise<CouncilActionPlanView> {
    const coverage = this.coverageFor(scope, plan);
    const release = await this.releaseEvaluation(scope, sessionId, plan, coverage);
    return { plan, coverage, release, released: this.releasedState(scope, sessionId, plan.plan_id) };
  }

  // -------------------------------------------------------------- propose

  /**
   * Create the plan for a validated verdict (idempotent on the plan
   * hash). Proposing supersedes any earlier open plan for the session:
   * only one current plan can be approved or materialized.
   */
  async proposePlan(
    principal: CouncilPrincipal,
    sessionId: string,
    verdict: Verdict,
    opts: { selected_action_ids?: string[]; auth?: KanbanAuthOptions } = {},
  ): Promise<CouncilActionPlan> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'create_tasks',
      'mutate',
      opts.auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const verdictCheck = validateVerdict(verdict);
    if (!verdictCheck.ok) {
      throw new CouncilKanbanError(
        'COUNCIL_VERDICT_NOT_VALID',
        'The verdict failed canonical contract validation and cannot ground a plan.',
        422,
        { issues: verdictCheck.issues as unknown as Record<string, unknown> },
      );
    }
    if (verdict.session_id !== sessionId || verdict.validation_status !== 'valid') {
      throw new CouncilKanbanError(
        'COUNCIL_VERDICT_NOT_VALID',
        'Only a validated verdict for this session can ground an action plan.',
      );
    }
    if (verdict.result_kind !== 'scored') {
      throw new CouncilKanbanError(
        'COUNCIL_VERDICT_NOT_VALID',
        'A consult verdict carries no action proposals; only a scored verdict can ground an action plan.',
      );
    }
    const envelope = kanbanEnvelope(principal, scope, 'write');
    const stored = this.repositories.getSession(envelope, sessionId);
    if (!stored) {
      throw new CouncilKanbanError(
        'COUNCIL_SESSION_NOT_FOUND',
        `Council session ${sessionId} is not visible in the caller's scope.`,
        404,
      );
    }
    const selected = (verdict.action_proposals ?? []).filter(
      (item) =>
        !opts.selected_action_ids || opts.selected_action_ids.includes(item.action_id),
    );
    if (selected.length === 0) {
      throw new CouncilKanbanError(
        'COUNCIL_VERDICT_NOT_VALID',
        'The verdict carries no selected action proposals to plan.',
      );
    }
    const items: PlanItemState[] = selected.map((item) => {
      const check = validateActionProposal(item);
      if (!check.ok) {
        throw new CouncilKanbanError(
          'COUNCIL_VERDICT_NOT_VALID',
          `Action proposal ${item.action_id} failed canonical validation.`,
          422,
          { issues: check.issues as unknown as Record<string, unknown> },
        );
      }
      if (item.session_id !== sessionId || item.verdict_revision !== verdict.verdict_revision) {
        throw new CouncilKanbanError(
          'COUNCIL_VERDICT_NOT_VALID',
          `Action proposal ${item.action_id} does not belong to this session and verdict revision.`,
        );
      }
      return { ...item, item_revision: 1, item_sha256: hashItem(item, 1) };
    });
    const planHash = computePlanHash({
      sessionId,
      verdictRevision: verdict.verdict_revision,
      verdictSha256: verdict.content_sha256,
      tenantId: scope.tenant_id,
      companyId: scope.company_id,
      items,
    });
    const existing = this.db
      .prepare(
        `SELECT id, verdict_id, plan_hash, actions_json, risk_class, status, supersedes_id, created_at
           FROM council_action_proposals
          WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND plan_hash = ?`,
      )
      .get(scope.tenant_id, scope.company_id, sessionId, planHash) as PlanRow | undefined;
    if (existing) return this.rowToPlan(scope, sessionId, existing);

    const riskClass = items.reduce<string>(
      (max, item) =>
        RISK_ORDER.indexOf(item.risk_class as (typeof RISK_ORDER)[number]) >
        RISK_ORDER.indexOf(max as (typeof RISK_ORDER)[number])
          ? item.risk_class
          : max,
      'low',
    );
    const planId = this.newId();
    const createdAt = this.now();
    const superseded = this.db
      .prepare(
        `SELECT id FROM council_action_proposals
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
            AND status IN ('proposed', 'approved', 'rejected')`,
      )
      .all(scope.tenant_id, scope.company_id, sessionId) as Array<{ id: string }>;
    const planBase = {
      session_id: sessionId,
      plan_hash: planHash,
      verdict_revision: verdict.verdict_revision,
      items,
    };
    this.db
      .transaction(() => {
        for (const stale of superseded) {
          this.db
            .prepare(
              `UPDATE council_action_proposals SET status = 'superseded'
                WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?`,
            )
            .run(scope.tenant_id, scope.company_id, sessionId, stale.id);
        }
        this.db
          .prepare(
            `INSERT INTO council_action_proposals
               (tenant_id, company_id, session_id, id, verdict_id, plan_hash, actions_json, risk_class, status, supersedes_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, ?)`,
          )
          .run(
            scope.tenant_id,
            scope.company_id,
            sessionId,
            planId,
            verdict.content_sha256,
            planHash,
            canonicalStringify(items),
            riskClass,
            createdAt,
          );
        appendKanbanJournalEvent(this.db, scope, sessionId, {
          eventId: this.newId(),
          actorSubject: principal.subject,
          action: 'plan_proposed',
          createdAt,
          data: {
            plan_id: planId,
            plan_hash: planHash,
            verdict_revision: verdict.verdict_revision,
            verdict_sha256: verdict.content_sha256,
            item_count: items.length,
            superseded_plan_ids: superseded.map((row) => row.id),
            required_execution_grant: requiredGrantFor(planBase),
            authorization: { permission: 'create_tasks' },
          },
        });
      })
      .immediate();
    return this.rowToPlan(scope, sessionId, this.planRow(scope, sessionId, planId));
  }

  /** Read one plan with its approval coverage and release evaluation. */
  async getPlan(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilActionPlanView> {
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'read', 'read', auth);
    const plan = this.refreshPlanStatus(
      scope,
      sessionId,
      this.rowToPlan(scope, sessionId, this.planRow(scope, sessionId, planId)),
    );
    return this.view(scope, sessionId, plan);
  }

  /** All plans recorded for the session, oldest first. */
  async listPlans(
    principal: CouncilPrincipal,
    sessionId: string,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilActionPlan[]> {
    const { scope } = authorizeKanbanOperation(this.db, principal, sessionId, 'read', 'read', auth);
    const rows = this.db
      .prepare(
        `SELECT id, verdict_id, plan_hash, actions_json, risk_class, status, supersedes_id, created_at
           FROM council_action_proposals
          WHERE tenant_id = ? AND company_id = ? AND session_id = ?
          ORDER BY created_at ASC`,
      )
      .all(scope.tenant_id, scope.company_id, sessionId) as PlanRow[];
    return rows.map((row) => this.rowToPlan(scope, sessionId, row));
  }

  // --------------------------------------------------------------- revise

  /**
   * Edit one plan item. The edit supersedes the whole plan: the edited
   * item's revision increments, the plan hash is recomputed, and every
   * approval recorded against the earlier hash stops covering the plan.
   */
  async revisePlanItem(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    actionId: string,
    patch: Partial<ActionProposal>,
    auth?: KanbanAuthOptions,
  ): Promise<CouncilActionPlan> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'create_tasks',
      'mutate',
      auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const current = this.rowToPlan(scope, sessionId, this.planRow(scope, sessionId, planId));
    if (current.status === 'superseded') {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_SUPERSEDED',
        `Plan ${planId} was superseded by a later revision; edit the current plan instead.`,
        409,
      );
    }
    const index = current.items.findIndex((item) => item.action_id === actionId);
    if (index < 0) {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_ITEM_NOT_FOUND',
        `Plan ${planId} has no action ${actionId}.`,
        404,
      );
    }
    const before = current.items[index];
    const merged: ActionProposal = { ...itemContent(before) } as ActionProposal;
    for (const field of MUTABLE_ITEM_FIELDS) {
      if (patch[field] !== undefined) {
        (merged as unknown as Record<string, unknown>)[field] = patch[field];
      }
    }
    const check = validateActionProposal(merged);
    if (!check.ok) {
      throw new CouncilKanbanError(
        'COUNCIL_VERDICT_NOT_VALID',
        `The edited action ${actionId} failed canonical validation.`,
        422,
        { issues: check.issues as unknown as Record<string, unknown> },
      );
    }
    const nextRevision = before.item_revision + 1;
    const revisedItem: PlanItemState = {
      ...merged,
      item_revision: nextRevision,
      item_sha256: hashItem(merged, nextRevision),
    };
    const items = current.items.map((item, i) => (i === index ? revisedItem : item));
    const planHash = computePlanHash({
      sessionId,
      verdictRevision: current.verdict_revision,
      verdictSha256: current.verdict_id,
      tenantId: scope.tenant_id,
      companyId: scope.company_id,
      items,
    });
    if (planHash === current.plan_hash) return current;
    const newPlanId = this.newId();
    const createdAt = this.now();
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `UPDATE council_action_proposals SET status = 'superseded'
              WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND id = ?`,
          )
          .run(scope.tenant_id, scope.company_id, sessionId, planId);
        this.db
          .prepare(
            `INSERT INTO council_action_proposals
               (tenant_id, company_id, session_id, id, verdict_id, plan_hash, actions_json, risk_class, status, supersedes_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
          )
          .run(
            scope.tenant_id,
            scope.company_id,
            sessionId,
            newPlanId,
            current.verdict_id,
            planHash,
            canonicalStringify(items),
            current.risk_class,
            planId,
            createdAt,
          );
        appendKanbanJournalEvent(this.db, scope, sessionId, {
          eventId: this.newId(),
          actorSubject: principal.subject,
          action: 'plan_item_revised',
          createdAt,
          data: {
            plan_id: newPlanId,
            plan_hash: planHash,
            previous_plan_id: planId,
            previous_plan_hash: current.plan_hash,
            action_id: actionId,
            from_revision: before.item_revision,
            to_revision: nextRevision,
            authorization: { permission: 'create_tasks' },
          },
        });
      })
      .immediate();
    return this.rowToPlan(scope, sessionId, this.planRow(scope, sessionId, newPlanId));
  }

  // -------------------------------------------------------------- approve

  /**
   * Record one explicit approval decision for one plan item, bound to
   * the item's exact current revision and the current plan hash. This
   * is the action-plan approval authorization ('approve_plan'): it is
   * not a run approval and it is not an execution credential.
   */
  async decidePlanItem(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    actionId: string,
    decision: 'approved' | 'rejected',
    opts: { expires_at?: string; auth?: KanbanAuthOptions } = {},
  ): Promise<CouncilActionPlanView> {
    const { scope, accessVia } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'approve_plan',
      'mutate',
      opts.auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    let plan = this.rowToPlan(scope, sessionId, this.planRow(scope, sessionId, planId));
    if (plan.status === 'superseded') {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_SUPERSEDED',
        `Plan ${planId} was superseded; decisions bind to the current plan only.`,
        409,
      );
    }
    const item = plan.items.find((entry) => entry.action_id === actionId);
    if (!item) {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_ITEM_NOT_FOUND',
        `Plan ${planId} has no action ${actionId}.`,
        404,
      );
    }
    const coverage = this.coverageFor(scope, plan);
    const existing = coverage.items.find((entry) => entry.action_id === actionId);
    if (existing?.decision === decision && existing.decided_by === principal.subject) {
      return this.view(scope, sessionId, this.refreshPlanStatus(scope, sessionId, plan));
    }
    const binding = {
      action_id: actionId,
      item_revision: item.item_revision,
      item_sha256: item.item_sha256,
      plan_id: planId,
      plan_hash: plan.plan_hash,
      verdict_revision: plan.verdict_revision,
      session_id: sessionId,
    };
    const targetSha256 = canonicalHash(binding);
    const issuedAt = this.now();
    const expiresAt =
      opts.expires_at ?? new Date(Date.parse(issuedAt) + this.approvalTtlMs).toISOString();
    const approvalId = this.newId();
    this.db
      .transaction(() => {
        this.db
          .prepare(
            `INSERT INTO council_approvals
               (tenant_id, company_id, id, kind, session_id, action_proposal_id,
                authority_mode, purpose, actor_subject, actor_role, parent_approval_id,
                scope_proof, current_plan_hash, verdict_hash, max_cost_minor, currency,
                seat_allowlist_json, company_scope_verified, status, issued_at, expires_at,
                revoked_at, revoked_by, consumed_at)
             VALUES (?, ?, ?, 'action_plan', ?, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, 'active', ?, ?, NULL, NULL, NULL)`,
          )
          .run(
            scope.tenant_id,
            scope.company_id,
            approvalId,
            sessionId,
            planId,
            principal.subject,
            principal.supportAccess ? 'support' : principal.channel === 'machine' ? 'machine' : 'owner',
            canonicalStringify({
              decision,
              ...binding,
              target_sha256: targetSha256,
              approved_by_principal: principal.subject,
              via: accessVia,
            }),
            plan.plan_hash,
            plan.verdict_id,
            item.budget_limit?.amount_minor ?? null,
            item.budget_limit?.currency ?? null,
            accessVia === 'support' ? 0 : 1,
            issuedAt,
            expiresAt,
          );
        appendKanbanJournalEvent(this.db, scope, sessionId, {
          eventId: this.newId(),
          actorSubject: principal.subject,
          action: 'plan_item_decided',
          createdAt: issuedAt,
          data: {
            plan_id: planId,
            plan_hash: plan.plan_hash,
            action_id: actionId,
            decision,
            item_revision: item.item_revision,
            target_sha256: targetSha256,
            approval_id: approvalId,
            expires_at: expiresAt,
            authorization: { permission: 'approve_plan', via: accessVia },
          },
        });
      })
      .immediate();
    plan = this.refreshPlanStatus(scope, sessionId, plan);
    if (plan.status === 'approved') {
      appendKanbanJournalEvent(this.db, scope, sessionId, {
        eventId: this.newId(),
        actorSubject: principal.subject,
        action: 'plan_approved',
        createdAt: this.now(),
        data: {
          plan_id: plan.plan_id,
          plan_hash: plan.plan_hash,
          authorization: { permission: 'approve_plan' },
        },
      });
    }
    return this.view(scope, sessionId, plan);
  }

  // ---------------------------------------------------------- materialize

  /**
   * Create one held child task per approved plan item (idempotent on
   * the Section 19.6 operation identity). Children are born in Being
   * Prepared behind council_plan_assembling, carry the source-session
   * recursion tag, and are never dispatched by this layer. Private
   * sessions materialize nothing.
   */
  async materializePlanTasks(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    auth?: KanbanAuthOptions,
  ): Promise<MaterializePlanResult> {
    const { row, scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'mutate',
      auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    if (isPrivateSessionRow(row)) {
      return { kind: 'not_materialized', reason: 'private_session' };
    }
    const plan = this.refreshPlanStatus(
      scope,
      sessionId,
      this.rowToPlan(scope, sessionId, this.planRow(scope, sessionId, planId)),
    );
    const coverage = this.coverageFor(scope, plan);
    if (!coverage.complete) {
      throw new CouncilKanbanError(
        'COUNCIL_PLAN_NOT_FULLY_APPROVED',
        'Plan tasks are created only after every selected item carries a current approval.',
        409,
        { coverage: coverage as unknown as Record<string, unknown> },
      );
    }
    const lockKey = `${scope.tenant_id}:${scope.company_id}:${sessionId}:materialize:${plan.plan_hash}`;
    return withKeyedLock(lockKey, async () => {
      const parent = await this.parentAdapter.ensureParentTask(principal, sessionId, auth);
      if (parent.kind === 'none') {
        return { kind: 'not_materialized', reason: 'private_session' } as MaterializePlanResult;
      }
      const links: Array<{ action_id: string; task_id: string; operation_id: string; created: boolean }> = [];
      for (const item of plan.items) {
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
          links.push({
            action_id: item.action_id,
            task_id: existingLink.task_id,
            operation_id: operationId,
            created: false,
          });
          continue;
        }
        const description = [
          councilSourceSessionTag(sessionId),
          'Handler: council_action',
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
          parent_task_id: parent.task_id,
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
            parent.task_id,
            plan.plan_id,
            item.action_id,
            plan.plan_hash,
            operationId,
            result.task.id,
            result.task.status,
            this.now(),
          );
        links.push({
          action_id: item.action_id,
          task_id: result.task.id,
          operation_id: operationId,
          created: !result.deduped,
        });
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
          created_count: links.filter((link) => link.created).length,
          linked_count: links.filter((link) => !link.created).length,
          task_ids: links.map((link) => link.task_id),
          authorization: { permission: 'execute' },
        },
      });
      return { kind: 'materialized', parent_task_id: parent.task_id, links } as MaterializePlanResult;
    });
  }

  // -------------------------------------------------------------- release

  /** Evaluate the release conditions without changing any state. */
  async evaluatePlanRelease(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    opts: { grant_ref?: string | null; auth?: KanbanAuthOptions } = {},
  ): Promise<CouncilPlanReleaseEvaluation> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'read',
      opts.auth,
    );
    const plan = this.refreshPlanStatus(
      scope,
      sessionId,
      this.rowToPlan(scope, sessionId, this.planRow(scope, sessionId, planId)),
    );
    const coverage = this.coverageFor(scope, plan);
    return this.releaseEvaluation(scope, sessionId, plan, coverage, opts.grant_ref ?? null);
  }

  /**
   * Mark a plan ready when (and only when) approval is complete, the
   * execution-grant requirement is recorded, and an active run grant
   * resolves through the Section 25.6 port. Release changes NO task
   * state and lifts NO hold: it records readiness in the journal for
   * CWE-036 / CWE-050 dispatch composition.
   */
  async releasePlan(
    principal: CouncilPrincipal,
    sessionId: string,
    planId: string,
    opts: { grant_ref?: string | null; auth?: KanbanAuthOptions } = {},
  ): Promise<{ released: boolean; evaluation: CouncilPlanReleaseEvaluation }> {
    const { scope } = authorizeKanbanOperation(
      this.db,
      principal,
      sessionId,
      'execute',
      'mutate',
      opts.auth,
    );
    assertKanbanSessionNotDeleted(this.repositories, principal, sessionId);
    const plan = this.refreshPlanStatus(
      scope,
      sessionId,
      this.rowToPlan(scope, sessionId, this.planRow(scope, sessionId, planId)),
    );
    const coverage = this.coverageFor(scope, plan);
    const evaluation = await this.releaseEvaluation(scope, sessionId, plan, coverage, opts.grant_ref ?? null);
    if (!evaluation.releasable) return { released: false, evaluation };
    const already = this.releasedState(scope, sessionId, planId);
    if (already) return { released: true, evaluation };
    appendKanbanJournalEvent(this.db, scope, sessionId, {
      eventId: this.newId(),
      actorSubject: principal.subject,
      action: 'plan_released',
      createdAt: this.now(),
      data: {
        plan_id: plan.plan_id,
        plan_hash: plan.plan_hash,
        grant_ref: evaluation.conditions.run_grant_ref,
        readiness: evaluation.readiness,
        authorization: { permission: 'execute' },
      },
    });
    return { released: true, evaluation };
  }
}
