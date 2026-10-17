/**
 * CWE-036 pure action-plan computation (Sections 17.6, 19.5; T090).
 *
 * The plan preview must compute the EXACT plan an approval will bind
 * and a create will materialize, while writing nothing: no task, no
 * plan row, no journal event, no webhook, no notification, no dispatch,
 * no model call. CWE-035's CouncilActionPlanService persists plans in
 * proposePlan, so the preview cannot call it. This module therefore
 * reproduces the service's hash math exactly (same canonicalHash
 * inputs, same item-content stripping, same grant aggregation), and
 * the CWE-036 test suites prove byte equality between a preview's
 * plan_hash and the hash proposePlan persists for the same verdict
 * and selection. If CWE-035's math ever changes, that parity test
 * fails loudly instead of letting preview and approval drift apart.
 */
import {
  canonicalHash,
  validateActionProposal,
  type ActionProposal,
  type Verdict,
} from '../contracts';
import { councilActionOperationId } from './constants';
import { CouncilKanbanError } from './errors';
import type { PlanItemState, RequiredExecutionGrant } from './plan-service';

export interface CouncilPlanPreview {
  session_id: string;
  verdict_revision: number;
  /** The verdict's content hash; uniquely identifies the verdict content. */
  verdict_sha256: string;
  plan_hash: string;
  items: PlanItemState[];
  required_execution_grant: RequiredExecutionGrant;
}

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

/**
 * Select and validate the plan items for a verdict, applying the same
 * gates proposePlan applies (canonical ActionProposal validation,
 * session and verdict-revision binding). Throws the same typed
 * COUNCIL_VERDICT_NOT_VALID errors as the service.
 */
export function selectPlanItems(
  sessionId: string,
  verdict: Verdict,
  selectedActionIds?: string[],
): PlanItemState[] {
  if (verdict.result_kind !== 'scored') {
    throw new CouncilKanbanError(
      'COUNCIL_VERDICT_NOT_VALID',
      'A consult verdict carries no action proposals; only a scored verdict can ground an action plan.',
    );
  }
  const selected = (verdict.action_proposals ?? []).filter(
    (item) => !selectedActionIds || selectedActionIds.includes(item.action_id),
  );
  if (selected.length === 0) {
    throw new CouncilKanbanError(
      'COUNCIL_VERDICT_NOT_VALID',
      'The verdict carries no selected action proposals to plan.',
    );
  }
  return selected.map((item) => {
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
}

/**
 * Compute the exact plan for a validated scored verdict. Pure: this
 * function performs no writes of any kind (T090).
 */
export function computePlanPreview(
  sessionId: string,
  verdict: Verdict,
  scope: { tenant_id: string; company_id: string },
  selectedActionIds?: string[],
): CouncilPlanPreview {
  if (verdict.session_id !== sessionId) {
    throw new CouncilKanbanError(
      'COUNCIL_VERDICT_NOT_VALID',
      'The verdict does not belong to this session and cannot ground its action plan.',
    );
  }
  const items = selectPlanItems(sessionId, verdict, selectedActionIds);
  const planHash = computePlanHash({
    sessionId,
    verdictRevision: verdict.verdict_revision,
    verdictSha256: verdict.content_sha256,
    tenantId: scope.tenant_id,
    companyId: scope.company_id,
    items,
  });
  return {
    session_id: sessionId,
    verdict_revision: verdict.verdict_revision,
    verdict_sha256: verdict.content_sha256,
    plan_hash: planHash,
    items,
    required_execution_grant: requiredGrantFor({
      session_id: sessionId,
      plan_hash: planHash,
      verdict_revision: verdict.verdict_revision,
      items,
    }),
  };
}
