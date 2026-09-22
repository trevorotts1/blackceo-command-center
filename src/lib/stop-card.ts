/**
 * stop-card.ts — THE ONE CHOKEPOINT for a card that stops permanently.
 *
 * ── The operator's rule ──────────────────────────────────────────────────────
 *   "if it's stopped permanently because it failed the prerequisite amount of
 *    times, it should not be silent."
 *
 * ── The defect class this closes ─────────────────────────────────────────────
 * Every terminal-stop path in this codebase grew its own block writer, and each
 * one made its own independent decision about whether to tell a human. Measured
 * on a live client box (2026-09-22):
 *
 *   - An episode card failed at 08:26:27 with "SOP 9.1 Step 1 blocked: handoff
 *     package unreadable (EDEADLK on all artifact reads)". Eleven hours later
 *     `blocked_notice_sent_at` was NULL, `block_reason` was NULL, status was
 *     `backlog` so the board showed ordinary queued work, and the failure
 *     existed ONLY as an internal `error` activity row. The gateway log for
 *     08:20–08:40 recorded ZERO outbound sends, against a control of 58 sends
 *     across the rest of that same day — the log records sends and the search
 *     works, so the silence was real and not an artefact of the instrument.
 *   - A card sat stranded 10.5h on a lost scheduler lease with nothing retrying
 *     it and nobody told.
 *   - A daily cron reported `ok` while that client's episode was dead.
 *
 * The common shape is not "one path forgot". It is that "does this notify?" was
 * a per-path choice, made N times, in N files, by N authors — so the answer
 * drifted to "no" wherever nobody was looking. This module makes it ONE choice,
 * made ONCE, that a guard test can enforce.
 *
 * ── The guarantee ────────────────────────────────────────────────────────────
 * `stopCardPermanently()` is the only sanctioned way to park a card in a state
 * it will not leave without a human. It:
 *
 *   1. writes a plain-English `block_reason` a non-technical owner can act on
 *      (what stopped, why, what they can do) — never a machine string;
 *   2. persists the machine detail separately, for diagnosis, where it survives
 *      the unblock (a `task_blocked` events row + the block-history snapshot);
 *   3. stamps `blocked_notice_sent_at` as an atomic CLAIM, so a restart or a
 *      second sweep tick cannot re-send;
 *   4. sends exactly ONE notification, through the senders that already exist —
 *      `sendRequesterAudienceAsk` (the audience-confirm gate's own sender) for
 *      an OWNER-audience stop, `notifySystem` for a SYSTEM-audience one. No new
 *      transport is invented here and no chat id is ever hardcoded.
 *

 * ── Where the plain English lands, and where it deliberately does not ────────
 * When the chokepoint owns the write (`applyBlock` defaulted), `reason` IS the
 * `block_reason` column: plain English on the card, machine detail in the
 * events row beside it.
 *
 * When a caller owns its own compound compare-and-swap (`applyBlock: false` —
 * `recordDispatchFailure`, `blockTaskForQC`), that caller's existing
 * `block_reason` write is left alone. This codebase treats that column as
 * concise machine-readable metadata by an established contract that other
 * tests pin ('sop_authoring_failed', 'qc_result_loop_detected'), with
 * `block_needs` / `ask` as the human-facing pair. Overwriting it would break
 * that contract to restate something the owner never reads there.
 *
 * `reason` is still plain English in every case, because it is the text of the
 * NOTIFICATION — which is the thing the owner actually receives. Never pass a
 * machine string as `reason`; pass it as `machineDetail`.
 * * ── MOVE-IN-SILENCE is preserved, deliberately ───────────────────────────────
 * "Not silent" means a HUMAN is told, not that the CLIENT is told. A
 * SYSTEM-audience stop is an internal gap the client cannot act on and must
 * never reach their Telegram; it goes to the operator lane instead. Both lanes
 * stamp, so "exactly once" holds either way and neither can silently no-op.
 *
 * ── Why the stamp is a claim and not a flag ──────────────────────────────────
 * `UPDATE ... WHERE blocked_notice_sent_at IS NULL` returning `changes === 1`
 * is the same claim-then-send pattern the trust engine uses for every other
 * client-facing message. Only the winner of that CAS sends. This is what makes
 * a repeated sweep tick, a process restart mid-send, and two concurrent sweeps
 * all collapse to one notification.
 *
 * The stamp is cleared when a card LEAVES blocked (see the unblock writers in
 * tasks/[id]/route.ts, ad-campaigns.ts and archify-runs.ts), so it is a
 * per-block claim rather than a once-per-card-lifetime one. Without that clear,
 * a card blocked, unblocked and blocked again would be permanently silent on
 * its second stop — the exact defect this module exists to prevent.
 */

