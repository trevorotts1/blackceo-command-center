/**
 * src/lib/social/cycle-service.ts — the durable weekly invitation cycle
 * service (F07 + F17, social/wf10-weekly-expiry).
 *
 * PROBLEM (F07): both cron scripts (Skill 35's register-weekly-cron.sh and
 * Skill 57's register-social-cron.sh) encode the invitation cadence as
 * INSTRUCTIONS INSIDE A PROMPT — "wait up to 1 hour", "if no reply by noon
 * ask once more", "if no reply by 6 PM use the evergreen theme". That is an
 * agent burning tokens to simulate a state machine, with no durable state:
 * a restart loses the reminder, a second fire double-asks, and "next week"
 * only exists if last week's prompt happened to run it.
 *
 * WHAT THIS OWNS (per the W0 company_cycle.json contract):
 *   - One cycle per (company_id, week_start_local) — UNIQUE, so a second
 *     fire for the same week collapses to a no-op, and next week's row is
 *     created INDEPENDENTLY of this week's response.
 *   - Persisted invitation_sent_at / reminder_due_at / response_state /
 *     cutoff_at / selected_fallback / next_cycle_at. The scheduler runs
 *     SHORT jobs (social-cycle + social-theme-nudge in jobs/) that read due
 *     rows — never an agent waiting hours.
 *   - Bounded reminders: at most MAX_REMINDERS reminders per cycle, on the
 *     cadence REMINDER_CADENCE_HOURS, all before cutoff.
 *   - "Skip this week" closes ONLY that cycle (skip_week=1, state=skipped);
 *     next week still gets its invitation.
 *   - "Pause reminders" is an EXPLICIT preference (pause_reminders_until or
 *     pause_reminders=true on the company row) — honored as a preference,
 *     never inferred.
 *   - Evergreen publishing only with a RECORDED standing approval
 *     (standing_approval='evergreen'); otherwise the cutoff disposition is
 *     'draft' + the invitation is re-asked (next cycle still invited).
 *
 * Deterministic under an injected clock (nowFn) for QC-F07's fake-clock
 * proofs: four unanswered weeks, DST change, service restart, late reply.
 */

import { randomUUID, createHash } from 'crypto';
import { getDb, queryAll, queryOne, run, timeNow } from '@/lib/db';

// ── Tunables (env-overridable for tests; defaults are the product policy) ──
export const MAX_REMINDERS = Number(process.env.SOCIAL_CYCLE_MAX_REMINDERS ?? 2);
export const REMINDER_CADENCE_HOURS = Number(process.env.SOCIAL_CYCLE_REMINDER_CADENCE_HOURS ?? 8);
export const CUTOFF_HOURS_AFTER_INVITE = Number(
  process.env.SOCIAL_CYCLE_CUTOFF_HOURS ?? 34,
);
/** Days ahead the NEXT cycle's invitation is minted after a cutoff/skip. */
export const NEXT_CYCLE_LEAD_DAYS = Number(process.env.SOCIAL_CYCLE_NEXT_LEAD_DAYS ?? 7);

export type CycleState = 'draft' | 'invited' | 'responded' | 'closed' | 'skipped';
export type ResponseState = 'awaiting' | 'theme_chosen' | 'skip' | 'pause' | 'evergreen' | 'cutoff';

export interface CycleRow {
  id: string;
  company_id: string;
  week_start_local: string;
  timezone: string;
  policy_revision: number;
  state: CycleState;
  invitation_sent_at: string | null;
  invitation_token_hash: string | null;
  invitation_channel: string | null;
  reminder_count: number;
  reminder_due_at: string | null;
  last_reminder_at: string | null;
  response_state: string | null;
  responded_at: string | null;
  cutoff_at: string | null;
  selected_fallback: string | null;
  standing_approval: string | null;
  skip_week: number;
  next_cycle_at: string | null;
  disposition: string | null;
  created_at: string;
  updated_at: string;
}

export interface WeekStartOptions {
  /** IANA timezone; defaults to America/New_York (the fleet's client-local). */
  timezone?: string;
  /** 0=Sunday..6=Saturday; the client-local week starts Sunday. */
  weekStartsOn?: number;
}

