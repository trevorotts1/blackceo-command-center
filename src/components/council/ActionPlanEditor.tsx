'use client';

/**
 * ActionPlanEditor (CWE-036, Skill 77) - the approved action-plan
 * editor over CWE-032's shared component contracts.
 *
 * The editor keeps the product's three separate authorizations
 * visibly separate (Sections 21, 25), in this order:
 *
 *   1. Council advice: the verdict itself. Advice is not approval.
 *   2. Plan approval: the exact plan the owner approves, with the
 *      full plan hash it binds shown on screen, per-item selection,
 *      budgets, dependencies, and each item's approval state.
 *   3. Execution permission: a separate standing execution grant.
 *      Plan approval never authorizes execution; without an active
 *      grant every created task stays held.
 *
 * The component is a controlled projection of committed state: it
 * fetches nothing, invents no approval, and its buttons only call
 * the callbacks the composition wires to the real endpoints.
 */

import './ActionPlanEditor.css';

export interface ActionPlanItemView {
  action_id: string;
  title: string;
  description: string;
  budget_limit: { amount_minor: number; currency: string } | null;
  due_at: string | null;
  /** Display labels for this item's dependencies, resolved by the caller. */
  depends_on_labels: readonly string[];
  risk_class: string;
  approval_state: 'approved' | 'rejected' | 'pending';
  decided_by: string | null;
}

export type ActionPlanGrantStatus =
  | 'active'
  | 'missing'
  | 'expired'
  | 'revoked'
  | 'exhausted';

export interface ActionPlanEditorView {
  session_id: string;
  verdict_revision: number;
  verdict_label: string;
  ratification_status: string;
  plan_hash: string;
  plan_status:
    | 'preview'
    | 'proposed'
    | 'approved'
    | 'rejected'
    | 'superseded'
    | 'executed'
    | 'expired';
  items: readonly ActionPlanItemView[];
  budgets: readonly { currency: string; amount_minor: number }[];
  approver_subject: string | null;
  execution_grant_status: ActionPlanGrantStatus;
  execution_grant_ref: string | null;
}

export interface ActionPlanEditorProps {
  plan: ActionPlanEditorView;
  selectedActionIds: readonly string[];
  onToggleAction?: (actionId: string, selected: boolean) => void;
  onApprove?: () => void;
  onCreate?: () => void;
}

export function formatBudget(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(amountMinor / 100);
  } catch {
    return `${currency} ${(amountMinor / 100).toFixed(2)}`;
  }
}

function approvalStateLabel(item: ActionPlanItemView): string {
  switch (item.approval_state) {
    case 'approved':
      return item.decided_by ? `Approved by ${item.decided_by}` : 'Approved';
    case 'rejected':
      return item.decided_by ? `Rejected by ${item.decided_by}` : 'Rejected';
    case 'pending':
      return 'Awaiting decision';
  }
}

export function ActionPlanEditor({
  plan,
  selectedActionIds,
  onToggleAction,
  onApprove,
  onCreate,
}: ActionPlanEditorProps) {
  const selected = new Set(selectedActionIds);
  const approved = plan.plan_status === 'approved' || plan.plan_status === 'executed';
  const grantActive = plan.execution_grant_status === 'active';

  return (
    <section className="council-action-editor" data-testid="council-action-plan-editor" aria-label="Action plan">
      <h2 className="council-action-heading">Action plan</h2>

      <div className="council-action-panel" data-testid="council-advice-summary">
        <h3 className="council-action-panel-title">1. Council advice</h3>
        <p>
          The council&apos;s verdict is advice. It recommends{' '}
          <strong>{plan.verdict_label}</strong> (verdict revision {plan.verdict_revision},
          ratification: {plan.ratification_status}). Reading the advice, or agreeing with
          it, does not approve any work and does not authorize any task.
        </p>
      </div>

      <div className="council-action-panel" data-testid="council-plan-approval">
        <h3 className="council-action-panel-title">2. Plan approval</h3>
        <p>
          Approving this plan binds the exact plan below: the selected actions, their
          dependencies, their budgets, and the destination scope. Changing any selected
          action changes the hash and invalidates this approval for the changed work.
        </p>
        <p className="council-action-hash-row">
          <span className="council-action-hash-label">Plan hash this approval binds</span>
          <code className="council-action-hash" data-testid="council-plan-hash">
            {plan.plan_hash}
          </code>
        </p>
        <p className="council-action-status">
          Plan status: <strong>{plan.plan_status}</strong>
          {plan.approver_subject ? (
            <>
              {' '}
              · Approved by <strong>{plan.approver_subject}</strong>
            </>
          ) : null}
        </p>

        <ul className="council-action-items">
          {plan.items.map((item) => (
            <li
              key={item.action_id}
              className="council-action-item"
              data-testid={`council-plan-item-${item.action_id}`}
            >
              <label className="council-action-item-head">
                <input
                  type="checkbox"
                  checked={selected.has(item.action_id)}
                  disabled={!onToggleAction || approved}
                  onChange={(event) => onToggleAction?.(item.action_id, event.target.checked)}
                  data-testid={`council-plan-select-${item.action_id}`}
                />
                <span className="council-action-item-title">{item.title}</span>
              </label>
              <p className="council-action-item-desc">{item.description}</p>
              <p className="council-action-item-meta">
                <span>
                  Budget:{' '}
                  {item.budget_limit
                    ? formatBudget(item.budget_limit.amount_minor, item.budget_limit.currency)
                    : 'No budget limit'}
                </span>
                <span>Risk: {item.risk_class}</span>
                {item.due_at ? <span>Due: {item.due_at}</span> : null}
                <span data-testid={`council-plan-item-approval-${item.action_id}`}>
                  {approvalStateLabel(item)}
                </span>
              </p>
              {item.depends_on_labels.length > 0 ? (
                <p className="council-action-item-deps">
                  Depends on: {item.depends_on_labels.join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        {plan.budgets.length > 0 ? (
          <p className="council-action-status" data-testid="council-plan-budgets">
            Total budget:{' '}
            {plan.budgets
              .map((budget) => formatBudget(budget.amount_minor, budget.currency))
              .join(' + ')}
          </p>
        ) : null}

        <button
          type="button"
          className="council-action-btn council-action-btn-primary"
          data-testid="council-plan-approve"
          disabled={!onApprove || approved || selected.size === 0}
          onClick={onApprove}
        >
          {approved ? 'Plan approved' : 'Approve this exact plan'}
        </button>
      </div>

      <div className="council-action-panel" data-testid="council-execution-boundary">
        <h3 className="council-action-panel-title">3. Execution permission</h3>
        <p>
          <strong>Plan approval does not authorize execution.</strong> Execution needs a
          separate standing execution grant, and each task is released only when its own
          dependencies and prerequisites are met.
        </p>
        <p className="council-action-status" data-testid="council-execution-grant-status">
          {grantActive ? (
            <>
              A standing execution grant is active
              {plan.execution_grant_ref ? ` (grant ${plan.execution_grant_ref})` : ''}.
              Tasks may be released one by one as their own conditions are met.
            </>
          ) : (
            <>
              No standing execution grant is active (status: {plan.execution_grant_status}).
              Every task created from this plan stays held.
            </>
          )}
        </p>
        <button
          type="button"
          className="council-action-btn"
          data-testid="council-plan-create"
          disabled={!onCreate || !approved}
          onClick={onCreate}
        >
          Create the approved tasks
        </button>
        <p className="council-action-note">
          Creating tasks does not dispatch them: each task is born held behind the plan
          assembly barrier.
        </p>
      </div>
    </section>
  );
}
