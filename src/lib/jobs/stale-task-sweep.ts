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
import { notifySystem, ownerSendsSuppressed, ownerSendsHeld } from '@/lib/notify';
import { sendRequesterAudienceAsk, sendProviderChoiceAsk, isQuietHour } from './trust-engine';
import { recoverFinishedTaskToReview } from './finished-work-recovery';
import { runStaleReturnNoteCleanup } from './stale-return-note-cleanup';
import { resolveStaleTaskSweepKillFlag, killFlagSkipReason } from '@/lib/ops/operator-kill-flags';
import { resolveSlaThreshold, minPossibleSlaThreshold } from '@/lib/board-slas';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';
// FIX 41: the QC-reroute cap constant — the stale sweep must never push a card
// past it (see the capped-skip guard in the blocked branch and the no-increment
// rule on from-blocked returns in returnToOrchestrator below).
import { QC_MAX_REROUTES } from '@/lib/qc-scorer';
// PD-TEST-063: the dispatch cap, from the SAME exported constant the dispatcher
// blocks at — see the dispatch-budget end-state guard in the blocked branch.
import { MAX_DISPATCH_ATTEMPTS } from '@/lib/task-dispatcher';
import { transition, recordStatusEvent } from '@/lib/task-lifecycle';
import { blockDispatchIfOwnerKilled } from '@/lib/owner-killed';
import { v4 as uuidv4 } from 'uuid';

export const STALE_TASK_SWEEP_CRON = '*/10 * * * *';

/**
 * CC-054: the clock the quiet-hours check reads. A test that asserts "a 2pm
 * reminder goes out" would otherwise pass by day and fail by night, so this one
 * check takes an injectable clock. It is used for the quiet-hours check ONLY —
 * every age calculation in this file keeps `Date.now()`.
 */
let sweepClock: () => Date = () => new Date();

export function __setStaleSweepClockForTests(fn: (() => Date) | null): void {
  sweepClock = fn ?? (() => new Date());
}

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
  /**
   * PD-TEST-063: consumed dispatch budget (migration 077). Read so the blocked
   * branch can tell an ordinary stale card (remaining budget → return to
   * backlog) from an END-STATED one (exhausted budget → never launder it into a
   * fresh one). Absent on a pre-077 box; the SELECT substitutes NULL there.
   */
  dispatch_attempts: number | null;
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
  /** SWEEP-LOOP: backlog cards past the stale threshold that are already with
   *  the orchestrator. Counted, never "returned" (no transition, no event). */
  alreadyInBacklog?: number;
  /**
   * PD-TEST-063: blocked tasks whose DISPATCH budget was already exhausted, and
   * which were therefore kept OUT of backlog (never laundered into a fresh
   * budget) and escalated to their named human instead. This counts the
   * END-STATE DECISION for this tick, so it is incremented even when the
   * escalation itself is deduped — `repinged` is the count of escalations that
   * actually went out. Counting them separately keeps the two decisions
   * distinguishable in the cron log: "this card was re-pinged in the ordinary
   * 2h window" vs "this card is END-STATED and will never be auto-re-dispatched
   * again without explicit human budget".
   */
  budgetEndStated?: number;
  budgetEndStatedIds?: string[];
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
 * CC-054: what a reminder attempt actually achieved. Only 'delivered' may be
 * recorded as a re-ping; 'held' means nothing left the box (muted, on hold, or
 * quiet hours) so the next run tries again; 'no-address' means the owner has no
 * resolvable destination at all and the operator was told.
 */
type RepingOutcome = 'delivered' | 'held' | 'no-address';

