/**
 * Council action-plan API facade (CWE-036, directive Sections 17.5,
 * 17.6, 19.5, 19.6, 25; Section 35 contracts T090-T095, T159).
 *
 * The three registered action-plan endpoints (preview, approve,
 * create) run through this facade, which composes CWE-035's
 * CouncilActionPlanService with the CWE-036 action modules:
 *
 * - preview: computes the exact plan from the session's committed,
 *   CWE-026-validated verdict revision and writes NOTHING (T090). The
 *   hash it returns is the hash an approval binds and a create
 *   materializes; parity with the persisted plan is proven by tests.
 * - approve: binds the exact plan hash, the selected actions, the
 *   scope, the budgets (inside the item hashes), and the approving
 *   principal (T091). A plan hash that does not match the current
 *   verdict revision's computed plan is refused: approval never
 *   transfers to changed work.
 * - create: requires the committed approval for the same plan hash,
 *   then runs the Section 17.6 assembly under the dispatch barrier
 *   (T092-T095, T159).
 *
 * Request bodies are validated strictly: unknown fields are refused,
 * and a client can never name a handler, an executor, or a foreign
 * scope through these endpoints. Scope comes only from the trusted
 * principal (CWE-007); the routes establish it before calling here.
 */
import { canonicalHash, validateVerdict, type Verdict } from './contracts';
import type { CouncilPrincipal } from './auth';
import { CouncilApiError, idempotencyConflict, schemaValidation } from './api/errors';
import type { AuthorizedSession, CouncilRouteContext } from './api/foundation';
import { CouncilActionError } from './kanban/action-errors';
import { computePlanPreview, type CouncilPlanPreview } from './kanban/action-preview';
import { CouncilPlanAssembly, type CouncilPlanAssemblyResult } from './kanban/action-assembly';
import { CouncilActionExecutionGuard } from './kanban/action-execution';
import { listPlanTaskLinks } from './kanban/action-dependencies';
import { CouncilKanbanError } from './kanban/errors';
import {
  CouncilActionPlanService,
  type CouncilActionPlanView,
} from './kanban/plan-service';

const API_SOURCE = 'council-api';
const APPROVE_OPERATION = 'council.sessions.action_plan.approve';
const CREATE_OPERATION = 'council.sessions.action_plan.create';

// ------------------------------------------------------------- services

export interface ActionPlanServices {
  planService: CouncilActionPlanService;
  assembly: CouncilPlanAssembly;
  guard: CouncilActionExecutionGuard;
}

/**
 * Compose the action-plan services over the request's store. The
 * execution guard runs with CWE-035's fail-closed run-authorization
 * port until CWE-050 composes the real CWE-049 implementation, so in
 * this composition tasks are created held and released only when a
 * real grant resolves.
 */
export function composeActionPlanServices(ctx: CouncilRouteContext): ActionPlanServices {
  const db = ctx.store.handle();
  const planService = new CouncilActionPlanService({ repositories: ctx.repositories, db });
  const guard = new CouncilActionExecutionGuard({
    repositories: ctx.repositories,
    db,
    planService,
  });
  const assembly = new CouncilPlanAssembly({
    repositories: ctx.repositories,
    db,
    planService,
    executionGuard: guard,
  });
  return { planService, assembly, guard };
}

// ------------------------------------------------------------ translation

function actionForStatus(status: number): string {
  switch (status) {
    case 400:
      return 'fix_request';
    case 403:
      return 'check_authorization';
    case 404:
      return 'check_session_id';
    case 409:
      return 'reload_and_retry';
    case 410:
      return 'do_not_retry';
    case 503:
      return 'retry_later';
    default:
      return 'fix_request';
  }
}

/** Translate kanban/action errors into the canonical API envelope. */
export function translateActionError(error: unknown): never {
  if (error instanceof CouncilKanbanError || error instanceof CouncilActionError) {
    throw new CouncilApiError(error.code, error.message, {
      status: error.status,
      action: actionForStatus(error.status),
    });
  }
  throw error;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    translateActionError(error);
  }
}

