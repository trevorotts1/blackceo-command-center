'use client';

import { Wifi, WifiOff, AlertCircle, Loader2 } from 'lucide-react';
import type { StatusResponse } from './types';

/**
 * The subset of PublicClient fields this component needs. Defined locally to
 * avoid importing from @/lib/clients (server-only module) into a client
 * component. The shape must stay in sync with PublicClient in clients.ts.
 */
export interface ClientWiringInfo {
  name: string;
  gateway_url: string;
  is_self: boolean;
}

/**
 * E1 — Connection-state indicator for the Conversational AI analytics area.
 *
 * Answers two plain-English questions the page never answered before:
 *   1. HOW is this wired? (which client / gateway the data comes from)
 *   2. IS it connected? (green = data flowing; amber = no sources yet; red = unreachable)
 *
 * Driven entirely by the already-loaded StatusResponse the page receives from
 * `/api/conversational-ai/status`, plus the selected client from
 * `/api/clients`. No new server round-trip needed — the parent page passes the
 * status prop it already holds.
 *
 * Connection states:
 *   connected   — anySource is true (at least one Round-3 data source found)
 *   no-sources  — status ok but no data sources present yet (wired but empty)
 *   disconnected — status fetch failed (ok:false or null status)
 *   loading     — status not yet fetched
 */

type WireState = 'loading' | 'connected' | 'no-sources' | 'disconnected';

function wireState(status: StatusResponse | null): WireState {
  if (!status) return 'loading';
  if (!status.ok) return 'disconnected';
  if (status.anySource) return 'connected';
  return 'no-sources';
}

const STATE_CONFIG: Record<
  WireState,
  { icon: React.ReactNode; label: string; bg: string; text: string; border: string }
> = {
  loading: {
    icon: <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />,
    label: 'Checking connection…',
    bg: 'bg-gray-50',
    text: 'text-gray-500',
    border: 'border-gray-200',
  },
  connected: {
    icon: <Wifi className="w-4 h-4" aria-hidden="true" />,
    label: 'Connected — data flowing',
    bg: 'bg-emerald-50',
    text: 'text-emerald-700',
    border: 'border-emerald-200',
  },
  'no-sources': {
    icon: <AlertCircle className="w-4 h-4" aria-hidden="true" />,
    label: 'Connected — no data sources active yet',
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    border: 'border-amber-200',
  },
  disconnected: {
    icon: <WifiOff className="w-4 h-4" aria-hidden="true" />,
    label: 'Not connected',
    bg: 'bg-red-50',
    text: 'text-red-700',
    border: 'border-red-200',
  },
};

interface Props {
  /** The already-fetched status response from /api/conversational-ai/status. */
  status: StatusResponse | null;
  /** The selected client from /api/clients (null until fetched). */
  selectedClient: ClientWiringInfo | null;
}

export function ConnectionStatusBar({ status, selectedClient }: Props) {
  const state = wireState(status);
  const cfg = STATE_CONFIG[state];

  // Build a plain-English description of which gateway this page is reading.
  const gatewayDescription = (() => {
    if (!selectedClient) return null;
    const label = selectedClient.is_self ? 'your local OpenClaw gateway' : `${selectedClient.name}'s OpenClaw gateway`;
    const url = selectedClient.gateway_url;
    return { label, url };
  })();

  // Count how many Round-3 data sources are present vs expected.
  const sourceCount = status?.sources.filter((s) => s.present).length ?? 0;
  const totalSources = status?.sources.length ?? 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-xl border ${cfg.border} ${cfg.bg} px-4 py-3 flex items-center gap-3 flex-wrap`}
    >
      {/* Connection pill */}
      <span className={`inline-flex items-center gap-1.5 font-semibold text-sm ${cfg.text} shrink-0`}>
        {cfg.icon}
        {cfg.label}
      </span>

      {/* Divider (hidden on narrow screens where wrapping handles it) */}
      <span className="hidden sm:inline text-gray-300 select-none" aria-hidden="true">|</span>

      {/* Wiring description */}
      {gatewayDescription ? (
        <span className="text-sm text-gray-600">
          Reading from{' '}
          <span className="font-medium text-gray-800">{gatewayDescription.label}</span>
          {' '}
          <span className="font-mono text-xs text-gray-400">({gatewayDescription.url})</span>
        </span>
      ) : (
        <span className="text-sm text-gray-400">Identifying data source…</span>
      )}

      {/* Source count — only shown when status is known */}
      {state !== 'loading' && totalSources > 0 && (
        <>
          <span className="hidden sm:inline text-gray-300 select-none" aria-hidden="true">|</span>
          <span className="text-sm text-gray-500">
            {sourceCount === 0
              ? 'No Round-3 data sources connected yet — charts will fill as OpenClaw skills come online.'
              : `${sourceCount} of ${totalSources} data source${totalSources !== 1 ? 's' : ''} active`}
          </span>
        </>
      )}

      {/* Explicit "not connected" explanation */}
      {state === 'disconnected' && (
        <>
          <span className="hidden sm:inline text-gray-300 select-none" aria-hidden="true">|</span>
          <span className="text-sm text-red-600">
            Could not reach the gateway. Analytics are unavailable until the connection is restored.
          </span>
        </>
      )}
    </div>
  );
}
