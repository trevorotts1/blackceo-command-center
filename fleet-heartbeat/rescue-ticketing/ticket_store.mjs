// rescue-ticketing/ticket_store.mjs
// FIX-RESCUE-07: durable Rescue-Rangers ticketing core (pure logic, storage-agnostic).
//
// This module carries ALL the decision logic for the redesigned ticket system so
// it is identical whether the durable store is Postgres/Supabase or an n8n Data
// Table: RR- number formatting, the ticket state machine, severity + SLA
// computation, ownership flips, and semantic dedup keys. It performs NO I/O — the
// caller (the n8n Code node, or the receiver) supplies the persisted rows and
// writes back the results. Every non-trivial function is unit-tested in
// tests/test-ticket-store.mjs.
//
// State machine (audited: every transition appends a row to ticket_events):
//
//   OPEN ──► ACK ──► IN_PROGRESS ──► RESOLVED ──► CLOSED
//     │        │          │  │  └──► ESCALATED ─┐
//     │        │          │  └─────► NEEDS_HUMAN─┤
//     └────────┴──────────┴──────────────────────┘
//   RESOLVED/CLOSED ──► REOPENED ──► (ACK|IN_PROGRESS|…)
//
import { createHash } from "node:crypto";

export const STATES = Object.freeze([
  "OPEN", "ACK", "IN_PROGRESS", "RESOLVED", "ESCALATED", "NEEDS_HUMAN", "CLOSED", "REOPENED",
]);

// Legal transitions. Anything not listed is rejected (fail-closed) so a bad
// caller can never drive a ticket into an impossible state.
export const LEGAL_TRANSITIONS = Object.freeze({
  OPEN:        ["ACK", "IN_PROGRESS", "ESCALATED", "NEEDS_HUMAN", "RESOLVED", "CLOSED"],
  ACK:         ["IN_PROGRESS", "ESCALATED", "NEEDS_HUMAN", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["RESOLVED", "ESCALATED", "NEEDS_HUMAN", "CLOSED"],
  RESOLVED:    ["CLOSED", "REOPENED"],
  ESCALATED:   ["IN_PROGRESS", "NEEDS_HUMAN", "RESOLVED", "CLOSED"],
  NEEDS_HUMAN: ["IN_PROGRESS", "ESCALATED", "RESOLVED", "CLOSED"],
  CLOSED:      ["REOPENED"],
  REOPENED:    ["ACK", "IN_PROGRESS", "ESCALATED", "NEEDS_HUMAN", "RESOLVED", "CLOSED"],
});

export function canTransition(from, to) {
  const allowed = LEGAL_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertTransition(from, to) {
  if (!STATES.includes(from)) throw new Error(`unknown from-state: ${from}`);
  if (!STATES.includes(to)) throw new Error(`unknown to-state: ${to}`);
  if (!canTransition(from, to)) {
    throw new Error(`illegal ticket transition ${from} -> ${to}`);
  }
  return true;
}

// Human-facing monotonic id. The store supplies the next integer (a Postgres
// sequence or the n8n Data Table max+1); we only format it.
export function formatTicketNumber(n) {
  const i = Math.trunc(Number(n));
  if (!Number.isFinite(i) || i < 1) throw new Error(`invalid ticket number: ${n}`);
  return `RR-${String(i).padStart(6, "0")}`;
}

// Failure-class -> severity. Unknown classes default to "medium" (never silently
// low). The receiver's decisionMode can escalate this (see severityFor below).
const CLASS_SEVERITY = Object.freeze({
  // critical: box is down / data or security at stake
  "mac-tunnel-unreachable": "critical",
  "gateway-down": "critical",
  "container-exited": "critical",
  "billing": "critical",
  "data-loss": "critical",
  "security": "critical",
  // high: degraded but reachable
  "gateway-port-closed": "high",
  "gateway-auth": "high",
  "config-invalid": "high",
  "mac-config-invalid": "high",
  "mac-gateway-down": "high",
  // medium: advisory / coaching / how-to with a problem
  "coach-client-agent": "medium",
  "how-to": "medium",
  "unknown": "medium",
  // low: probes / pure answers
  "routing-test": "low",
  "synthetic": "low",
  "deliver-answer": "low",
});

export const SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);

export function severityFor(failureClass, decisionMode) {
  let sev = CLASS_SEVERITY[String(failureClass || "").toLowerCase()] || "medium";
  // A human-needed decision never sits below "high" no matter the class.
  if (decisionMode === "HUMAN_NEEDED" && (sev === "medium" || sev === "low")) sev = "high";
  return sev;
}

// SLA response budget (minutes) per severity. sla_due_at = created_at + this.
export const SLA_MINUTES = Object.freeze({ critical: 15, high: 30, medium: 120, low: 480 });

export function slaMinutesFor(severity) {
  return SLA_MINUTES[severity] ?? SLA_MINUTES.medium;
}

export function computeSlaDue(createdAtIso, severity) {
  const base = new Date(createdAtIso);
  if (isNaN(base.getTime())) throw new Error(`invalid created_at: ${createdAtIso}`);
  return new Date(base.getTime() + slaMinutesFor(severity) * 60_000).toISOString();
}

// A ticket is SLA-breached when it is still OPEN work past its due time. Terminal
// states (RESOLVED/CLOSED) never breach.
const TERMINAL = new Set(["RESOLVED", "CLOSED"]);
export function isBreached(ticket, nowIso) {
  if (!ticket || TERMINAL.has(ticket.status)) return false;
  if (!ticket.sla_due_at) return false;
  const now = nowIso ? new Date(nowIso) : new Date();
  return new Date(ticket.sla_due_at).getTime() <= now.getTime();
}

// Ownership: the rescue-agent owns a ticket while it is auto-working; it flips to
// the operator the moment a human is required (escalate / needs-human / billing /
// timeout / queue-cap) or the ticket is SLA-escalated.
export function ownerFor(status, decisionMode) {
  if (status === "ESCALATED" || status === "NEEDS_HUMAN") return "operator";
  if (decisionMode === "HUMAN_NEEDED") return "operator";
  return "rescue-agent";
}

// Semantic dedup key: identical (client, failure_class) within the dedup window
// collapses onto the existing OPEN ticket instead of minting a new one (and does
// NOT consume the daily cap). The window is enforced by the caller's query; the
// key itself is deterministic.
export function dedupKey(client, failureClass) {
  const norm = (s) => String(s || "").trim().toLowerCase();
  return createHash("sha256").update(`${norm(client)}::${norm(failureClass)}`).digest("hex").slice(0, 32);
}

export const DEDUP_WINDOW_MINUTES = 360; // 6h

// Build the immutable audit event for a transition (persist into ticket_events).
export function buildEvent(ticketId, fromStatus, toStatus, actor, note) {
  return {
    ticket_id: ticketId,
    from_status: fromStatus || null,
    to_status: toStatus,
    actor: actor || "rescue-agent",
    note: (note || "").slice(0, 500),
    at: new Date().toISOString(),
  };
}
