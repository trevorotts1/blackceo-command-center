/**
 * Goals store — DB helpers + vault mirror over the `operator_goals` table
 * (Migration 037).
 *
 * Track B6 (Operator Console Goals sub-module, PRD Section 4.7).
 *
 * The SQLite row is the canonical record; `<vault>/goals.md` (and per-category
 * subfiles under `<vault>/goals/<category>.md`) is a human-editable mirror so
 * Memory search and Obsidian can pick goals up alongside other notes. PRD 4.7
 * gives the operator the option of either layout — we always mirror BOTH for
 * forward compatibility:
 *
 *   - `<vault>/goals.md`                  — full markdown checklist, all goals.
 *   - `<vault>/goals/<category>.md`       — per-category checklist.
 *
 * Mirror failures are logged but never break the API call. The DB row is the
 * source of truth.
 */
import { randomUUID } from 'crypto';
import { queryAll, queryOne, run } from '@/lib/db';
import { writeClientFile, isRemoteError } from '@/lib/operator/client-fs';
import {
  getClientContext,
  clientToOpenClawTarget,
} from '@/lib/clients';
import { getOpenClawClient } from '@/lib/openclaw/client';

export interface GoalRow {
  id: string;
  category: string | null;
  title: string;
  body: string | null;
  completed: number;
  completed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Goal {
  id: string;
  category: string | null;
  title: string;
  body: string | null;
  completed: boolean;
  completed_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

function decodeRow(row: GoalRow): Goal {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    completed: !!row.completed,
    completed_at: row.completed_at,
    sort_order: row.sort_order ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface ListGoalsOptions {
  category?: string | null;
  completed?: boolean | null;
}

export function listGoals(opts: ListGoalsOptions = {}): Goal[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (typeof opts.category === 'string') {
    where.push('category = ?');
    params.push(opts.category);
  }
  if (typeof opts.completed === 'boolean') {
    where.push('completed = ?');
    params.push(opts.completed ? 1 : 0);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = queryAll<GoalRow>(
    `SELECT id, category, title, body, completed, completed_at, sort_order, created_at, updated_at
     FROM operator_goals
     ${whereSql}
     ORDER BY completed ASC, sort_order ASC, datetime(created_at) DESC, id DESC`,
    params
  );
  return rows.map(decodeRow);
}

export function getGoal(id: string): Goal | null {
  const row = queryOne<GoalRow>(
    `SELECT id, category, title, body, completed, completed_at, sort_order, created_at, updated_at
     FROM operator_goals WHERE id = ?`,
    [id]
  );
  return row ? decodeRow(row) : null;
}

export interface CreateGoalInput {
  title: string;
  body?: string | null;
  category?: string | null;
  sort_order?: number;
}

export function createGoal(input: CreateGoalInput): Goal {
  const id = randomUUID();
  const now = new Date().toISOString();
  run(
    `INSERT INTO operator_goals
       (id, category, title, body, completed, completed_at, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
    [
      id,
      input.category ?? null,
      input.title,
      input.body ?? null,
      typeof input.sort_order === 'number' ? input.sort_order : 0,
      now,
      now,
    ]
  );
  return getGoal(id)!;
}

export interface UpdateGoalInput {
  title?: string;
  body?: string | null;
  category?: string | null;
  completed?: boolean;
  sort_order?: number;
}

export function updateGoal(id: string, input: UpdateGoalInput): Goal | null {
  const existing = getGoal(id);
  if (!existing) return null;
  const fields: string[] = [];
  const params: unknown[] = [];
  if (typeof input.title === 'string') {
    fields.push('title = ?');
    params.push(input.title);
  }
  if (input.body !== undefined) {
    fields.push('body = ?');
    params.push(input.body);
  }
  if (input.category !== undefined) {
    fields.push('category = ?');
    params.push(input.category);
  }
  if (typeof input.completed === 'boolean') {
    fields.push('completed = ?');
    params.push(input.completed ? 1 : 0);
    fields.push('completed_at = ?');
    params.push(input.completed ? new Date().toISOString() : null);
  }
  if (typeof input.sort_order === 'number') {
    fields.push('sort_order = ?');
    params.push(input.sort_order);
  }
  if (fields.length === 0) return existing;
  fields.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  run(`UPDATE operator_goals SET ${fields.join(', ')} WHERE id = ?`, params);
  return getGoal(id);
}

export function deleteGoal(id: string): boolean {
  const res = run(`DELETE FROM operator_goals WHERE id = ?`, [id]);
  return res.changes > 0;
}

/**
 * Render the current DB state to markdown checklist files in the SELECTED
 * client's workspace. Writes a top-level `goals.md` with everything and
 * per-category subfiles.
 *
 * PER-CLIENT (E12): like the journal mirror, the goals land in the selected
 * client agent's OWN workspace (local fs for self, SSH tunnel for a remote
 * client) so the agent's memory crawler picks them up. Best-effort: returns the
 * list of files written (or empty on error / down tunnel).
 */
export async function writeVaultMirror(): Promise<string[]> {
  const written: string[] = [];
  try {
    const goals = listGoals();

    // Top-level master file.
    const master = await writeClientFile('vault-root', 'goals.md', renderMarkdown(goals, 'All goals'));
    if (master && !isRemoteError(master)) {
      written.push(master.absPath);
    } else if (master && isRemoteError(master)) {
      console.error('[goals] writeVaultMirror remote failed:', master.reason);
      return written; // tunnel down — skip the subfiles too
    }

    // Per-category subfiles.
    const byCategory = new Map<string, Goal[]>();
    for (const g of goals) {
      const key = (g.category && g.category.trim()) || 'uncategorized';
      const arr = byCategory.get(key) || [];
      arr.push(g);
      byCategory.set(key, arr);
    }
    for (const [category, items] of Array.from(byCategory.entries())) {
      const safe = category.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'uncategorized';
      const sub = await writeClientFile('vault-root', `goals/${safe}.md`, renderMarkdown(items, `Goals: ${category}`));
      if (sub && !isRemoteError(sub)) written.push(sub.absPath);
    }
  } catch (err) {
    console.error('[goals] writeVaultMirror failed:', err);
  }
  return written;
}

// ---- AI step (E12): goals → client agent dispatch context -----------------

/**
 * Build a compact, plain-text context block listing the SELECTED client's
 * ACTIVE (incomplete) goals. Feature clusters that dispatch a turn to the
 * client agent (Bridge, Call mode) prepend this so the agent always knows what
 * the operator is currently driving toward — the "inject active goals into the
 * client agent dispatch context" half of E12.
 *
 * Returns an empty string when there are no active goals, so callers can
 * unconditionally prepend it.
 */
export function buildGoalsContext(opts: { max?: number } = {}): string {
  const max = Math.max(1, Math.min(50, opts.max ?? 12));
  let active: Goal[];
  try {
    active = listGoals({ completed: false });
  } catch {
    return '';
  }
  if (active.length === 0) return '';
  const shown = active.slice(0, max);
  const lines: string[] = [];
  lines.push('## Active goals (operator context)');
  lines.push('These are the operator\'s current open goals. Keep them in mind and');
  lines.push('flag anything in this turn that moves one forward or blocks it.');
  lines.push('');
  for (const g of shown) {
    const cat = g.category ? ` [${g.category}]` : '';
    lines.push(`- ${g.title}${cat}`);
  }
  if (active.length > shown.length) {
    lines.push(`- ...and ${active.length - shown.length} more`);
  }
  return lines.join('\n');
}

export interface OnTrackResult {
  ok: boolean;
  /** The agent's plain-text assessment, when it returned one. */
  assessment?: string;
  /** Number of active goals considered. */
  activeGoals: number;
  reason?: string;
}

/**
 * Periodic on-track check (E12): dispatch the active-goals context to the
 * SELECTED client's OpenClaw agent and ask for a short "are we on track?"
 * assessment. Designed to be called from a cron / scheduled job (it resolves
 * the client itself and never throws).
 *
 * Uses `getOpenClawClient(clientToOpenClawTarget(client))` so a remote client's
 * gateway (with CF-Access headers) is targeted, not the loopback. A down
 * gateway returns `{ ok: false, reason }` rather than throwing.
 */
export async function goalsOnTrackCheck(): Promise<OnTrackResult> {
  const active = (() => {
    try {
      return listGoals({ completed: false });
    } catch {
      return [] as Goal[];
    }
  })();
  if (active.length === 0) {
    return { ok: true, activeGoals: 0, assessment: 'No active goals to check.' };
  }

  const client = getClientContext();
  if (!client) {
    return { ok: false, activeGoals: active.length, reason: 'no client selected' };
  }

  const context = buildGoalsContext({ max: 25 });
  const prompt =
    `${context}\n\n` +
    'Briefly assess whether the operator is on track against these goals based ' +
    'on recent activity in your workspace. Reply in 3 to 5 sentences: what is ' +
    'progressing, what is stalled, and the single most useful next action. Do ' +
    'not use em dashes.';

  try {
    const oc = getOpenClawClient(clientToOpenClawTarget(client));
    if (!oc.isConnected()) {
      await oc.connect();
    }
    // One-shot dispatch keyed on a stable per-client session id so the check
    // threads into the agent's own activity log.
    await oc.sendMessage(`goals-on-track:${client.id}`, prompt);
    return {
      ok: true,
      activeGoals: active.length,
      assessment:
        'On-track check dispatched to the client agent. Its assessment will ' +
        'arrive in the agent activity log.',
    };
  } catch (err) {
    return {
      ok: false,
      activeGoals: active.length,
      reason: err instanceof Error ? err.message : 'gateway dispatch failed',
    };
  }
}

function renderMarkdown(goals: Goal[], heading: string): string {
  const lines: string[] = [];
  lines.push(`# ${heading}`);
  lines.push('');
  lines.push(`_Mirrored from operator_goals at ${new Date().toISOString()}._`);
  lines.push('');
  if (goals.length === 0) {
    lines.push('_No goals._');
    return lines.join('\n');
  }
  for (const g of goals) {
    const box = g.completed ? '[x]' : '[ ]';
    const cat = g.category ? ` _(${g.category})_` : '';
    lines.push(`- ${box} ${g.title}${cat}`);
    if (g.body && g.body.trim()) {
      const indented = g.body
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n');
      lines.push(indented);
    }
  }
  lines.push('');
  return lines.join('\n');
}
