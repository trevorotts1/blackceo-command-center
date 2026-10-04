/**
 * B13 — bounded stale-turn reconciliation for Company Headquarters private chat.
 *
 * Authority: SPEC.md revision 4, S9 "Durable turn protocol" (the paragraph that
 * begins "Use existing server job registration pattern to check stale nonterminal
 * turns once per minute; no second daemon."). Storage shape: S6 line 251
 * (`hq_chat_turns`), frozen by contract evidence/contracts/storage-auth.md §(b.3)
 * — B01 owns the DDL (migration 169), B09 owns the `src/lib/hq/chat.ts` state
 * machine, B13 owns THIS file only.
 *
 * WHAT THIS JOB DOES (and nothing else)
 * ------------------------------------
 *   expired `sending` / `awaiting_reply` lease -> `reconciling`
 *     "Expired sending/awaiting turn becomes reconciling." A turn whose lease is
 *     still live belongs to another sender and is left alone.
 *   `reconciling` + verified correlation proves completion -> `replied`
 *     Only a matching EXPLICIT completion observation plus persisted reply may
 *     mark replied. The observation arrives through the injected correlation
 *     capability below; this module never calls a gateway itself, never imports
 *     the gateway client, and never assumes a history method exists.
 *   `reconciling` + nothing established within 10 minutes -> `unresolved`
 *     Terminal uncertainty, no automatic resend, error_code `delivery_uncertain`,
 *     display text `ΔELIVERY_UNCERTAIN_MESSAGE` below. An unknown send is NEVER
 *     retried, and a persisted partial `reply_text` is NEVER treated as
 *     completion — a guessed success is not an outcome this job can produce.
 *   stale `queued` with attempts=0 -> REPORTED ONLY (safe to claim, never claimed here)
 *     Claiming is the send path's (B09). This job performs no network operation
 *     of any kind, so there is no code path here that can send or resend.
 *
 * BOUNDED BY CONSTRUCTION: one pass, no loops, at most `limit` rows read and at
 * most one state write per row per pass. Every write is a single compare-and-swap
 * fenced on (state, lease_token, lease_expires_at) read in this pass, so an
 * obsolete writer or a concurrent sender can never be clobbered. Repeated passes
 * with a frozen clock change nothing (the 10-minute window is anchored on the
 * stored lease expiry, never on a value this job rewrites).
 *
 * CLOCK: injected, never read from the wall here. The caller passes `now`.
 *
 * ponytail: registration in `src/lib/jobs/scheduler.ts` is A01's path (same as the
 * B06 retention sweep); this file exports `HQ_CHAT_RECONCILE_CRON` for it. Add a
 * kill flag only if A01's registration pattern requires one.
 */
import { getDb, parseDbTime, queryAll, run } from '@/lib/db';
import type { HqChatTurnState } from '@/lib/hq/types';

/** SPEC S9: "check stale nonterminal turns once per minute". */
export const HQ_CHAT_RECONCILE_CRON = '* * * * *';

/** SPEC S9: reconciliation that cannot establish an outcome ends `unresolved` "within 10 minutes". */
export const HQ_CHAT_RECONCILE_UNRESOLVED_MS = 10 * 60 * 1000;

/** SPEC S9 display text for an unresolved turn; shown by the conversation surface. */
export const HQ_CHAT_DELIVERY_UNCERTAIN_MESSAGE = 'Delivery uncertain; inspect conversation before sending again';

/** Chosen `error_code` for the unresolved outcome (SPEC names the state, not the code). */
export const HQ_CHAT_UNCERTAIN_ERROR_CODE = 'delivery_uncertain';

/** Per-pass read ceiling. One whole session holds at most one nonterminal turn (S6 partial unique index). */
export const HQ_CHAT_RECONCILE_DEFAULT_LIMIT = 500;

/** The nonterminal states a reconciliation pass may look at (S9 state list). */
const NONTERMINAL_STATES: readonly HqChatTurnState[] = ['queued', 'sending', 'awaiting_reply', 'reconciling'];

