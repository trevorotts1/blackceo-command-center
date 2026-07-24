'use client';

/**
 * FleetGrid — responsive grid of client rows for the /fleet page (U009).
 *
 * Wraps the shared CardGrid component and renders one ClientRow per
 * FleetClientStatus entry. Graceful degradation covers three cases:
 *
 *   0 clients  →  a quiet empty-state card with "No clients yet." and a
 *                 one-line hint explaining that clients appear once added
 *                 in settings. No crash, no blank grid.
 *   1 client   →  a constrained column layout so the single card never
 *                 stretches full-bleed across xl screens.
 *   N clients  →  the default CardGrid four-column responsive layout.
 *
 * White-label safe — all accents via brand-* or semantic utilities.
 */

import type { FleetClientStatus } from '@/lib/fleet';
import { CardGrid } from './CardGrid';
import { ClientRow } from './ClientRow';

export interface FleetGridProps {
  clients: FleetClientStatus[];
  className?: string;
}

export function FleetGrid({ clients, className }: FleetGridProps) {
  /* ── 0 clients: quiet empty state ────────────────────────────────────── */
  if (clients.length === 0) {
    return (
      <section aria-label="Fleet clients">
        <CardGrid
          cols="grid-cols-1"
          className={className}
        >
          <div className="bg-white border border-gray-200 rounded-xl p-6 text-center">
            <p className="text-sm font-medium text-gray-700">No clients yet.</p>
            <p className="text-xs text-gray-400 mt-1">
              Clients appear here once added in settings.
            </p>
          </div>
        </CardGrid>
      </section>
    );
  }

  /* ── 1 client: constrained cols so the card never goes full-bleed ────── */
  /* ── N clients: default four-column responsive layout ────────────────── */
  const cols =
    clients.length === 1
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3'
      : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4';

  return (
    <section aria-label="Fleet clients">
      <CardGrid cols={cols} ariaLabel="Fleet clients" className={className}>
        {clients.map((client) => (
          <ClientRow key={client.id} client={client} />
        ))}
      </CardGrid>
    </section>
  );
}
