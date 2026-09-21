import { NextResponse } from 'next/server';
import {
  BALANCE_NOT_EXPOSED,
  BALANCE_STALE_MS,
  isBalanceStale,
  readResourceLedger,
  refreshProviderBalances,
} from '@/lib/capacity/resource-ledger';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/capacity
 *
 * The live resource picture this box routes against: per provider, how many
 * concurrency slots are free, how much money is left, and what a million
 * tokens costs there.
 *
 * WHY A SEPARATE ROUTE. /api/health answers "is this box up"; a watchdog polls
 * it and a non-answer must be a 503. Resource state is neither — a provider
 * with an unknown balance is a perfectly healthy box — so it gets its own
 * route that always answers 200 and says what it does not know.
 *
 * NULL IS AN ANSWER. `balance: null` means UNDETERMINED, never zero:
 *   • `balanceExposed: false`  — the vendor publishes no balance endpoint at
 *     all (Ollama Cloud, Agnes), so nothing was ever probed.
 *   • `lastProbeError` set     — a documented probe ran and could not produce
 *     a number (no key on this box, HTTP status, timeout).
 *   • both absent              — the key declares no spending cap (an uncapped
 *     OpenRouter key reports `limit_remaining: null`).
 * A caller that treats any of those as "$0 remaining" will refuse work that
 * would have run fine.
 *
 * FRESHNESS. Balances come from the `provider-ledger` cron (every 5 min). This
 * route never blocks a dashboard on outbound HTTP: when a row is stale it
 * answers immediately with what it has, flags `stale: true`, and kicks the
 * refresh so the next read is current. `?refresh=1` awaits a forced probe
 * instead, for an operator who wants the number NOW.
 */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get('refresh') === '1';

  if (force) {
    try {
      await refreshProviderBalances({ force: true });
    } catch (err) {
      // A failed probe is data, not an outage: fall through and report the
      // stored ledger with whatever error the probe recorded.
      console.warn('[capacity] forced balance refresh failed:', (err as Error).message);
    }
  }

  const providers = readResourceLedger().map((entry) => ({
    ...entry,
    /** False when the vendor documents no balance endpoint — see BALANCE_NOT_EXPOSED. */
    balanceExposed: !(entry.provider in BALANCE_NOT_EXPOSED),
    /** True when this provider's balance has not been read inside the freshness window. */
    stale: !(entry.provider in BALANCE_NOT_EXPOSED) && isBalanceStale(entry.balanceAsOf),
  }));

  const stale = providers.some((p) => p.stale);
  if (stale && !force) {
    // Fire-and-forget so the dashboard is never held behind a vendor's API.
    void refreshProviderBalances().catch((err) =>
      console.warn('[capacity] background balance refresh failed:', (err as Error).message),
    );
  }

  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    stalenessWindowMs: BALANCE_STALE_MS,
    stale,
    providers,
  });
}
