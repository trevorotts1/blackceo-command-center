/**
 * /conversational-ai/funnel — the route that MOUNTS `FunnelAttributionView`
 * (PBB-127 / T-30). Without this page the view was dead code: correct at
 * unit level, absent at runtime, so requirement R-31 ("Real Command Center
 * views") was not delivered.
 *
 * A thin SERVER component (no 'use client'): it calls the module's own
 * `loadFunnelAttribution()` — the accepted Round-3 `pixel-events/` reader —
 * rather than fetching its own API, so the snapshot the page renders is the
 * one the unit tests pin. No database, no client workspace beyond that one
 * read-only source directory.
 *
 * The F-52 card's stage-bar renderer (`PixelFunnel`) is deliberately NOT
 * touched here: this unit owns the truthful projection, not that component,
 * and this route is where the truthful one is actually reachable.
 */
import { FunnelAttributionView } from '@/components/funnel/FunnelAttributionView';
import { loadFunnelAttribution } from '@/lib/funnel/attribution';

// Source contents change as events land; never statically cache this page.
export const dynamic = 'force-dynamic';

export default function FunnelAttributionPage() {
  const snapshot = loadFunnelAttribution();

  return (
    <main className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      <header className="space-y-1">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
          Performance
        </p>
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">Funnel attribution</h1>
        <p className="text-sm text-gray-500">
          Source: <code>pixel-events/</code> (Round-3 reader). Attribution classes stay separated
          and the four outcomes stay independent — unknown is never zero.
        </p>
      </header>

      <section className="rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
        <FunnelAttributionView snapshot={snapshot} />
      </section>

      <p className="text-xs text-gray-500">
        <a href="/conversational-ai" className="underline">
          Back to Conversational AI
        </a>
      </p>
    </main>
  );
}
