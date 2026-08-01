'use client';

/**
 * Per-ticket audit timeline (P13).
 *
 * Renders the durable `ticket_events` trail for one ticket: every validated
 * state transition the store accepted, with its actor, decision mode, and
 * note. This is the audit surface the Telegram-only workflow never had — the
 * relay kept its state in n8n workflow static data, which is wiped on every
 * re-import, so before the durable store there was nothing to render here.
 *
 * Fetched ON DEMAND (when a row is expanded) so the list endpoint stays cheap
 * no matter how long a ticket's history grows.
 */

import { useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import type { RescueEvent } from '@/lib/rescue/types';
import { absoluteTime, clockTime, humanizeToken, relativeTime } from '@/lib/rescue/format';

interface DetailResponse {
  events: RescueEvent[];
}

/** Dot colour by the status the event moved the ticket INTO. */
function dotClass(toStatus: string | null): string {
  switch (String(toStatus || '').toUpperCase()) {
    case 'RESOLVED':
    case 'CLOSED':
      return 'bg-brand-500';
    case 'ESCALATED':
    case 'NEEDS_HUMAN':
      return 'bg-red-500';
    case 'IN_PROGRESS':
    case 'ACK':
      return 'bg-amber-500';
    case 'REOPENED':
      return 'bg-purple-500';
    default:
      return 'bg-gray-400';
  }
}

export default function RescueTimeline({ ticketId }: { ticketId: string }) {
  const [events, setEvents] = useState<RescueEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setEvents(null);
    fetch(`/api/rescue/tickets/${encodeURIComponent(ticketId)}`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: DetailResponse) => {
        if (!cancelled) setEvents(Array.isArray(data.events) ? data.events : []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [ticketId]);

  if (failed) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-red-700">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <span>Timeline unavailable for this ticket.</span>
      </div>
    );
  }

  if (events === null) {
    return (
      <div className="px-4 py-3 space-y-2" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-4 bg-gray-100 rounded animate-pulse" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-gray-500">
        No audit events recorded for this ticket.
      </div>
    );
  }

  return (
    <ol className="px-4 py-3 space-y-3">
      {events.map((event) => (
        <li key={event.seq} className="flex gap-3">
          <div className="flex flex-col items-center pt-1">
            <span className={`h-2.5 w-2.5 rounded-full ${dotClass(event.toStatus)}`} aria-hidden="true" />
            <span className="flex-1 w-px bg-gray-200 mt-1" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1 pb-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-semibold text-gray-900">
                {event.fromStatus ? `${event.fromStatus} → ${event.toStatus ?? '?'}` : (event.toStatus ?? 'event')}
              </span>
              <span
                className="text-xs text-gray-500 font-mono"
                title={absoluteTime(event.at)}
              >
                {clockTime(event.at)} · {relativeTime(event.at)}
              </span>
            </div>
            <div className="text-xs text-gray-500">
              {event.actor ? <span>by {event.actor}</span> : null}
              {event.decisionMode ? (
                <span>
                  {event.actor ? ' · ' : ''}
                  {humanizeToken(event.decisionMode)}
                </span>
              ) : null}
            </div>
            {event.note ? (
              <p className="mt-0.5 text-sm text-gray-700 break-words">{event.note}</p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
