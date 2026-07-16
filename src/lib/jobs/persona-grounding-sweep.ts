/**
 * A-U12 — persona_grounding_degraded board event (CC half of the both-repo
 * unit; ONB's shared-utils/persona_grounding_health_probe.py, merged
 * 2026-07-16 commit 4411c87b, is the other half). Mirrors sweep-liveness.ts's
 * cooldown-guarded, NULL-task_id event pattern for a board-wide,
 * non-task-scoped condition — the same pattern board-hygiene.ts's
 * processBlendRegressionCheck established first (task_id is nullable on
 * `events`; a global/box-wide condition rides a NULL task_id row).
 *
 * The probe's own module docstring names this file's job explicitly: "It
 * does not render a chip or fire a Command-Center board event. It only
 * emits the `persona_grounding_degraded` EVENT NAME as a string field — the
 * Command Center owns turning that into a board chip/event exactly as it
 * already owns `persona_blend_regression` / `persona_mismatch`
 * (board-hygiene.ts)."
 *
 * Two readers, same split as sweep-liveness.ts:
 *   1. checkPersonaGrounding() (deep-checks.ts) — pure, side-effect-free
 *      read folded into /api/health/deep's `advisory.persona_match`. Never
 *      gates the box's pass/indeterminate verdict (A-U12 acceptance (a)).
 *   2. runPersonaGroundingHealthSweep() (this file) — the scheduler.ts cron
 *      entry point. Fires exactly ONE cooldown-guarded `persona_grounding_
 *      degraded` event per cooldown window while the condition persists.
 *
 * DESIGN DECISION (A-U12 acceptance (c), "restoring it clears the chip"):
 * the board CHIP (PersonaGroundingBanner.tsx) does NOT read this event feed
 * — `events` is an append-only feed-of-record (persona_mismatch /
 * persona_blend_regression / sweep_liveness_alert rows never clear). The
 * chip instead renders from the LIVE deep-health advisory (current probe
 * state) on every poll, so it clears the moment a probe cycle reports
 * grounding healthy again — no separate "resolved" bookkeeping needed. This
 * event is the durable, cooldown-guarded AUDIT record of the transition,
 * same posture as sweep_liveness_alert / persona_blend_regression.
 */
import { v4 as uuidv4 } from 'uuid';
import { queryOne, run, timeNow, sqlTime } from '@/lib/db';
import { notifySystem } from '@/lib/notify';
import { checkPersonaGrounding } from '@/lib/health/deep-checks';

export const PERSONA_GROUNDING_DEGRADED_EVENT = 'persona_grounding_degraded';

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Re-alert cadence while the condition persists (default 60 minutes),
 *  mirroring SWEEP_LIVENESS_ALERT_COOLDOWN_MINUTES's precedent. */
const ALERT_COOLDOWN_MINUTES = numEnv('PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES', 60);

function isDisabled(): boolean {
  return (
    process.env.DISABLE_PERSONA_GROUNDING_SWEEP === '1' ||
    process.env.DISABLE_PERSONA_GROUNDING_SWEEP === 'true'
  );
}

export interface PersonaGroundingSweepResult {
  ranAt: string;
  skippedReason?: string;
  degraded: boolean;
  alerted: boolean;
}

/**
 * scheduler.ts-registered cron entry point. Cooldown-guarded: at most one
 * notifySystem() + one `persona_grounding_degraded` event per cooldown
 * window while the condition persists, so a multi-hour degrade does not spam
 * every probe cycle. An INDETERMINATE probe read (script not yet deployed on
 * this box, transient spawn failure, malformed output) is never treated as a
 * confirmed degrade — this must never fabricate a board event off an
 * unreadable probe.
 */
export async function runPersonaGroundingHealthSweep(): Promise<PersonaGroundingSweepResult> {
  const ranAt = timeNow();

  if (isDisabled()) {
    return { ranAt, skippedReason: 'DISABLE_PERSONA_GROUNDING_SWEEP set', degraded: false, alerted: false };
  }

  const check = await checkPersonaGrounding();

  if (check.indeterminate || !check.grounding) {
    return { ranAt, degraded: false, alerted: false };
  }

  if (!check.grounding.degraded) {
    return { ranAt, degraded: false, alerted: false };
  }

  let recentAlert = 0;
  try {
    recentAlert =
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events
          WHERE type = ? AND ${sqlTime('created_at')} >= datetime('now', ?)`,
        [PERSONA_GROUNDING_DEGRADED_EVENT, `-${ALERT_COOLDOWN_MINUTES} minutes`],
      )?.n ?? 0;
  } catch {
    recentAlert = 0;
  }

  if (recentAlert > 0) {
    // Already alerted within the cooldown window -- stay quiet, still report
    // the degraded read so the caller's log line is honest about the
    // ongoing condition.
    return { ranAt, degraded: true, alerted: false };
  }

  const reasons =
    Array.isArray(check.grounding.reasons) && check.grounding.reasons.length > 0
      ? check.grounding.reasons.join('; ')
      : 'neutral-floor fallback (layer-1-3)';
  const message =
    `[PERSONA-GROUNDING] ${PERSONA_GROUNDING_DEGRADED_EVENT}: company-config grounding degraded — ${reasons}. ` +
    `Advisory only (A-U12) — never gates box health; check company-config on this box.`;

  notifySystem(message, { agent: 'persona-grounding-sweep', action: 'grounding_degraded' });

  try {
    run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, NULL, ?, ?)`, [
      uuidv4(),
      PERSONA_GROUNDING_DEGRADED_EVENT,
      message,
      ranAt,
    ]);
  } catch {
    /* audit best-effort — the notifySystem() call above already fired */
  }

  return { ranAt, degraded: true, alerted: true };
}
