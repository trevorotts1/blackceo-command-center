// Integration tests for the Relay Brain interim GC snippet and the receiver
// store hook (FIX-RESCUE-07).
// Run: node --test fleet-heartbeat/scripts/lib/rescue-integration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { openStore } from "./rescue-ticket-store.mjs";
import * as hook from "./rescue-receiver-store-hook.mjs";

const require = createRequire(import.meta.url);
const scriptsDir = dirname(dirname(fileURLToPath(import.meta.url))); // .../scripts
const { rescueBrainGc } = require(join(scriptsDir, "relay-brain-gc-snippet.js"));

test("relay brain interim GC prunes old terminal tickets + stale counters, keeps the rest", () => {
  const now = Date.now();
  const old = new Date(now - 40 * 86400000).toISOString();
  const recent = new Date(now - 1 * 86400000).toISOString();
  const store = {
    tickets: {
      keep_open: { status: "pending", createdAt: old },
      keep_inprogress: { status: "answered", createdAt: old },
      keep_recent: { status: "closed_resolved", resolvedAt: recent },
      prune_old: { status: "closed_resolved", resolvedAt: old },
      prune_old2: { status: "closed", answeredAt: old },
      bad_stamp: { status: "closed_resolved", resolvedAt: "not-a-date" },
    },
    counters: { "acme|2020-01-01": 5, ["acme|" + new Date(now).toISOString().slice(0, 10)]: 3 },
    seq: 9,
  };
  const res = rescueBrainGc(store, { now });
  assert.equal(res.ticketsPruned, 2);
  assert.equal(res.countersPruned, 1);
  // open / in-progress / recent / unparseable-age all survive (fail safe)
  assert.ok(store.tickets.keep_open && store.tickets.keep_inprogress);
  assert.ok(store.tickets.keep_recent && store.tickets.bad_stamp);
  assert.ok(!store.tickets.prune_old && !store.tickets.prune_old2);
  assert.equal(store.seq, 9, "seq counter untouched");
});

test("receiver hook drives the full lifecycle and is idempotent on retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-hook-"));
  const dbPath = join(dir, "hook.sqlite");
  process.env.RESCUE_TICKET_DB = dbPath;
  try {
    hook.__resetStoreForTest();
    const tid = "hook-1";
    assert.equal(await hook.recordInbound({ ticketId: tid, client: "acme", agent: "main", message: "gateway down", failureClass: "gateway-down", source: "pathA" }), true);
    // retry must not double-mint / double-count
    assert.equal(await hook.recordInbound({ ticketId: tid, client: "acme", failureClass: "gateway-down" }), true);
    assert.equal(await hook.recordAnswerEvent({ ticketId: tid, answer: "diagnosing", decisionMode: "WE_ARE_FIXING", status: "IN_PROGRESS" }), true);
    assert.equal(await hook.recordAnswerEvent({ ticketId: tid, answer: "fixed", decisionMode: "WE_SOLVED_IT", status: "RESOLVED", statusPrefix: "fixed:" }), true);
    assert.equal(await hook.recordClose({ ticketId: tid }), true);

    assert.equal(await hook.recordInbound({ ticketId: "hook-2", client: "acme", failureClass: "credential-leak", source: "pathB" }), true);
    assert.equal(await hook.recordAnswerEvent({ ticketId: "hook-2", answer: "human", decisionMode: "HUMAN_NEEDED", status: "IN_PROGRESS" }), true);

    const s = openStore(dbPath);
    const t1 = s.getTicket("hook-1");
    const t2 = s.getTicket("hook-2");
    assert.equal(t1.status, "CLOSED");
    assert.deepEqual(s.events("hook-1").map((e) => e.to_status), ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
    assert.equal(t2.status, "ESCALATED");
    assert.equal(t2.owner, "operator");
    assert.equal(t2.severity, "SEV1");
    assert.equal(s.countToday("acme"), 2, "retry did not inflate the daily cap");
    s.close_();
  } finally {
    delete process.env.RESCUE_TICKET_DB;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("receiver hook records an event even for an un-minted (sync/probe) ticket without counting cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-hook2-"));
  const dbPath = join(dir, "hook.sqlite");
  process.env.RESCUE_TICKET_DB = dbPath;
  try {
    hook.__resetStoreForTest();
    assert.equal(await hook.recordAnswerEvent({ ticketId: "probe-1", answer: "ok", decisionMode: "JUST_AN_ANSWER", status: "RESOLVED" }), true);
    const s = openStore(dbPath);
    const t = s.getTicket("probe-1");
    assert.ok(t, "auto-created a row for the un-minted ticket");
    assert.equal(t.status, "RESOLVED");
    assert.equal(s.countToday(t.client), 0, "probe path did not consume cap");
    s.close_();
  } finally {
    delete process.env.RESCUE_TICKET_DB;
    rmSync(dir, { recursive: true, force: true });
  }
});