async function repingBlockedHuman(task: StaleTaskRow): Promise<RepingOutcome> {
  const who = task.blocked_on_human ?? 'owner';
  if (who === 'operator') {
    // U101: report THIS task's own effective (department-overridden or global)
    // re-ping threshold, not always the global constant.
    const repingHours = resolveSlaThreshold(task.department, 'staleBlockedRepingHours', STALE_BLOCKED_REPING_HOURS);
    notifySystem(
      `[STALE-BLOCKED] Task "${task.title}" (id: ${task.id}) has been waiting in Blocked for over ` +
        `${repingHours}h without a response. Reminder: ${task.ask ?? '(no ask specified)'}`,
      { agent: 'stale-task-sweep', action: 'escalate' },
    );
    return 'delivered';
  }
  // Owner. Never at night, never while client sends are muted or on hold —
  // in both cases nothing is recorded, so the next run tries again.
  if (ownerSendsSuppressed() || ownerSendsHeld() || isQuietHour(sweepClock())) return 'held';
  const text =
    `Reminder: "${task.title}" is still waiting on you. ` +
    `${task.ask?.trim() || 'It needs a decision or some input from you before it can continue.'}`;
  const viaRequester = sendRequesterAudienceAsk(task.id, text);
  if (viaRequester === 'telegram' || viaRequester === 'session') return 'delivered';
  if (viaRequester === 'send_failed') return 'held';
  const viaOwner = sendProviderChoiceAsk(task.id, text);
  if (viaOwner === 'telegram') return 'delivered';
  if (viaOwner === 'send_failed') return 'held';
  notifySystem(
    `[stale-blocked-undeliverable] Task ${task.id} is waiting on its owner and no owner address could be resolved.`,
    { agent: 'stale-task-sweep', action: 'escalate' },
  );
  return 'no-address';
}

/**
 * SWEEP-DEDUP: escalate a still-blocked task to its named human, AT MOST ONCE per
 * window, and write the event row that is also the dedup key the next tick reads.
 *
 * Extracted (PD-TEST-063) so the end-stated branch below escalates through the
 * exact same path — same dedup, same audit row, same failure modes — instead of
 * duplicating it. Returns true when this call actually escalated.
 *
 * We are DEDUPING, not muting: a still-stuck task escalates again on the next
 * window, and the dedup guard fails OPEN, so no escalation is ever lost to a
 * query error.
 */
async function repingBlockedOnce(task: StaleTaskRow, ageHours: number): Promise<boolean> {
  if (wasRecentlyRepinged(task.id)) return false;

  // First threshold: re-ping the named human.
  const outcome = await repingBlockedHuman(task);
  // CC-054: a HELD reminder (muted, on hold, or quiet hours) sent nothing, so
  // it must record nothing either — the next run tries again.
  if (outcome === 'held') return false;
  // Audit trail AND the dedup key the check above reads. Written on BOTH
  // branches (operator → notifySystem, owner → the trust engine's gateway send)
  // because this INSERT is common to both — that is what makes the dedup cover
  // the operator path, which previously wrote NO dedupable key at all.
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
  return true;
}

/**
 * CC-054: when the newest reminder for this stay in Blocked was recorded (ms),
 * or null. A null means no reminder can be PROVEN to have gone out — the card
 * stays Blocked and the sweep tries again, rather than returning a card whose
 * owner was never told.
 */
