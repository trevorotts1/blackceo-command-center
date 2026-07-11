/**
 * owner-reports.ts — the OWNER NOTIFICATION funnel (spec §5, build-plan W5).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS
 * ────────────────────────────────────────────────────────────────────────────
 * ONE thin funnel for the three owner messages the Zero-Human spec §5 requires,
 * so that no status-write code path can ship silent and every report carries
 * the full field set:
 *
 *   1. notifyOwnerAssigned(taskId)  — "I'm sending this task to the [Dept] department."
 *   2. notifyOwnerStarted(taskId)   — persona + department + specialist + SOP + role
 *   3. notifyOwnerDone(taskId)      — who/role + where-to-find-it + SOP + persona
 *
 * (Bonus, for the held-task edge case in W5: notifyOwnerHeld(taskId, reason).)
 *
 * Every helper SELF-RESOLVES all of its fields from the live DB given only a
 * taskId, joining tasks → agents → sops and reading the latest deliverable. The
 * caller may pass already-resolved values (most are in scope at dispatch time)
 * via the optional `overrides` arg to skip the redundant reads — but the helper
 * never *requires* them, so a raw `UPDATE status` path can funnel through here
 * with nothing but the task id.
 *
 * DESIGN CONTRACT (mirrors notify.ts, do not break):
 *   - BEST-EFFORT: a failed resolve or send NEVER throws. Returns boolean.
 *     Callers wrap in try/catch anyway (matching the existing DONE blocks) but
 *     this module guarantees it on its own.
 *   - NEVER blocks/rolls back DB state. Notification is downstream of the write.
 *   - Gateway-routed only: delegates to notify.ts notifyOwner() →
 *     `openclaw message send` (spec §8 / MEMORY: never a direct Bot API call).
 *   - Test/CI gate: OWNER_NOTIFY_TELEGRAM_DISABLED=1 suppresses sends (honored
 *     inside notify.ts). Must NOT be inherited by a live box (W5 edge case).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * INTEGRATION POINTS — where each export gets wired in (build-plan §6 item 4/5,
 * W5.1–W5.4). This file is PURE NET-NEW; the call sites below are edited at
 * integration time, NOT by this file.
 * ────────────────────────────────────────────────────────────────────────────
 *   notifyOwnerAssigned():
 *     • src/app/api/webhooks/auto-route/route.ts:89
 *         (after the `assigned_agent_id` UPDATE — the auto-route assignment)
 *     • src/app/api/tasks/ingest/route.ts:~330
 *         (symmetric call in the ingest assignment path)
 *
 *   notifyOwnerStarted():
 *     • src/app/api/tasks/[id]/dispatch/route.ts:436
 *         (after the `status='in_progress'` UPDATE; persona/dept/specialist/
 *          SOP/role are all in local scope — pass them as overrides)
 *     • src/lib/task-dispatcher.ts  (autoDispatchTask, after its in_progress flip)
 *
 *   notifyOwnerDone():  [single funnel for ALL ~20+ raw done paths]
 *     • src/lib/task-lifecycle.ts:250-253
 *         (the transition() 'done' case — THE central funnel point)
 *     • src/app/api/tasks/[id]/route.ts:434-436
 *         (manual / QC-agent approval PATCH — replaces the bare 2-field string)
 *     • src/lib/qc-scorer.ts:3484-3486
 *         (QC auto-approve — replaces the bare 2-field string)
 *
 *   notifyOwnerHeld():  (optional, W5 held-task edge case)
 *     • any path that sets `routed_but_not_dispatched` / holds a task so the
 *       owner isn't left with an assignment and no follow-up.
 * ════════════════════════════════════════════════════════════════════════════
 */

import path from 'path';
import { queryOne } from '@/lib/db';
import { notifyOwner } from '@/lib/notify';
import { getMissionControlUrl } from '@/lib/config';
import type { Task, Agent } from '@/lib/types';
import type { SOP } from '@/lib/sops';

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

/**
 * The five spec-§5 fields, plus the deliverable location for DONE. Every value
 * is optional/nullable so a partially-provisioned task still produces a report
 * with sensible fallbacks rather than throwing.
 */
export interface OwnerReportFields {
  /** task.title */
  title: string;
  /** task.department (canonical slug or label) */
  department: string | null;
  /** active persona guiding the work — task.persona_name */
  persona: string | null;
  /** the AI specialist handling it — assigned agent name */
  specialist: string | null;
  /** the specialist's role — assigned agent role */
  role: string | null;
  /** the SOP driving the work — sops.name resolved via task.sop_id */
  sop: string | null;
  /**
   * CLIENT-SAFE "where to find it" (MSG-02): the board URL, optionally with a
   * deliverable's BASENAME as a hint. NEVER a raw operator filesystem path.
   */
  location: string | null;
}

