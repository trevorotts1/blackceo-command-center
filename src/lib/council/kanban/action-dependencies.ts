/**
 * CWE-036 action dependency semantics (Sections 17.6, 19.5, 19.6;
 * T094).
 *
 * Dependencies between planned actions use the repository's
 * executable task semantics, not prose:
 *
 * - The edge set is derived from committed records only: each plan
 *   item's `depends_on_action_ids` (inside the item hash and the plan
 *   hash, so an approval binds them) joined through
 *   `council_task_links` to the REAL task IDs materialization created.
 * - An edge is satisfied only when the dependency's task has reached
 *   the lifecycle's terminal `done` state through the official
 *   transition() path (with its completion-evidence gate). A task that
 *   is merely created, released, or in progress never satisfies an
 *   edge, and no model assertion can satisfy one (Section 19.7).
 * - The host board has no separate dependency table and no dependency
 *   enforcement of its own (its `dependencies` field is planning
 *   metadata), so validation lives here, at the layer that creates
 *   the edges: cycles, self-dependencies, references outside the
 *   selected plan (including another company's actions, which can
 *   never resolve inside this scope), and impossible due dates are
 *   rejected before assembly creates anything.
 */
import type Database from 'better-sqlite3';
import { CouncilActionError } from './action-errors';
import type { PlanItemState } from './plan-service';

export interface DependencyIssue {
  code:
    | 'duplicate_action_id'
    | 'self_dependency'
    | 'unknown_dependency'
    | 'dependency_cycle'
    | 'due_before_dependency'
    | 'invalid_due_at';
  action_id: string;
  depends_on_action_id?: string;
  message: string;
}

/** Validate the dependency graph and schedule of a plan's items. */
export function validateActionGraph(items: PlanItemState[]): DependencyIssue[] {
  const issues: DependencyIssue[] = [];
  const byId = new Map<string, PlanItemState>();
  for (const item of items) {
    if (byId.has(item.action_id)) {
      issues.push({
        code: 'duplicate_action_id',
        action_id: item.action_id,
        message: `Action ${item.action_id} appears more than once in the plan.`,
      });
    }
    byId.set(item.action_id, item);
  }
  for (const item of items) {
    const itemDue = item.due_at ? Date.parse(item.due_at) : null;
    if (item.due_at && (itemDue === null || Number.isNaN(itemDue))) {
      issues.push({
        code: 'invalid_due_at',
        action_id: item.action_id,
        message: `Action ${item.action_id} carries an unparseable due_at (${item.due_at}).`,
      });
    }
    for (const depId of item.depends_on_action_ids) {
      if (depId === item.action_id) {
        issues.push({
          code: 'self_dependency',
          action_id: item.action_id,
          depends_on_action_id: depId,
          message: `Action ${item.action_id} depends on itself.`,
        });
        continue;
      }
      const dep = byId.get(depId);
      if (!dep) {
        issues.push({
          code: 'unknown_dependency',
          action_id: item.action_id,
          depends_on_action_id: depId,
          message:
            `Action ${item.action_id} depends on ${depId}, which is not one of the ` +
            'selected plan actions. Dependencies must resolve inside the approved plan; ' +
            'references to other plans, other sessions, or other companies are rejected, never dropped.',
        });
        continue;
      }
      if (itemDue !== null && !Number.isNaN(itemDue) && dep.due_at) {
        const depDue = Date.parse(dep.due_at);
        if (!Number.isNaN(depDue) && itemDue < depDue) {
          issues.push({
            code: 'due_before_dependency',
            action_id: item.action_id,
            depends_on_action_id: depId,
            message:
              `Action ${item.action_id} is due at ${item.due_at}, before its dependency ` +
              `${depId} is due at ${dep.due_at}; the schedule is impossible.`,
          });
        }
      }
    }
  }
  const cycle = findCycle(items);
  if (cycle) {
    issues.push({
      code: 'dependency_cycle',
      action_id: cycle[0],
      message: `The plan's dependency graph contains a cycle: ${cycle.join(' -> ')}.`,
    });
  }
  return issues;
}

