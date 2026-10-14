'use client';

/**
 * LinkedTasksPanel (CWE-036, Skill 77) - the canonical projection of
 * the tasks an approved council plan created (Section 21).
 *
 * The panel renders committed board state only: real task IDs, the
 * task's real lifecycle status, its dispatch hold, and each
 * dependency's real state. It keeps no duplicate local task status.
 * A held task NEVER renders as running: the dispatch hold wins over
 * every lifecycle label, because a held task is not executing no
 * matter what its column says.
 */

import './LinkedTasksPanel.css';

export interface LinkedTaskDependencyView {
  action_id: string;
  task_id: string | null;
  title: string;
  /** The dependency task's real lifecycle status; null when not created. */
  status: string | null;
  /** True only when the dependency task reached the terminal done state. */
  satisfied: boolean;
}

export interface LinkedTaskView {
  task_id: string;
  action_id: string;
  title: string;
  /** Real lifecycle status from the tasks table. */
  status: string;
  dispatch_hold: boolean;
  hold_reason: string | null;
  /** True when the execution guard released this task from the council hold. */
  released: boolean;
  dependencies: readonly LinkedTaskDependencyView[];
}

export interface LinkedTasksPanelProps {
  parent_task_id: string | null;
  plan_hash: string | null;
  tasks: readonly LinkedTaskView[];
}

/**
 * The one honest state label for a linked task. Order matters: done
 * is terminal truth; blocked is a visible owner-facing state; the
 * dispatch hold outranks every working label, so a held task can
 * never render as in progress or running.
 */
export function linkedTaskStateLabel(task: LinkedTaskView): string {
  if (task.status === 'done') return 'Done';
  if (task.status === 'blocked') return 'Blocked';
  if (task.dispatch_hold) return 'Held';
  if (task.released) return 'Released to the board';
  switch (task.status) {
    case 'in_progress':
      return 'In progress';
    case 'review':
      return 'In review';
    case 'testing':
      return 'In testing';
    case 'assigned':
      return 'Assigned';
    case 'pending_dispatch':
      return 'Waiting for dispatch';
    case 'planning':
      return 'Being prepared';
    case 'inbox':
    case 'backlog':
      return 'Waiting';
    default:
      return task.status;
  }
}

function holdReasonLabel(holdReason: string | null): string {
  if (holdReason === 'council_plan_assembling') return 'plan assembly barrier';
  return holdReason ?? 'dispatch hold';
}

function dependencyStateLabel(dep: LinkedTaskDependencyView): string {
  if (dep.satisfied) return 'Done';
  if (!dep.task_id || !dep.status) return 'Not created';
  if (dep.status === 'blocked') return 'Blocked';
  return dep.status === 'done' ? 'Done' : 'Not done yet';
}

export function LinkedTasksPanel({ parent_task_id, plan_hash, tasks }: LinkedTasksPanelProps) {
  return (
    <section className="council-linked-panel" data-testid="council-linked-tasks" aria-label="Linked tasks">
      <h2 className="council-linked-heading">Linked tasks</h2>
      {parent_task_id ? (
        <p className="council-linked-meta">
          Parent task: <code>{parent_task_id}</code>
          {plan_hash ? (
            <>
              {' '}
              · Plan <code>{plan_hash.slice(0, 12)}…</code>
            </>
          ) : null}
        </p>
      ) : null}
      {tasks.length === 0 ? (
        <p className="council-linked-empty" data-testid="council-linked-tasks-empty">
          No tasks have been created from this plan yet.
        </p>
      ) : (
        <ul className="council-linked-list">
          {tasks.map((task) => (
            <li
              key={task.task_id}
              className="council-linked-task"
              data-testid={`council-linked-task-${task.task_id}`}
            >
              <div className="council-linked-task-head">
                <span className="council-linked-task-title">{task.title}</span>
                <span
                  className="council-linked-state"
                  data-testid={`council-linked-task-state-${task.task_id}`}
                >
                  {linkedTaskStateLabel(task)}
                </span>
              </div>
              <p className="council-linked-meta">
                Task ID: <code>{task.task_id}</code>
              </p>
              {task.dispatch_hold ? (
                <p className="council-linked-hold" data-testid={`council-linked-task-hold-${task.task_id}`}>
                  Held: {holdReasonLabel(task.hold_reason)}. This task is not running and
                  cannot be dispatched.
                </p>
              ) : null}
              {task.dependencies.length > 0 ? (
                <ul className="council-linked-deps">
                  {task.dependencies.map((dep) => (
                    <li
                      key={dep.action_id}
                      data-testid={`council-linked-task-dep-${task.task_id}-${dep.action_id}`}
                    >
                      Depends on {dep.title}: {dependencyStateLabel(dep)}
                      {dep.task_id ? (
                        <>
                          {' '}
                          (<code>{dep.task_id}</code>)
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
