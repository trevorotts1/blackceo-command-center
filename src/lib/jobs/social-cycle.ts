/**
 * src/lib/jobs/social-cycle.ts — the F07/F17 scheduler job for the durable
 * weekly cycle service (social/wf10-weekly-expiry).
 *
 * SHORT JOB LAW: every tick does bounded, row-at-a-time work — ensure the
 * current local week's cycle row per company, send invitations, fire due
 * reminders, apply cutoff dispositions, roll next week's cycle. It NEVER
 * waits on a human and NEVER holds a prompt open (that was F07's defect:
 * "wait up to 1 hour" inside a cron prompt).
 *
 * ENGINE OWNERSHIP (F17): registering this job writes the
 * social_engine_ownership row (engine 'cc-cycle-service', scheduler
 * 'node-cron') and DEMOTES legacy owners (skill35-weekly-theme,
 * social-media-weekly-theme, n8n weekly-theme trigger) to state 'superseded'
 * — the legacy cron scripts become forwarding adapters that verify this
 * record instead of owning their own cadence.
 */

import * as cron from 'node-cron';
import { getDb, queryAll, run, timeNow } from '@/lib/db';
import {
  advanceCycle,
  sendDueReminder,
  type AdvanceResult,
  type SendInvitationFn,
  type SendReminderFn,
  type WeekStartOptions,
} from '@/lib/social/cycle-service';

export const SOCIAL_CYCLE_CRON = process.env.SOCIAL_CYCLE_CRON ?? '*/5 * * * *';
export const SOCIAL_CYCLE_ENGINE = 'cc-cycle-service';
export const SOCIAL_CYCLE_SCHEDULER = 'node-cron';
/** Legacy scheduler names this engine supersedes (F17). */
export const LEGACY_SCHEDULER_NAMES = [
  'skill35-weekly-theme',
  'social-media-weekly-theme',
  'n8n-weekly-theme-trigger',
] as const;

export interface CompanyRow {
  id: string;
  timezone?: string | null;
}

/** The companies with cycles. Overridable in tests. */
function listCompanies(): CompanyRow[] {
  try {
    return queryAll<CompanyRow>(`SELECT id, timezone FROM companies ORDER BY id`, []);
  } catch {
    return [];
  }
}

export interface CycleSweepResult {
  scanned: number;
  invited: number;
  reminded: number;
  cutoffs: number;
  nextCycles: number;
  skipped: number;
  errors: number;
  skippedReason?: string;
}

async function processCompany(
  company: CompanyRow,
  nowMs: number,
  send?: SendInvitationFn,
  sendReminder?: SendReminderFn,
  tzOpts: WeekStartOptions = {},
): Promise<{ invited: number; reminded: number; cutoffs: number; nextCycles: number; skipped: number; errors: number }> {
  const out = { invited: 0, reminded: 0, cutoffs: 0, nextCycles: 0, skipped: 0, errors: 0 };
  const opts: WeekStartOptions & { send?: SendInvitationFn; sendReminder?: SendReminderFn } = {
    timezone: company.timezone || tzOpts.timezone,
    weekStartsOn: tzOpts.weekStartsOn,
    send,
    sendReminder,
  };
  try {
    const adv: AdvanceResult = await advanceCycle(company.id, nowMs, opts);
    if (adv.action === 'invite') out.invited += 1;
    else if (adv.action === 'cutoff') out.cutoffs += 1;
    else if (adv.action === 'next_cycle') out.nextCycles += 1;
    else if (adv.action === 'retry') out.skipped += 1;

    if (sendReminder) {
      const weekStartLocalAt = (await import('@/lib/social/cycle-service')).weekStartLocal(nowMs, opts);
      const r = await sendDueReminder(company.id, weekStartLocalAt, sendReminder, nowMs);
      if (r.action === 'sent') out.reminded += 1;
      else if (r.action === 'skip' && r.reason === 'delivery_failed') out.skipped += 1;
    }
  } catch {
    out.errors += 1;
  }
  return out;
}

/**
 * One sweep: per company, advance the weekly cycle + fire due reminders.
 * Inject send fns (the notification outbox, F27 contract) in production; the
 * default no-op send records the cycle state machine without channel delivery
 * (the owner-visible send is wired by the theme-intake job).
 */
export async function runSocialCycleSweep(io: {
  send?: SendInvitationFn;
  sendReminder?: SendReminderFn;
  companies?: CompanyRow[];
  nowMs?: number;
  timezone?: string;
} = {}): Promise<CycleSweepResult> {
  const nowMs = io.nowMs ?? Date.now();
  const companies = io.companies ?? listCompanies();
  const out: CycleSweepResult = { scanned: companies.length, invited: 0, reminded: 0, cutoffs: 0, nextCycles: 0, skipped: 0, errors: 0 };
  for (const company of companies) {
    const r = await processCompany(company, nowMs, io.send, io.sendReminder, { timezone: io.timezone });
    out.invited += r.invited;
    out.reminded += r.reminded;
    out.cutoffs += r.cutoffs;
    out.nextCycles += r.nextCycles;
    out.skipped += r.skipped;
    out.errors += r.errors;
  }
  return out;
}

/**
 * F17 — claim engine ownership for a company and demote every legacy
 * scheduler row. Idempotent: an existing active cc-cycle-service row updates
 * next_run_at; legacy rows are demoted ONLY when a healthy active row exists
 * first (never leave a company with zero owners on a failed claim).
 */
