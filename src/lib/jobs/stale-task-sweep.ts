/**
 * Stale Task Sweep (N36 / SOP-01-Blocked-vs-Return).
 *
 * Detects tasks that have made no progress past their column threshold and
 * returns them to the orchestrator for re-routing. Nothing rots silently.
 *
 * Per-column thresholds (configurable via env, defaults in STALE_THRESHOLDS):
 *   in_progress:   24h
 *   review:        12h
 *   to-do/backlog: 48h
 *   blocked:       re-ping at 2h (STALE_BLOCKED_REPING_HOURS); return to
 *                  orchestrator at 6h TOTAL from first block
 *                  (STALE_BLOCKED_REPINGED_HOURS). FIX 24 tightened both
 *                  (was 72h re-ping / 144h return).
 *
 * What happens:
 *   - Non-Blocked stale tasks: synthesize a broken-but-agent-could handback
 *     and call the return-to-orchestrator logic directly (sets status=backlog,
 *     writes task_returned event, broadcasts task_updated).
 *   - Blocked stale tasks: re-ping the named blocked_on_human once (Telegram
 *     for owner / Rescue Rangers webhook for operator). After a second
 *     threshold (STALE_BLOCKED_REPINGED_THRESHOLD_HOURS), return to the
 *     orchestrator to re-classify.
 *     "Once" is ENFORCED (SWEEP-DEDUP): the sweep runs every 10 minutes but the
 *     re-ping window is 2h wide (FIX 24), so the re-ping is gated on wasRecentlyRepinged()
 *     — at most one escalation per task per STALE_REPING_DEDUP_HOURS (default 24h).
 *     This is a CAP, not a mute: a still-stuck task escalates again next window,
 *     and the guard FAILS OPEN so a query error can never silence an escalation.
 *
 * Reads last_progress_at (migration 071). Falls back to updated_at when
 * last_progress_at is NULL (pre-migration-071 DB).
 *
 * Disable with DISABLE_STALE_TASK_SWEEP=1 — set it in the environment, or
 * durably (deploy-proof) with `bash scripts/operator-flag.sh set
 * DISABLE_STALE_TASK_SWEEP 1`. Either source disables the sweep; see
 * src/lib/ops/operator-kill-flags.ts.
 *
 * U101: every STALE_THRESHOLDS entry is a global default, additionally
 * overridable per-department via config/board-slas.json (src/lib/
 * board-slas.ts) — precedence: explicit env var > that task's department
 * entry > the hardcoded default. An absent/malformed config file is
 * fail-closed to the unchanged, byte-identical global-default behavior.
 */

import { queryAll, queryOne, run, sqlTime, parseDbTime } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { getMissionControlUrl } from '@/lib/config';
import { missionControlAuthHeaders } from '@/lib/mc-auth';
import { notifySystem } from '@/lib/notify';
import { recoverFinishedTaskToReview } from './finished-work-recovery';
import { resolveStaleTaskSweepKillFlag, killFlagSkipReason } from '@/lib/ops/operator-kill-flags';
import { resolveSlaThreshold, minPossibleSlaThreshold } from '@/lib/board-slas';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
// FIX 41: the QC-reroute cap constant — the stale sweep must never push a card
// past it (see the capped-skip guard in the blocked branch and the no-increment
// rule on from-blocked returns in returnToOrchestrator below).
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';
import { transition, recordStatusEvent } from '@/lib/task-lifecycle';
import { blockDispatchIfOwnerKilled } from '@/lib/owner-killed';
import { v4 as uuidv4 } from 'uuid';

export const STALE_TASK_SWEEP_CRON = '*/10 * * * *';

