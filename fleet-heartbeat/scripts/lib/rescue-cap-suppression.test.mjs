// Regression tests for FIX-RESCUE-13 — the daily cap must SUPPRESS, not announce.
// Run: node --test fleet-heartbeat/scripts/lib/rescue-cap-suppression.test.mjs
//
// THE INCIDENT THESE PIN
// ----------------------
// The cap branch computed "cap reached (25/25)" and then POSTED it — once per
// task, forever, every sweep. A backlog of blocked tasks turned the brake into
// the amplifier: hundreds of identical pages an hour. The tests below fail on
// the pre-fix store, which had no cap gate at all: `mintOrRecur()` minted every
// escalation and returned no `post` decision, so every one of them was sent.
//
// The other half of the contract is just as load-bearing and is pinned here too:
// SUPPRESSION MUST NEVER BECOME SILENCE. Under the cap everything still pages, a
// disabled cap suppresses nothing, a broken cap table fails OPEN, and every
// suppressed event stays durably counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, DEFAULT_DAILY_CAP } from "./rescue-ticket-store.mjs";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "rr-cap-"));
  const store = openStore(join(dir, "t.sqlite"));
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Drive N *distinct* escalations (distinct failure classes, so semantic dedup
// never folds them) through the mint path and collect what would be SENT.
function drive(store, n, { cap = DEFAULT_DAILY_CAP, client = "acme" } = {}) {
  const results = [];
  const posted = [];
  for (let i = 1; i <= n; i++) {
    const r = store.mintOrRecur({
      ticketId: `t-${i}`,
      client,
      failureClass: `agent-error-${i}`,
      problem: `problem ${i}`,
      capPerDay: cap,
    });
    results.push(r);
    if (r.post) posted.push(r);
  }
  return { results, posted };
}

test("REGRESSION: past the cap, NO per-task message is emitted — at most ONE consolidated notice", () => {
  const { store, cleanup } = freshStore();
  try {
    const cap = 25;
    const { results, posted } = drive(store, 30, { cap });

    const minted = results.filter((r) => r.status === "minted");
    const suppressed = results.filter((r) => r.status === "cap_suppressed");
    assert.equal(minted.length, cap, "exactly `cap` escalations mint");
    assert.equal(suppressed.length, 5, "the 5 past the cap are suppressed, not minted");

    // ── THE FIX ─────────────────────────────────────────────────────────────
    // Pre-fix: all 30 minted and all 30 posted (`post` was not even a field).
    // Post-fix: 25 ticket posts + exactly ONE consolidated cap notice = 26.
    const capPosts = posted.filter((r) => r.postKind === "cap_summary");
    assert.equal(capPosts.length, 1, "EXACTLY ONE consolidated cap notice per client per day");
    assert.equal(posted.length, cap + 1, "25 ticket posts + 1 consolidated notice — nothing else");

    // The defect, stated as an assertion: every escalation past the cap that is
    // NOT the single consolidated notice must be SILENT. This is the line that
    // the pre-fix `{ status:'cap_exceeded', _post:true }` branch violated 5×.
    const perTaskCapMessages = suppressed.filter((r) => r.post && r.postKind !== "cap_summary");
    assert.equal(perTaskCapMessages.length, 0, "NEVER a per-task 'cap reached' message");
    assert.equal(
      suppressed.filter((r) => r.post === false).length,
      4,
      "every suppressed escalation after the one notice is silent",
    );

    // Nothing past the cap was minted — no RR numbers burned, nothing deleted.
    for (let i = cap + 1; i <= 30; i++) {
      assert.equal(store.getTicket(`t-${i}`), null, `t-${i} past the cap must not mint a ticket`);
    }

    // ── SUPPRESSION IS NOT AMNESIA ──────────────────────────────────────────
    assert.equal(store.countToday("acme"), cap, "the daily counter stops AT the cap");
    assert.equal(store.countSuppressedToday("acme"), 5, "all 5 suppressed events stay COUNTED");
    const view = store.readView({ capPerDay: cap });
    const row = view.capSuppressed.find((c) => c.client === "acme");
    assert.ok(row, "suppressed volume is observable in the read view / report");
    assert.equal(row.suppressed, 5);
    assert.ok(row.notifiedAt, "the one consolidated notice is recorded as sent");

    // The single notice carries the count, so the human still learns the volume.
    assert.match(capPosts[0].message, /cap reached \(25\/25\)/i);
    assert.match(capPosts[0].message, /Suppressed so far: 1/);
  } finally {
    cleanup();
  }
});

test("NEVER SILENCE: under the cap, every single escalation still posts", () => {
  const { store, cleanup } = freshStore();
  try {
    const { results, posted } = drive(store, 25, { cap: 25 });
    assert.equal(posted.length, 25, "25 of 25 page a human — the cap suppresses NOTHING below itself");
    assert.ok(results.every((r) => r.status === "minted" && r.post === true));
    assert.equal(store.countSuppressedToday("acme"), 0, "nothing suppressed under the cap");
  } finally {
    cleanup();
  }
});

test("NEVER SILENCE: capGate FAILS OPEN — a broken cap table still mints and posts", () => {
  const { store, cleanup } = freshStore();
  try {
    drive(store, 25, { cap: 25 });
    // Simulate the cap machinery itself breaking (corrupt table, locked db...).
    store.capGate = () => {
      throw new Error("cap table unavailable");
    };
    const r = store.mintOrRecur({
      ticketId: "t-boom",
      client: "acme",
      failureClass: "gateway-down",
      capPerDay: 25,
    });
    assert.equal(r.status, "minted", "a broken cap must never swallow an escalation");
    assert.equal(r.post, true, "FAIL-OPEN: it pages a human");
  } finally {
    cleanup();
  }
});

test("NEVER SILENCE: a disabled cap (0) suppresses nothing", () => {
  const { store, cleanup } = freshStore();
  try {
    const { posted } = drive(store, 30, { cap: 0 });
    assert.equal(posted.length, 30, "cap<=0 means NO cap — every escalation posts");
    assert.equal(store.countSuppressedToday("acme"), 0);
  } finally {
    cleanup();
  }
});

test("NEVER SILENCE: past the cap, a recurrence still folds onto its OPEN ticket", () => {
  const { store, cleanup } = freshStore();
  try {
    const first = store.mintOrRecur({
      ticketId: "t-open",
      client: "acme",
      failureClass: "gateway-down",
      capPerDay: 25,
    });
    assert.equal(first.status, "minted");
    drive(store, 30, { cap: 25 }); // blow past the cap with other classes

    // The still-open ticket a human already has must keep absorbing recurrences —
    // the cap gate sits AFTER dedup and must not swallow them.
    const again = store.mintOrRecur({
      ticketId: "t-open-DIFFERENT",
      client: "acme",
      failureClass: "gateway-down",
      problem: "still down",
      capPerDay: 25,
    });
    assert.equal(again.status, "deduped", "not cap_suppressed — it folds onto the live ticket");
    assert.equal(again.ticketId, "t-open");
    assert.equal(
      store.events("t-open").filter((e) => /recurred/.test(e.note || "")).length,
      1,
      "the recurrence is still recorded on the open ticket",
    );
  } finally {
    cleanup();
  }
});

test("the cap is PER CLIENT: one client at cap never silences another", () => {
  const { store, cleanup } = freshStore();
  try {
    drive(store, 30, { cap: 25, client: "acme" });
    const other = store.mintOrRecur({
      ticketId: "other-1",
      client: "other-co",
      failureClass: "gateway-down",
      capPerDay: 25,
    });
    assert.equal(other.status, "minted");
    assert.equal(other.post, true, "a different client is unaffected by a neighbour at cap");
    assert.equal(store.countSuppressedToday("other-co"), 0);
  } finally {
    cleanup();
  }
});

test("capGate: the single-notice latch resets on the next DAY", () => {
  const { store, cleanup } = freshStore();
  try {
    const cap = 25;
    drive(store, 26, { cap }); // 25 mint, 1 suppressed + notice fired today
    assert.equal(store.capState("acme", { cap }).notifiedAt != null, true);

    // Tomorrow the counter is a different day_key: not at cap, nothing suppressed.
    const tomorrow = Date.now() + 86_400_000;
    const g = store.capGate({ client: "acme", cap, now: tomorrow });
    assert.equal(g.suppress, false, "a new day starts clean — the cap is DAILY");
  } finally {
    cleanup();
  }
});

test("capGate is idempotent about the notice under repeated crossings (no re-announce)", () => {
  const { store, cleanup } = freshStore();
  try {
    const cap = 2;
    drive(store, 2, { cap });
    const first = store.capGate({ client: "acme", cap, problem: "p1" });
    const second = store.capGate({ client: "acme", cap, problem: "p2" });
    const third = store.capGate({ client: "acme", cap, problem: "p3" });
    assert.deepEqual(
      [first.notice, second.notice, third.notice],
      [true, false, false],
      "the notice fires ONCE; every crossing after it is silent",
    );
    assert.equal(third.suppressed, 3, "and all three are still counted");
  } finally {
    cleanup();
  }
});

test("gc keeps cap-suppression evidence far longer than the daily counters", () => {
  const { store, cleanup } = freshStore();
  try {
    drive(store, 26, { cap: 25 });
    const r = store.gc(); // default: counters 2d, suppressions 30d
    assert.equal(r.suppressionsDeleted, 0, "today's suppression evidence is never GC'd");
    assert.equal(store.countSuppressedToday("acme"), 1);
  } finally {
    cleanup();
  }
});