import { v4 as uuidv4 } from 'uuid';
import { run, queryOne } from '@/lib/db';
import { transition, TransitionError, type LifecycleState } from '@/lib/task-lifecycle';
import { recordBlockEvent } from '@/lib/block-events';
import { notifySystem } from '@/lib/notify';
import { sendRequesterAudienceAsk, sendProviderChoiceAsk } from '@/lib/jobs/trust-engine';

/** Who a permanent stop is addressed to. SYSTEM never reaches the client. */
export type StopAudience = 'OWNER' | 'SYSTEM';

export interface StopCardParams {
  taskId: string;
  /**
   * PLAIN ENGLISH, for a non-technical owner: what stopped, why, and what they
   * can do about it. This is what lands in `block_reason` and what the owner
   * reads on the card. Never put a machine string here — that is `machineDetail`.
   */
  reason: string;
  /** Which code path stopped the card ('qc-scorer', 'task-dispatcher', …). */
  source: string;
  /** What the named human must do. Becomes `block_needs` and `ask`. */
  needs: string;
  /** OWNER (the person who asked for the work) or SYSTEM (the operator). */
  audience: StopAudience;
  /** Owner-facing gap list, JSON-encoded into `block_gaps` (a string[]). */
  gaps?: string[];
  /** True when this stop is the end of a retry ladder — named in the notice. */
  retriesExhausted?: boolean;
  /**
   * Raw technical cause, persisted for diagnosis and NEVER sent to the owner.
   * This is where an EDEADLK, a stack trace, or an error code belongs.
   */
  machineDetail?: string;
  /**
   * `false` when the CALLER has already landed the status flip and its own
   * block_* columns (a compound raw writer whose CAS `transition()` cannot
   * express — `recordDispatchFailure`, the stuck sweep's fallback). The
   * chokepoint then performs only the notice half: stamp, send, audit.
   * Defaults to `true` (the chokepoint owns the write).
   */
  applyBlock?: boolean;
  /** CAS guard for the status flip. Only meaningful when applyBlock !== false. */
  expectedFrom?: LifecycleState;
  /** Extra columns to land atomically with the stop. */
  extraColumns?: Record<string, string | number | null>;
  /** Passthrough to transition() for operator-initiated stops. */
  operatorOverride?: boolean;
}

export interface StopCardResult {
  /** The card is in `blocked` because of THIS call (false on a lost race). */
  blocked: boolean;
  /** This call won the notice claim and sent. False means someone already did. */
  notified: boolean;
  /** How the notice was delivered, or why it was not. */
  delivery: 'telegram' | 'session' | 'system' | 'already-claimed' | 'undeliverable' | 'not-blocked';
}

/** `ask` is capped to 500 to match UpdateTaskSchema.ask's validation limit. */
const ASK_MAX = 500;

/**
 * Compose the owner-facing notice. It names the card, states in plain English
 * what stopped it, says whether the retries are gone, and ends with the one
 * thing the owner can do. The machine detail is deliberately absent — it is
 * persisted for diagnosis, not read out to a non-technical person.
 */
export function stoppedNotice(p: {
  title: string;
  reason: string;
  needs: string;
  retriesExhausted?: boolean;
}): string {
  const exhausted = p.retriesExhausted
    ? ' It has used up its automatic retries, so it will not start again on its own.'
    : ' It will not start again on its own.';
  return `"${p.title}" has stopped and needs you.\n\n${p.reason}${exhausted}\n\nWhat to do: ${p.needs}`;
}

/**
 * Claim the right to notify about THIS block. Returns true for exactly one
 * caller per block: the CAS only matches while `blocked_notice_sent_at` is
 * NULL, and it is cleared when the card leaves blocked.
 */
function claimStopNotice(taskId: string, now: string): boolean {
  try {
    const res = run(
      'UPDATE tasks SET blocked_notice_sent_at = ? WHERE id = ? AND blocked_notice_sent_at IS NULL',
      [now, taskId],
    );
    return (res.changes ?? 0) > 0;
  } catch {
    // Pre-migration box with no such column: we cannot claim, so we cannot
    // guarantee exactly-once. Sending is still strictly better than silence —
    // a duplicate notice is a nuisance, a missing one is the defect.
    return true;
  }
}

/**
 * THE CHOKEPOINT. Park a card permanently and make sure a human is told once.
 *
 * Never throws: a stop that cannot be recorded must still not take down the
 * sweep, dispatcher or scorer that called it. Every failure mode is reported
 * through the returned result rather than an exception.
 *
 * Any new code path that leaves a card in a state it cannot leave on its own
 * MUST call this. `scripts/guard-silent-terminal-stops.ts` fails the build for
 * a `blocked` writer that does not, unless the site carries an explicit
 * `SILENT-STOP-EXEMPT:` annotation naming why silence is correct there — so
 * silence is always a reviewed choice and never an accident.
 */
