/**
 * Rescue Rangers dashboard (P13): PURE presentation + classification logic.
 *
 * Deliberately framework-free and I/O-free (no React, no better-sqlite3, no
 * fs) so it is unit-testable with the repo's existing node:test + tsx runner,
 * matching the `src/lib/nav-gating.ts` precedent. Every rule that a reader
 * might otherwise re-derive per component (which severities exist and in what
 * order, which decision modes count as "we fixed it", whether a ticket is
 * still operationally open, whether it has blown its SLA) lives here exactly
 * once.
 */

import type {
  RescueDailyCounts,
  RescueSeverity,
  RescueSeverityCount,
  RescueTicket,
} from './types';

/** Severity tiers, most severe first — the display order everywhere. */
export const SEVERITY_ORDER: RescueSeverity[] = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];

/** Human labels; the store writes the bare SEVn token. */
export const SEVERITY_LABELS: Record<RescueSeverity, string> = {
  SEV1: 'SEV1 · Critical',
  SEV2: 'SEV2 · High',
  SEV3: 'SEV3 · Medium',
  SEV4: 'SEV4 · Low',
};

/**
 * Statuses that still need attention. MUST stay in step with the store's own
 * `OPEN_STATUSES` (rescue-ticket-store.mjs) — the report and this dashboard
 * disagreeing about what "open" means is exactly the drift class this repo
 * keeps hitting, so the list is duplicated ONCE, here, with this note.
 */
export const OPEN_STATUSES = [
  'OPEN',
  'ACK',
  'IN_PROGRESS',
  'ESCALATED',
  'NEEDS_HUMAN',
  'REOPENED',
] as const;

export function isOpenStatus(status: string | null | undefined): boolean {
  return OPEN_STATUSES.includes(String(status || '').toUpperCase() as never);
}

/** Statuses that mean "a human still owes this ticket an answer". */
const HUMAN_PENDING_STATUSES = ['ESCALATED', 'NEEDS_HUMAN'];

export function normalizeSeverity(value: string | null | undefined): RescueSeverity | null {
  const s = String(value || '').toUpperCase();
  return (SEVERITY_ORDER as string[]).includes(s) ? (s as RescueSeverity) : null;
}

/**
 * Order a severity count list most-severe-first, with any unrecognised
 * severity bucketed last as UNKNOWN rather than dropped — a store that starts
 * emitting SEV0 must show up as a visible anomaly, never silently vanish.
 */
export function orderSeverityCounts(
  rows: Array<{ severity: string | null; open: number }>,
): RescueSeverityCount[] {
  const known = new Map<RescueSeverity, number>();
  let unknown = 0;
  for (const row of rows) {
    const sev = normalizeSeverity(row.severity);
    const n = Number(row.open) || 0;
    if (sev) known.set(sev, (known.get(sev) ?? 0) + n);
    else unknown += n;
  }
  const out: RescueSeverityCount[] = SEVERITY_ORDER.map((severity) => ({
    severity,
    open: known.get(severity) ?? 0,
  }));
  if (unknown > 0) out.push({ severity: 'UNKNOWN', open: unknown });
  return out;
}

/**
 * The daily-count bucket a ticket belongs to.
 *
 * `human-pending` wins over the decision mode: a ticket the receiver labelled
 * HUMAN_NEEDED but that a human has since RESOLVED is no longer pending, and
 * a ticket sitting in ESCALATED/NEEDS_HUMAN is pending no matter what mode it
 * carries. Everything else keys off the decision mode; an unrecognised or
 * absent mode falls to `unclassified` so the buckets always reconcile to the
 * intake total instead of quietly losing a ticket.
 */
export type DailyBucket =
  | 'fixedByUs'
  | 'toldAgent'
  | 'answered'
  | 'humanPending'
  | 'inProgress'
  | 'unclassified';

export function bucketForTicket(ticket: {
  status?: string | null;
  decisionMode?: string | null;
}): DailyBucket {
  const status = String(ticket.status || '').toUpperCase();
  const mode = String(ticket.decisionMode || '').toUpperCase();

  if (HUMAN_PENDING_STATUSES.includes(status)) return 'humanPending';
  if (mode === 'HUMAN_NEEDED' && isOpenStatus(status)) return 'humanPending';

  switch (mode) {
    case 'WE_FIXED_IT':
    case 'WE_SOLVED_IT':
      return 'fixedByUs';
    case 'WE_ARE_FIXING':
      return isOpenStatus(status) ? 'inProgress' : 'fixedByUs';
    case 'TOLD_YOUR_AGENT':
      return 'toldAgent';
    case 'JUST_AN_ANSWER':
      return 'answered';
    case 'HUMAN_NEEDED':
      // Closed out by a human — credit it as fixed by us, not still pending.
      return 'fixedByUs';
    default:
      return 'unclassified';
  }
}

/** Roll a day's tickets into the five headline counts (+ reconcilers). */
export function tallyDaily(
  day: string,
  tickets: Array<{ status?: string | null; decisionMode?: string | null }>,
): RescueDailyCounts {
  const counts: RescueDailyCounts = {
    day,
    in: tickets.length,
    fixedByUs: 0,
    toldAgent: 0,
    answered: 0,
    humanPending: 0,
    inProgress: 0,
    unclassified: 0,
  };
  for (const t of tickets) counts[bucketForTicket(t)] += 1;
  return counts;
}

/**
 * The UTC day key for an instant. The durable store keys its own per-client
 * day counters off `created_at.slice(0, 10)` of an ISO-8601 UTC timestamp, so
 * the dashboard MUST slice the same way or the two disagree at every local
 * midnight offset.
 */
export function utcDayKey(at: Date | string = new Date()): string {
  const iso = typeof at === 'string' ? at : at.toISOString();
  return iso.slice(0, 10);
}

/** Is this ticket still open AND past its SLA due time? */
export function isSlaBreached(
  ticket: { status?: string | null; slaDueAt?: string | null; sla_due_at?: string | null },
  now: number = Date.now(),
): boolean {
  const due = ticket.slaDueAt ?? ticket.sla_due_at ?? null;
  if (!due) return false;
  if (!isOpenStatus(ticket.status)) return false;
  const dueMs = Date.parse(due);
  return Number.isFinite(dueMs) && dueMs < now;
}

/** Sort open tickets: SLA breaches first, then severity, then oldest first. */
export function sortOpenTickets(tickets: RescueTicket[]): RescueTicket[] {
  const rank = (t: RescueTicket) => {
    const sev = normalizeSeverity(t.severity);
    return sev ? SEVERITY_ORDER.indexOf(sev) : SEVERITY_ORDER.length;
  };
  return [...tickets].sort((a, b) => {
    if (a.slaBreached !== b.slaBreached) return a.slaBreached ? -1 : 1;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/**
 * Whether the gated "Rescue Rangers" affordance should render.
 *
 * FAILS CLOSED, exactly like `shouldShowEngineNavItem` (U77): while the probe
 * is still loading, or errored, we do not KNOW whether this box carries the
 * rescue store, so the entry stays hidden rather than flashing in or leaving
 * a dead card on a client box that will never have one.
 */
export type RescueProbeStatus = 'loading' | 'ok' | 'error';

export function shouldShowRescueEntry(status: RescueProbeStatus, available: boolean): boolean {
  return status === 'ok' && available === true;
}
