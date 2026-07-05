// Tests for the durable Rescue Rangers ticket store (FIX-RESCUE-07).
// Run: node --test fleet-heartbeat/scripts/lib/rescue-ticket-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openStore,
  formatRr,
  dedupKey,
  severityForClass,
  slaDueAt,
  LEGAL_TRANSITIONS,
} from "./rescue-ticket-store.mjs";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "rr-store-"));
  const store = openStore(join(dir, "t.sqlite"));
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("formatRr pads to RR-000123", () => {
  assert.equal(formatRr(1), "RR-000001");
  assert.equal(formatRr(123), "RR-000123");
  assert.equal(formatRr(1000000), "RR-1000000");
});

test("severity + SLA derivation", () => {
  assert.equal(severityForClass("gateway-down"), "SEV1");
  assert.equal(severityForClass("billing-exhausted"), "SEV1");
  assert.equal(severityForClass("agent-error"), "SEV2");
  assert.equal(severityForClass("how-to question"), "SEV4");
  assert.equal(severityForClass("coach-client-agent"), "SEV3");
  assert.equal(severityForClass(""), "SEV3");
  assert.equal(severityForClass("totally-unknown-thing"), "SEV3");
  const due = slaDueAt("2026-07-05T00:00:00.000Z", "SEV1");
  assert.equal(due, "2026-07-05T00:15:00.000Z");
});

test("createTicket mints monotonic RR numbers and is idempotent", () => {
  const { store, cleanup } = freshStore();
  try {
    const a = store.createTicket({ ticketId: "t-1", client: "acme", failureClass: "gateway-down" });
    const b = store.createTicket({ ticketId: "t-2", client: "acme", failureClass: "how-to" });
    assert.equal(a.created, true);
    assert.equal(a.ticket.rr_number, 1);
    assert.equal(formatRr(a.ticket.rr_number), "RR-000001");
    assert.equal(b.ticket.rr_number, 2);
    assert.equal(a.ticket.severity, "SEV1");
    assert.equal(a.ticket.status, "OPEN");
    assert.equal(a.ticket.owner, "rescue-agent");

    // idempotent: same ticketId does not re-mint or double count
    const again = store.createTicket({ ticketId: "t-1", client: "acme", failureClass: "gateway-down" });
    assert.equal(again.deduped, true);
    assert.equal(again.created, false);
    assert.equal(again.ticket.rr_number, 1);
    assert.equal(store.countToday("acme"), 2); // two distinct tickets, retry did not add
  } finally {
    cleanup();
  }
});

test("state machine: legal transitions update timestamps, ownership, and audit", () => {
  const { store, cleanup } = freshStore();
  try {
    store.createTicket({ ticketId: "t-1", client: "acme", failureClass: "agent-error" });
    store.transition("t-1", "ACK", { actor: "rescue-agent" });
    let t = store.transition("t-1", "IN_PROGRESS", { actor: "rescue-agent" });
    assert.ok(t.first_response_at, "first_response_at set on first non-OPEN transition");
    assert.equal(t.owner, "rescue-agent");

    t = store.transition("t-1", "ESCALATED", { actor: "operator", note: "sla breach" });
    assert.equal(t.owner, "operator", "escalation flips owner to operator");
    assert.ok(t.escalated_at);

    t = store.transition("t-1", "RESOLVED", { actor: "operator" });
    assert.ok(t.resolved_at);
    assert.equal(t.resolved_by, "operator");

    t = store.transition("t-1", "CLOSED", { actor: "operator" });
    assert.equal(t.status, "CLOSED");

    // full audit trail recorded in order
    const evs = store.events("t-1");
    const chain = evs.map((e) => e.to_status);
    assert.deepEqual(chain, ["OPEN", "ACK", "IN_PROGRESS", "ESCALATED", "RESOLVED", "CLOSED"]);
    // seq is monotonic per ticket
    assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  } finally {
    cleanup();
  }
});