function lastRepingMs(taskId: string, sinceMs: number): number | null {
  try {
    const row = queryOne<{ created_at: string }>(
      `SELECT created_at FROM events
        WHERE task_id = ? AND type IN ('stale_repinged', 'stale_blocked_repinged')
        ORDER BY ${sqlTime('created_at')} DESC LIMIT 1`,
      [taskId],
    );
    const ms = parseDbTime(row?.created_at);
    return Number.isNaN(ms) || ms <= sinceMs ? null : ms;
  } catch {
    return null; // cannot prove a reminder went out — the card stays Blocked
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
  // PD-TEST-063: the consumed DISPATCH budget is part of the handback record.
  // The counter itself survives on the row (above); this puts the number in
  // front of the orchestrator/human reading the card, so a re-opened card shows
  // how much budget it already burned instead of looking brand new.
  const currentDispatchAttempts = task.dispatch_attempts ?? 0;
  const accounting = [
    currentAttempts > 0 ? `qc_reroute_attempts=${currentAttempts}` : null,
    currentDispatchAttempts > 0
      ? `dispatch_attempts=${currentDispatchAttempts}/${MAX_DISPATCH_ATTEMPTS} PRESERVED`
      : null,
  ]
    .filter(Boolean)
    .join(', ');

  // CC-052: the description is NO LONGER WRITTEN. The handback note that used to
  // be prepended here ([STALE-RETURN] …) put internal bookkeeping into the
  // client's own description — the very text they read on the card. The
  // `task_returned` event below already records the reason and the counters, so
  // nothing is lost by leaving the description exactly as its author wrote it.

  // SWEEP-03 (drag-back trap) — CORRECTED BY PD-TEST-063.
  //
  // The TRAP is real and still guarded against: a blocked card returned to
  // backlog that still carries `dispatch_attempts >= MAX_DISPATCH_ATTEMPTS`
  // would be filtered out by every advancer (intake-advance / backlog-redispatch
  // both gate on `dispatch_attempts < cap`), so it would rot in backlog with no
  // way back — `resume` only accepts blocked cards. SWEEP-03 "fixed" that by
  // zeroing the counter, which is what PD-TEST-063 is about: it also DESTROYED
  // the record of the consumed budget and handed the card a brand-new one.
  //
  // The trap is now fixed at the SOURCE instead: runStaleTaskSweep's blocked
  // branch never routes an exhausted card here at all (see the dispatch-budget
  // end-state guard), so an exhausted budget can never reach this function. What
  // is left here is the one thing SWEEP-03 got right — clearing the stale
  // BACKOFF WINDOW so a legitimately re-routed card is not held behind an
  // expired timer. That is a TIME gate, not a BUDGET: it does not change the
  // count, the count still increments on the next failure, and the card still
  // blocks at the cap.
  //
  // The counter itself is deliberately NOT written here — same rule FIX 41
  // applied to qc_reroute_attempts: the stale sweep is a WATCHDOG, not a
  // dispatch attempt, so it must never mint retry budget. The decision recorded
  // in the U061 ticket is PRESERVE (src/app/api/tasks/[id]/resume/route.ts:15-17:
  // "A Resume that resets dispatch_attempts to 0 would turn a capped retry loop
  // into an unbounded one"), and recordDispatchSuccess({preserveAttempts}) states
  // the same contract for the pre-engine recovery path — "so a later ordinary
  // backlog sweep cannot turn this exception into a fresh budget"
  // (src/lib/task-dispatcher.ts:304-308). A watchdog has strictly less
  // authority than the human Resume path, so it cannot reset what Resume preserves.
  const fromBlocked = task.status === 'blocked';

  try {
    // MR-04: route through transition() with extraColumns so the compound
    // UPDATE goes through the legal-transition guard + preconditions + CAS
    // atomically, instead of a raw SQL write with no guard.
    // FIX 41 + PD-TEST-063: NEITHER qc_reroute_attempts NOR dispatch_attempts
    // appears in extraColumns — transition() writes only the columns listed, so
    // both counters pass through untouched on every stale return.
    // CC-052: the description is not listed either — the card's own text is the
    // client's, and this sweep no longer edits it.
    const extraCols: Record<string, string | number | null> = {
      last_progress_at: now,
    };
    if (fromBlocked) {
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
      [uuidv4(), task.id, `[STALE-RETURN] ${reason}${accounting ? ` (${accounting})` : ''}`, now],
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

  // U-25: remove the [STALE-RETURN] notes this job used to write into task
  // descriptions. Bounded (200 cards per run); a no-op once none are left.
  try { runStaleReturnNoteCleanup(); } catch (err) {
    console.warn('[stale-task-sweep] note clean-up failed (non-fatal):', (err as Error).message);
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
  // PD-TEST-063: dispatch_attempts arrives with migration 077 — AFTER the 071
  // last_progress_at column this sweep already requires — but a box mid-roll can
  // still be missing it, and an unguarded reference would throw "no such column"
  // and kill the whole sweep. Probe it exactly like the other two: absent ⇒
  // every row reads 0 attempts, which disables the end-state guard below and
  // leaves behaviour identical to the pre-077 board (no accounting exists there,
  // so there is no budget to preserve).
  let hasDispatchAttempts = false;
  try {
    const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
    hasKilledAt = cols.some((c) => c.name === 'killed_at');
    hasDispatchAttempts = cols.some((c) => c.name === 'dispatch_attempts');
  } catch {
    hasKilledAt = false;
    hasDispatchAttempts = false;
  }

  const progressCol = 'COALESCE(last_progress_at, updated_at)';
  const killedAtCol = hasKilledAt ? ', killed_at' : '';
  const dispatchAttemptsCol = hasDispatchAttempts ? 'dispatch_attempts' : 'NULL AS dispatch_attempts';

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

  // The QC-reroute cap, read from the same QC_MAX_REROUTES constant every other
  // consumer uses (env-overridable). CC-063 reads it in the candidate query as
  // well as in the per-row guard below.
  const qcCap = parseInt(process.env.QC_MAX_REROUTES || String(QC_MAX_REROUTES), 10);

  // CC-063: a card already in `backlog` is WITH the orchestrator — there is
  // nothing to return it to, and transition('backlog'→'backlog') is an idempotent
  // no-op, so pre-fix the sweep re-"returned" the same card on EVERY tick. Those
  // cards no longer enter the candidate list at all (they used to crowd out live
  // cards behind the LIMIT 100); they are counted separately before the loop.
  // A blocked card that already spent its whole QC-reroute budget is END-STATED
  // by the cap path and is excluded here for the same reason it is skipped below.
  let candidates: StaleTaskRow[];
  try {
    candidates = queryAll<StaleTaskRow>(
      `SELECT id, title, status, description, department, workspace_id,
              assigned_agent_id, blocked_reason, blocked_on_human, ask,
              last_progress_at, updated_at, qc_reroute_attempts,
              ${dispatchAttemptsCol}${killedAtCol}
       FROM tasks
       WHERE archived_at IS NULL
         AND status NOT IN ('done')
         AND ${sqlTime(progressCol)} < ${sqlTime('?')}
         AND status != 'backlog'
         AND NOT (status = 'blocked' AND COALESCE(qc_reroute_attempts, 0) >= ?)
       ORDER BY ${sqlTime(progressCol)} ASC
       LIMIT 100`,
      [hoursAgo(tightestThreshold), qcCap],
    );
  } catch (err) {
    return { scanned: 0, returned: 0, repinged: 0, skippedReason: `Query failed: ${(err as Error).message}` };
  }

  // SWEEP-LOOP / CC-063: the backlog cards the sweep used to walk one by one.
  // One count query, one log line, no per-card event.
  let alreadyInBacklog = 0;
  try {
    alreadyInBacklog =
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE archived_at IS NULL AND status = 'backlog'
            AND ${sqlTime(progressCol)} < ${sqlTime('?')}`,
        [hoursAgo(STALE_THRESHOLDS.backlog)],
      )?.n ?? 0;
  } catch {
    alreadyInBacklog = 0;
  }

  let returned = 0;
  let repinged = 0;
  let recovered = 0;
  const recoveredIds: string[] = [];
  // PD-TEST-063: blocked cards with an exhausted dispatch budget that were
  // re-escalated instead of being laundered back onto the dispatch conveyor.
  let budgetEndStated = 0;
  const budgetEndStatedIds: string[] = [];

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
        // QC_MAX_REROUTES constant every other consumer uses (env-overridable),
        // read once above the candidate query.
        if ((task.qc_reroute_attempts ?? 0) >= qcCap) {
          continue;
        }

        // PD-TEST-063 (the dispatch-budget end-state guard): a blocked card that
        // has ALREADY burned its whole dispatch budget is end-stated for the same
        // reason the QC-capped card above is — the cap path blocked it on purpose,
        // the dispatch ladder is exhausted, and a human owes the next move.
        //
        // THE DEFECT this closes: pre-fix, the 6h return below routed such a card
        // through returnToOrchestrator, which zeroed dispatch_attempts (SWEEP-03).
        // Live evidence, task 1d269693-ff54-4b1f-b45a-61dc7d8ca4d4: event
        // 6e1ffc5c blocked it at "8 failed" attempts (00:47Z), event d3d7f3ce
        // swept blocked→backlog at 06:50Z (actor stale-task-sweep, the 6h window),
        // and event 22b564a8 re-dispatched it at 06:52Z — two minutes later, on a
        // budget it had just been handed back. The 8 consumed attempts were gone
        // and the card was dispatchable again.
        //
        // So: do NOT return it to backlog (that is what launders the budget — the
        // RETURN is the only writer that can clear the accounting), and do NOT
        // drop it silently (that would leave a stuck card with no escalation at
        // all — the trap the other direction). Keep escalating to the named human
        // on the ordinary deduped window, so the card keeps reaching a person
        // until someone actually answers. The counter is never touched.
        //
        // The cap is read from the same MAX_DISPATCH_ATTEMPTS the dispatcher
        // blocks at and the advancers gate on — not a re-derived copy.
        const dispatchBudgetExhausted = (task.dispatch_attempts ?? 0) >= MAX_DISPATCH_ATTEMPTS;

        if (ageHours >= returnThreshold) {
          if (dispatchBudgetExhausted) {
            if (await repingBlockedOnce(task, ageHours)) repinged++;
            budgetEndStated++;
            budgetEndStatedIds.push(task.id);
            continue;
          }
          // CC-054 (owner decision D-8 default): a card waiting on the OWNER
          // leaves Blocked only after a reminder that was really sent, and only
          // after the owner has had the rest of the window to answer it. With no
          // provable reminder, or one sent too recently, the sweep reminds (if
          // the dedup allows) and leaves the card where it is.
          // Operator-blocked cards keep today's behaviour: returned at the window.
          if ((task.blocked_on_human ?? 'owner') !== 'operator') {
            const remindedAt = lastRepingMs(task.id, progressDate);
            const answerWindowMs = Math.max(0, returnThreshold - repingThreshold) * 3_600_000;
            if (remindedAt === null || Date.now() - remindedAt < answerWindowMs) {
              if (await repingBlockedOnce(task, ageHours)) repinged++;
              continue;
            }
          }
          // Second threshold passed: return to orchestrator. The consumed
          // dispatch budget rides along in the reason so the audit row itself
          // records what the card had already spent (PD-TEST-063 (c)).
          returnToOrchestrator(
            task,
            `Blocked task stale for ${Math.round(ageHours)}h with no human response to: "${task.ask ?? '(no ask)'}"` +
              ` (dispatch_attempts=${task.dispatch_attempts ?? 0}/${MAX_DISPATCH_ATTEMPTS} PRESERVED; ` +
              `qc_reroute_attempts=${task.qc_reroute_attempts ?? 0})`,
          ).catch(err =>
            console.warn(`[stale-task-sweep] returnToOrchestrator failed for ${task.id}:`, (err as Error).message),
          );
          returned++;
        } else if (ageHours >= repingThreshold) {
          if (await repingBlockedOnce(task, ageHours)) repinged++;
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
        // CC-063: backlog cards never reach this loop — the candidate query
        // excludes `status = 'backlog'` and the count above names them once.
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

  if (alreadyInBacklog > 0) {
    console.log(`[stale-task-sweep] ${alreadyInBacklog} backlog card(s) past the stale threshold are already with the orchestrator — nothing to return (no event written)`);
  }
  return { scanned: candidates.length, returned, repinged, recovered, recoveredIds, budgetEndStated, budgetEndStatedIds, alreadyInBacklog };
}