/** Caller-supplied overrides; any field omitted is resolved from the DB. */
export type OwnerReportOverrides = Partial<OwnerReportFields>;

/**
 * Resolve the report fields for a task. Single set of joins; best-effort.
 * Returns null ONLY if the task row itself cannot be found (nothing to report).
 */
export function resolveReportFields(
  taskId: string,
  overrides: OwnerReportOverrides = {},
): OwnerReportFields | null {
  let task: Task | undefined;
  try {
    task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
  } catch (err) {
    console.error(
      '[owner-reports] resolveReportFields: task lookup failed (%s): %s',
      taskId,
      (err as Error).message,
    );
    return null;
  }
  if (!task) {
    console.warn('[owner-reports] resolveReportFields: no task row for %s', taskId);
    return null;
  }

  // Assigned agent → specialist name + role.
  let agent: Agent | undefined;
  if (
    (overrides.specialist === undefined || overrides.role === undefined) &&
    task.assigned_agent_id
  ) {
    try {
      agent = queryOne<Agent>(
        'SELECT id, name, role FROM agents WHERE id = ?',
        [task.assigned_agent_id],
      );
    } catch {
      /* best-effort: leave undefined */
    }
  }

  // SOP name via task.sop_id (only if not overridden).
  let sop: SOP | undefined;
  if (overrides.sop === undefined && task.sop_id) {
    try {
      sop = queryOne<SOP>(
        'SELECT id, name FROM sops WHERE id = ? AND deleted_at IS NULL',
        [task.sop_id],
      );
    } catch {
      /* best-effort */
    }
  }

  return {
    title: overrides.title ?? task.title,
    department: overrides.department ?? task.department ?? null,
    persona: overrides.persona ?? task.persona_name ?? null,
    specialist: overrides.specialist ?? agent?.name ?? null,
    role: overrides.role ?? agent?.role ?? null,
    sop: overrides.sop ?? sop?.name ?? null,
    location: clientSafeLocation(taskId, overrides.location),
  };
}

/**
 * MSG-02 — the client-safe "where to find it" value.
 *
 * NEVER surface a raw absolute operator filesystem path to the client
 * (MOVE-IN-SILENCE). The Command Center board URL is the canonical,
 * client-safe location. Resolution:
 *   • A caller override or deliverable value that is ALREADY a public URL
 *     (http/https) is safe → pass it through.
 *   • Anything else is treated as a filesystem path: strip to its BASENAME
 *     (the filename only — never the operator's directory tree) and anchor the
 *     owner at the board URL where they can actually retrieve it.
 *   • No deliverable at all → the board URL alone.
 */
