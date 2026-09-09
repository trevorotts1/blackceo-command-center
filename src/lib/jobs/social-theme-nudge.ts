/**
 * src/lib/jobs/social-theme-nudge.ts — the F07 reminder-delivery half of the
 * cycle service (social/wf10-weekly-expiry).
 *
 * Splits responsibility: social-cycle.ts advances the STATE MACHINE (ensure,
 * invite, cutoff, next week); THIS job delivers the messages — the invitation
 * and its bounded reminders — through the registered notification channel
 * (the theme-intake outbox; F27's WF11 builds the mini-app UI, this owns the
 * JOB side). The invitation-renewal hook lives here too: minting a new
 * intake ticket for the SAME saved draft when a previous ticket expired
 * (F35's invitation-expiry branch, per the invitation.json contract rule
 * "renew mints new ticket to same draft").
 *
 * Channel contract: a sender is a plain function (payload) => delivered.
 * Production wires the owner-notification sender; tests inject recorders.
 * A failed delivery NEVER mutates cycle state (retry next tick).
 */

import { randomUUID, createHash } from 'crypto';
import { queryAll, queryOne, run, timeNow } from '@/lib/db';
import {
  MAX_REMINDERS,
  type InvitationPayload,
  type ReminderPayload,
  type SendInvitationFn,
  type SendReminderFn,
} from '@/lib/social/cycle-service';

export interface ThemeIntakeDraft {
  draftId: string;
  companyId: string;
  /** The saved draft the renewal re-tickets (never regenerated). */
  savedAnswers: Record<string, unknown> | null;
  ticketToken?: string;
  ticketExpiresAt?: string;
  ticketUsedAt?: string | null;
  ticketRevokedAt?: string | null;
}

export interface RenewTicketResult {
  ok: boolean;
  draftId: string;
  newTicket: string | null;
  expiresAt: string | null;
  error?: string;
}

/**
 * F35 invitation-renewal — mint a NEW ticket for the SAME saved draft. The
 * contract (invitation.json): token_hash is stored, the raw token never
 * logged; renew mints a NEW ticket bound to the same draft; the old ticket's
 * expiry does not touch the draft. No UI here (WF11 owns the mini-app); this
 * is the job-side mint that the registered notification channel delivers.
 */
export function renewInvitationTicket(
  draftId: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = Number(process.env.SOCIAL_INTAKE_TTL_SECONDS ?? 7 * 86_400),
): RenewTicketResult {
  const draft = queryOne<{ id: string; company_id: string; saved_answers: string | null; ticket_token_hash: string | null }>(
    `SELECT id, company_id, saved_answers, ticket_token_hash FROM social_theme_drafts WHERE id = ?`,
    [draftId],
  );
  if (!draft) {
    return { ok: false, draftId, newTicket: null, expiresAt: null, error: 'E_DRAFT_NOT_FOUND' };
  }
  if (!draft.saved_answers) {
    return { ok: false, draftId, newTicket: null, expiresAt: null, error: 'E_NO_SAVED_ANSWERS' };
  }
  const token = randomUUID();
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(nowMs + ttlSeconds * 1000).toISOString();
  // The previous ticket is superseded, not deleted — audit keeps one hash per
  // ticket generation, and a revoked/expired old hash can never be replayed
  // because redemption checks expires_at/used_at/revoked_at.
  run(
    `UPDATE social_theme_drafts
     SET ticket_token_hash = ?, ticket_expires_at = ?, ticket_renewed_at = ?, updated_at = ?
     WHERE id = ?`,
    [tokenHash, expiresAt, timeNow(), timeNow(), draftId],
  );
  return { ok: true, draftId, newTicket: token, expiresAt };
}

export type DeliverRenewalFn = (payload: {
  draftId: string;
  companyId: string;
  /** The RAW new token — the intake URL carries it; only the hash is stored. */
  ticket: string;
  expiresAt: string;
  message: string;
}) => Promise<boolean> | boolean;

/**
 * Renew + deliver in one step: mint the new ticket for the same draft and
 * hand it to the registered notification channel. Delivery failure returns
 * false WITHOUT consuming the ticket (redelivery re-sends the same token
 * until it is redeemed or expires).
 */
export async function deliverInvitationRenewal(
  draftId: string,
  deliver: DeliverRenewalFn,
  nowMs: number = Date.now(),
): Promise<{ ok: boolean; delivered: boolean; error?: string }> {
  const mint = renewInvitationTicket(draftId, nowMs);
  if (!mint.ok || !mint.newTicket || !mint.expiresAt) {
    return { ok: false, delivered: false, error: mint.error };
  }
  const draft = queryOne<{ company_id: string }>(`SELECT company_id FROM social_theme_drafts WHERE id = ?`, [draftId]);
  const delivered = await deliver({
    draftId,
    companyId: draft?.company_id ?? '',
    ticket: mint.newTicket,
    expiresAt: mint.expiresAt,
    message: `Your theme intake link for this week expired — here is a fresh one (same saved answers, nothing lost): /social/theme-intake?t=${mint.newTicket}`,
  });
  return { ok: true, delivered };
}

/**
 * The production senders wired into the cycle sweep. Both are best-effort:
 * they persist a theme-intake outbox row (the registered notification
 * channel) and report delivered=false on any failure so the cycle state is
 * untouched for retry. No direct Telegram send from this module — the
 * outbox consumer owns transport (silence doctrine: owner-only audience).
 */
export function makeOutboxSenders(): { send: SendInvitationFn; sendReminder: SendReminderFn } {
  const enqueue = (kind: string, payload: Record<string, unknown>): boolean => {
    try {
      run(
        `INSERT INTO social_theme_outbox (id, kind, company_id, cycle_id, payload, created_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [randomUUID(), kind, String(payload.companyId ?? ''), String(payload.cycleId ?? ''), JSON.stringify(payload), timeNow()],
      );
      return true;
    } catch {
      return false;
    }
  };
  return {
    send: (payload: InvitationPayload) => ({ delivered: enqueue('invitation', payload as unknown as Record<string, unknown>), channel: 'theme-intake-outbox' }),
    sendReminder: (payload: ReminderPayload) => ({ delivered: enqueue('reminder', payload as unknown as Record<string, unknown>) }),
  };
}

/** Bounded-reminder fact for tests/audits. */
export function reminderBound(): number {
  return MAX_REMINDERS;
}

/** All open (unanswered) invited cycles — read-side for dashboards. */
export function openCycles(nowMs: number = Date.now()): Array<{ cycle_id: string; company_id: string; week_start_local: string; reminder_count: number; cutoff_at: string | null; state: string }> {
  return queryAll(
    `SELECT id AS cycle_id, company_id, week_start_local, reminder_count, cutoff_at, state
     FROM social_cycles WHERE state = 'invited' AND (cutoff_at IS NULL OR cutoff_at > ?)
     ORDER BY week_start_local`,
    [new Date(nowMs).toISOString()],
  );
}