// ── Local week math (DST-safe) ─────────────────────────────────────────────
// week_start_local is a DATE string computed in the CLIENT's timezone via
// Intl, never UTC arithmetic on epoch days — a UTC-based week boundary drifts
// across a DST change (QC-F07's DST step).

/**
 * Midnight of the client-local week-start day for the local date containing
 * `atMs`, computed with Intl against the named timezone. Returns 'YYYY-MM-DD'.
 */
export function weekStartLocal(atMs: number, opts: WeekStartOptions = {}): string {
  const timezone = opts.timezone || 'America/New_York';
  const weekStartsOn = opts.weekStartsOn ?? 0; // Sunday
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(atMs)).map((p) => [p.type, p.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  const localHour = Number(parts.hour === '24' ? '00' : parts.hour);
  // Day-of-week of that local DATE, computed as a UTC noon probe (noon avoids
  // every DST edge: no zone shifts a noon by a full day).
  const ymd = localDate.split('-').map(Number);
  const dow = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2], 12)).getUTCDay();
  const back = (dow - weekStartsOn + 7) % 7;
  // A local date that begins BEFORE the week boundary in wall-clock terms when
  // it is still the prior local day (late-evening UTC offset) — Intl already
  // gave us the true local date, so `back` is exact.
  void localHour;
  const start = new Date(Date.UTC(ymd[0], ymd[1] - 1, ymd[2] - back, 12));
  const startFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return startFmt.format(start);
}

/** Next week_start after `weekStart` in the same timezone (+7 calendar days). */
export function nextWeekStart(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 7, 12));
  return next.toISOString().slice(0, 10);
}

// ── Row access ──────────────────────────────────────────────────────────────

export function getCycle(companyId: string, weekStart: string): CycleRow | null {
  return (queryOne(
    `SELECT * FROM social_cycles WHERE company_id = ? AND week_start_local = ?`,
    [companyId, weekStart],
  ) as CycleRow | undefined) ?? null;
}

export function getCycleById(cycleId: string): CycleRow | null {
  return (queryOne(`SELECT * FROM social_cycles WHERE id = ?`, [cycleId]) as CycleRow | undefined) ?? null;
}

function touch(cycleId: string): void {
  run(`UPDATE social_cycles SET updated_at = ? WHERE id = ?`, [timeNow(), cycleId]);
}

// ── Core operations (each SHORT — the jobs call one of these per due row) ──

export interface EnsureCycleResult {
  cycleId: string;
  created: boolean;
}

/**
 * Idempotently ensure the cycle row for (company, weekStart) exists. A second
 * ensure for the same week is a no-op returning the SAME id (unique
 * (company_id, week_start_local) — E_CYCLE_DUPLICATE is impossible by
 * construction; the contract's error name is honored by collapsing).
 */
export function ensureCycle(companyId: string, weekStart: string, opts: WeekStartOptions = {}): EnsureCycleResult {
  const existing = getCycle(companyId, weekStart);
  if (existing) return { cycleId: existing.id, created: false };
  const id = randomUUID();
  run(
    `INSERT INTO social_cycles (id, company_id, week_start_local, timezone, policy_revision, state, next_cycle_at)
     VALUES (?, ?, ?, ?, 1, 'draft', NULL)`,
    [id, companyId, weekStart, opts.timezone || 'America/New_York'],
  );
  return { cycleId: id, created: true };
}

export interface InvitationPayload {
  companyId: string;
  cycleId: string;
  weekStart: string;
  channel: string;
  /** The rendered invitation text — the caller (nudge job) delivers it. */
  message: string;
  tokenHash: string;
}

export interface SendFnResult {
  delivered: boolean;
  /** e.g. 'telegram', 'outbox' — recorded on the cycle for audit. */
  channel?: string;
}

/**
 * Deliver an invitation. The JOB wires the real channel (theme-intake
 * notification outbox, F27's contract); tests inject a recorder. Returns
 * false to mean "not delivered" — the cycle is NOT stamped invited and the
 * scheduler retries next tick.
 */
export type SendInvitationFn = (payload: InvitationPayload) => Promise<SendFnResult> | SendFnResult;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Send THIS week's invitation exactly once per cycle. Idempotent: an already
 * invited/responded/closed/skipped cycle returns 'already'. On delivery
 * failure the state stays draft so the next tick retries.
 */