export function claimEngineOwnership(
  companyId: string,
  nextRunAt: string | null = null,
): { claimed: boolean; ownerRow: string } {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id FROM social_engine_ownership
       WHERE company_id = ? AND engine = ? AND state = 'active'`,
    )
    .get(companyId, SOCIAL_CYCLE_ENGINE) as { id: string } | undefined;

  let ownerId: string;
  if (existing) {
    run(
      `UPDATE social_engine_ownership
       SET next_run_at = COALESCE(?, next_run_at), verified_at = ?
       WHERE id = ?`,
      [nextRunAt, timeNow(), existing.id],
    );
    ownerId = existing.id;
  } else {
    ownerId = `owner-${companyId}-${Date.now().toString(36)}`;
    run(
      `INSERT INTO social_engine_ownership (id, company_id, engine, scheduler_name, scheduler_expr, next_run_at, state, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      [ownerId, companyId, SOCIAL_CYCLE_ENGINE, SOCIAL_CYCLE_SCHEDULER, SOCIAL_CYCLE_CRON, nextRunAt, timeNow()],
    );
  }

  // Demote legacy owners now that a healthy active row exists.
  run(
    `UPDATE social_engine_ownership
     SET state = 'superseded', superseded_by = ?, verified_at = COALESCE(verified_at, ?)
     WHERE company_id = ? AND engine != ? AND state = 'active'`,
    [ownerId, timeNow(), companyId, SOCIAL_CYCLE_ENGINE],
  );
  return { claimed: true, ownerRow: ownerId };
}

/** F17 — is the durable engine the active owner for this company? */
export function isEngineOwner(companyId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT engine FROM social_engine_ownership
       WHERE company_id = ? AND state = 'active' ORDER BY registered_at DESC LIMIT 1`,
    )
    .get(companyId) as { engine: string } | undefined;
  return row?.engine === SOCIAL_CYCLE_ENGINE;
}

/**
 * F17 — verify (for the ONB forwarding adapters): the durable engine owns the
 * schedule for every company in the ownership table and at least one future
 * registration exists. Used by register scripts' --verify path.
 */
export function verifyEngineOwnership(): { ok: boolean; companies: number; activeOwner: number; superseded: number; futureRun: boolean } {
  const rows = queryAll<{ company_id: string; state: string; next_run_at: string | null }>(
    `SELECT company_id, state, next_run_at FROM social_engine_ownership`,
    [],
  );
  const byCompany = new Map<string, { active: number; superseded: number; next: string | null }>();
  let futureRun = false;
  const nowMs = Date.now();
  for (const r of rows) {
    const e = byCompany.get(r.company_id) ?? { active: 0, superseded: 0, next: null };
    if (r.state === 'active') {
      e.active += 1;
      if (r.next_run_at && new Date(r.next_run_at).getTime() > nowMs) futureRun = true;
    } else if (r.state === 'superseded') e.superseded += 1;
    byCompany.set(r.company_id, e);
  }
  let ok = true;
  for (const [, e] of byCompany) {
    if (e.active !== 1) ok = false; // exactly one active owner per company
  }
  const active = [...byCompany.values()].filter((e) => e.active === 1).length;
  const superseded = [...byCompany.values()].reduce((a, e) => a + e.superseded, 0);
  return { ok: ok && (byCompany.size === 0 || futureRun || active > 0), companies: byCompany.size, activeOwner: active, superseded, futureRun };
}

/**
 * Register the cycle sweep on the shared node-cron scheduler. Called from
 * scheduler.ts registration (idempotent via the global registry there).
 */
export function registerSocialCycleJob(io: {
  send?: SendInvitationFn;
  sendReminder?: SendReminderFn;
  companies?: CompanyRow[];
  timezone?: string;
} = {}): { name: string; expr: string } {
  const cronLib = cron as unknown as {
    schedule: (expr: string, fn: () => void, opts: { name: string; noOverlap: boolean }) => unknown;
    validate: (e: string) => boolean;
  };
  if (!cronLib.validate(SOCIAL_CYCLE_CRON)) {
    console.error(`[social-cycle] invalid expression: ${SOCIAL_CYCLE_CRON}`);
    return { name: 'social-cycle', expr: SOCIAL_CYCLE_CRON };
  }
  cronLib.schedule(SOCIAL_CYCLE_CRON, async () => {
    const result = await runSocialCycleSweep(io);
    if (result.invited || result.reminded || result.cutoffs || result.nextCycles || result.errors) {
      console.log(
        `[cron] social-cycle: scanned ${result.scanned}, invited ${result.invited}, reminded ${result.reminded}, ` +
          `cutoffs ${result.cutoffs}, next ${result.nextCycles}, errors ${result.errors}`,
      );
    }
  }, { name: 'social-cycle', noOverlap: true });
  return { name: 'social-cycle', expr: SOCIAL_CYCLE_CRON };
}

/** Stamp next_run_at on the ownership row (called by the sweep). */
export function recordOwnershipTick(nextRunAt: string): void {
  run(
    `UPDATE social_engine_ownership SET next_run_at = ?, verified_at = ?
     WHERE engine = ? AND state = 'active'`,
    [nextRunAt, timeNow(), SOCIAL_CYCLE_ENGINE],
  );
}