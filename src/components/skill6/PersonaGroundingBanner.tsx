'use client';

/**
 * A-U12 — persona_grounding_degraded board chip (CC half of the both-repo
 * unit; ONB shipped shared-utils/persona_grounding_health_probe.py, which
 * "does not render a chip or fire a Command-Center board event ... only
 * emits the persona_grounding_degraded EVENT NAME as a string field — the
 * Command Center owns turning that into a board chip/event exactly as it
 * already owns persona_blend_regression / persona_mismatch").
 *
 * Clones the Skill-6 / Anthology board-projection-drift banner pattern
 * (src/components/skill6/BoardDriftBanner.tsx,
 * src/components/anthology/BoardDriftBanner.tsx): reads the non-gating
 * `persona_match` advisory off the existing /api/health/deep endpoint
 * (checkPersonaGrounding, src/lib/health/deep-checks.ts) and renders a chip
 * ONLY when `grounding.degraded === true`.
 *
 * DESIGN DECISION (A-U12 acceptance (c), "restoring it clears the chip"):
 * the `persona_grounding_degraded` EVENT lands on the `events` feed-of-record
 * as a durable, cooldown-guarded row (persona-grounding-sweep.ts) exactly
 * like persona_blend_regression / sweep_liveness_alert — that feed is
 * append-only and never clears a row. The CHIP therefore does NOT read the
 * event feed; it renders from the LIVE probe state on every poll, so it
 * clears the moment a probe cycle reports grounding healthy again — no
 * separate "resolved" bookkeeping needed. Polls every 30s (matching
 * SystemStatusDrawer's live-feed row, src/components/SystemStatusDrawer.tsx)
 * so a restore is visible without a page reload, satisfying "within one
 * probe cycle" in both directions.
 *
 * Read-only, fail-soft: a diagnostic aid, never a page dependency — any
 * fetch/parse failure renders nothing rather than breaking the board.
 * Not workspace-scoped (unlike its two siblings) — company-config grounding
 * is a box-wide condition, not tied to one department's board.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface PersonaMatchAdvisory {
  pass: boolean;
  indeterminate?: boolean;
  detail: string;
  persona_match?: {
    count: number;
    mean: number | null;
    buckets: { low: number; mid: number; high: number };
  };
  grounding?: {
    degraded: boolean;
    event?: string;
    reasons?: string[];
  };
}

interface DegradedState {
  reasons: string[];
  detail: string;
}

const POLL_INTERVAL_MS = 30_000;

/** `pollIntervalMs` is a TEST-ONLY override (defaults to the real 30s
 *  cadence) — it lets a render test exercise the actual clear-on-restore
 *  transition on ONE mounted instance (a real poll firing twice) instead of
 *  only proving a fresh mount reads correctly, which would miss a "sticky
 *  chip" regression entirely (a mount/remount pair always starts from a
 *  fresh `useState(null)`, so it can never catch the `else` branch being
 *  deleted). No production caller passes this prop. */
export function PersonaGroundingBanner({ pollIntervalMs = POLL_INTERVAL_MS }: { pollIntervalMs?: number } = {}) {
  const [degraded, setDegraded] = useState<DegradedState | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch('/api/health/deep', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const c: PersonaMatchAdvisory | undefined = data?.advisory?.persona_match;
        if (!c || cancelled) return;

        // Only a CONFIRMED grounding degrade counts — an indeterminate probe
        // (script not yet deployed on this box / transient spawn failure) is
        // a different failure mode, not this chip's job (mirrors the Skill-6
        // banner's posture on `indeterminate`).
        if (c.indeterminate !== true && c.grounding?.degraded === true) {
          setDegraded({
            reasons: Array.isArray(c.grounding.reasons) ? c.grounding.reasons : [],
            detail: c.detail,
          });
        } else {
          // Live-derived: clears the instant a poll reports grounding
          // healthy again (A-U12 acceptance (c)) — no event-feed lookup.
          setDegraded(null);
        }
      } catch {
        // Fail-soft — this chip is a diagnostic aid, never a hard dependency.
      }
    }

    check();
    const interval = setInterval(check, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollIntervalMs]);

  if (!degraded) return null;

  return (
    <div
      className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6 lg:px-8"
      data-testid="persona-grounding-degraded-chip"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">Persona grounding degraded</p>
          <p className="mt-0.5 text-xs text-amber-800">
            {degraded.reasons.length > 0
              ? degraded.reasons.join('; ')
              : 'company-config grounding fell back to the neutral floor'}
            {' — advisory only, does not affect box health.'}
          </p>
        </div>
      </div>
    </div>
  );
}