/**
 * Throw one of this facade's own gating errors through the API
 * translation, so route callers always see the canonical envelope
 * (never a bare 500). Service-layer callers of the kanban modules
 * still receive the original CouncilActionError/CouncilKanbanError.
 */
function boundaryError(error: CouncilActionError | CouncilKanbanError): never {
  translateActionError(error);
}

// ------------------------------------------------------------ body parsing

function rejectUnknownKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
  surface: string,
): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) {
      throw schemaValidation(
        `Unexpected field "${key}" in the ${surface} request. These endpoints accept only ` +
          'the registered contract fields; a client cannot name a handler, an executor, ' +
          'or a scope through them.',
      );
    }
  }
}

function requirePlanHash(body: Record<string, unknown>): string {
  const value = body.plan_hash;
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw schemaValidation('plan_hash must be the 64-character plan hash returned by preview.');
  }
  return value;
}

function optionalSelectedActionIds(body: Record<string, unknown>): string[] | undefined {
  const value = body.selected_action_ids;
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.trim() === '')
  ) {
    throw schemaValidation('selected_action_ids must be an array of action ID strings.');
  }
  return value as string[];
}

function requireVerdictRevision(body: Record<string, unknown>): number {
  const value = body.verdict_revision;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw schemaValidation('verdict_revision must be the positive integer revision from preview.');
  }
  return value;
}

// ------------------------------------------------------------- verdict gate

/**
 * Load the session's committed verdict and enforce revision currency:
 * a plan built on a superseded verdict revision can be neither
 * approved nor created, and a revision that was never committed does
 * not exist. Validation is the canonical CWE-003/CWE-026 contract
 * validation the plan service itself applies.
 */
function loadCurrentVerdict(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  requestedRevision: number,
): Verdict {
  const verdict = ctx.repositories.getVerdict(authorized.envelope, sessionId);
  if (!verdict) {
    boundaryError(new CouncilActionError(
      'COUNCIL_VERDICT_NOT_FOUND',
      `Session ${sessionId} has no committed verdict; there is nothing to preview, approve, or create.`,
      404,
    ));
  }
  if (requestedRevision < verdict.verdict_revision) {
    boundaryError(new CouncilActionError(
      'COUNCIL_VERDICT_SUPERSEDED',
      `Verdict revision ${requestedRevision} was superseded by revision ${verdict.verdict_revision}; ` +
        'a plan built on a superseded verdict revision cannot be approved or created.',
      409,
    ));
  }
  if (requestedRevision > verdict.verdict_revision) {
    boundaryError(new CouncilActionError(
      'COUNCIL_VERDICT_NOT_FOUND',
      `Session ${sessionId} has no committed verdict revision ${requestedRevision}.`,
      404,
    ));
  }
  const check = validateVerdict(verdict);
  if (!check.ok || verdict.validation_status !== 'valid') {
    boundaryError(new CouncilKanbanError(
      'COUNCIL_VERDICT_NOT_VALID',
      'The committed verdict is not a validated verdict and cannot ground an action plan.',
      422,
    ));
  }
  return verdict;
}

// ---------------------------------------------------------------- preview

export interface ActionPlanPreviewResult extends CouncilPlanPreview {
  preview_only: true;
  approval_binding: {
    plan_hash: string;
    tenant_id: string;
    company_id: string;
    note: string;
  };
}

/**
 * POST action-plan/preview. Pure computation over the committed
 * verdict: no plan row, no journal event, no task, no request-key
 * claim, no model call (T090). The idempotency key the foundation
 * requires is accepted as correlation only; a pure function needs no
 * claim to replay identically.
 */