function clientSafeLocation(taskId: string, override?: string | null): string {
  const board = boardUrl(taskId);
  const raw = (override ?? resolveLocation(taskId) ?? '').trim();
  if (!raw) return board;
  if (/^https?:\/\//i.test(raw)) return raw;
  const name = path.basename(raw);
  return name ? `${name} — ${board}` : board;
}

/**
 * Where-to-find-it: the latest registered deliverable path for the task.
 * Returns null when there is no deliverable yet (caller falls back to the board).
 */
function resolveLocation(taskId: string): string | null {
  try {
    const row = queryOne<{ path: string | null }>(
      `SELECT path FROM task_deliverables
       WHERE task_id = ? AND path IS NOT NULL AND path <> ''
       ORDER BY created_at DESC, rowid DESC
       LIMIT 1`,
      [taskId],
    );
    return row?.path ?? null;
  } catch {
    return null;
  }
}

/** The Command Center board link for a task — the universal fallback location. */
function boardUrl(taskId: string): string {
  try {
    return `${getMissionControlUrl()}/tasks/${taskId}`;
  } catch {
    return `/tasks/${taskId}`;
  }
}

/** Human-readable department label with a safe fallback. */
function deptLabel(department: string | null): string {
  return department && department.trim() ? department : 'your team';
}

// ---------------------------------------------------------------------------
// The three (+1) owner notifications
// ---------------------------------------------------------------------------

/**
 * ASSIGNMENT (spec §5): "I'm sending this task to the [Department] department."
 * Fire after the `assigned_agent_id` UPDATE. Resolves the department from the
 * task unless provided.
 *
 * @returns true if a Telegram send was attempted+succeeded, false otherwise.
 */
export function notifyOwnerAssigned(
  taskId: string,
  overrides: OwnerReportOverrides = {},
): boolean {
  try {
    const f = resolveReportFields(taskId, overrides);
    if (!f) return false;
    const dept = deptLabel(f.department);
    const msg = `📥 I'm sending this task to the *${dept}* department.\n\n*Task:* ${f.title}`;
    return notifyOwner(msg);
  } catch (err) {
    console.error(
      '[owner-reports] notifyOwnerAssigned error (non-fatal): %s',
      (err as Error).message,
    );
    return false;
  }
}

/**
 * START (spec §5): "Your task has started" + persona + department + specialist
 * + SOP + role. Fire after the `status='in_progress'` UPDATE. At dispatch time
 * all five values are already in local scope — pass them via `overrides` to
 * avoid the extra reads (the funnel self-resolves any you omit).
 *
 * @returns true if a Telegram send was attempted+succeeded, false otherwise.
 */
export function notifyOwnerStarted(
  taskId: string,
  overrides: OwnerReportOverrides = {},
): boolean {
  try {
    const f = resolveReportFields(taskId, overrides);
    if (!f) return false;
    const lines = [
      `🚀 *Your task has started.*`,
      ``,
      `*Task:* ${f.title}`,
      `*Department:* ${deptLabel(f.department)}`,
      `*Specialist:* ${f.specialist ?? 'assigning…'}`,
      `*Role:* ${f.role ?? '—'}`,
      `*Persona:* ${f.persona ?? 'auto-select'}`,
      `*SOP:* ${f.sop ?? '—'}`,
    ];
    return notifyOwner(lines.join('\n'));
  } catch (err) {
    console.error(
      '[owner-reports] notifyOwnerStarted error (non-fatal): %s',
      (err as Error).message,
    );
    return false;
  }
}

/**
 * DONE (spec §5): "Your task is complete" + who completed it (role) + where to
 * find it + which SOP + which persona. This is the SINGLE funnel the ~20+ raw
 * done paths route through (via task-lifecycle.transition()'s done case), so a
 * new status-write path cannot ship a silent or bare-2-field done.
 *
 * @returns true if a Telegram send was attempted+succeeded, false otherwise.
 */
export function notifyOwnerDone(
  taskId: string,
  overrides: OwnerReportOverrides = {},
): boolean {
  try {
    const f = resolveReportFields(taskId, overrides);
    if (!f) return false;
    const who = f.specialist
      ? `${f.specialist}${f.role ? ` (${f.role})` : ''}`
      : f.role ?? deptLabel(f.department);
    const lines = [
      `✅ *Your task is complete.*`,
      ``,
      `*Task:* ${f.title}`,
      `*Completed by:* ${who}`,
      `*Department:* ${deptLabel(f.department)}`,
      `*Where to find it:* ${f.location}`,
      `*SOP:* ${f.sop ?? '—'}`,
      `*Persona:* ${f.persona ?? '—'}`,
    ];
    return notifyOwner(lines.join('\n'));
  } catch (err) {
    console.error(
      '[owner-reports] notifyOwnerDone error (non-fatal): %s',
      (err as Error).message,
    );
    return false;
  }
}

/**
 * SCHEMA-ERROR ESCALATION: best-effort owner notification when an ingest write fails
 * because this box's schema is behind pending migrations. Tells the owner the box
 * needs `npm run db:seed` / a redeploy so work is not silently lost.
 *
 * Same gateway-routed, fail-soft contract as notifyOwnerAssigned — never throws into
 * the request path.
 *
 * @returns true if a Telegram send was attempted+succeeded, false otherwise.
 */
export function notifyOwnerSchemaError(detail: string): boolean {
  try {
    const msg =
      `⚠️ Command Center ingest failed on this box: schema out of date (${detail}). ` +
      `A task was NOT captured. Restart the app / run migrations (npm run db:seed) and retry.`;
    return notifyOwner(msg);
  } catch (err) {
    console.error(
      '[owner-reports] notifyOwnerSchemaError error (non-fatal): %s',
      (err as Error).message,
    );
    return false;
  }
}

/**
 * HELD (W5 edge case): when a routed task is held (e.g. `routed_but_not_dispatched`)
 * and START will NOT fire, tell the owner so they aren't left with an assignment
 * and no follow-up. Optional; not one of the three required §5 messages.
 *
 * @returns true if a Telegram send was attempted+succeeded, false otherwise.
 */
export function notifyOwnerHeld(
  taskId: string,
  reason?: string,
  overrides: OwnerReportOverrides = {},
): boolean {
  try {
    const f = resolveReportFields(taskId, overrides);
    if (!f) return false;
    const lines = [
      `⏸️ *Your task is queued and waiting.*`,
      ``,
      `*Task:* ${f.title}`,
      `*Department:* ${deptLabel(f.department)}`,
      reason ? `*Why:* ${reason}` : null,
      `I'll report again as soon as it starts.`,
    ].filter((l): l is string => l !== null);
    return notifyOwner(lines.join('\n'));
  } catch (err) {
    console.error(
      '[owner-reports] notifyOwnerHeld error (non-fatal): %s',
      (err as Error).message,
    );
    return false;
  }
}
