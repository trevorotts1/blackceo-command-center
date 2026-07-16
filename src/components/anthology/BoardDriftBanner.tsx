'use client';

/**
 * U79 (GK-17) — self-heal escalation-of-last-resort banner.
 *
 * ORIGIN (A7): an empty Anthology board (0 cards) used to be visually
 * identical whether there was genuinely no work queued, or the S0→mc_board
 * mirror silently dropped cards while the engine's own ledger kept
 * accumulating participants (the confirmed A7 failure: 5 ledger participants
 * sat invisible for 3 days against 0 cards, with no distinguishing signal).
 * The v5.4.0 banner made that visible — but only detected the FULLY-empty
 * case (board_cards === 0) and, worse, was the operator's FIRST and ONLY
 * response: it told them to hand-run the reconcile command.
 *
 * U79/GK-17 makes the underlying reconcile a CONVERGING repair (ONB leg,
 * merge b62455b1): `mc_board.py reconcile --json` now re-posts every ledger
 * subject missing from the board and reports whether the sweep actually
 * converged (zero deferred/error subjects) — persisted by the daily tick to
 * `<state_dir>/reports/smoke-test-*.json` under `board_reconcile.converged`.
 * This banner is the CC half of that unit: it reads the newest such report
 * (surfaced by checkAnthologyBoardProjection() as `board_reconcile_converged`
 * on the SAME `anthology_board_projection` advisory entry) and renders ONLY
 * when the automatic repair ran and did NOT converge — the escalation of
 * last resort the unit's title promises, never the first response. A repair
 * that converged (`true`), an unknown/no-report state (`null`), or the
 * pre-U79 raw ledger-vs-board count heuristic ALONE are never sufficient —
 * this banner keys off `board_reconcile_converged === false` and nothing
 * else. Because the repair is automatic (zero operator action per the
 * unit's acceptance), this copy is escalation-only — it no longer instructs
 * a manual reconcile command.
 *
 * NON-GATING advisory, unchanged: `anthology_board_projection` lives under
 * the response's `advisory` object, not the gating `checks` object, so this
 * signal never flips the box red or trips auto-rollback.
 *
 * Read-only, fail-soft: this is a diagnostic aid, never a page dependency —
 * any fetch/parse failure renders nothing rather than breaking the board.
 * Only mounted on the anthology workspace route (see workspace/[slug]/page.tsx),
 * which is itself behind the app's Cloudflare Access + same-origin operator
 * gating (src/middleware.ts) — there is no separate client-facing surface.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface AnthologyBoardProjectionCheck {
  pass: boolean;
  indeterminate?: boolean;
  detail: string;
  ledger_participants?: number;
  ledger_anthologies?: number;
  board_cards?: number;
  board_reconcile_converged?: boolean | null;
  board_reconcile_status?: string;
  board_reconcile_age_seconds?: number;
  board_reconcile_stale?: boolean;
}

interface EscalationState {
  status?: string;
  ageSeconds?: number;
}

export function AnthologyBoardDriftBanner() {
  const [escalation, setEscalation] = useState<EscalationState | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch('/api/health/deep', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        // Non-gating advisory field — read from `advisory`, not the gating
        // `checks` object.
        const c: AnthologyBoardProjectionCheck | undefined = data?.advisory?.anthology_board_projection;
        if (!c || cancelled) return;

        // U79/GK-17: the ONLY escalation condition. `true` (converged) and
        // `null` (unknown — no report yet, stale, or a legacy runner) must
        // both render nothing; the old pass/board_cards heuristic is no
        // longer consulted here at all.
        if (c.board_reconcile_converged === false) {
          setEscalation({
            status: c.board_reconcile_status,
            ageSeconds: c.board_reconcile_age_seconds,
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

  if (!escalation) return null;

  return (
    <div
      data-testid="anthology-selfheal-banner"
      className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6 lg:px-8"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-amber-900">
            Board self-heal did not converge
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            The automatic reconcile ran on the last scheduled cycle and did not resolve every
            ledger participant onto this board. This is an escalation, not an instruction — no
            operator action is required; the next scheduled cycle retries automatically.
          </p>
        </div>
      </div>
    </div>
  );
}