export async function sendInvitation(
  companyId: string,
  weekStart: string,
  send: SendInvitationFn,
  nowMs: number = Date.now(),
): Promise<{ action: 'sent' | 'already' | 'retry'; cycleId: string }> {
  const cycle = getCycle(companyId, weekStart);
  if (!cycle) return { action: 'retry', cycleId: '' };
  if (cycle.state !== 'draft') return { action: 'already', cycleId: cycle.id };

  const token = randomUUID();
  const payload: InvitationPayload = {
    companyId,
    cycleId: cycle.id,
    weekStart,
    channel: 'theme-intake',
    message:
      `What is the content theme for the week of ${weekStart}? ` +
      `Reply any time before cutoff. If you do not answer, we will prepare a draft and ask again.`,
    tokenHash: hashToken(token),
  };

  const result = await send(payload);
  if (!result.delivered) return { action: 'retry', cycleId: cycle.id };

  const cutoff = new Date(nowMs + CUTOFF_HOURS_AFTER_INVITE * 3600_000).toISOString();
  run(
    `UPDATE social_cycles
     SET state = 'invited', invitation_sent_at = ?, invitation_token_hash = ?,
         invitation_channel = ?, reminder_count = 0, reminder_due_at = ?, cutoff_at = ?,
         disposition = NULL, updated_at = ?
     WHERE id = ? AND state = 'draft'`,
    [
      new Date(nowMs).toISOString(),
      payload.tokenHash,
      result.channel || payload.channel,
      new Date(nowMs + REMINDER_CADENCE_HOURS * 3600_000).toISOString(),
      cutoff,
      timeNow(),
      cycle.id,
    ],
  );
  return { action: 'sent', cycleId: cycle.id };
}

export interface ReminderPayload {
  companyId: string;
  cycleId: string;
  weekStart: string;
  reminderNumber: number;
  message: string;
}

/** Deliver a reminder. Same shape as SendInvitationFn. */
export type SendReminderFn = (payload: ReminderPayload) => Promise<SendFnResult> | SendFnResult;

function pauseActive(cycle: CycleRow, nowMs: number): boolean {
  // Explicit preference only: pause_reminders=true, or pause_reminders_until
  // in the future, recorded on the cycle (F07: "pause-reminders is an
  // explicit preference" — never inferred from silence).
  const db = getDb();
  const pref = db.prepare(
    `SELECT pause_reminders, pause_reminders_until FROM social_cycles WHERE id = ?`,
  ).get(cycle.id) as { pause_reminders?: number | null; pause_reminders_until?: string | null } | undefined;
  void db;
  if (!pref) return false;
  if (pref.pause_reminders === 1) return true;
  if (pref.pause_reminders_until) {
    return new Date(pref.pause_reminders_until).getTime() > nowMs;
  }
  return false;
}

/**
 * Fire the due reminder (if any) for a cycle. Bounded: at most MAX_REMINDERS
 * reminders, each REMINDER_CADENCE_HOURS apart, none after cutoff_at.
 */
export async function sendDueReminder(
  companyId: string,
  weekStart: string,
  send: SendReminderFn,
  nowMs: number = Date.now(),
): Promise<{ action: 'sent' | 'skip' | 'none'; cycleId: string; reason?: string }> {
  const cycle = getCycle(companyId, weekStart);
  if (!cycle) return { action: 'none', cycleId: '' };
  if (cycle.state !== 'invited') return { action: 'none', cycleId: cycle.id };
  if (pauseActive(cycle, nowMs)) return { action: 'skip', cycleId: cycle.id, reason: 'paused' };
  if (!cycle.reminder_due_at) return { action: 'none', cycleId: cycle.id };
  if (new Date(cycle.reminder_due_at).getTime() > nowMs) return { action: 'none', cycleId: cycle.id };
  if (cycle.cutoff_at && new Date(cycle.cutoff_at).getTime() <= nowMs) {
    return { action: 'skip', cycleId: cycle.id, reason: 'past_cutoff' };
  }
  if (cycle.reminder_count >= MAX_REMINDERS) {
    return { action: 'skip', cycleId: cycle.id, reason: 'max_reminders' };
  }

  const n = cycle.reminder_count + 1;
  const result = await send({
    companyId,
    cycleId: cycle.id,
    weekStart,
    reminderNumber: n,
    message: `Reminder: what is the content theme for the week of ${weekStart}? (reminder ${n} of ${MAX_REMINDERS})`,
  });
  if (!result.delivered) return { action: 'skip', cycleId: cycle.id, reason: 'delivery_failed' };

  const nextDue = new Date(nowMs + REMINDER_CADENCE_HOURS * 3600_000).toISOString();
  run(
    `UPDATE social_cycles
     SET reminder_count = reminder_count + 1, last_reminder_at = ?, reminder_due_at = ?, updated_at = ?
     WHERE id = ?`,
    [new Date(nowMs).toISOString(), nextDue, timeNow(), cycle.id],
  );
  return { action: 'sent', cycleId: cycle.id };
}