// F09 / FIX 24: presentations signature-deck renders legitimately run for many
// hours (40 pipeline phases; batch render of 25-50 slides). In_progress
// presentations tasks younger than this many hours since last progress are
// exempt from the stale return. FIX 24 tightened the shipped default 72h → 24h
// (a render 24h+ with NO activity is a dead run, not a long build — render/QC
// legitimately run hours, not a literal day). Env-overridable; a non-positive
// override is REJECTED (warned about) and the default 24 ships.
export const PRESENTATIONS_RENDER_EXEMPT_HOURS = (() => {
  const raw = (process.env.PRESENTATIONS_RENDER_EXEMPT_HOURS ?? '').trim();
  if (raw === '') return 24;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[stale-task-sweep] PRESENTATIONS_RENDER_EXEMPT_HOURS="${raw}" is invalid (must be a positive number of hours) — using default 24`,
    );
    return 24;
  }
  return parsed;
})();

/**
 * FIX 24: the blocked-card lifecycle windows, resolved ONCE as a validated pair.
 *
 *   STALE_BLOCKED_REPING_HOURS      — first re-ping to the named human.
 *     Shipped default 2h (was 72h = half the old 144h return window): a missed
 *     block catches the same working session instead of three days later.
 *   STALE_BLOCKED_REPINGED_HOURS    — return to orchestrator / operator
 *     escalation, TOTAL from first block. Shipped default 6h (was 144h).
 *
 * VALIDATION: each window must parse to a positive finite number (0, -1, NaN,
 * "abc" → REJECTED, default ships), AND the escalation window must not be
 * shorter than the first re-ping window (internally inverted → BOTH rejected,
 * defaults ship). The pair is also re-checked per-row at runtime (see the
 * blocked branch) because resolveSlaThreshold reads env/board-slas.json
 * independently of this module-level resolve.
 */
export function resolveBlockedWindows(
  repingRaw: string | undefined,
  returnedRaw: string | undefined,
): { reping: number; returned: number } {
  const parsePositive = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    const t = raw.trim();
    if (t === '') return null;
    const parsed = Number(t);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
  };
  const reping = parsePositive(repingRaw) ?? 2;
  const returned = parsePositive(returnedRaw) ?? 6;
  if (returned < reping) {
    console.warn(
      `[stale-task-sweep] internally inverted blocked windows: STALE_BLOCKED_REPINGED_HOURS="${returned}" is shorter than ` +
        `STALE_BLOCKED_REPING_HOURS="${reping}" — escalation must never fire before the first re-ping. Rejecting both overrides; ` +
        `shipped defaults apply (re-ping 2h, return 6h).`,
    );
    return { reping: 2, returned: 6 };
  }
  return { reping, returned };
}

const BLOCKED_WINDOWS = resolveBlockedWindows(
  process.env.STALE_BLOCKED_REPING_HOURS,
  process.env.STALE_BLOCKED_REPINGED_HOURS,
);

/** FIX 24: first blocked-card re-ping, hours (see BLOCKED_WINDOWS). */
export const STALE_BLOCKED_REPING_HOURS = BLOCKED_WINDOWS.reping;

// Per-column stale thresholds in hours.
const STALE_THRESHOLDS: Record<string, number> = {
  in_progress: parseFloat(process.env.STALE_IN_PROGRESS_HOURS || '24'),
  review: parseFloat(process.env.STALE_REVIEW_HOURS || '12'),
  backlog: parseFloat(process.env.STALE_BACKLOG_HOURS || '48'),
  todo: parseFloat(process.env.STALE_TODO_HOURS || '48'),
  // Blocked card lifecycle from FIRST block: re-ping at STALE_BLOCKED_REPING_HOURS,
  // return to orchestrator at this TOTAL window (FIX 24 shipped default 6h, was 144h).
  blocked_repinged: BLOCKED_WINDOWS.returned,
};

/** U101: this job's global-default thresholds, keyed to match BoardSlaOverrides
 *  (src/lib/board-slas.ts) — the settings-surface API reads this to render the
 *  "(default)" row of the effective SLA table. */
export const STALE_TASK_SWEEP_GLOBAL_DEFAULTS = {
  staleInProgressHours: STALE_THRESHOLDS.in_progress,
  staleReviewHours: STALE_THRESHOLDS.review,
  staleBacklogHours: STALE_THRESHOLDS.backlog,
  staleTodoHours: STALE_THRESHOLDS.todo,
  staleBlockedRepingHours: STALE_BLOCKED_REPING_HOURS, // FIX 24: 2h shipped
  staleBlockedRepingedHours: STALE_THRESHOLDS.blocked_repinged, // FIX 24: 6h shipped
} as const;

interface StaleTaskRow {
  id: string;
  title: string;
  status: string;
  description: string | null;
  department: string | null;
  workspace_id: string | null;
  assigned_agent_id: string | null;
  blocked_reason: string | null;
  blocked_on_human: string | null;
  ask: string | null;
  last_progress_at: string | null;
  updated_at: string;
  qc_reroute_attempts: number | null;
  /** FIX-17: owner-kill timestamp (migration 123). Absent on pre-123 DBs. */
  killed_at?: string | null;
}

export interface StaleSweepResult {
  scanned: number;
  returned: number;
  repinged: number;
  /** in_progress tasks recovered to `review` (finished work found on disk /
   *  registered) instead of being bounced to backlog (SWEEP-RECOVER). */
  recovered?: number;
  recoveredIds?: string[];
  skippedReason?: string;
}

function hoursAgo(hours: number): string {
  const d = new Date(Date.now() - hours * 60 * 60 * 1000);
  return d.toISOString();
}

function progressTimestamp(row: StaleTaskRow): string {
  return row.last_progress_at ?? row.updated_at;
}

/**
 * B6: is this review task DELIBERATELY parked by QC (a heuristic no-key /
 * provider-down score), rather than idle-stale? Such a task carries a
 * `[QC-HEURISTIC…]` or `[QC-DEFERRED-PROVIDER-DOWN]` qc_review event and is held
 * in review ON PURPOSE (awaiting a human promote or provider recovery). Bouncing
 * it back to the orchestrator just churns the review lane (the 1,958 task_returned
 * / 5,616 stale_repinged furnace), so the stale sweep must leave it alone.
 * NOTE: SQLite LIKE treats '[' literally (no bracket char-classes), so the
 * '%[QC-HEURISTIC%' pattern matches both [QC-HEURISTIC] and [QC-HEURISTIC-FINAL].
 * [QC-JUDGE-FAILED-FINAL] — the terminal "the judge failed every call up to the
 * bound, a human must look" escalation — is matched explicitly. It is parked ON
 * PURPOSE and is precisely the task a human has been asked to look at, so
 * bouncing it to the orchestrator would destroy the alarm just raised.
 */
function isParkedInReview(taskId: string): boolean {
  try {
    const row = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND type = 'qc_review'
          AND (message LIKE '%[QC-HEURISTIC%'
               OR message LIKE '%[QC-DEFERRED-PROVIDER-DOWN]%'
               OR message LIKE '%[QC-JUDGE-FAILED-FINAL]%')`,
      [taskId],
    );
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * F09: does this presentations task show a REAL event (any type) within the
 * last N hours? A live render emits phase/render/progress events as it runs,
 * so recent activity proves the runner is alive. A crashed run emits nothing
 * and must NOT be exempted — it ages out on the normal threshold. Fail-closed
 * to "no activity" if the events table is unreadable, so a dead run is never
 * shielded from the sweep by a broken check.
 */
const PRESENTATIONS_ACTIVITY_WINDOW_HOURS = parseFloat(
  process.env.PRESENTATIONS_ACTIVITY_WINDOW_HOURS || '24',
);

function hasRecentTaskActivity(taskId: string, hours: number): boolean {
  try {
    const row = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ?
          AND ${sqlTime('created_at')} >= ${sqlTime('?')}`,
      [taskId, hoursAgo(hours)],
    );
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * SWEEP-DEDUP: how long a single blocked task stays "already escalated" (hours).
 * The sweep runs every 10 minutes (STALE_TASK_SWEEP_CRON) but the blocked re-ping
 * window is 72h wide, so WITHOUT a dedup key every operator-blocked task past the
 * threshold re-escalated on EVERY tick — 6 escalations/hour/task for 72h straight.
 * One live board turned 71 blocked tasks into ~426 escalations/hour and buried the
 * escalation channel in hundreds of identical messages (and ~99k stale_repinged
 * event rows). This is the cap: one re-ping per task per window, not per tick.
 */
const STALE_REPING_DEDUP_HOURS = parseFloat(process.env.STALE_REPING_DEDUP_HOURS || '24');

/**
 * SWEEP-DEDUP: has this task ALREADY been re-pinged inside the dedup window?
 *
 * Matches BOTH event types on purpose:
 *   - 'stale_blocked_repinged' — the key this sweep writes from now on.
 *   - 'stale_repinged'         — the legacy type it used to write.
 * The superset match is what makes deploying this SAFE: on a box that already has
 * a backlog of legacy 'stale_repinged' rows, those rows immediately satisfy the
 * dedup, so the first post-deploy tick does NOT emit one final escalation burst.
 *
 * ⚠️ FAILS OPEN. A thrown query must NEVER swallow an escalation — a genuinely
 * stuck task reaching a human is the whole point of this sweep. On error we return
 * false ("not recently re-pinged") and let the escalation through. The failure mode
 * of this guard is a duplicate message, never silence.
 */
function wasRecentlyRepinged(
  taskId: string,
  withinHours: number = STALE_REPING_DEDUP_HOURS,
): boolean {
  try {
    const row = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ?
          AND type IN ('stale_repinged', 'stale_blocked_repinged')
          AND ${sqlTime('created_at')} >= ${sqlTime('?')}`,
      [taskId, hoursAgo(withinHours)],
    );
    return (row?.n ?? 0) > 0;
  } catch (err) {
    // FAIL-OPEN — see contract above. Escalate anyway; never go quiet.
    console.warn(
      `[stale-task-sweep] re-ping dedup check failed for ${taskId} (failing OPEN, will escalate):`,
      (err as Error).message,
    );
    return false;
  }
}