export async function previewActionPlan(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<ActionPlanPreviewResult> {
  rejectUnknownKeys(
    body,
    ['verdict_revision', 'selected_action_ids', 'idempotency_key'],
    'action plan preview',
  );
  const verdictRevision = requireVerdictRevision(body);
  const selectedActionIds = optionalSelectedActionIds(body);
  const verdict = loadCurrentVerdict(ctx, authorized, sessionId, verdictRevision);
  const preview = await guard(async () =>
    computePlanPreview(sessionId, verdict, ctx.principal.scope, selectedActionIds),
  );
  return {
    ...preview,
    preview_only: true,
    approval_binding: {
      plan_hash: preview.plan_hash,
      tenant_id: ctx.principal.scope.tenant_id,
      company_id: ctx.principal.scope.company_id,
      note:
        'Approval binds this exact plan hash, the selected actions, this scope, and the ' +
        'budgets inside the item hashes. Changing any selected action invalidates the hash.',
    },
  };
}

// ---------------------------------------------------------------- approve

export interface ActionPlanApprovalResult {
  plan_id: string;
  session_id: string;
  plan_hash: string;
  verdict_revision: number;
  status: CouncilActionPlanView['plan']['status'];
  approved_by: string;
  scope: { tenant_id: string; company_id: string };
  coverage: CouncilActionPlanView['coverage'];
  replayed: boolean;
  note: string;
}

interface ApprovalDecisionInput {
  action_id: string;
  decision: 'approved' | 'rejected';
}

function parseDecisions(
  body: Record<string, unknown>,
  planActionIds: readonly string[],
): Map<string, 'approved' | 'rejected'> | null {
  const value = body.decisions;
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw schemaValidation('decisions must be an array of { action_id, decision } entries.');
  }
  const decisions = new Map<string, 'approved' | 'rejected'>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw schemaValidation('Each decision must be an object with action_id and decision.');
    }
    const record = entry as Record<string, unknown>;
    rejectUnknownKeys(record, ['action_id', 'decision'], 'approval decision');
    if (typeof record.action_id !== 'string' || !planActionIds.includes(record.action_id)) {
      throw schemaValidation(
        `Decision names action ${String(record.action_id)}, which is not one of the selected plan actions.`,
      );
    }
    if (record.decision !== 'approved' && record.decision !== 'rejected') {
      throw schemaValidation('Each decision must be "approved" or "rejected".');
    }
    decisions.set(record.action_id, record.decision);
  }
  return decisions;
}

function approvalResult(
  view: CouncilActionPlanView,
  principal: CouncilPrincipal,
  replayed: boolean,
): ActionPlanApprovalResult {
  return {
    plan_id: view.plan.plan_id,
    session_id: view.plan.session_id,
    plan_hash: view.plan.plan_hash,
    verdict_revision: view.plan.verdict_revision,
    status: view.plan.status,
    approved_by: principal.subject,
    scope: { tenant_id: view.plan.tenant_id, company_id: view.plan.company_id },
    coverage: view.coverage,
    replayed,
    note:
      'This is the action-plan approval authorization. It is not a council-run approval ' +
      'and it is not an execution credential: created tasks stay held until a separate ' +
      'standing execution grant and each task\'s own prerequisites permit release.',
  };
}

/**
 * POST action-plan/approve. Verifies the submitted plan hash against
 * the plan computed from the current verdict revision, persists the
 * plan through CWE-035's service, and records one bound decision per
 * selected action under the approving principal (T091).
 */