test("illegal transition throws; unknown ticket throws", () => {
  const { store, cleanup } = freshStore();
  try {
    store.createTicket({ ticketId: "t-1", client: "acme", failureClass: "info" });
    store.transition("t-1", "RESOLVED", { actor: "rescue-agent" });
    // RESOLVED -> IN_PROGRESS is illegal per the map
    assert.ok(!LEGAL_TRANSITIONS.RESOLVED.includes("IN_PROGRESS"));
    assert.throws(() => store.transition("t-1", "IN_PROGRESS", {}), /illegal/);
    assert.throws(() => store.transition("does-not-exist", "ACK", {}), /unknown ticket/);
    assert.throws(() => store.transition("t-1", "BOGUS", {}), /unknown status/);
  } finally {
    cleanup();
  }
});

test("reopen after resolve/close is legal and restores rescue-agent ownership", () => {
  const { store, cleanup } = freshStore();
  try {
    store.createTicket({ ticketId: "t-1", client: "acme", failureClass: "delivery-failure" });
    store.transition("t-1", "RESOLVED", { actor: "rescue-agent" });
    store.transition("t-1", "CLOSED", { actor: "rescue-agent" });
    const t = store.reopen("t-1", { note: "recurred" });
    assert.equal(t.status, "REOPENED");
    assert.equal(t.owner, "rescue-agent");
  } finally {
    cleanup();
  }
});

test("answer() records answer and moves lifecycle", () => {
  const { store, cleanup } = freshStore();
  try {
    store.createTicket({ ticketId: "t-1", client: "acme", failureClass: "how-to" });
    let t = store.answer("t-1", { answer: "here is how", decisionMode: "JUST_AN_ANSWER", resolved: true });
    assert.equal(t.status, "RESOLVED");
    assert.equal(t.answer, "here is how");
    assert.equal(t.decision_mode, "JUST_AN_ANSWER");
    assert.ok(t.first_response_at);
  } finally {
    cleanup();
  }
});

test("dueForEscalation returns only breached, non-terminal tickets", () => {
  const { store, cleanup } = freshStore();
  try {
    // SEV1 -> 15 min SLA. Force created_at into the past by editing directly.
    store.createTicket({ ticketId: "past", client: "acme", failureClass: "gateway-down" });
    store.createTicket({ ticketId: "fresh", client: "acme", failureClass: "gateway-down" });
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    store.db
      .prepare("UPDATE tickets SET created_at=:c, sla_due_at=:s WHERE ticket_id='past'")
      .run({ c: old, s: new Date(Date.now() - 45 * 60 * 1000).toISOString() });

    const due = store.dueForEscalation();
    assert.equal(due.length, 1);
    assert.equal(due[0].ticket_id, "past");

    // once escalated it is no longer due
    store.escalate("past", { actor: "operator" });
    assert.equal(store.dueForEscalation().length, 0);
  } finally {
    cleanup();
  }
});

test("semantic dedup key + findByDedup within window", () => {
  const { store, cleanup } = freshStore();
  try {
    const k = dedupKey("Acme", "gateway-down");
    assert.equal(dedupKey("acme", "GATEWAY-DOWN"), k, "dedup key is case-insensitive");
    store.createTicket({ ticketId: "t-1", client: "Acme", failureClass: "gateway-down" });
    const hit = store.findByDedup(k);
    assert.ok(hit);
    assert.equal(hit.ticket_id, "t-1");
    // resolved tickets fall out of the dedup window
    store.transition("t-1", "RESOLVED", { actor: "rescue-agent" });
    assert.equal(store.findByDedup(k), null);
  } finally {
    cleanup();
  }
});