/**
 * Attempt to notify the blocked_on_human via the available channels.
 * Best-effort: failure here must never crash the sweep.
 */
async function repingBlockedHuman(task: StaleTaskRow): Promise<void> {
  const who = task.blocked_on_human ?? 'owner';
  // U101: report THIS task's own effective (department-overridden or global)
  // re-ping threshold, not always the global constant. FIX 24: the re-ping is
  // its OWN named window (STALE_BLOCKED_REPING_HOURS), not half of the return
  // window anymore.
  const repingHours = resolveSlaThreshold(task.department, 'staleBlockedRepingHours', STALE_BLOCKED_REPING_HOURS);
  const message =
    `[STALE-BLOCKED] Task "${task.title}" (id: ${task.id}) has been waiting in Blocked for over ` +
    `${repingHours}h without a response. ` +
    `Reminder: ${task.ask ?? '(no ask specified)'}`;

  if (who === 'operator') {
    // SWEEP-06 / MSG-06: an operator re-ping is a SYSTEM concern — route it
    // through the single notifySystem() path (Rescue Rangers webhook, or a
    // server log when unset). It must NEVER reach a client Telegram.
    notifySystem(message, { agent: 'stale-task-sweep', action: 'escalate' });
  } else {
    // Owner: notify via the Command Center's internal message route (which
    // triggers Telegram if wired). Best-effort -- no throw on failure.
    const ccUrl = getMissionControlUrl();
    try {
      // AUTH (SWEEP-401): this is a SERVER-SIDE loopback to our own /api/events —
      // it carries NO same-origin Origin/Referer, so middleware Gate B treats it
      // as EXTERNAL and (with MC_API_TOKEN set) hard-401s a POST without a bearer.
      // Before this fix every owner re-ping 401'd and was swallowed by the catch
      // below (one box logged ~1,301 rejections at ~600/hr), silently dropping
      // stale-blocked owner notifications fleet-wide. Present the canonical bearer.
      const resp = await fetch(`${ccUrl}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...missionControlAuthHeaders() },
        body: JSON.stringify({
          type: 'stale_blocked_repinged',
          payload: { task_id: task.id, message },
        }),
      });
      if (!resp.ok) {
        // Do not swallow silently — a rejected re-ping means the owner was NOT
        // notified; surface it loudly (this is exactly the failure that stayed
        // invisible for a month behind a bare console.warn on the catch alone).
        console.error(
          `[stale-task-sweep] Owner re-ping POST /api/events returned ${resp.status} — owner was NOT notified` +
            (resp.status === 401 || resp.status === 403
              ? ' (AUTH: verify MC_API_TOKEN is set in this process and matches the Command Center)'
              : ''),
        );
      }
    } catch (err) {
      console.warn('[stale-task-sweep] Owner re-ping notification failed:', (err as Error).message);
    }
  }
}

/**
 * Return a stale non-Blocked task to the orchestrator.
 * Mirrors the POST /api/tasks/[id]/return-to-orchestrator logic inline
 * so the sweep does not depend on an HTTP round-trip to itself.
 */
async function returnToOrchestrator(task: StaleTaskRow, reason: string): Promise<void> {
  const now = new Date().toISOString();

  // FIX 41: the counter is now read-only here. Pre-fix, EVERY stale return
  // incremented qc_reroute_attempts — including the from-blocked handback —
  // which combined with the blocked-branch return above to form the
  // stale-return ↔ cap ping-pong: block → 6h stale → return (+1) →
  // re-dispatch → cap-guard bounce → blocked → 6h stale → return (+1) … so a
  // single looping card marched its numerator far past QC_MAX_REROUTES and the
  // "cap reached" escalations kept re-firing on a number that no longer meant
  // "QC failed N times". The stale sweep is a WATCHDOG, not a QC attempt: it
  // no longer writes the counter at all (this function is the only writer in
  // this file; the blocked branch above now skips capped cards outright).
  // A from-blocked stale return therefore never increments — the counter stays
  // exactly what the QC cap path (or the owner) left it.
  const currentAttempts = task.qc_reroute_attempts ?? 0;
  const handbackNote = [
    `[STALE-RETURN] ${now}${currentAttempts > 0 ? ` (qc_reroute_attempts=${currentAttempts})` : ''}`,
    `Problem: ${reason}`,
    `Tried: stale sweep detected no progress`,
    `Needs: orchestrator re-route or human triage`,
  ].join('\n');

  const updatedDescription = task.description
    ? `${handbackNote}\n\n---\n\n${task.description}`
    : handbackNote;

  // SWEEP-03 (drag-back trap): a task returning to backlog FROM blocked would
  // otherwise keep dispatch_attempts >= cap and a stale backoff window, so every
  // advancer (intake-advance / backlog-redispatch) would filter it out and it
  // would rot in backlog forever. Reset the dispatch accounting ONLY on the
  // from-blocked transition — a non-blocked stale return (in_progress/review →
  // backlog) is left untouched so a genuinely looping task still stays capped.
  const fromBlocked = task.status === 'blocked';

  try {
    // MR-04: route through transition() with extraColumns so the compound
    // UPDATE goes through the legal-transition guard + preconditions + CAS
    // atomically, instead of a raw SQL write with no guard.
    // FIX 41: qc_reroute_attempts is deliberately ABSENT from extraColumns —
    // transition() writes only the columns listed, so the counter passes
    // through untouched on every stale return, from-blocked or not.
    const extraCols: Record<string, string | number | null> = {
      description: updatedDescription,
      last_progress_at: now,
    };
    if (fromBlocked) {
      extraCols.dispatch_attempts = 0;
      extraCols.next_dispatch_eligible_at = null;
    }
    await transition(task.id, 'backlog', {
      actor: 'stale-task-sweep',
      reason,
      extraColumns: extraCols,
    });

    run(
      `INSERT INTO events (id, type, task_id, message, created_at)
       VALUES (?, 'task_returned', ?, ?, ?)`,
      [uuidv4(), task.id, `[STALE-RETURN] ${reason}`, now],
    );

    broadcast({ type: 'task_updated', payload: { id: task.id, status: 'backlog' } });
  } catch (err) {
    console.warn(`[stale-task-sweep] returnToOrchestrator failed for ${task.id}:`, (err as Error).message);
  }
}

export async function runStaleTaskSweep(): Promise<StaleSweepResult> {
  // F6 — the kill-flag is resolved from process.env OR a DURABLE operator-overrides
  // file that lives OUTSIDE the checkout, so a deploy / re-clone / `git clean -fdx`
  // cannot silently undo an operator's emergency stop. Fails OPEN: any read error
  // resolves to NOT disabled, so the sweep runs and escalation still happens.
  const killFlag = resolveStaleTaskSweepKillFlag();
  if (killFlag.disabled) {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: killFlagSkipReason(killFlag) };
  }

  // Guard: last_progress_at column must exist (migration 071).
  let hasLastProgressAt = false;
  try {
    const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
    hasLastProgressAt = cols.some((c) => c.name === 'last_progress_at');
  } catch {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: 'Cannot read tasks schema' };
  }

  if (!hasLastProgressAt) {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: 'Migration 071 not applied yet (no last_progress_at column)' };
  }

  // FIX-17: `killed_at` (migration 123) may be absent on a box mid-roll. The
  // owner-kill guard reads it defensively (see owner-killed.ts), but the SELECT
  // below must not reference a column that does not exist yet — a pre-123 box
  // would throw "no such column" and this sweep would return a hard `Query
  // failed` instead of running. Probe the column exactly like last_progress_at
  // and only include it when present. A pre-123 box keeps working with the
  // TEXT-MARKER kill path only (the structured column arrives with the migration).
  let hasKilledAt = false;
  try {
    const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
    hasKilledAt = cols.some((c) => c.name === 'killed_at');
  } catch {
    hasKilledAt = false;
  }

  const progressCol = 'COALESCE(last_progress_at, updated_at)';
  const killedAtCol = hasKilledAt ? ', killed_at' : '';

  // U101: query at the TIGHTEST possible per-column threshold across the
  // global default AND every configured department override, so a
  // department-tightened SLA (config/board-slas.json, src/lib/board-slas.ts)
  // is never missed by this superset fetch — per-row filtering below then
  // applies each task's OWN effective (env > department > default) threshold.
  const tightestThreshold = Math.min(
    minPossibleSlaThreshold('staleInProgressHours', STALE_THRESHOLDS.in_progress),
    minPossibleSlaThreshold('staleReviewHours', STALE_THRESHOLDS.review),
    minPossibleSlaThreshold('staleBacklogHours', STALE_THRESHOLDS.backlog),
    minPossibleSlaThreshold('staleTodoHours', STALE_THRESHOLDS.todo),
    // FIX 24: the blocked re-ping window is its OWN named constant now (2h
    // default, NOT half of the 6h return window) — widest-possible fetch must
    // use the min of the two independent windows.
    minPossibleSlaThreshold('staleBlockedRepingHours', STALE_BLOCKED_REPING_HOURS),
    minPossibleSlaThreshold('staleBlockedRepingedHours', STALE_THRESHOLDS.blocked_repinged),
  );

  let candidates: StaleTaskRow[];
  try {
    candidates = queryAll<StaleTaskRow>(
      `SELECT id, title, status, description, department, workspace_id,
              assigned_agent_id, blocked_reason, blocked_on_human, ask,
              last_progress_at, updated_at, qc_reroute_attempts${killedAtCol}
       FROM tasks
       WHERE archived_at IS NULL
         AND status NOT IN ('done')
         AND ${sqlTime(progressCol)} < ${sqlTime('?')}
       ORDER BY ${sqlTime(progressCol)} ASC
       LIMIT 100`,
      [hoursAgo(tightestThreshold)],
    );
  } catch (err) {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: `Query failed: ${(err as Error).message}` };
  }

  let returned = 0;
  let repinged = 0;
  let recovered = 0;
  const recoveredIds: string[] = [];

  for (const task of candidates) {
    try {
      // FIX-17 / Error 12 / Rule R12: a task the owner KILLED (killed_at column
      // OR the "OWNER KILLED" note marker) is NEVER returned to the orchestrator
      // for re-routing. The incident: a killed deck task was bounced back to the
      // orchestrator by this very sweep, re-dispatched as "LIVE", and produced
      // 4 identical handback stalls. An OWNER-KILLED task stays dead — its
      // correct end state is the owner's explicit un-kill, not the stale sweep.
      // One deduped `dispatch_blocked_owner_killed` event row records the block.
      if (blockDispatchIfOwnerKilled(task, 'stale-task-sweep')) {
        console.warn(
          `[stale-task-sweep] task ${task.id} is OWNER-KILLED (Rule R12) — excluded from stale return; task stays dead`,
        );
        continue;
      }

      const progressTs = progressTimestamp(task);
      // B2: parseDbTime corrects the space-dialect misparse — new Date('YYYY-MM-DD
      // HH:MM:SS') reads as LOCAL time and shifts the age by the box's UTC offset.
      const progressDate = parseDbTime(progressTs);
      if (Number.isNaN(progressDate)) continue;
      const ageHours = (Date.now() - progressDate) / (1000 * 60 * 60);

      if (task.status === 'blocked') {
        // Blocked tasks: re-ping at the FIRST window (FIX 24: STALE_BLOCKED_REPING_HOURS,
        // default 2h — its own named constant, no longer half the return window),
        // return to orchestrator at the SECOND (STALE_BLOCKED_REPINGED_HOURS, default 6h
        // total from first block). U101: per-department override (falls back to the
        // global default) for each window independently.
        const returnThreshold = resolveSlaThreshold(
          task.department,
          'staleBlockedRepingedHours',
          STALE_THRESHOLDS.blocked_repinged,
        ); // FIX 24 default 6h total (was 144h)
        let repingThreshold = resolveSlaThreshold(
          task.department,
          'staleBlockedRepingHours',
          STALE_BLOCKED_REPING_HOURS,
        ); // FIX 24 default 2h (was 72h)
        // Per-row inversion guard: resolveSlaThreshold reads env/board-slas.json
        // independently per key, and the module-level BLOCKED_WINDOWS validation
        // only covers the shipped defaults — a dept override (or env) could still
        // set re-ping AFTER return. Escalation must never fire before the first
        // re-ping, so clamp the re-ping to the return window for THIS row.
        if (repingThreshold > returnThreshold) {
          repingThreshold = returnThreshold;
        }

        // FIX 41 (break the stale-return ↔ cap ping-pong): a blocked card that
        // already hit the QC-reroute cap is END-STATED — the QC cap path blocked
        // it on purpose and a human owes the next move. Returning it here would
        // (a) bump qc_reroute_attempts yet again and (b) put it straight back on
        // the auto-dispatch conveyor, where the cap guard bounces it, where the
        // stale sweep returns it … an unbounded counter with numerator marching
        // past the cap forever. So: skip entirely. The card stays blocked, the
        // counter stays where the cap path left it, and no stale sweep fires a
        // re-ping or a return against it. The cap is read from the same
        // QC_MAX_REROUTES constant every other consumer uses (env-overridable).
        const qcCap = parseInt(process.env.QC_MAX_REROUTES || String(QC_MAX_REROUTES), 10);
        if ((task.qc_reroute_attempts ?? 0) >= qcCap) {
          continue;
        }

        if (ageHours >= returnThreshold) {
          // Second threshold passed: return to orchestrator.
          returnToOrchestrator(task, `Blocked task stale for ${Math.round(ageHours)}h with no human response to: "${task.ask ?? '(no ask)'}"`).catch(err =>
            console.warn(`[stale-task-sweep] returnToOrchestrator failed for ${task.id}:`, (err as Error).message),
          );
          returned++;
        } else if (ageHours >= repingThreshold) {
          // SWEEP-DEDUP: re-ping AT MOST ONCE PER WINDOW, not once per 10-min tick.
          // Without this gate the whole 72h→144h blocked window re-escalates every
          // single tick (see STALE_REPING_DEDUP_HOURS). We are DEDUPING, not muting:
          // a still-stuck task escalates again on the next window, and the guard
          // fails OPEN, so no escalation is ever lost to a query error.
          if (wasRecentlyRepinged(task.id)) {
            continue;
          }

          // First threshold: re-ping the named human.
          await repingBlockedHuman(task);
          // Audit trail AND the dedup key the check above reads. Written on BOTH
          // branches (operator → notifySystem, owner → /api/events) because this
          // INSERT is common to both — that is what makes the dedup cover the
          // operator path, which previously wrote NO dedupable key at all.
          const now = new Date().toISOString();
          try {
            run(
              `INSERT INTO events (id, type, task_id, message, created_at)
               VALUES (?, 'stale_blocked_repinged', ?, ?, ?)`,
              [uuidv4(), task.id, `Re-pinged ${task.blocked_on_human ?? 'owner'} on blocked task (stale ${Math.round(ageHours)}h)`, now],
            );
          } catch (err) {
            // events table issue -- non-fatal for THIS tick, but it means no dedup
            // key was written, so the next tick will escalate again (fail-open).
            console.warn(
              `[stale-task-sweep] failed to write re-ping dedup key for ${task.id}:`,
              (err as Error).message,
            );
          }
          repinged++;
        }
        continue;
      }

      // Non-Blocked tasks: check per-column threshold.
      // U101: per-department override (falls back to the global default).
      const deptCanon = canonicalDeptSlug(task.department || '') || (task.department ?? '');

      // F09 — presentations long-render exemption. A signature-deck render runs
      // 40 pipeline phases and can legitimately occupy in_progress for many
      // hours; a single slide render can take longer than the global 24h
      // in_progress threshold on a loaded box. The sweep's returnToOrchestrator
      // demotes such a run to backlog MID-RENDER (the runner treats that as an
      // interrupted run). Exempt presentations in_progress tasks for up to
      // PRESENTATIONS_RENDER_EXEMPT_HOURS — but ONLY while events show recent
      // activity, so a genuinely dead run still ages out on the normal
      // threshold. Review status keeps its own shorter path via B6/parked guard.
      if (
        deptCanon === 'presentations' &&
        task.status === 'in_progress' &&
        ageHours < PRESENTATIONS_RENDER_EXEMPT_HOURS &&
        hasRecentTaskActivity(task.id, PRESENTATIONS_ACTIVITY_WINDOW_HOURS)
      ) {
        continue;
      }

      const thresholdHours =
        task.status === 'in_progress' ? resolveSlaThreshold(task.department, 'staleInProgressHours', STALE_THRESHOLDS.in_progress) :
        task.status === 'review' ? resolveSlaThreshold(task.department, 'staleReviewHours', STALE_THRESHOLDS.review) :
        resolveSlaThreshold(task.department, 'staleBacklogHours', STALE_THRESHOLDS.backlog);

      if (ageHours >= thresholdHours) {
        // B6: a review task deliberately parked by QC (heuristic no-key /
        // provider-down) is NOT idle-stale — leave it for the QC sweep or an
        // operator promote instead of churning it back to the orchestrator.
        if (task.status === 'review' && isParkedInReview(task.id)) {
          continue;
        }
        // SWEEP-RECOVER: never bounce FINISHED in_progress work back to backlog.
        // If the agent completed and only the write-back failed (the carded-but-
        // trapped MC_API_TOKEN 401), recover the card to `review` (redelivering
        // on-disk output) instead of demoting it. Only in_progress can carry
        // finished-but-unregistered work; review/backlog fall through unchanged.
        if (task.status === 'in_progress') {
          try {
            if (await recoverFinishedTaskToReview(task, 'stale-task-sweep')) {
              recovered++;
              recoveredIds.push(task.id);
              continue;
            }
          } catch (err) {
            console.error(`[stale-task-sweep] recovery check failed for ${task.id}:`, (err as Error).message);
          }
        }
        returnToOrchestrator(
          task,
          `Task stale in '${task.status}' for ${Math.round(ageHours)}h (threshold: ${thresholdHours}h) with no progress`,
        ).catch(err =>
          console.warn(`[stale-task-sweep] returnToOrchestrator failed for ${task.id}:`, (err as Error).message),
        );
        returned++;
      }
    } catch (err) {
      console.warn(`[stale-task-sweep] Processing task ${task.id} failed:`, (err as Error).message);
    }
  }

  return { scanned: candidates.length, returned, repinged, recovered, recoveredIds };
}