export async function approveActionPlan(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  services: ActionPlanServices = composeActionPlanServices(ctx),
): Promise<ActionPlanApprovalResult> {
  rejectUnknownKeys(
    body,
    ['verdict_revision', 'plan_hash', 'selected_action_ids', 'decisions', 'idempotency_key'],
    'action plan approval',
  );
  const verdictRevision = requireVerdictRevision(body);
  const planHash = requirePlanHash(body);
  const selectedActionIds = optionalSelectedActionIds(body);
  const verdict = loadCurrentVerdict(ctx, authorized, sessionId, verdictRevision);
  const preview = await guard(async () =>
    computePlanPreview(sessionId, verdict, ctx.principal.scope, selectedActionIds),
  );
  if (preview.plan_hash !== planHash) {
    boundaryError(new CouncilActionError(
      'COUNCIL_PLAN_HASH_MISMATCH',
      'The submitted plan hash does not match the plan computed from the current verdict ' +
        'revision. The plan changed after preview; approval binds the exact current hash only.',
      409,
    ));
  }
  const decisions = parseDecisions(body, preview.items.map((item) => item.action_id));

  const fingerprint = canonicalHash({
    operation: APPROVE_OPERATION,
    session_id: sessionId,
    verdict_revision: verdictRevision,
    plan_hash: planHash,
    selected_action_ids: selectedActionIds ?? null,
    decisions: decisions ? [...decisions.entries()] : null,
  });
  const claim = ctx.repositories.claimRequestKey({
    tenantId: ctx.principal.scope.tenant_id,
    source: API_SOURCE,
    operation: APPROVE_OPERATION,
    requestKey: idempotencyKey,
    payloadFingerprint: fingerprint,
    sessionId,
  });
  if (claim.outcome === 'conflict') throw idempotencyConflict(APPROVE_OPERATION);
  if (claim.outcome === 'replay') {
    const plans = await guard(async () =>
      services.planService.listPlans(ctx.principal, sessionId),
    );
    const existing = plans.find((plan) => plan.plan_hash === planHash);
    if (!existing) throw idempotencyConflict(APPROVE_OPERATION);
    const view = await guard(async () =>
      services.planService.getPlan(ctx.principal, sessionId, existing.plan_id),
    );
    return approvalResult(view, ctx.principal, true);
  }

  const plan = await guard(async () =>
    services.planService.proposePlan(ctx.principal, sessionId, verdict, {
      selected_action_ids: selectedActionIds,
    }),
  );
  if (plan.plan_hash !== planHash) {
    boundaryError(new CouncilActionError(
      'COUNCIL_PLAN_HASH_MISMATCH',
      'The persisted plan hash differs from the approved hash; no decision was recorded.',
      409,
    ));
  }
  for (const item of plan.items) {
    const decision = decisions?.get(item.action_id) ?? (decisions === null ? 'approved' : null);
    if (decision === null) continue;
    await guard(async () =>
      services.planService.decidePlanItem(
        ctx.principal,
        sessionId,
        plan.plan_id,
        item.action_id,
        decision,
      ),
    );
  }
  const view = await guard(async () =>
    services.planService.getPlan(ctx.principal, sessionId, plan.plan_id),
  );
  return approvalResult(view, ctx.principal, false);
}

// ----------------------------------------------------------------- create

export interface ActionPlanCreateResult {
  operation: typeof CREATE_OPERATION;
  session_id: string;
  plan_id: string;
  plan_hash: string;
  status: string;
  assembly_id: string | null;
  parent_task_id: string | null;
  tasks: Array<{
    action_id: string;
    task_id: string;
    operation_id: string;
    created: boolean | null;
    released: boolean;
    releasable: boolean;
    reasons: string[];
  }>;
  edges: Array<{
    action_id: string;
    task_id: string | null;
    depends_on_action_id: string;
    depends_on_task_id: string | null;
  }>;
  replayed: boolean;
  note: string;
}

const CREATE_NOTE =
  'Creation materializes the approved plan under the assembly barrier. Every task is ' +
  'born held; a task is released only when a standing execution grant admits its exact ' +
  'operation and its own dependencies and prerequisites permit.';

/** The payload fingerprint recorded for a request key, when claimed. */
function findClaimFingerprint(
  ctx: CouncilRouteContext,
  operation: string,
  requestKey: string,
): string | null {
  const row = ctx.store
    .handle()
    .prepare(
      `SELECT payload_fingerprint FROM council_request_keys
        WHERE tenant_id = ? AND source = ? AND operation = ? AND request_key = ?`,
    )
    .get(ctx.principal.scope.tenant_id, API_SOURCE, operation, requestKey) as
    | { payload_fingerprint: string }
    | undefined;
  return row?.payload_fingerprint ?? null;
}

