'use client';

/**
 * U27 / B-U13 — Skill-6 board projection drift banner.
 *
 * Clones the Anthology A7 pattern (src/components/anthology/BoardDriftBanner.tsx)
 * for Skill 6's fail-soft producer. SKILL.md:607-608 names the blindness
 * verbatim: "cc_board.py fail-softs (the card just never lands / never moves)
 * and the build continues unregistered" — a completed build run can leave
 * ZERO trace that its board card never landed. This banner makes that
 * distinguishable for the operator viewing the Web Development board: it
 * reads the `skill6_board_projection` entry off the existing `/api/health/deep`
 * endpoint (src/lib/health/deep-checks.ts). That entry is a NON-GATING
 * advisory — it lives under the response's `advisory` object, not the gating
 * `checks` object, so a drift never flips the box red or trips auto-rollback
 * (same posture as the Anthology A7 banner). The banner renders ONLY when the
 * advisory reports a confirmed drift (one or more runs completed intake but
 * their card never landed or vanished from the board) — a healthy-idle board
 * or a healthy-projecting board renders nothing here.
 *
 * Read-only, fail-soft: this is a diagnostic aid, never a page dependency —
 * any fetch/parse failure renders nothing rather than breaking the board.
 * Only mounted on the web-development workspace route (see
 * workspace/[slug]/page.tsx), itself behind the app's Cloudflare Access +
 * same-origin operator gating (src/middleware.ts) — no separate client-facing
 * surface.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Skill6BoardProjectionCheck {
  pass: boolean;
  indeterminate?: boolean;
  detail: string;
  ledger_runs?: number;
  board_landed?: number;
  drift_count?: number;
  unwired_count?: number;
}

interface DriftState {
  ledgerRuns: number;
  driftCount: number;
  detail: string;
}

/** Extracts the generic `cc_board.py reconcile --json` command from the
 *  advisory detail string (the endpoint deliberately omits any absolute
 *  evidence-root path). Returns null if the detail carries no `Run:` marker. */
function extractCommand(detail: string): string | null {
  const m = detail.match(/Run:\s*(.+)$/);
  return m ? m[1].trim() : null;
}

export function Skill6BoardDriftBanner() {
  const [drift, setDrift] = useState<DriftState | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch('/api/health/deep', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        // Non-gating advisory field (U27 / B-U13) — read from `advisory`, not
        // the gating `checks` object.
        const c: Skill6BoardProjectionCheck | undefined = data?.advisory?.skill6_board_projection;
        if (!c || cancelled) return;

        // Only a CONFIRMED drift (not indeterminate — an unreadable
        // evidence-root or locked task DB is a different failure mode, not
        // this banner's job) with a positive drift count counts as drift.
        if (c.pass === false && c.indeterminate !== true && (c.drift_count ?? 0) > 0) {
          setDrift({
            ledgerRuns: c.ledger_runs ?? 0,
            driftCount: c.drift_count ?? 0,
            detail: c.detail,
          });
        }
      } catch {
        // Fail-soft — this banner is a diagnostic aid, never a hard dependency.
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!drift) return null;

  const command = extractCommand(drift.detail);

  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6 lg:px-8">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">
            Board projection drift — {drift.driftCount} Skill-6 card(s) may be dead, not idle
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            {drift.ledgerRuns} evidence-root run(s) completed intake, but {drift.driftCount} of their
            board card(s) never landed or vanished from this board. Reconcile:
          </p>
          {command && (
            <code className="mt-1.5 block w-fit max-w-full overflow-x-auto rounded bg-amber-100 px-2 py-1 text-[11px] text-amber-950">
              {command}
            </code>
          )}
        </div>
      </div>
    </div>
  );
}
