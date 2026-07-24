/**
 * /fleet — client-status dashboard (U009).
 *
 * A React Server Component: no client hooks, no framer-motion, no clock.
 * Renders a four-stat KPI bar (total clients, live gateways, interviews
 * complete, needs-attention) and the full FleetGrid for every client the
 * gateway knows about.
 *
 * The data comes from getFleetStatus() — an async server-side call that
 * returns self-first-ordered FleetClientStatus[].
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Server, AlertTriangle } from 'lucide-react';

import { getFleetStatus } from '@/lib/fleet';
import type { FleetClientStatus } from '@/lib/fleet';
import { CardGrid, StatCard } from '@/components/fleet/CardGrid';
import { FleetGrid } from '@/components/fleet/FleetGrid';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Fleet — Command Center',
  description: 'Per-client interview, gateway, and pipeline status across your fleet.',
};

/* ── KPI helpers ──────────────────────────────────────────────────────── */

function liveCount(clients: FleetClientStatus[]): number {
  return clients.filter((c) => c.liveness === 'live').length;
}

function interviewCompleteCount(clients: FleetClientStatus[]): number {
  return clients.filter((c) => c.interview === 'complete').length;
}

function needsAttentionCount(clients: FleetClientStatus[]): number {
  return clients.filter(
    (c) => c.liveness === 'offline' || c.health === 'error',
  ).length;
}

/* ── page ─────────────────────────────────────────────────────────────── */

export default async function FleetPage() {
  let clients: FleetClientStatus[] = [];

  try {
    clients = await getFleetStatus();
  } catch {
    // fall through — honest error card rendered below
  }

  /* derive KPIs only when we have data */
  const total = clients.length;
  const liveGws = liveCount(clients);
  const interviewsDone = interviewCompleteCount(clients);
  const attention = needsAttentionCount(clients);

  return (
    <div className="min-h-dvh bg-bcc-bg flex flex-col">
      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <header className="h-14 bg-white border-b border-gray-200 px-4 sm:px-6 flex items-center gap-3">
        {/* Brand mark — matches overview's fallback square */}
        <div className="w-8 h-8 rounded-lg bg-brand-600 flex items-center justify-center shrink-0">
          <Server className="w-4 h-4 text-white" />
        </div>

        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-gray-900 font-semibold text-[15px]">Fleet</span>
          <span
            className="hidden sm:inline text-gray-400 text-[15px] shrink-0"
            aria-hidden="true"
          >
            /
          </span>
          <span className="hidden sm:inline text-gray-500 text-[15px] font-medium shrink-0">
            Command Center
          </span>
        </div>

        <div className="flex-1" />

        <Link
          href="/"
          className="text-sm font-medium text-brand-700 hover:text-brand-800 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 rounded"
        >
          Overview
        </Link>
      </header>

      {/* ── Main ───────────────────────────────────────────────────────── */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
        <div className="mb-6">
          <h1 className="text-2xl sm:text-[28px] font-bold text-gray-900 tracking-tight leading-tight">
            Fleet
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Per-client interview, gateway, and pipeline status.
          </p>
        </div>

        {!clients.length ? (
          /* ── Error / empty card ─────────────────────────────────────── */
          <div className="bg-white border border-gray-200 rounded-xl p-6 max-w-lg">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  Fleet status unavailable
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  The gateway did not return client data. Check that the gateway
                  is running and try reloading.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* ── KPI strip ─────────────────────────────────────────────── */}
            <section aria-label="Fleet KPIs" className="mb-8">
              <CardGrid cols="grid-cols-2 lg:grid-cols-4">
                <StatCard label="Clients" value={total} />
                <StatCard label="Live gateways" value={liveGws} />
                <StatCard label="Interviews complete" value={interviewsDone} />
                <StatCard
                  label="Needs attention"
                  value={attention}
                  alert={attention > 0}
                />
              </CardGrid>
            </section>

            {/* ── Full fleet grid ──────────────────────────────────────── */}
            <section aria-label="Client fleet">
              <FleetGrid clients={clients} />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