/**
 * POST action-plan/create. Requires the committed approval for the
 * exact plan hash, then runs the Section 17.6 assembly (T092-T095).
 * Replays return the recorded assembly outcome; a double click, a
 * timeout retry, or a renamed action title can never duplicate a
 * created task, because identity is the Section 19.6 operation key,
 * never the title.
 */
export async function createActionPlan(
  ctx: CouncilRouteContext,
  authorized: AuthorizedSession,
  sessionId: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  services: ActionPlanServices = composeActionPlanServices(ctx),
): Promise<ActionPlanCreateResult> {
  rejectUnknownKeys(
    body,
    ['plan_hash', 'plan_id', 'grant_ref', 'idempotency_key'],
    'action plan creation',
  );
  const planHash = requirePlanHash(body);
  const planIdClaim = body.plan_id;
  if (planIdClaim !== undefined && planIdClaim !== null && typeof planIdClaim !== 'string') {
    throw schemaValidation('plan_id must be a string when supplied.');
  }
  const grantRef = body.grant_ref;
  if (grantRef !== undefined && grantRef !== null && typeof grantRef !== 'string') {
    throw schemaValidation('grant_ref must be a string when supplied.');
  }

  const plans = await guard(async () => services.planService.listPlans(ctx.principal, sessionId));
  const plan =
    typeof planIdClaim === 'string'
      ? plans.find((entry) => entry.plan_id === planIdClaim)
      : plans.filter((entry) => entry.plan_hash === planHash && entry.status !== 'superseded').at(-1) ??
        plans.filter((entry) => entry.plan_hash === planHash).at(-1);
  if (!plan) {
    boundaryError(new CouncilActionError(
      'COUNCIL_PLAN_NOT_CURRENT',
      'No plan matching the submitted approval reference exists for this session. ' +
        'Creation requires a committed approval for the same plan hash.',
      404,
    ));
  }
  if (plan.plan_hash !== planHash) {
    boundaryError(new CouncilActionError(
      'COUNCIL_PLAN_HASH_MISMATCH',
      'The submitted plan hash does not match the referenced plan; creation binds the exact approved hash only.',
      409,
    ));
  }

  const fingerprint = canonicalHash({
    operation: CREATE_OPERATION,
    session_id: sessionId,
    plan_id: plan.plan_id,
    plan_hash: planHash,
    grant_ref: typeof grantRef === 'string' ? grantRef : null,
  });
  // A completed create stays replayable even if the plan was edited
  // afterwards: the retry of a finished operation returns its original
  // receipt and creates nothing (T092). The superseded refusal below
  // applies only to operations that never completed. A claim left by
  // a FAILED attempt (no assembly evidence exists) is not a replay:
  // the assembly re-runs under the same key, so a refused create
  // never replays as a phantom success.
  const db = ctx.store.handle();
  const scope = {
    tenant_id: ctx.principal.scope.tenant_id,
    company_id: ctx.principal.scope.company_id,
  };
  const links = listPlanTaskLinks(db, scope, sessionId, plan.plan_id);
  const assemblyRecord = services.assembly.assemblyRecord(scope, sessionId, plan.plan_id);
  const completedBefore = links.length > 0 || assemblyRecord !== null;
  const priorClaim = findClaimFingerprint(ctx, CREATE_OPERATION, idempotencyKey);
  if (priorClaim !== null && priorClaim !== fingerprint) {
    throw idempotencyConflict(CREATE_OPERATION);
  }
  if (priorClaim !== null && completedBefore) {
    return replayCreateResult(ctx, sessionId, plan.plan_id, plan.plan_hash, services);
  }
  if (plan.status === 'superseded') {
    boundaryError(new CouncilActionError(
      'COUNCIL_PLAN_NOT_CURRENT',
      'The referenced plan was superseded by a later revision; its approval does not transfer to changed work.',
      409,
    ));
  }
  if (priorClaim === null) {
    const claim = ctx.repositories.claimRequestKey({
      tenantId: ctx.principal.scope.tenant_id,
      source: API_SOURCE,
      operation: CREATE_OPERATION,
      requestKey: idempotencyKey,
      payloadFingerprint: fingerprint,
      sessionId,
    });
    if (claim.outcome === 'conflict') throw idempotencyConflict(CREATE_OPERATION);
    if (claim.outcome === 'replay' && completedBefore) {
      return replayCreateResult(ctx, sessionId, plan.plan_id, plan.plan_hash, services);
    }
  }

  const result = await guard(async () =>
    services.assembly.assemblePlan(ctx.principal, sessionId, plan.plan_id, {
      grant_ref: typeof grantRef === 'string' ? grantRef : null,
    }),
  );
  return assemblyResult(sessionId, plan.plan_id, result, false);
}

