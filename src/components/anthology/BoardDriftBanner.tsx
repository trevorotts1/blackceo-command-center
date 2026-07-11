'use client';

/**
 * A7 — empty-vs-idle board drift banner.
 *
 * An empty Anthology board (0 cards) is visually identical whether there is
 * genuinely no work queued right now, or the S0→mc_board mirror silently
 * dropped every card while the engine's own ledger kept accumulating
 * participants (the confirmed A7 failure: 5 ledger participants sat
 * invisible for 3 days against 0 cards, with no distinguishing signal).
 *
 * This banner makes the two cases distinguishable for the operator viewing
 * the board: it reads the `anthology_board_projection` entry off the existing
 * `/api/health/deep` endpoint (src/lib/health/deep-checks.ts). That entry is a
 * NON-GATING advisory — it lives under the response's `advisory` object, not
 * the gating `checks` object, so a drift never flips the box red or trips
 * auto-rollback (A7 refix). The banner renders ONLY when the advisory reports a
 * confirmed drift (ledger has rows, board has none) — a healthy-idle board
 * (ledger empty) or a healthy-projecting board renders nothing here.
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
}

interface DriftState {
  ledgerParticipants: number;
  ledgerAnthologies: number;
  detail: string;
}

/** Extracts the generic, path-free `mc_board.py reconcile --json` command from
 *  the advisory detail string (the endpoint deliberately omits the resolved
 *  absolute script path — see deep-checks.ts drift branch). Returns null if the
 *  detail carries no `Run:` marker. */
function extractCommand(detail: string): string | null {
  const m = detail.match(/Run:\s*(.+)$/);
  return m ? m[1].trim() : null;
}

export function AnthologyBoardDriftBanner() {
  const [drift, setDrift] = useState<DriftState | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch('/api/health/deep', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        // Non-gating advisory field (A7 refix) — read from `advisory`, not the
        // gating `checks` object.
        const c: AnthologyBoardProjectionCheck | undefined = data?.advisory?.anthology_board_projection;
        if (!c || cancelled) return;

        // Only a CONFIRMED drift (not indeterminate — engine unreadable is a
        // different failure mode, not this banner's job) with ledger rows
        // present and zero board cards counts as drift.
        const ledgerTotal = (c.ledger_participants ?? 0) + (c.ledger_anthologies ?? 0);
        if (c.pass === false && c.indeterminate !== true && ledgerTotal > 0 && (c.board_cards ?? 0) === 0) {
          setDrift({
            ledgerParticipants: c.ledger_participants ?? 0,
            ledgerAnthologies: c.ledger_anthologies ?? 0,
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
            Board projection drift — this board may be dead, not idle
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            The Anthology Engine ledger holds {drift.ledgerParticipants} participant row(s) and{' '}
            {drift.ledgerAnthologies} anthology row(s), but this board shows zero cards. Reconcile
            the mirror:
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
