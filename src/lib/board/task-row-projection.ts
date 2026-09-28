/**
 * A41 — ONE task-row projection, shared by every surface that shows a task.
 *
 * WHY THIS EXISTS
 * ---------------
 * A41 requires that live update, refresh, reconnect, and task detail agree
 * about preparation/execution state and provider provenance. Before this
 * module each surface hand-rolled its own SELECT and its own field list:
 *
 *   - board GET  (src/app/api/tasks/route.ts)   joined model_registry + attached
 *     8 computed fields.
 *   - detail GET (src/app/api/tasks/[id]/route.ts) joined model_registry but
 *     attached a DIFFERENT (smaller) set — no subtask_personas, no
 *     blend_confirm_state.
 *   - the 30 `task_updated` emit sites broadcast a raw `SELECT t.*` row, so
 *     none of the computed fields travelled — and `tasks.dispatch_hold` is a
 *     legacy INTEGER column, so the live payload carried `dispatch_hold: 0`
 *     where the board carried the real hold object.
 *
 * A Zustand `updateTask` replaces the card WHOLESALE
 * (src/lib/store.ts: `task.id === updatedTask.id ? updatedTask : task`), so a
 * live payload with a different key set does not merely stale the card — it
 * DROPS the fields the board had rendered.
 *
 * The fix is this module: `TASK_ROW_SELECT` (one SQL fragment) plus
 * `projectTaskRow()` (one transform). Board GET, detail GET, every emit site,
 * and the broadcast() choke point all read the same row shape from it. Adding
 * a field here adds it to all four surfaces at once — there is no second list
 * to forget.
 *
 * SERVER-ONLY. Imports better-sqlite3 through '@/lib/db'; never import from a
 * 'use client' module.
 */

import { queryOne, queryAll } from '@/lib/db';
import { loadSubtaskPersonas, loadPersonaBundleScopes } from '@/lib/persona-selector';
import { getOpenPersonaMismatch } from '@/lib/persona-mismatch';
import { getOpenDispatchHold } from '@/lib/dispatch-hold';
import { getQcHeuristicPark } from '@/lib/qc-promote';
import { getLatestBlockEvent } from '@/lib/block-events';
import { resolveProviderTruth, type ProviderTruth } from '@/lib/board/board-truth';
import type { Agent, Task } from '@/lib/types';

// P4-02 step 5 / A-U5 — cached sqlite_master probes. Schema presence is stable
// per process, and a pre-090 (or pre-104) box must not have its board fetch
// break on a JOIN to a table it does not have.
let _bundleTablePresent: boolean | null = null;
export function bundleTableExists(): boolean {
  if (_bundleTablePresent !== null) return _bundleTablePresent;
  try {
    const row = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_persona_bundle'",
      [],
    );
    _bundleTablePresent = !!row;
  } catch {
    _bundleTablePresent = false;
  }
  return _bundleTablePresent;
}

let _scopeTablePresent: boolean | null = null;
export function scopeTableExists(): boolean {
  if (_scopeTablePresent !== null) return _scopeTablePresent;
  try {
    const row = queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_persona_bundle_scope'",
      [],
    );
    _scopeTablePresent = !!row;
  } catch {
    _scopeTablePresent = false;
  }
  return _scopeTablePresent;
}

/**
 * The one SELECT list + join list every surface uses. Callers that filter
 * (board GET) append their own WHERE clauses against the `t` alias; callers
 * that fetch one row append `WHERE t.id = ?`.
 *
 * `department_id` is the board's long-standing alias for `t.workspace_id`
 * (workspaces ARE departments) and is part of the shared shape so refresh and
 * detail stop disagreeing on it too.
 */
export const TASK_ROW_SELECT_FIELDS = `
        t.*,
        t.workspace_id as department_id,
        aa.name as assigned_agent_name,
        aa.avatar_emoji as assigned_agent_emoji,
        aa.status as assigned_agent_status,
        ca.name as created_by_agent_name,
        ca.avatar_emoji as created_by_agent_emoji,
        mr.label as model_label,
        mr.provider as model_provider,
        mr.input_cost_per_million as model_input_cost_per_million,
        mr.output_cost_per_million as model_output_cost_per_million`;

/** The blend-confirm column, present only on a box that carries migration 090. */
export function blendConfirmSelectExpr(): string {
  return bundleTableExists() ? 'tpb.confirm_state as blend_confirm_state' : 'NULL as blend_confirm_state';
}

export const TASK_ROW_JOINS = `
      FROM tasks t
      LEFT JOIN agents aa ON t.assigned_agent_id = aa.id
      LEFT JOIN agents ca ON t.created_by_agent_id = ca.id
      LEFT JOIN model_registry mr ON t.model_id = mr.model_id`;

export function blendConfirmJoin(): string {
  return bundleTableExists() ? 'LEFT JOIN task_persona_bundle tpb ON tpb.task_id = t.id' : '';
}

/** Assemble the shared SELECT ... FROM ... joins for a caller's own WHERE. */
export function buildTaskRowSelect(): string {
  return `SELECT ${TASK_ROW_SELECT_FIELDS},
        ${blendConfirmSelectExpr()}
      ${TASK_ROW_JOINS}
      ${blendConfirmJoin()}`;
}

/**
 * A raw joined row as the SQL above returns it — `Task` plus the joined
 * `*_agent_*` columns the projection consumes and the A41 provider truth it
 * computes.
 */
export type TaskRowRaw = Task & {
  assigned_agent_name?: string;
  assigned_agent_emoji?: string;
  assigned_agent_status?: string;
  created_by_agent_name?: string;
  // A41 — preparation/execution state: intended model + provider vs the ACTUAL
  // runtime provider/state (see resolveExecutionState below).
  provider_truth?: ProviderTruth;
};