test("gc deletes old closed tickets + stale counters, keeps recent", () => {
  const { store, cleanup } = freshStore();
  try {
    store.createTicket({ ticketId: "old", client: "acme", failureClass: "info" });
    store.transition("old", "CLOSED", { actor: "rescue-agent" });
    const longAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
    store.db.prepare("UPDATE tickets SET resolved_at=:r, updated_at=:r WHERE ticket_id='old'").run({ r: longAgo });
    store.db.prepare("INSERT INTO counters(day_key,count) VALUES ('acme|2020-01-01', 5)").run();

    store.createTicket({ ticketId: "recent", client: "acme", failureClass: "info" });

    const res = store.gc({ closedOlderThanDays: 30, counterOlderThanDays: 2 });
    assert.equal(res.ticketsDeleted, 1);
    assert.ok(res.countersDeleted >= 1);
    assert.equal(store.getTicket("old"), null, "old closed ticket gc'd");
    assert.ok(store.getTicket("recent"), "recent ticket retained");
    // cascade removed the old ticket's events
    assert.equal(store.events("old").length, 0);
  } finally {
    cleanup();
  }
});

test("readView reports open-by-severity, MTTR, repeat offenders, cap usage", () => {
  const { store, cleanup } = freshStore();
  try {
    // repeat offender: 3 tickets for one client
    for (let i = 0; i < 3; i++) store.createTicket({ ticketId: `r${i}`, client: "loud", failureClass: "agent-error" });
    store.createTicket({ ticketId: "q1", client: "quiet", failureClass: "gateway-down" });
    // resolve one to feed MTTR
    store.transition("q1", "RESOLVED", { actor: "rescue-agent" });

    const v = store.readView({ repeatThreshold: 3 });
    const sevMap = Object.fromEntries(v.openBySeverity.map((r) => [r.severity, r.n]));
    assert.equal(sevMap.SEV2, 3, "three open SEV2 (agent-error)");
    assert.ok(v.mttrMinutes != null);
    assert.equal(v.resolvedInWindow, 1);
    assert.equal(v.repeatOffenders[0].client, "loud");
    assert.equal(v.repeatOffenders[0].tickets, 3);
    const loudCap = v.capUsage.find((c) => c.client === "loud");
    assert.equal(loudCap.used, 3);
    assert.equal(loudCap.cap, 25);
  } finally {
    cleanup();
  }
});

// === FIX-RESCUE-08: semantic dedup at mint time =============================

test("mintOrRecur mints a genuinely new ticket and counts the cap", () => {
  const { store, cleanup } = freshStore();
  try {
    const r = store.mintOrRecur({ ticketId: "acme-gateway-down-2026-07-05", client: "acme", failureClass: "gateway-down" });
    assert.equal(r.status, "minted");
    assert.equal(r.minted, true);
    assert.equal(r.deduped, false);
    assert.equal(r.rrNumber, 1);
    assert.equal(store.countToday("acme"), 1, "mint counts toward the daily cap");
  } finally {
    cleanup();
  }
});

test("mintOrRecur folds a recurrence onto the open sibling without minting or counting the cap", () => {
  const { store, cleanup } = freshStore();
  try {
    const first = store.mintOrRecur({ ticketId: "acme-gateway-down-2026-07-05", client: "acme", failureClass: "gateway-down", problem: "box down" });
    assert.equal(first.status, "minted");
    assert.equal(store.countToday("acme"), 1);

    // Same client + class, DIFFERENT ticketId (a client agent that never
    // persists its id) — must dedup onto the first ticket.
    const again = store.mintOrRecur({ ticketId: "acme-gateway-down-DIFFERENT", client: "acme", failureClass: "gateway-down", problem: "still down" });
    assert.equal(again.status, "deduped");
    assert.equal(again.deduped, true);
    assert.equal(again.minted, false);
    assert.equal(again.ticketId, "acme-gateway-down-2026-07-05", "returns the EXISTING ticketId");
    assert.equal(store.countToday("acme"), 1, "the 25/day cap is NOT incremented on a dedup");

    // A "recurred" audit event was appended to the existing ticket.
    const evs = store.events("acme-gateway-down-2026-07-05");
    const recurred = evs.filter((e) => /recurred/.test(e.note || ""));
    assert.equal(recurred.length, 1, "one recurred event appended");
    assert.equal(store.getByRrNumber(1).ticket_id, "acme-gateway-down-2026-07-05");
    assert.equal(store.getTicket("acme-gateway-down-DIFFERENT"), null, "no duplicate ticket minted");
  } finally {
    cleanup();
  }
});