/** Columns this job reads. Never the message body beyond what it must persist as an authoritative reply. */
type HqChatReconcileRow = {
  id: string;
  company_id: string;
  session_id: string;
  state: HqChatTurnState;
  attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  gateway_session_key: string | null;
  source_run_id: string | null;
  reply_text: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/** Why a reconciling turn was not resolved on this pass. Reported, never hidden. */
export type HqChatReconcileInconclusive = {
  turnId: string;
  reason: 'capability_unavailable' | 'no_matching_evidence' | 'probe_error' | 'no_time_anchor';
};

/**
 * Verified correlation capability. B13 never constructs one and never imports a
 * gateway: the caller supplies this ONLY when V07 has verified the exact method
 * and correlation fields in the installed version (SPEC S9: "Query existing
 * proven gateway/run history only if V07 verifies exact method and correlation
 * fields in installed version"). Absent it, the job has no correlation at all
 * and the bounded window ends `unresolved` — it does not guess a gateway API.
 */
export type HqChatCorrelationEvidence =
  | {
      outcome: 'completed';
      gatewaySessionKey: string;
      runId: string | null;
      /** Authoritative visible assistant text from the completion observation; must be nonempty. */
      replyText: string;
      completedAt: string | null;
    }
  | { outcome: 'not_found' }
  | { outcome: 'unsupported' };

export type HqChatCorrelationProbe = (
  turn: Pick<HqChatReconcileRow, 'id' | 'company_id' | 'session_id' | 'gateway_session_key' | 'source_run_id'>,
) => HqChatCorrelationEvidence | Promise<HqChatCorrelationEvidence>;

export type HqChatReconcileResult = {
  nowIso: string;
  scanned: number;
  truncated: boolean;
  correlationCapability: 'available' | 'unavailable';
  /** Expired-lease turns moved to `reconciling` this pass. */
  expiredToReconciling: string[];
  /** Reconciling turns completed by a matching correlation observation this pass. */
  provenReplied: string[];
  /** Reconciling turns ended terminally as `unresolved` this pass (bounded window elapsed). */
  unresolved: string[];
  /** Stale queued turns with attempts=0 — safe to claim, reported only, untouched here. */
  staleQueuedClaimable: string[];
  /** Reconciling turns left alone, with the reason. */
  inconclusive: HqChatReconcileInconclusive[];
  /** Set when the job did not run (HQ tables not present yet — "check schema before access", S6). */
  skippedReason?: 'schema_absent';
};

/**
 * Pure correlation check. PROVEN only when the evidence is an explicit completion
 * whose per-turn gateway session key matches the key stored on this exact turn
 * (SPEC S9: the per-turn key "uniquely identifies the originating turn even if no
 * runId is supplied") and whose visible text is nonempty. A recorded run id must
 * agree; a similar message body is not correlation, and a partial `reply_text`
 * already in the row is never evidence by itself.
 */
export function hqChatCorrelationProof(
  turn: Pick<HqChatReconcileRow, 'gateway_session_key' | 'source_run_id'>,
  evidence: HqChatCorrelationEvidence,
): { proven: true; replyText: string; runId: string | null } | { proven: false; reason: 'no_matching_evidence' } {
  if (evidence.outcome !== 'completed') return { proven: false, reason: 'no_matching_evidence' };
  if (!turn.gateway_session_key || evidence.gatewaySessionKey !== turn.gateway_session_key) {
    return { proven: false, reason: 'no_matching_evidence' };
  }
  if (turn.source_run_id && evidence.runId !== turn.source_run_id) {
    return { proven: false, reason: 'no_matching_evidence' };
  }
  const replyText = evidence.replyText.trim();
  if (!replyText) return { proven: false, reason: 'no_matching_evidence' };
  return { proven: true, replyText, runId: evidence.runId };
}

/** First parseable timestamp wins: the stored lease expiry is the uncertainty anchor (see header). */
function uncertainSinceMs(row: HqChatReconcileRow): number {
  for (const value of [row.lease_expires_at, row.updated_at, row.created_at]) {
    const parsed = parseDbTime(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function hqChatTurnsPresent(db: ReturnType<typeof getDb>): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'hq_chat_turns'`)
    .get() as { n: number } | undefined;
  return (row?.n ?? 0) === 1;
}

/**
 * One reconciliation pass. Terminates; performs no send, no retry, no gateway call.
 * Caller owns the clock: `now()` returns epoch milliseconds.
 */
export async function runHqChatReconcile(options: {
  now: () => number;
  probe?: HqChatCorrelationProbe;
  limit?: number;
}): Promise<HqChatReconcileResult> {
  const nowMs = options.now();
  const nowIso = new Date(nowMs).toISOString();
  const limit = options.limit ?? HQ_CHAT_RECONCILE_DEFAULT_LIMIT;
  const probe = options.probe;

  const result: HqChatReconcileResult = {
    nowIso,
    scanned: 0,
    truncated: false,
    correlationCapability: probe ? 'available' : 'unavailable',
    expiredToReconciling: [],
    provenReplied: [],
    unresolved: [],
    staleQueuedClaimable: [],
    inconclusive: [],
  };

  const db = getDb();
  if (!hqChatTurnsPresent(db)) {
    result.skippedReason = 'schema_absent';
    return result;
  }

  const placeholders = NONTERMINAL_STATES.map(() => '?').join(',');
  const rows = queryAll<HqChatReconcileRow>(
    `SELECT id, company_id, session_id, state, attempts, lease_token, lease_expires_at,
            gateway_session_key, source_run_id, reply_text, created_at, updated_at
       FROM hq_chat_turns
      WHERE state IN (${placeholders})
      ORDER BY created_at ASC, id ASC
      LIMIT ?`,
    [...NONTERMINAL_STATES, limit],
  );
  result.scanned = rows.length;
  result.truncated = rows.length === limit;

  for (const row of rows) {
    // A stale queued turn with attempts=0 is durable and provably unsent — safe to
    // claim, but claiming is the send path's job. Reported, never mutated here.
    if (row.state === 'queued') {
      if (row.attempts === 0) result.staleQueuedClaimable.push(row.id);
      continue;
    }

    // Expired sending/awaiting -> reconciling. A live lease is another sender's.
    if (row.state === 'sending' || row.state === 'awaiting_reply') {
      const expiry = parseDbTime(row.lease_expires_at);
      if (Number.isFinite(expiry) && expiry > nowMs) continue;
      const fenced = run(
        `UPDATE hq_chat_turns
            SET state = 'reconciling', updated_at = ?
          WHERE id = ? AND company_id = ? AND state = ?
            AND lease_token IS ? AND lease_expires_at IS ?`,
        [nowIso, row.id, row.company_id, row.state, row.lease_token, row.lease_expires_at],
      );
      if (fenced.changes === 1) result.expiredToReconciling.push(row.id);
      continue;
    }

    // reconciling: try the verified capability, then apply the bounded window.
    let proof: { proven: true; replyText: string; runId: string | null } | undefined;
    if (!probe) {
      result.inconclusive.push({ turnId: row.id, reason: 'capability_unavailable' });
    } else {
      try {
        const evidence = await probe({
          id: row.id,
          company_id: row.company_id,
          session_id: row.session_id,
          gateway_session_key: row.gateway_session_key,
          source_run_id: row.source_run_id,
        });
        const checked = hqChatCorrelationProof(row, evidence);
        if (checked.proven) proof = checked;
        else result.inconclusive.push({ turnId: row.id, reason: checked.reason });
      } catch {
        result.inconclusive.push({ turnId: row.id, reason: 'probe_error' });
      }
    }

    if (proof) {
      // Persist the authoritative text and the first observed run id (never overwriting a recorded one).
      const fenced = run(
        `UPDATE hq_chat_turns
            SET state = 'replied', reply_text = ?, source_run_id = COALESCE(source_run_id, ?),
                error_code = NULL, terminal_at = ?, updated_at = ?
          WHERE id = ? AND company_id = ? AND state = 'reconciling'
            AND lease_token IS ? AND lease_expires_at IS ?`,
        [proof.replyText, proof.runId, nowIso, nowIso, row.id, row.company_id, row.lease_token, row.lease_expires_at],
      );
      if (fenced.changes === 1) result.provenReplied.push(row.id);
      continue;
    }

    const since = uncertainSinceMs(row);
    if (!Number.isFinite(since)) {
      result.inconclusive.push({ turnId: row.id, reason: 'no_time_anchor' });
      continue;
    }
    if (nowMs - since < HQ_CHAT_RECONCILE_UNRESOLVED_MS) continue; // still inside the bounded window

    const fenced = run(
      `UPDATE hq_chat_turns
          SET state = 'unresolved', error_code = ?, terminal_at = ?, updated_at = ?
        WHERE id = ? AND company_id = ? AND state = 'reconciling'
          AND lease_token IS ? AND lease_expires_at IS ?`,
      [HQ_CHAT_UNCERTAIN_ERROR_CODE, nowIso, nowIso, row.id, row.company_id, row.lease_token, row.lease_expires_at],
    );
    if (fenced.changes === 1) result.unresolved.push(row.id);
  }

  return result;
}
