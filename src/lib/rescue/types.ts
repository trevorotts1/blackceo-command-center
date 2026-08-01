/**
 * Rescue Rangers ticket dashboard (P13): shared types.
 *
 * The row shapes mirror the schema created and owned EXCLUSIVELY by the
 * durable ticket store's writer module
 * (fleet-heartbeat/scripts/lib/rescue-ticket-store.mjs, FIX-RESCUE-07). The
 * Command Center never creates, migrates, or writes this schema — it only
 * reads it. Adding a column there is safe; this dashboard degrades to nulls.
 *
 * NO CLIENT NAMES: every client / person / box identifier is runtime data
 * read from the store at request time. Nothing in this file names a client,
 * so it is safe for the fleet-wide repository.
 */

/** The store's ticket lifecycle states (rescue-ticket-store.mjs STATUSES). */
export type RescueStatus =
  | 'OPEN'
  | 'ACK'
  | 'IN_PROGRESS'
  | 'RESOLVED'
  | 'ESCALATED'
  | 'NEEDS_HUMAN'
  | 'CLOSED'
  | 'REOPENED';

/** Severity tiers, derived by the store from the failure class. */
export type RescueSeverity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4';

/**
 * The receiver's decision vocabulary, as written to `tickets.decision_mode`.
 * `WE_SOLVED_IT` and `WE_FIXED_IT` are the same outcome under two spellings
 * (the store hook and the receiver each carry one) — both map to "fixed by
 * us" in the daily counts, which is why the mapping lives in one pure
 * function instead of being re-derived per consumer.
 */
export type RescueDecisionMode =
  | 'WE_FIXED_IT'
  | 'WE_SOLVED_IT'
  | 'WE_ARE_FIXING'
  | 'TOLD_YOUR_AGENT'
  | 'JUST_AN_ANSWER'
  | 'HUMAN_NEEDED';

/** Raw `tickets` row exactly as stored by rescue-ticket-store.mjs. Server only. */
export interface RescueTicketRow {
  ticket_id: string;
  rr_number: number | null;
  client: string | null;
  box: string | null;
  box_type: string | null;
  agent: string | null;
  person: string | null;
  failure_class: string | null;
  severity: string | null;
  status: string;
  owner: string | null;
  source: string | null;
  problem: string | null;
  answer: string | null;
  decision_mode: string | null;
  created_at: string;
  first_response_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  sla_due_at: string | null;
  escalated_at: string | null;
  dedup_key: string | null;
  day_count_key: string | null;
  updated_at: string;
}

/** Raw `ticket_events` row (the durable audit trail). Server only. */
export interface RescueEventRow {
  id: number;
  ticket_id: string;
  seq: number;
  at: string;
  from_status: string | null;
  to_status: string | null;
  actor: string | null;
  decision_mode: string | null;
  note: string | null;
}

/** A ticket as served to the browser. */
export interface RescueTicket {
  ticketId: string;
  rr: string | null;
  client: string | null;
  box: string | null;
  agent: string | null;
  person: string | null;
  failureClass: string | null;
  severity: RescueSeverity | null;
  status: RescueStatus | string;
  decisionMode: string | null;
  source: string | null;
  problem: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  slaDueAt: string | null;
  /** True when the ticket is still operationally open AND past its SLA. */
  slaBreached: boolean;
}

/** One audit event as served to the browser. */
export interface RescueEvent {
  seq: number;
  at: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string | null;
  decisionMode: string | null;
  note: string | null;
}

/** Open-ticket counts, one row per severity present. */
export interface RescueSeverityCount {
  severity: RescueSeverity | 'UNKNOWN';
  open: number;
}

/**
 * The five daily numbers the operator asked for, plus the reconciling
 * `unclassified` bucket so `in` always equals the sum of the buckets.
 */
export interface RescueDailyCounts {
  /** UTC day (YYYY-MM-DD) these counts cover — the store keys its own day
   *  counters the same way (`client|YYYY-MM-DD` off the ISO created_at). */
  day: string;
  in: number;
  fixedByUs: number;
  toldAgent: number;
  answered: number;
  humanPending: number;
  inProgress: number;
  unclassified: number;
}

/** A client currently blocked by the fleet standing gate. */
export interface RescueStandingBlock {
  client: string | null;
  boxSlug: string | null;
  reason: string | null;
  since: string | null;
}

/** The standing-blocks panel payload (see src/lib/rescue/standing.ts). */
export interface RescueStandingView {
  /** False when no snapshot exists on this box — the panel explains instead
   *  of pretending "zero blocks", which would be a lie, not an empty state. */
  available: boolean;
  takenAt: string | null;
  source: string | null;
  blocks: RescueStandingBlock[];
}

/** The `/api/rescue/summary` payload. */
export interface RescueSummary {
  /** False when the durable store file is absent (Batch C not deployed on
   *  this box, or a client box that never runs rescue). Drives the empty
   *  state and the gated nav entry. */
  available: boolean;
  generatedAt: string;
  openBySeverity: RescueSeverityCount[];
  openTotal: number;
  daily: RescueDailyCounts;
  standing: RescueStandingView;
  /** Rolling-window operational stats (mirrors rescue-report.mjs). */
  windowDays: number;
  mttrMinutes: number | null;
  resolvedInWindow: number;
  repeatOffenders: Array<{ client: string | null; tickets: number }>;
  capSuppressedToday: Array<{ client: string; suppressed: number; lastAt: string }>;
}