export async function stopCardPermanently(p: StopCardParams): Promise<StopCardResult> {
  const now = new Date().toISOString();
  const ask = p.needs.slice(0, ASK_MAX);
  const blockedOnHuman = p.audience === 'SYSTEM' ? 'operator' : 'owner';

  const task = queryOne<{ title: string; status: string }>(
    'SELECT title, status FROM tasks WHERE id = ?',
    [p.taskId],
  );
  if (!task) return { blocked: false, notified: false, delivery: 'not-blocked' };

  let blocked = task.status === 'blocked';

  if (p.applyBlock !== false) {
    // Already blocked: do NOT re-transition. The notice claim below is the
    // idempotency guard for the message; this is the guard for the write.
    if (task.status !== 'blocked') {
      const extraColumns: Record<string, string | number | null> = {
        ...(p.extraColumns ?? {}),
        block_reason: p.reason,
        block_needs: p.needs,
        block_audience: p.audience,
        blocked_on_human: blockedOnHuman,
        ask,
      };
      if (p.gaps && p.gaps.length > 0) extraColumns.block_gaps = JSON.stringify(p.gaps);
      try {
        await transition(p.taskId, 'blocked', {
          actor: p.source,
          reason: p.machineDetail ? `${p.reason} — ${p.machineDetail}` : p.reason,
          expectedFrom: p.expectedFrom,
          operatorOverride: p.operatorOverride,
          extraColumns,
        });
        blocked = true;
      } catch (err) {
        // A lost CAS race is a normal outcome (another writer already moved the
        // card). Anything else is worth a line, but never a throw.
        if (!(err instanceof TransitionError && err.code === 'CAS_CONFLICT')) {
          console.warn(`[stop-card] transition to blocked failed for ${p.taskId}:`, (err as Error).message);
        }
        return { blocked: false, notified: false, delivery: 'not-blocked' };
      }
      recordBlockEvent({
        taskId: p.taskId,
        blockReason: p.reason,
        blockGaps: p.gaps && p.gaps.length > 0 ? JSON.stringify(p.gaps) : null,
        blockNeeds: p.needs,
        blockAudience: p.audience,
        blockedOnHuman: blockedOnHuman,
        ask,
        actor: p.source,
      });
    }
  }

  if (!blocked) return { blocked: false, notified: false, delivery: 'not-blocked' };

  // The machine detail is written EVERY time the chokepoint runs, claim or no
  // claim, because it is the diagnosis record and a second sweep tick observing
  // the same fault is itself evidence worth keeping.
  if (p.machineDetail) {
    try {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), 'task_blocked', p.taskId,
          `[${p.source}] STOPPED PERMANENTLY — machine detail: ${p.machineDetail}`, now],
      );
    } catch { /* pre-migration events table — the block itself still landed */ }
  }

  if (!claimStopNotice(p.taskId, now)) {
    return { blocked: true, notified: false, delivery: 'already-claimed' };
  }

  const message = stoppedNotice({
    title: task.title,
    reason: p.reason,
    needs: p.needs,
    retriesExhausted: p.retriesExhausted,
  });

  if (p.audience === 'SYSTEM') {
    // MOVE-IN-SILENCE: an internal gap the client cannot act on never reaches
    // their chat. notifySystem is the operator lane (Rescue Rangers / server),
    // and it records an undeliverable rather than dropping the message.
    try {
      notifySystem(`[stopped] ${message}`, { agent: p.source, action: 'escalate' });
    } catch (err) {
      console.error('[stop-card] SYSTEM notify failed (non-fatal):', (err as Error).message);
    }
    return { blocked: true, notified: true, delivery: 'system' };
  }

  // OWNER lane. Same sender the audience-confirm gate uses: the requester's own
  // chat when the card has one, their gateway session when it does not. A card
  // an internal producer minted has no requester at all, so it falls through to
  // the box owner — resolved, never hardcoded, by sendProviderChoiceAsk.
  let delivery: 'telegram' | 'session' | 'undeliverable' = 'undeliverable';
  try {
    const viaRequester = sendRequesterAudienceAsk(p.taskId, message);
    if (viaRequester === 'telegram' || viaRequester === 'session') {
      delivery = viaRequester;
    } else {
      const viaOwner = sendProviderChoiceAsk(p.taskId, message);
      if (viaOwner === 'telegram') delivery = 'telegram';
    }
  } catch (err) {
    console.error('[stop-card] OWNER notify failed (non-fatal):', (err as Error).message);
  }

  if (delivery === 'undeliverable') {
    // Nobody was reachable. Record it where the operator will see it rather
    // than letting an unreachable owner become the new silent exit.
    try {
      notifySystem(
        `[stopped-undeliverable] Task ${p.taskId} stopped permanently and no owner address could be resolved. ${p.reason}`,
        { agent: p.source, action: 'escalate' },
      );
    } catch { /* best-effort */ }
  }

  return { blocked: true, notified: true, delivery };
}