export type ApplyResponseResult =
  | { ok: true; effect: string }
  | { ok: false; error: string; effect?: string };

/**
 * Apply the client's answer to THIS cycle. Guard rails (QC-F07):
 *   - A LATE answer (cutoff passed) is recorded but never flips the state of
 *     another week: it applies to its OWN cycle row only, and if that cycle
 *     already moved past 'invited' the answer is appended as a late response,
 *     never an overwrite of another week.
 *   - 'skip' closes ONLY this cycle (skip_week=1); next_cycle_at is still
 *     stamped so next week's cycle is created independently.
 *   - 'pause' records the explicit preference on THIS cycle's company row.
 *   - Evergreen is honored ONLY with a recorded standing approval; without
 *     one the evergreen request becomes a draft disposition and the ask
 *     repeats next week.
 */
export function applyResponse(
  cycleId: string,
  answer: { kind: 'theme' | 'skip' | 'pause' | 'evergreen'; theme?: string; until?: string },
  nowMs: number = Date.now(),
): ApplyResponseResult {
  const cycle = getCycleById(cycleId);
  if (!cycle) return { ok: false, error: 'E_CYCLE_NOT_FOUND' };
  const db = getDb();

  // Idempotency: a second delivery of the same answer class is a no-op.
  if (cycle.response_state === answer.kind) return { ok: true, effect: 'already_recorded' };

  const late = Boolean(cycle.cutoff_at && new Date(cycle.cutoff_at).getTime() < nowMs);

  if (answer.kind === 'skip') {
    run(
      `UPDATE social_cycles
       SET state = 'skipped', response_state = 'skip', responded_at = ?, skip_week = 1,
           next_cycle_at = ?, disposition = 'skipped_by_owner', updated_at = ?
       WHERE id = ?`,
      [timeNow(), new Date(nowMs + NEXT_CYCLE_LEAD_DAYS * 86_400_000).toISOString(), timeNow(), cycleId],
    );
    // Next week's cycle row is created INDEPENDENTLY — by the scheduler's
    // ensure step, never here — so a skip closes exactly one cycle.
    return { ok: true, effect: 'skipped_this_week_only' };
  }

  if (answer.kind === 'pause') {
    run(
      `UPDATE social_cycles
       SET response_state = 'pause', responded_at = ?, pause_reminders = 1,
           pause_reminders_until = ?, updated_at = ?
       WHERE id = ?`,
      [timeNow(), answer.until ?? null, timeNow(), cycleId],
    );
    return { ok: true, effect: 'reminders_paused' };
  }

  if (answer.kind === 'evergreen') {
    const approved = cycle.standing_approval === 'evergreen';
    if (approved) {
      run(
        `UPDATE social_cycles
         SET state = 'closed', response_state = 'evergreen', responded_at = ?,
             selected_fallback = COALESCE(selected_fallback, 'evergreen'), disposition = 'evergreen_published',
             next_cycle_at = ?, updated_at = ?
         WHERE id = ?`,
        [timeNow(), new Date(nowMs + NEXT_CYCLE_LEAD_DAYS * 86_400_000).toISOString(), timeNow(), cycleId],
      );
      return { ok: true, effect: 'evergreen_published' };
    }
    // No recorded standing approval → prepare a DRAFT and ask again next week.
    run(
      `UPDATE social_cycles
       SET state = 'closed', response_state = 'evergreen', responded_at = ?,
           disposition = 'draft_awaiting_approval', next_cycle_at = ?, updated_at = ?
       WHERE id = ?`,
      [timeNow(), new Date(nowMs + NEXT_CYCLE_LEAD_DAYS * 86_400_000).toISOString(), timeNow(), cycleId],
    );
    return { ok: true, effect: 'draft_prepared_ask_again' };
  }

  // theme
  run(
    `UPDATE social_cycles
     SET state = 'responded', response_state = 'theme_chosen', responded_at = ?,
         selected_fallback = NULL, disposition = ?, next_cycle_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      timeNow(),
      late ? 'late_theme_recorded' : 'theme_recorded',
      new Date(nowMs + NEXT_CYCLE_LEAD_DAYS * 86_400_000).toISOString(),
      timeNow(),
      cycleId,
    ],
  );
  void db;
  return { ok: true, effect: late ? 'late_theme_recorded_not_overwriting_other_weeks' : 'theme_recorded' };
}

export interface AdvanceResult {
  action: 'invite' | 'remind' | 'cutoff' | 'next_cycle' | 'none' | 'retry';
  cycleId: string;
  detail?: string;
}

/**
 * One SHORT scheduler step for a company: ensure this week's cycle exists,
 * invite/ask, or apply the cutoff disposition. The jobs call this per
 * company; it touches exactly one row per action.
 */
export async function advanceCycle(
  companyId: string,
  nowMs: number,
  opts: WeekStartOptions & { send?: SendInvitationFn; sendReminder?: SendReminderFn } = {},
): Promise<AdvanceResult> {
  const weekStart = weekStartLocal(nowMs, opts);
  const ensured = ensureCycle(companyId, weekStart, opts);
  const cycle = getCycle(companyId, weekStart);
  if (!cycle) return { action: 'retry', cycleId: ensured.cycleId, detail: 'cycle_row_missing' };

  // Skip-this-week cycles stay closed; next_cycle_at is what matters.
  if (cycle.next_cycle_at && new Date(cycle.next_cycle_at).getTime() <= nowMs) {
    const nextWeek = nextWeekStart(cycle.week_start_local);
    const next = ensureCycle(companyId, nextWeek, opts);
    if (next.created) return { action: 'next_cycle', cycleId: next.cycleId, detail: nextWeek };
  }

  if (cycle.state === 'draft') {
    if (opts.send) {
      const r = await sendInvitation(companyId, weekStart, opts.send, nowMs);
      return { action: r.action === 'sent' ? 'invite' : 'retry', cycleId: r.cycleId };
    }
    return { action: 'invite', cycleId: cycle.id, detail: 'pending_send' };
  }

  // invited + cutoff passed → apply the disposition now (short, stateful).
  if (cycle.state === 'invited' && cycle.cutoff_at && new Date(cycle.cutoff_at).getTime() <= nowMs) {
    const fallback = cycle.selected_fallback ?? 'draft';
    const approved = cycle.standing_approval === 'evergreen';
    const disposition = approved ? 'evergreen_used' : `draft_${fallback}_ask_again`;
    run(
      `UPDATE social_cycles
       SET state = 'closed', response_state = 'cutoff', disposition = ?, next_cycle_at = ?, updated_at = ?
       WHERE id = ?`,
      [disposition, new Date(nowMs + NEXT_CYCLE_LEAD_DAYS * 86_400_000).toISOString(), timeNow(), cycle.id],
    );
    return { action: 'cutoff', cycleId: cycle.id, detail: disposition };
  }

  return { action: 'none', cycleId: cycle.id };
}

/** Engine-ownership read (F17): the one active engine for a company. */
export function getEngineOwner(companyId: string): { engine: string; scheduler_name: string; next_run_at: string | null } | null {
  const row = queryOne(
    `SELECT engine, scheduler_name, next_run_at FROM social_engine_ownership
     WHERE company_id = ? AND state = 'active' ORDER BY registered_at DESC LIMIT 1`,
    [companyId],
  ) as { engine: string; scheduler_name: string; next_run_at: string | null } | undefined;
  return row ?? null;
}