function assemblyResult(
  sessionId: string,
  planId: string,
  result: CouncilPlanAssemblyResult,
  replayed: boolean,
): ActionPlanCreateResult {
  if (result.kind === 'not_assembled') {
    return {
      operation: CREATE_OPERATION,
      session_id: sessionId,
      plan_id: result.plan_id,
      plan_hash: result.plan_hash,
      status: 'not_assembled_private_session',
      assembly_id: null,
      parent_task_id: null,
      tasks: [],
      edges: [],
      replayed,
      note: CREATE_NOTE,
    };
  }
  const releaseByAction = new Map(result.releases.map((entry) => [entry.action_id, entry]));
  return {
    operation: CREATE_OPERATION,
    session_id: sessionId,
    plan_id: planId,
    plan_hash: result.plan_hash,
    status: 'assembled',
    assembly_id: result.assembly_id,
    parent_task_id: result.parent_task_id,
    tasks: result.links.map((link) => {
      const release = releaseByAction.get(link.action_id);
      return {
        action_id: link.action_id,
        task_id: link.task_id,
        operation_id: link.operation_id,
        created: link.created,
        released: release?.released ?? false,
        releasable: release?.decision.releasable ?? false,
        reasons: release?.decision.reasons ?? [],
      };
    }),
    edges: result.edges,
    replayed,
    note: CREATE_NOTE,
  };
}

/** Rebuild a create receipt from committed records for a replayed key. */
async function replayCreateResult(
  ctx: CouncilRouteContext,
  sessionId: string,
  planId: string,
  planHash: string,
  services: ActionPlanServices,
): Promise<ActionPlanCreateResult> {
  const scope = {
    tenant_id: ctx.principal.scope.tenant_id,
    company_id: ctx.principal.scope.company_id,
  };
  const db = ctx.store.handle();
  const links = listPlanTaskLinks(db, scope, sessionId, planId);
  const record = services.assembly.assemblyRecord(scope, sessionId, planId);
  const tasks = [];
  for (const link of links) {
    const decision = await guard(async () =>
      services.guard.evaluateTaskRelease(ctx.principal, sessionId, planId, link.action_id),
    );
    tasks.push({
      action_id: link.action_id,
      task_id: link.task_id,
      operation_id: link.operation_id,
      created: null,
      released: decision.already_released,
      releasable: decision.releasable,
      reasons: decision.reasons,
    });
  }
  return {
    operation: CREATE_OPERATION,
    session_id: sessionId,
    plan_id: planId,
    plan_hash: planHash,
    status: record?.completed ? 'assembled' : 'assembly_recorded',
    assembly_id: record?.assembly_id ?? null,
    parent_task_id: null,
    tasks,
    edges: [],
    replayed: true,
    note: CREATE_NOTE,
  };
}
