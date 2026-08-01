'use client';

/**
 * Rescue Rangers dashboard (P13) — the ticket UI the Command Center never had.
 *
 * Before this page, Telegram was the ENTIRE rescue interface: OPEN posts, IN
 * PROGRESS updates and watchdog alarms in one group topic, with no
 * open-by-severity view, no per-ticket history, and no daily accounting. This
 * renders all four over the durable ticket store:
 *
 *   1. Open tickets by severity (SEV1 first — the work queue order)
 *   2. Today's counts: in / fixed by us / told the agent / answered / human-pending
 *   3. Standing blocks (clients the fleet standing gate is holding)
 *   4. Per-ticket audit timeline, expanded on demand
 *
 * Polling mirrors the podcast dashboard: every 20 seconds while the tab is
 * visible, no websockets, no toasts, no sounds. Move in silence.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  MessageSquare,
  ShieldAlert,
  UserCheck,
  Wrench,
} from 'lucide-react';
import RescueTimeline from './RescueTimeline';
import { EmptyState, ErrorState, LoadingState, NO_STORE_COPY } from './states';
import type { RescueSummary, RescueTicket } from '@/lib/rescue/types';
import { SEVERITY_LABELS, normalizeSeverity } from '@/lib/rescue/severity';
import { absoluteTime, durationCopy, humanizeToken, relativeTime } from '@/lib/rescue/format';

const POLL_MS = 20000;

interface TicketsResponse {
  available: boolean;
  open: RescueTicket[];
  recent: RescueTicket[];
  lastUpdatedAt: string | null;
}

/** Severity accent, most severe = hottest. */
const SEVERITY_ACCENT: Record<string, { chip: string; value: string }> = {
  SEV1: { chip: 'bg-red-50 text-red-700 border-red-200', value: 'text-red-600' },
  SEV2: { chip: 'bg-orange-50 text-orange-700 border-orange-200', value: 'text-orange-600' },
  SEV3: { chip: 'bg-amber-50 text-amber-700 border-amber-200', value: 'text-amber-600' },
  SEV4: { chip: 'bg-sky-50 text-sky-700 border-sky-200', value: 'text-sky-600' },
  UNKNOWN: { chip: 'bg-gray-50 text-gray-600 border-gray-200', value: 'text-gray-600' },
};

function accentFor(severity: string | null): { chip: string; value: string } {
  return SEVERITY_ACCENT[severity ?? 'UNKNOWN'] ?? SEVERITY_ACCENT.UNKNOWN;
}

function StatCard({
  title,
  value,
  caption,
  icon,
  valueClass,
}: {
  title: string;
  value: string;
  caption?: string;
  icon: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-card p-4 sm:p-5">
      <div className="flex items-center justify-between">
        <span className="text-label text-gray-500">{title}</span>
        <span className="text-gray-400">{icon}</span>
      </div>
      <div className={`text-[40px] leading-[1.1] font-black ${valueClass ?? 'text-gray-900'}`}>
        {value}
      </div>
      {caption ? <div className="text-caption text-gray-500">{caption}</div> : null}
    </div>
  );
}

