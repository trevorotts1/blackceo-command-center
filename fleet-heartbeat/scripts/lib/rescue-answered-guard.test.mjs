// Tests for the cross-restart answer guard (FIX-RESCUE-11 i).
// Run: node --test fleet-heartbeat/scripts/lib/rescue-answered-guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point BOTH the durable store and the disk fallback at temp files per test.
function withTempEnv(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rr-answered-"));
  const prevDb = process.env.RESCUE_TICKET_DB;
  const prevAns = process.env.RESCUE_ANSWERED_DB;
  process.env.RESCUE_TICKET_DB = join(dir, "tickets.sqlite");
  process.env.RESCUE_ANSWERED_DB = join(dir, "answered.json");
  return fn(dir).finally(() => {
    if (prevDb === undefined) delete process.env.RESCUE_TICKET_DB;
    else process.env.RESCUE_TICKET_DB = prevDb;
    if (prevAns === undefined) delete process.env.RESCUE_ANSWERED_DB;
    else process.env.RESCUE_ANSWERED_DB = prevAns;
    rmSync(dir, { recursive: true, force: true });
  });
}

test("durable store status is authoritative: an answered ticket is seen as answered", async () => {
  await withTempEnv(async () => {
    const guard = await import("./rescue-answered-guard.mjs?a=" + Math.random());
    const storeMod = await import("./rescue-ticket-store.mjs");
    const s = storeMod.openStore();
    s.createTicket({ ticketId: "t-1", client: "acme", failureClass: "cron" });
    assert.equal(await guard.wasAnswered("t-1"), false, "OPEN ticket is not yet answered");
    s.answer("t-1", { answer: "done", resolved: true });
    s.close_();
    assert.equal(await guard.wasAnswered("t-1"), true, "RESOLVED/answered ticket reads as answered across a fresh guard");
    guard.__resetForTest();
  });
});

test("disk fallback dedups when the ticket is not (yet) in the durable store", async () => {
  await withTempEnv(async () => {
    const guard = await import("./rescue-answered-guard.mjs?b=" + Math.random());
    assert.equal(await guard.wasAnswered("ghost-1"), false);
    assert.equal(await guard.claimAnswer("ghost-1"), true, "first claim wins");
    assert.equal(await guard.claimAnswer("ghost-1"), false, "second claim is blocked (already answered)");
    assert.equal(await guard.wasAnswered("ghost-1"), true);
    guard.__resetForTest();
  });
});

test("claimAnswer with no id lets the answer proceed (nothing to dedup on)", async () => {
  await withTempEnv(async () => {
    const guard = await import("./rescue-answered-guard.mjs?c=" + Math.random());
    assert.equal(await guard.claimAnswer(""), true);
    assert.equal(await guard.claimAnswer(null), true);
    guard.__resetForTest();
  });
});