/**
 * PREPARATION / EXECUTION STATE — the one read of runtime provenance.
 *
 * `resolveProviderTruth` (src/lib/board/board-truth.ts, the D25 projector spec
 * 11.1/11.4 names) had NO production consumer before this module: intended
 * model/provider and the ACTUAL execution provider/state were computable and
 * never computed for a single UI row. A41 asks the four surfaces to agree about
 * this class, which is only meaningful once a surface carries it at all.
 *
 * Fail-soft: no execution row means honest nulls, never a fabricated "used".
 */
export function resolveExecutionState(task: {
  id: string;
  model_id?: string | null;
  model_label?: string | null;
  model_provider?: string | null;
}): ProviderTruth {
  let exec: { provider: string | null; state: string | null } | null = null;
  try {
    const row = queryOne<{ provider: string | null; state: string | null }>(
      'SELECT provider, state FROM task_executions WHERE task_id = ? ORDER BY generation DESC LIMIT 1',
      [task.id],
    );
    if (row) exec = row;
  } catch {
    /* pre-migration-132 box: actuals stay unknown, never invented */
  }
  return resolveProviderTruth(
    {
      model_id: task.model_id ?? null,
      model_label: task.model_label ?? null,
      model_provider: task.model_provider ?? null,
    },
    exec ? { executionProvider: exec.provider, executionState: exec.state } : null,
  );
}

/**
 * THE transform. Every surface that hands a task to a UI passes through here,
 * so refresh, task detail, live update and reconnect all carry the same keys
 * with the same values.
 *
 * Fail-soft by construction: every computed field comes from a helper that
 * returns null / [] rather than throwing, and the two identical
 * short-circuits (mismatch, qc-park) are preserved because they are cheaper
 * than the lookup and cannot change the answer — a task without a voice
 * persona never blended, and only a `review` task can carry a heuristic park.
 */
export function projectTaskRow(row: TaskRowRaw): TaskRowRaw {
  return {
    ...row,
    // ROBUST null-name guard (AF-TASKBOARD-NULLNAME): only emit the nested
    // assigned_agent object when BOTH the id AND a non-empty name are present.
    // A LEFT JOIN can return an agent_id whose joined agent row was deleted or
    // has a NULL name, which produced a truthy { name: null } that crashed
    // clients on `.name.charAt`. Every consumer gates on `task.assigned_agent ?`
    // being truthy, so `undefined` here removes the crash for ALL of them.
    assigned_agent:
      row.assigned_agent_id && row.assigned_agent_name
        ? // The joined summary is PARTIAL by design — the id/name/emoji/status
          // the board renders, exactly as this route has always shipped it
          // (several consumers already cast it by hand). `Task` declares the
          // full `Agent`; the cast is the same narrowing those consumers do,
          // moved to the one place that builds the object.
          ({
            id: row.assigned_agent_id,
            name: row.assigned_agent_name,
            avatar_emoji: row.assigned_agent_emoji,
            status: row.assigned_agent_status || 'standby',
          } as Agent)
        : undefined,
    // DEP-5 / F3.7 — multi-persona plan rows, so the kanban card can render
    // slot chips on reload as well as live.
    subtask_personas: loadSubtaskPersonas(row.id),
    // A-U5 — per-page/scoped persona-blend rows (migration 104).
    persona_bundle_scopes: scopeTableExists() ? loadPersonaBundleScopes(row.id) : [],
    // B-U6 / U20 — declared-vs-used comparator, short-circuited for a task that
    // never resolved a voice persona.
    persona_mismatch: row.voice_persona_id ? getOpenPersonaMismatch(row.id) : null,
    // U37 (C-06) — "routed but not runnable" hold. Overwrites the legacy
    // `tasks.dispatch_hold` INTEGER column that `t.*` brings along, so no
    // surface ever ships the raw 0/1 flag as if it were the hold.
    dispatch_hold: getOpenDispatchHold(row.id),
    // U38 (C-07) — human-promote gate; only a `review` task can carry it.
    qc_heuristic_park: row.status === 'review' ? getQcHeuristicPark(row.id) : null,
    // MR-30 — block history, read unconditionally so refresh and detail agree
    // on a currently-blocked task too (the panel returns early when blocked,
    // rendering the live red/amber panel from the block_* columns).
    last_block_event: getLatestBlockEvent(row.id),
    // A41 — preparation / execution state: intended model+provider vs the
    // ACTUAL runtime provider/state. Same object on every surface.
    provider_truth: resolveExecutionState(row),
  };
}

export function projectTaskRows(rows: TaskRowRaw[]): TaskRowRaw[] {
  return rows.map(projectTaskRow);
}

/**
 * ONE task, projected, for a caller that is about to broadcast it or serve it
 * as task detail. Returns null when the task does not exist — callers must
 * treat that as "nothing to send", never as an empty row.
 */
export function loadTaskRow(taskId: string): TaskRowRaw | null {
  try {
    const row = queryOne<TaskRowRaw>(`${buildTaskRowSelect()} WHERE t.id = ?`, [taskId]);
    return row ? projectTaskRow(row) : null;
  } catch {
    return null;
  }
}

/** Board GET's shape over an already-filtered row set. */
export function loadTaskRows(whereSql: string, params: unknown[]): TaskRowRaw[] {
  const rows = queryAll<TaskRowRaw>(`${buildTaskRowSelect()} ${whereSql}`, params);
  return projectTaskRows(rows);
}