function findCycle(items: PlanItemState[]): string[] | null {
  const byId = new Map(items.map((item) => [item.action_id, item]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, 'visiting');
    stack.push(id);
    for (const depId of byId.get(id)?.depends_on_action_ids ?? []) {
      if (!byId.has(depId)) continue;
      if (state.get(depId) === 'visiting') {
        return [...stack.slice(stack.indexOf(depId)), depId];
      }
      if (!state.has(depId)) {
        const found = visit(depId);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };
  for (const item of items) {
    if (!state.has(item.action_id)) {
      const found = visit(item.action_id);
      if (found) return found;
    }
  }
  return null;
}

/** Throw the typed assembly error when the graph is not executable. */
export function assertActionGraphValid(items: PlanItemState[]): void {
  const issues = validateActionGraph(items);
  if (issues.length > 0) {
    throw new CouncilActionError(
      'COUNCIL_DEPENDENCY_INVALID',
      'The action plan dependency graph is not executable; assembly created nothing.',
      422,
      { issues: issues as unknown as Record<string, unknown> },
    );
  }
}

/**
 * Deterministic topological order (dependencies first), stable by
 * plan order. Assumes the graph was validated; a cycle yields the
 * remaining items in plan order rather than looping forever.
 */
export function topologicalActionOrder(items: PlanItemState[]): PlanItemState[] {
  const byId = new Map(items.map((item) => [item.action_id, item]));
  const emitted = new Set<string>();
  const ordered: PlanItemState[] = [];
  let progressed = true;
  while (ordered.length < items.length && progressed) {
    progressed = false;
    for (const item of items) {
      if (emitted.has(item.action_id)) continue;
      const ready = item.depends_on_action_ids.every(
        (depId) => !byId.has(depId) || emitted.has(depId),
      );
      if (ready) {
        emitted.add(item.action_id);
        ordered.push(item);
        progressed = true;
      }
    }
  }
  for (const item of items) {
    if (!emitted.has(item.action_id)) ordered.push(item);
  }
  return ordered;
}

export interface PlanTaskLink {
  action_id: string;
  task_id: string;
  operation_id: string;
  plan_hash: string;
}

/** All task links recorded for one plan, in creation order. */
export function listPlanTaskLinks(
  db: Database.Database,
  scope: { tenant_id: string; company_id: string },
  sessionId: string,
  planId: string,
): PlanTaskLink[] {
  return db
    .prepare(
      `SELECT action_id, task_id, operation_id, plan_hash
         FROM council_task_links
        WHERE tenant_id = ? AND company_id = ? AND session_id = ? AND action_proposal_id = ?
        ORDER BY created_at ASC, action_id ASC`,
    )
    .all(scope.tenant_id, scope.company_id, sessionId, planId) as PlanTaskLink[];
}

export interface ResolvedDependencyEdge {
  action_id: string;
  task_id: string | null;
  depends_on_action_id: string;
  depends_on_task_id: string | null;
}

/**
 * Resolve every dependency edge of a plan to real task IDs through
 * council_task_links. An edge whose endpoint has no link yet resolves
 * with a null task ID; it is reported, never silently dropped.
 */
export function resolvePlanEdges(
  db: Database.Database,
  scope: { tenant_id: string; company_id: string },
  sessionId: string,
  planId: string,
  items: PlanItemState[],
): ResolvedDependencyEdge[] {
  const links = listPlanTaskLinks(db, scope, sessionId, planId);
  const taskByAction = new Map(links.map((link) => [link.action_id, link.task_id]));
  const edges: ResolvedDependencyEdge[] = [];
  for (const item of items) {
    for (const depId of item.depends_on_action_ids) {
      edges.push({
        action_id: item.action_id,
        task_id: taskByAction.get(item.action_id) ?? null,
        depends_on_action_id: depId,
        depends_on_task_id: taskByAction.get(depId) ?? null,
      });
    }
  }
  return edges;
}

export interface DependencyState {
  depends_on_action_id: string;
  task_id: string | null;
  /** Live lifecycle status of the dependency's task, when created. */
  status: string | null;
  /** True only when the dependency task is in the terminal done state. */
  satisfied: boolean;
}

/**
 * Live dependency states for one action: each dependency's real task
 * status, read from the tasks table at evaluation time. Satisfaction
 * is the lifecycle's `done` state and nothing weaker (Section 19.7).
 */
export function dependencyStatesFor(
  db: Database.Database,
  scope: { tenant_id: string; company_id: string },
  sessionId: string,
  planId: string,
  item: PlanItemState,
): DependencyState[] {
  const links = listPlanTaskLinks(db, scope, sessionId, planId);
  const taskByAction = new Map(links.map((link) => [link.action_id, link.task_id]));
  return item.depends_on_action_ids.map((depId) => {
    const taskId = taskByAction.get(depId) ?? null;
    if (!taskId) {
      return { depends_on_action_id: depId, task_id: null, status: null, satisfied: false };
    }
    const row = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
      | { status: string }
      | undefined;
    const status = row?.status ?? null;
    return {
      depends_on_action_id: depId,
      task_id: taskId,
      status,
      satisfied: status === 'done',
    };
  });
}