function SeverityStrip({ summary }: { summary: RescueSummary }) {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {summary.openBySeverity.map((row) => {
        const accent = accentFor(row.severity);
        const label = SEVERITY_LABELS[row.severity as 'SEV1'] ?? `${row.severity} · Unclassified`;
        return (
          <div
            key={row.severity}
            className="bg-white rounded-2xl border border-gray-200 shadow-card p-4 sm:p-5"
          >
            <div className="flex items-center justify-between">
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${accent.chip}`}
              >
                {row.severity}
              </span>
              <span className="text-gray-400">
                <ShieldAlert className="h-5 w-5" aria-hidden="true" />
              </span>
            </div>
            <div
              className={`text-[40px] leading-[1.1] font-black ${row.open > 0 ? accent.value : 'text-gray-900'}`}
            >
              {row.open}
            </div>
            <div className="text-caption text-gray-500">{label}</div>
          </div>
        );
      })}
    </div>
  );
}

function DailyCounts({ summary }: { summary: RescueSummary }) {
  const d = summary.daily;
  return (
    <section aria-labelledby="rescue-daily-heading">
      <div className="flex items-baseline justify-between mb-3">
        <h2 id="rescue-daily-heading" className="text-section text-gray-900">
          Today
        </h2>
        <span className="text-caption text-gray-500 font-mono">{d.day} UTC</span>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard
          title="Tickets in"
          value={String(d.in)}
          icon={<MessageSquare className="h-5 w-5" aria-hidden="true" />}
        />
        <StatCard
          title="Fixed by us"
          value={String(d.fixedByUs)}
          icon={<Wrench className="h-5 w-5" aria-hidden="true" />}
        />
        <StatCard
          title="Told the agent"
          value={String(d.toldAgent)}
          icon={<UserCheck className="h-5 w-5" aria-hidden="true" />}
        />
        <StatCard
          title="Answered"
          value={String(d.answered)}
          icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
        />
        <StatCard
          title="Human pending"
          value={String(d.humanPending)}
          valueClass={d.humanPending > 0 ? 'text-red-600' : undefined}
          icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
        />
      </div>
      {(d.inProgress > 0 || d.unclassified > 0) && (
        <p className="mt-2 text-caption text-gray-500">
          {d.inProgress > 0 ? `${d.inProgress} still being worked` : null}
          {d.inProgress > 0 && d.unclassified > 0 ? ' · ' : null}
          {d.unclassified > 0 ? `${d.unclassified} with no recorded decision yet` : null}
        </p>
      )}
    </section>
  );
}

function StandingPanel({ summary }: { summary: RescueSummary }) {
  const standing = summary.standing;
  return (
    <section aria-labelledby="rescue-standing-heading">
      <h2 id="rescue-standing-heading" className="text-section text-gray-900 mb-3">
        Standing blocks
      </h2>
      {!standing.available ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-gray-50 px-4 py-5 text-caption text-gray-600">
          No standing snapshot on this box. The fleet standing gate&apos;s verdicts live in the
          automation platform; this panel reads a local snapshot so the dashboard never needs that
          credential. Until a snapshot is written, blocks are shown as unknown rather than as zero.
        </div>
      ) : standing.blocks.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-card px-4 py-5 text-caption text-gray-600">
          No clients are currently held by the standing gate.
          {standing.takenAt ? (
            <span className="text-gray-400"> · snapshot {relativeTime(standing.takenAt)}</span>
          ) : null}
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-card overflow-hidden">
          <ul className="divide-y divide-gray-100">
            {standing.blocks.map((block, i) => (
              <li key={`${block.boxSlug ?? block.client ?? i}`} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-label font-semibold text-gray-900">
                    {block.client ?? block.boxSlug}
                  </span>
                  {block.since ? (
                    <span className="text-xs text-gray-500" title={absoluteTime(block.since)}>
                      since {relativeTime(block.since)}
                    </span>
                  ) : null}
                </div>
                {block.boxSlug && block.client ? (
                  <div className="text-xs text-gray-500 font-mono">{block.boxSlug}</div>
                ) : null}
                {block.reason ? (
                  <p className="mt-0.5 text-sm text-gray-700 break-words">{block.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>
          {standing.takenAt ? (
            <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs text-gray-500">
              Snapshot taken {relativeTime(standing.takenAt)}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function TicketRow({
  ticket,
  expanded,
  onToggle,
}: {
  ticket: RescueTicket;
  expanded: boolean;
  onToggle: () => void;
}) {
  const accent = accentFor(normalizeSeverity(ticket.severity));
  return (
    <li className="bg-white">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full text-left px-4 py-3 flex items-start gap-3 hover:bg-gray-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-300"
      >
        <span className="pt-1 text-gray-400 shrink-0">
          {expanded ? (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${accent.chip}`}
            >
              {ticket.severity ?? 'UNCLASSIFIED'}
            </span>
            {ticket.rr ? (
              <span className="text-xs font-mono text-gray-500">{ticket.rr}</span>
            ) : null}
            <span className="text-label font-semibold text-gray-900 truncate">
              {ticket.client ?? ticket.box ?? 'Unidentified sender'}
            </span>
            {ticket.slaBreached ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-50 border border-red-200 px-2 py-0.5 text-xs font-semibold text-red-700">
                <Clock className="h-3 w-3" aria-hidden="true" />
                SLA breached
              </span>
            ) : null}
          </span>
          {ticket.problem ? (
            <span className="mt-1 block text-sm text-gray-700 line-clamp-2 break-words">
              {ticket.problem}
            </span>
          ) : null}
          <span className="mt-1 block text-xs text-gray-500">
            <span className="font-medium text-gray-600">{ticket.status}</span>
            {ticket.decisionMode ? <> · {humanizeToken(ticket.decisionMode)}</> : null}
            {ticket.box ? <> · {ticket.box}</> : null}
            {ticket.agent ? <> · agent {ticket.agent}</> : null}
            <> · </>
            <span title={absoluteTime(ticket.createdAt)}>opened {relativeTime(ticket.createdAt)}</span>
          </span>
        </span>
      </button>
      {expanded ? (
        <div className="border-t border-gray-100 bg-gray-50/60">
          <RescueTimeline ticketId={ticket.ticketId} />
        </div>
      ) : null}
    </li>
  );
}

function TicketList({
  title,
  tickets,
  expandedId,
  onToggle,
  emptyCopy,
}: {
  title: string;
  tickets: RescueTicket[];
  expandedId: string | null;
  onToggle: (id: string) => void;
  emptyCopy: string;
}) {
  return (
    <section aria-label={title}>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-section text-gray-900">{title}</h2>
        <span className="text-caption text-gray-500">{tickets.length}</span>
      </div>
      {tickets.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-card px-4 py-5 text-caption text-gray-600">
          {emptyCopy}
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 shadow-card overflow-hidden">
          <ul className="divide-y divide-gray-100">
            {tickets.map((ticket) => (
              <TicketRow
                key={ticket.ticketId}
                ticket={ticket}
                expanded={expandedId === ticket.ticketId}
                onToggle={() => onToggle(ticket.ticketId)}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default function RescueDashboard() {
  const [summary, setSummary] = useState<RescueSummary | null>(null);
  const [tickets, setTickets] = useState<TicketsResponse | null>(null);
  const [error, setError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const load = useCallback(async (silent = false) => {
    if (!silent) setError(false);
    try {
      const [summaryRes, ticketsRes] = await Promise.all([
        fetch('/api/rescue/summary', { cache: 'no-store' }),
        fetch('/api/rescue/tickets?limit=50', { cache: 'no-store' }),
      ]);
      if (!summaryRes.ok || !ticketsRes.ok) throw new Error('bad status');
      setSummary((await summaryRes.json()) as RescueSummary);
      setTickets((await ticketsRes.json()) as TicketsResponse);
    } catch {
      if (!silent) setError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the tab is visible. Same cadence discipline as the podcast
  // dashboard: no websockets, no notifications, no client-visible churn.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) void load(true);
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  if (error && !summary) return <ErrorState onRetry={() => void load()} />;
  if (!summary || !tickets) return <LoadingState />;

  // The store is absent on this box (Batch C not deployed here, or a client
  // box that never runs a receiver). Empty state, never an error.
  if (!summary.available) {
    return (
      <div className="space-y-6">
        <EmptyState title="No ticket data yet" message={NO_STORE_COPY} />
        <StandingPanel summary={summary} />
      </div>
    );
  }

  const toggle = (id: string) => setExpandedId((cur) => (cur === id ? null : id));

  return (
    <div className="space-y-8">
      <section aria-labelledby="rescue-open-heading">
        <div className="flex items-baseline justify-between mb-3">
          <h2 id="rescue-open-heading" className="text-section text-gray-900">
            Open by severity
          </h2>
          {/* Mount-gated so the server and first client render agree (the
              relative caption is time-dependent and would otherwise mismatch). */}
          <span className="text-caption text-gray-500">
            {mounted && tickets.lastUpdatedAt
              ? `Updated ${relativeTime(tickets.lastUpdatedAt)}`
              : ' '}
          </span>
        </div>
        <SeverityStrip summary={summary} />
        <p className="mt-2 text-caption text-gray-500">
          {summary.openTotal} open · MTTR {durationCopy(summary.mttrMinutes)} over{' '}
          {summary.resolvedInWindow} resolved in the last {summary.windowDays} days
        </p>
      </section>

      <DailyCounts summary={summary} />

      <TicketList
        title="Open tickets"
        tickets={tickets.open}
        expandedId={expandedId}
        onToggle={toggle}
        emptyCopy="Nothing open. Every ticket has been resolved or closed."
      />

      <StandingPanel summary={summary} />

      {summary.capSuppressedToday.length > 0 && (
        <section aria-labelledby="rescue-cap-heading">
          <h2 id="rescue-cap-heading" className="text-section text-gray-900 mb-3">
            Suppressed by the daily cap
          </h2>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 shadow-card px-4 py-3">
            <ul className="space-y-1">
              {summary.capSuppressedToday.map((row) => (
                <li key={row.client} className="text-sm text-amber-900">
                  <span className="font-semibold">{row.client}</span>: {row.suppressed} suppressed ·
                  last {relativeTime(row.lastAt)}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {summary.repeatOffenders.length > 0 && (
        <section aria-labelledby="rescue-repeat-heading">
          <h2 id="rescue-repeat-heading" className="text-section text-gray-900 mb-3">
            Repeat escalations · last {summary.windowDays} days
          </h2>
          <div className="rounded-2xl border border-gray-200 bg-white shadow-card px-4 py-3">
            <ul className="space-y-1">
              {summary.repeatOffenders.map((row, i) => (
                <li key={`${row.client ?? 'unknown'}-${i}`} className="text-sm text-gray-700">
                  <span className="font-semibold text-gray-900">{row.client ?? 'Unidentified'}</span>
                  : {row.tickets} tickets
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <TicketList
        title="Recent activity"
        tickets={tickets.recent}
        expandedId={expandedId}
        onToggle={toggle}
        emptyCopy="No ticket activity recorded yet."
      />
    </div>
  );
}
