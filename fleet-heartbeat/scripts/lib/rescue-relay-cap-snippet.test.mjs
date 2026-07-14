// Tests for the n8n Relay Brain cap snippet (FIX-RESCUE-13):
//   - relay-brain-cap-snippet.js  (the cap SUPPRESSES; it does not announce)
// Run: node --test fleet-heartbeat/scripts/lib/rescue-relay-cap-snippet.test.mjs
//
// This is the surface that actually flooded: the relay's cap branch returned
// `_post: true` for EVERY task past the cap. The suite below drives the snippet
// exactly the way the Code node does and proves the flood is gone — while the
// escalation path itself stays open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, DEFAULT_DAILY_CAP } from "./rescue-ticket-store.mjs";

const require = createRequire(import.meta.url);
const cap = require("../relay-brain-cap-snippet.js");

// The in-n8n static-data store shape.
function freshRelayStore() {
  return { tickets: {}, counters: {}, capSuppressions: {}, seq: 0 };
}

// Model the Relay Brain's mint loop: increment the day counter on a mint, and
// collect everything the node would POST.
function driveRelay(store, n, { capPerDay = 25, client = "acme", now = Date.now() } = {}) {
  const dayKey = cap.rescueDayKey(client, now);
  const posted = [];
  const decisions = [];
  for (let i = 1; i <= n; i++) {
    const g = cap.rescueCapGate(store, { client, dayKey, cap: capPerDay, now, problem: `problem ${i}` });
    decisions.push(g);
    if (g.suppress) {
      // The cap branch. PRE-FIX this returned `_post: true` unconditionally.
      if (g.notice) posted.push({ kind: "cap_summary", message: cap.rescueCapSummary(g) });
      continue; // suppressed: counted, not minted, not sent
    }
    store.counters[dayKey] = Number(store.counters[dayKey] || 0) + 1;
    store.tickets[`t-${i}`] = { status: "open", createdAt: new Date(now).toISOString() };
    posted.push({ kind: "ticket", message: `ticket t-${i}` });
  }
  return { posted, decisions, dayKey };
}

test("REGRESSION: past the cap the relay posts NOTHING per task — one consolidated notice, then silence", () => {
  const store = freshRelayStore();
  const { posted, decisions, dayKey } = driveRelay(store, 30, { capPerDay: 25 });

  const capPosts = posted.filter((p) => p.kind === "cap_summary");
  assert.equal(capPosts.length, 1, "EXACTLY ONE consolidated notice — not one per task");
  assert.equal(posted.length, 26, "25 ticket posts + 1 notice (pre-fix: 30 posts, 5 of them '(cap)')");

  const suppressed = decisions.filter((d) => d.suppress);
  assert.equal(suppressed.length, 5);
  assert.equal(
    suppressed.filter((d) => d.notice).length,
    1,
    "only the FIRST crossing may speak; the rest are silent",
  );

  // Suppression is not amnesia — the store still knows exactly what it swallowed.
  assert.equal(store.capSuppressions[dayKey].count, 5, "all 5 suppressed events remain counted");
  assert.ok(store.capSuppressions[dayKey].notifiedAt, "the one notice is latched");
  assert.equal(store.counters[dayKey], 25, "the counter stops AT the cap");
  assert.match(capPosts[0].message, /Suppressed so far: 1/);
});

test("NEVER SILENCE: under the cap every escalation posts", () => {
  const store = freshRelayStore();
  const { posted, decisions } = driveRelay(store, 25, { capPerDay: 25 });
  assert.equal(posted.length, 25);
  assert.ok(decisions.every((d) => d.suppress === false), "nothing below the cap is ever suppressed");
});

test("NEVER SILENCE: fail-open on a missing/hostile store, and on a disabled cap", () => {
  for (const bad of [null, undefined, 0, "nope"]) {
    const g = cap.rescueCapGate(bad, { client: "acme", cap: 25 });
    assert.equal(g.suppress, false, "a broken store must let the page through");
  }
  const store = freshRelayStore();
  const { posted } = driveRelay(store, 30, { capPerDay: 0 });
  assert.equal(posted.length, 30, "cap<=0 means NO cap");
  assert.equal(cap.rescueCapEnabled(0), false);
  assert.equal(cap.rescueCapEnabled(-1), false);
  assert.equal(cap.rescueCapEnabled(NaN), false);
  assert.equal(cap.rescueCapEnabled(25), true);
});

test("the relay snippet and the durable store make the SAME cap decision", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-cap-mirror-"));
  const durable = openStore(join(dir, "t.sqlite"));
  const relay = freshRelayStore();
  try {
    const capPerDay = 5;
    const now = Date.now();
    const dayKey = cap.rescueDayKey("acme", now);

    const relayPost = [];
    const storePost = [];
    for (let i = 1; i <= 8; i++) {
      const g = cap.rescueCapGate(relay, { client: "acme", dayKey, cap: capPerDay, now });
      if (!g.suppress) relay.counters[dayKey] = Number(relay.counters[dayKey] || 0) + 1;
      relayPost.push(g.suppress ? (g.notice ? "notice" : "silent") : "post");

      const r = durable.mintOrRecur({
        ticketId: `t-${i}`,
        client: "acme",
        failureClass: `agent-error-${i}`,
        capPerDay,
      });
      storePost.push(r.status === "cap_suppressed" ? (r.post ? "notice" : "silent") : "post");
    }
    assert.deepEqual(relayPost, storePost, "byte-for-byte the same post/suppress sequence");
    assert.deepEqual(relayPost, ["post", "post", "post", "post", "post", "notice", "silent", "silent"]);
    assert.equal(DEFAULT_DAILY_CAP, 25, "one shared default cap constant");
  } finally {
    durable.close_();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dayKey mirrors the durable store's client|YYYY-MM-DD shape", () => {
  const now = Date.parse("2026-07-14T18:30:00.000Z");
  assert.equal(cap.rescueDayKey("acme", now), "acme|2026-07-14");
  assert.equal(cap.rescueDayKey("", now), "unknown|2026-07-14");
});

test("old cap-suppression rows are pruned, today's is kept", () => {
  const store = freshRelayStore();
  const now = Date.now();
  store.capSuppressions["acme|2020-01-01"] = { count: 99, notifiedAt: "x" };
  driveRelay(store, 26, { capPerDay: 25, now });
  assert.equal(store.capSuppressions["acme|2020-01-01"], undefined, "stale day pruned");
  assert.equal(store.capSuppressions[cap.rescueDayKey("acme", now)].count, 1, "today's evidence kept");
});
