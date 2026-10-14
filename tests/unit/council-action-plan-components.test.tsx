/**
 * CWE-036 - ActionPlanEditor and LinkedTasksPanel: REAL render tests
 * (directive Sections 21, 22, 25).
 *
 * Renders the actual components (@testing-library/react + jsdom, see
 * vitest.component.config.ts) against labeled synthetic view models
 * and proves the Section 25 separations on screen:
 *
 * - council advice, plan approval, and execution permission render
 *   as three distinct sections, in that order, with the exact
 *   separation copy ("Plan approval does not authorize execution.");
 * - the plan hash an approval binds is visible in full;
 * - per-item selection, budgets, totals, dependencies, and approval
 *   states render from the view model, and the approve/create
 *   buttons enable only in the states the contract allows;
 * - the linked-tasks panel shows real task IDs, and a held task
 *   NEVER renders as running: a task whose lifecycle status is
 *   in_progress but whose dispatch hold is set renders "Held";
 * - dependency states render from real task state (Done / Not done
 *   yet / Blocked / Not created).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import {
  ActionPlanEditor,
  formatBudget,
  type ActionPlanEditorView,
} from '../../src/components/council/ActionPlanEditor';
import {
  LinkedTasksPanel,
  linkedTaskStateLabel,
  type LinkedTaskView,
} from '../../src/components/council/LinkedTasksPanel';

afterEach(() => {
  cleanup();
});

const PLAN_HASH = 'abcdef0123456789'.repeat(4);

const EDITOR_VIEW: ActionPlanEditorView = {
  session_id: 'sess-ui-1',
  verdict_revision: 1,
  verdict_label: 'WAIT',
  ratification_status: 'ratified',
  plan_hash: PLAN_HASH,
  plan_status: 'proposed',
  items: [
    {
      action_id: 'act-1',
      title: 'Research the pilot',
      description: 'Gather the evidence for the pilot decision.',
      budget_limit: { amount_minor: 5000, currency: 'USD' },
      due_at: null,
      depends_on_labels: [],
      risk_class: 'medium',
      approval_state: 'pending',
      decided_by: null,
    },
    {
      action_id: 'act-2',
      title: 'Run the pilot',
      description: 'Run the bounded pilot in one region.',
      budget_limit: { amount_minor: 7500, currency: 'USD' },
      due_at: '2026-12-01T00:00:00.000Z',
      depends_on_labels: ['Research the pilot'],
      risk_class: 'high',
      approval_state: 'pending',
      decided_by: null,
    },
  ],
  budgets: [{ currency: 'USD', amount_minor: 12500 }],
  approver_subject: null,
  execution_grant_status: 'missing',
  execution_grant_ref: null,
};

describe('ActionPlanEditor', () => {
  it('renders advice, plan approval, and execution permission as three distinct sections', () => {
    render(
      <ActionPlanEditor plan={EDITOR_VIEW} selectedActionIds={['act-1', 'act-2']} />,
    );
    const advice = screen.getByTestId('council-advice-summary');
    const approval = screen.getByTestId('council-plan-approval');
    const execution = screen.getByTestId('council-execution-boundary');
    expect(advice.textContent).toContain('1. Council advice');
    expect(advice.textContent).toContain('does not approve any work');
    expect(approval.textContent).toContain('2. Plan approval');
    expect(execution.textContent).toContain('3. Execution permission');
    expect(execution.textContent).toContain('Plan approval does not authorize execution.');
    // Document order: advice before approval before execution.
    expect(
      advice.compareDocumentPosition(approval) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      approval.compareDocumentPosition(execution) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows the full plan hash the approval binds', () => {
    render(<ActionPlanEditor plan={EDITOR_VIEW} selectedActionIds={['act-1']} />);
    expect(screen.getByTestId('council-plan-hash').textContent).toBe(PLAN_HASH);
    expect(screen.getByTestId('council-plan-approval').textContent).toContain(
      'Plan hash this approval binds',
    );
  });

  it('renders per-item budgets, the total, dependencies, and approval states', () => {
    render(<ActionPlanEditor plan={EDITOR_VIEW} selectedActionIds={['act-1', 'act-2']} />);
    const item1 = screen.getByTestId('council-plan-item-act-1');
    const item2 = screen.getByTestId('council-plan-item-act-2');
    expect(item1.textContent).toContain('$50.00');
    expect(item2.textContent).toContain('$75.00');
    expect(item2.textContent).toContain('Depends on: Research the pilot');
    expect(screen.getByTestId('council-plan-budgets').textContent).toContain('$125.00');
    expect(screen.getByTestId('council-plan-item-approval-act-1').textContent).toBe(
      'Awaiting decision',
    );
    expect(formatBudget(5000, 'USD')).toBe('$50.00');
  });

  it('toggles selection through the callback and approves through the callback', () => {
    const onToggleAction = vi.fn();
    const onApprove = vi.fn();
    render(
      <ActionPlanEditor
        plan={EDITOR_VIEW}
        selectedActionIds={['act-1', 'act-2']}
        onToggleAction={onToggleAction}
        onApprove={onApprove}
      />,
    );
    fireEvent.click(screen.getByTestId('council-plan-select-act-2'));
    expect(onToggleAction).toHaveBeenCalledWith('act-2', false);
    const approve = screen.getByTestId('council-plan-approve') as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('disables approve with nothing selected, and disables create until the plan is approved', () => {
    const onCreate = vi.fn();
    const { rerender } = render(
      <ActionPlanEditor
        plan={EDITOR_VIEW}
        selectedActionIds={[]}
        onToggleAction={() => undefined}
        onApprove={() => undefined}
        onCreate={onCreate}
      />,
    );
    expect((screen.getByTestId('council-plan-approve') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('council-plan-create') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('council-execution-grant-status').textContent).toContain(
      'No standing execution grant is active (status: missing)',
    );
    expect(screen.getByTestId('council-execution-grant-status').textContent).toContain(
      'Every task created from this plan stays held',
    );

    rerender(
      <ActionPlanEditor
        plan={{
          ...EDITOR_VIEW,
          plan_status: 'approved',
          approver_subject: 'owner:alice',
          execution_grant_status: 'active',
          execution_grant_ref: 'grant-1',
          items: EDITOR_VIEW.items.map((item) => ({
            ...item,
            approval_state: 'approved' as const,
            decided_by: 'owner:alice',
          })),
        }}
        selectedActionIds={['act-1', 'act-2']}
        onToggleAction={() => undefined}
        onApprove={() => undefined}
        onCreate={onCreate}
      />,
    );
    const approveAfter = screen.getByTestId('council-plan-approve') as HTMLButtonElement;
    expect(approveAfter.disabled).toBe(true);
    expect(approveAfter.textContent).toBe('Plan approved');
    expect(screen.getByTestId('council-plan-item-approval-act-1').textContent).toBe(
      'Approved by owner:alice',
    );
    expect(screen.getByTestId('council-execution-grant-status').textContent).toContain(
      'A standing execution grant is active (grant grant-1)',
    );
    const create = screen.getByTestId('council-plan-create') as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    expect(onCreate).toHaveBeenCalledTimes(1);
    // Selection is locked once the plan is approved.
    expect((screen.getByTestId('council-plan-select-act-1') as HTMLInputElement).disabled).toBe(
      true,
    );
  });
});

const LINKED_TASKS: LinkedTaskView[] = [
  {
    task_id: 'task-held-1',
    action_id: 'act-1',
    title: 'Research the pilot',
    status: 'in_progress',
    dispatch_hold: true,
    hold_reason: 'council_plan_assembling',
    released: false,
    dependencies: [],
  },
  {
    task_id: 'task-dep-2',
    action_id: 'act-2',
    title: 'Run the pilot',
    status: 'backlog',
    dispatch_hold: true,
    hold_reason: 'council_plan_assembling',
    released: false,
    dependencies: [
      {
        action_id: 'act-1',
        task_id: 'task-held-1',
        title: 'Research the pilot',
        status: 'in_progress',
        satisfied: false,
      },
      {
        action_id: 'act-0',
        task_id: null,
        title: 'Earlier step',
        status: null,
        satisfied: false,
      },
    ],
  },
  {
    task_id: 'task-done-3',
    action_id: 'act-3',
    title: 'Finished step',
    status: 'done',
    dispatch_hold: false,
    hold_reason: null,
    released: true,
    dependencies: [],
  },
  {
    task_id: 'task-blocked-4',
    action_id: 'act-4',
    title: 'Blocked step',
    status: 'blocked',
    dispatch_hold: true,
    hold_reason: 'council_plan_assembling',
    released: false,
    dependencies: [],
  },
  {
    task_id: 'task-released-5',
    action_id: 'act-5',
    title: 'Released step',
    status: 'backlog',
    dispatch_hold: false,
    hold_reason: null,
    released: true,
    dependencies: [],
  },
];

describe('LinkedTasksPanel', () => {
  it('shows real task IDs, the parent, and the plan reference', () => {
    render(
      <LinkedTasksPanel parent_task_id="task-parent-0" plan_hash={PLAN_HASH} tasks={LINKED_TASKS} />,
    );
    const panel = screen.getByTestId('council-linked-tasks');
    expect(panel.textContent).toContain('task-parent-0');
    for (const task of LINKED_TASKS) {
      expect(screen.getByTestId(`council-linked-task-${task.task_id}`).textContent).toContain(
        task.task_id,
      );
    }
  });

  it('never renders a held task as running, whatever its lifecycle status says', () => {
    render(
      <LinkedTasksPanel parent_task_id="task-parent-0" plan_hash={PLAN_HASH} tasks={LINKED_TASKS} />,
    );
    expect(screen.getByTestId('council-linked-task-state-task-held-1').textContent).toBe('Held');
    expect(screen.getByTestId('council-linked-tasks').textContent).not.toContain('In progress');
    const hold = screen.getByTestId('council-linked-task-hold-task-held-1');
    expect(hold.textContent).toContain('plan assembly barrier');
    expect(hold.textContent).toContain('not running');
    expect(
      linkedTaskStateLabel({
        task_id: 'x',
        action_id: 'a',
        title: 't',
        status: 'in_progress',
        dispatch_hold: true,
        hold_reason: 'council_plan_assembling',
        released: false,
        dependencies: [],
      }),
    ).toBe('Held');
  });

  it('renders dependency states from real task state', () => {
    render(
      <LinkedTasksPanel parent_task_id="task-parent-0" plan_hash={PLAN_HASH} tasks={LINKED_TASKS} />,
    );
    const depOpen = screen.getByTestId('council-linked-task-dep-task-dep-2-act-1');
    expect(depOpen.textContent).toContain('Not done yet');
    expect(depOpen.textContent).toContain('task-held-1');
    const depMissing = screen.getByTestId('council-linked-task-dep-task-dep-2-act-0');
    expect(depMissing.textContent).toContain('Not created');
  });

  it('renders done, blocked, and released states distinctly', () => {
    render(
      <LinkedTasksPanel parent_task_id="task-parent-0" plan_hash={PLAN_HASH} tasks={LINKED_TASKS} />,
    );
    expect(screen.getByTestId('council-linked-task-state-task-done-3').textContent).toBe('Done');
    expect(screen.getByTestId('council-linked-task-state-task-blocked-4').textContent).toBe(
      'Blocked',
    );
    expect(screen.getByTestId('council-linked-task-state-task-released-5').textContent).toBe(
      'Released to the board',
    );
  });

  it('renders the honest empty state before any task exists', () => {
    render(<LinkedTasksPanel parent_task_id={null} plan_hash={null} tasks={[]} />);
    expect(screen.getByTestId('council-linked-tasks-empty').textContent).toBe(
      'No tasks have been created from this plan yet.',
    );
  });
});