test("mintOrRecur: exact ticketId repeat returns existing (idempotent), never counts twice", () => {
  const { store, cleanup } = freshStore();
  try {
    store.mintOrRecur({ ticketId: "acme-cron-2026-07-05", client: "acme", failureClass: "cron" });
    const dup = store.mintOrRecur({ ticketId: "acme-cron-2026-07-05", client: "acme", failureClass: "cron" });
    assert.equal(dup.status, "exists");
    assert.equal(dup.deduped, true);
    assert.equal(store.countToday("acme"), 1);
  } finally {
    cleanup();
  }
});

test("mintOrRecur: different failure_class mints a distinct ticket (not deduped)", () => {
  const { store, cleanup } = freshStore();
  try {
    store.mintOrRecur({ ticketId: "acme-gateway-down-2026-07-05", client: "acme", failureClass: "gateway-down" });
    const other = store.mintOrRecur({ ticketId: "acme-cron-2026-07-05", client: "acme", failureClass: "cron" });
    assert.equal(other.status, "minted", "a different failure_class is a different problem");
    assert.equal(store.countToday("acme"), 2);
  } finally {
    cleanup();
  }
});

test("mintOrRecur: a resolved sibling does NOT absorb a new outage (window/terminal gate)", () => {
  const { store, cleanup } = freshStore();
  try {
    store.mintOrRecur({ ticketId: "acme-gateway-down-A", client: "acme", failureClass: "gateway-down" });
    store.transition("acme-gateway-down-A", "RESOLVED", { actor: "rescue-agent" });
    // The prior one is resolved -> a fresh outage should MINT, not dedup.
    const fresh = store.mintOrRecur({ ticketId: "acme-gateway-down-B", client: "acme", failureClass: "gateway-down" });
    assert.equal(fresh.status, "minted");
    assert.equal(store.countToday("acme"), 2);
  } finally {
    cleanup();
  }
});

test("mintOrRecur: dedup window is honored (stale sibling => mint)", () => {
  const { store, cleanup } = freshStore();
  try {
    store.mintOrRecur({ ticketId: "acme-gateway-down-old", client: "acme", failureClass: "gateway-down" });
    // Now = 7h later, window = 6h -> the old open ticket is out of window.
    const later = Date.now() + 7 * 60 * 60 * 1000;
    const r = store.mintOrRecur({ ticketId: "acme-gateway-down-new", client: "acme", failureClass: "gateway-down", now: later });
    assert.equal(r.status, "minted", "outside the 6h window a fresh ticket mints");
  } finally {
    cleanup();
  }
});

test("recurrence appends an event without changing state and throws on unknown ticket", () => {
  const { store, cleanup } = freshStore();
  try {
    store.createTicket({ ticketId: "t-r", client: "acme", failureClass: "cron" });
    const before = store.getTicket("t-r").status;
    store.recurrence("t-r", { note: "recurred x2" });
    assert.equal(store.getTicket("t-r").status, before, "state unchanged");
    assert.ok(store.events("t-r").some((e) => e.note === "recurred x2"));
    assert.throws(() => store.recurrence("nope", {}), /unknown ticket/);
  } finally {
    cleanup();
  }
});

test("durability: reopening the same DB file preserves tickets and RR sequence", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-persist-"));
  const p = join(dir, "t.sqlite");
  try {
    let s = openStore(p);
    s.createTicket({ ticketId: "t-1", client: "acme", failureClass: "gateway-down" });
    s.close_();
    // Re-open (simulates n8n re-import: the durable file is untouched)
    s = openStore(p);
    assert.ok(s.getTicket("t-1"), "ticket survived re-open");
    const next = s.createTicket({ ticketId: "t-2", client: "acme", failureClass: "info" });
    assert.equal(next.ticket.rr_number, 2, "RR sequence continued, not reset");
    s.close_();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
