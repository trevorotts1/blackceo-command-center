#!/usr/bin/env node
// Unit tests for the FIX-RESCUE-07 ticketing core. Pure logic, no I/O.
// Run: node rescue-ticketing/tests/test-ticket-store.mjs
import {
  formatTicketNumber, canTransition, assertTransition, severityFor, slaMinutesFor,
  computeSlaDue, isBreached, ownerFor, dedupKey, buildEvent, STATES, SEVERITIES,
  LEGAL_TRANSITIONS,
} from "../ticket_store.mjs";

let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ok   - ${name}`);
  else { console.error(`  FAIL - ${name}`); failures++; }
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

console.log("RR- monotonic numbering");
check("formats zero-padded RR-000123", formatTicketNumber(123) === "RR-000123");
check("formats large number", formatTicketNumber(1000000) === "RR-1000000");
check("rejects 0 / negative", throws(() => formatTicketNumber(0)) && throws(() => formatTicketNumber(-5)));

console.log("state machine (audited)");
check("OPEN->IN_PROGRESS legal", canTransition("OPEN", "IN_PROGRESS"));
check("IN_PROGRESS->RESOLVED legal", canTransition("IN_PROGRESS", "RESOLVED"));
check("RESOLVED->REOPENED legal", canTransition("RESOLVED", "REOPENED"));
check("CLOSED->REOPENED legal", canTransition("CLOSED", "REOPENED"));
check("CLOSED->IN_PROGRESS ILLEGAL", !canTransition("CLOSED", "IN_PROGRESS"));
check("RESOLVED->OPEN ILLEGAL", !canTransition("RESOLVED", "OPEN"));
check("assertTransition throws on illegal", throws(() => assertTransition("CLOSED", "OPEN")));
check("assertTransition throws on unknown state", throws(() => assertTransition("OPEN", "BOGUS")));
check("every state has a transition list", STATES.every((s) => Array.isArray(LEGAL_TRANSITIONS[s])));
const targets = new Set(Object.values(LEGAL_TRANSITIONS).flat());
check("every non-OPEN state is reachable as a target", STATES.filter((s) => s !== "OPEN").every((s) => targets.has(s)));

console.log("severity + SLA");
check("container-exited is critical", severityFor("container-exited") === "critical");
check("coach-client-agent is medium", severityFor("coach-client-agent") === "medium");
check("routing-test is low", severityFor("routing-test") === "low");
check("unknown class defaults medium (never low)", severityFor("something-new") === "medium");
check("HUMAN_NEEDED lifts medium to high", severityFor("coach-client-agent", "HUMAN_NEEDED") === "high");
check("critical SLA 15 min", slaMinutesFor("critical") === 15);
check("low SLA 480 min", slaMinutesFor("low") === 480);
const due = computeSlaDue("2026-07-05T00:00:00.000Z", "critical");
check("sla_due = created + 15min", due === "2026-07-05T00:15:00.000Z");
check("computeSlaDue rejects bad date", throws(() => computeSlaDue("not-a-date", "high")));

console.log("SLA breach detection");
check("past-due OPEN ticket is breached",
  isBreached({ status: "IN_PROGRESS", sla_due_at: "2020-01-01T00:00:00Z" }, "2026-07-05T00:00:00Z"));
check("future-due ticket not breached",
  !isBreached({ status: "OPEN", sla_due_at: "2999-01-01T00:00:00Z" }, "2026-07-05T00:00:00Z"));
check("RESOLVED ticket never breaches",
  !isBreached({ status: "RESOLVED", sla_due_at: "2020-01-01T00:00:00Z" }, "2026-07-05T00:00:00Z"));

console.log("ownership flips");
check("auto work owned by rescue-agent", ownerFor("IN_PROGRESS", "SELF_FIX") === "rescue-agent");
check("ESCALATED owned by operator", ownerFor("ESCALATED", "SELF_FIX") === "operator");
check("NEEDS_HUMAN owned by operator", ownerFor("NEEDS_HUMAN", null) === "operator");
check("HUMAN_NEEDED decision -> operator", ownerFor("IN_PROGRESS", "HUMAN_NEEDED") === "operator");

console.log("semantic dedup");
const k1 = dedupKey("Kofi Bryant", "container-exited");
const k2 = dedupKey("  kofi bryant ", "CONTAINER-EXITED");
const k3 = dedupKey("Kofi Bryant", "gateway-down");
check("dedup key stable across case/whitespace", k1 === k2);
check("dedup key differs by failure class", k1 !== k3);
check("dedup key is a 32-char hex", /^[0-9a-f]{32}$/.test(k1));

console.log("audit event");
const ev = buildEvent("RR-000001", "OPEN", "IN_PROGRESS", "rescue-agent", "started auto-fix");
check("event carries from/to/actor", ev.from_status === "OPEN" && ev.to_status === "IN_PROGRESS" && ev.actor === "rescue-agent");
check("event has an ISO timestamp", !isNaN(new Date(ev.at).getTime()));
check("severities enumerated", SEVERITIES.length === 4);

if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
console.log("\nAll ticket-store tests passed.");
