// Tests for the n8n Relay Brain snippets:
//   - relay-brain-dedup-snippet.js   (FIX-RESCUE-08 semantic dedup before mint)
//   - relay-auth-constant-time-snippet.js (FIX-RESCUE-11 ii constant-time auth)
// Run: node --test fleet-heartbeat/scripts/lib/rescue-relay-snippets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dedup = require("../relay-brain-dedup-snippet.js");
const auth = require("../relay-auth-constant-time-snippet.js");
// Cross-check the snippet key against the durable store's key (must be identical
// so a ticket minted on either path dedups against the other).
import { dedupKey as storeDedupKey } from "./rescue-ticket-store.mjs";

test("relay dedup key is byte-identical to the durable store key", () => {
  assert.equal(dedup.rescueDedupKey("Acme Co", "Gateway-Down"), storeDedupKey("Acme Co", "Gateway-Down"));
  assert.equal(dedup.rescueDedupKey(" acme ", "cron"), dedup.rescueDedupKey("ACME", "CRON"), "normalized (trim + lowercase)");
});

test("rescueDedupBeforeMint: empty store => mint", () => {
  const store = { tickets: {}, counters: {} };
  const d = dedup.rescueDedupBeforeMint(store, { client: "acme", failureClass: "cron", ticketId: "acme-cron-2026-07-05" });
  assert.equal(d.status, "mint");
});

test("rescueDedupBeforeMint: exact ticketId present => exists (no dedup vs other)", () => {
  const store = { tickets: { "acme-cron-2026-07-05": { status: "open" } }, counters: {} };
  const d = dedup.rescueDedupBeforeMint(store, { client: "acme", failureClass: "cron", ticketId: "acme-cron-2026-07-05" });
  assert.equal(d.status, "exists");
  assert.equal(d.ticketId, "acme-cron-2026-07-05");
});

test("rescueDedupBeforeMint: open sibling within window => deduped, recurred event appended", () => {
  const now = Date.parse("2026-07-05T12:00:00.000Z");
  const existing = {
    status: "open",
    createdAt: "2026-07-05T09:00:00.000Z", // 3h ago, inside 6h window
    dedupKey: dedup.rescueDedupKey("acme", "gateway-down"),
  };
  const store = { tickets: { "acme-gateway-down-2026-07-05": existing }, counters: {} };
  const d = dedup.rescueDedupBeforeMint(store, {
    client: "acme", failureClass: "gateway-down",
    ticketId: "acme-gateway-down-DIFFERENT", problem: "still down", now,
  });
  assert.equal(d.status, "deduped");
  assert.equal(d.ticketId, "acme-gateway-down-2026-07-05");
  assert.equal(existing.recurCount, 1);
  assert.equal(existing.events.length, 1);
  assert.equal(existing.events[0].type, "recurred");
  assert.equal(Object.keys(store.tickets).length, 1, "no duplicate minted");
});

test("rescueDedupBeforeMint: terminal or out-of-window sibling => mint (not deduped)", () => {
  const now = Date.parse("2026-07-05T12:00:00.000Z");
  const key = dedup.rescueDedupKey("acme", "gateway-down");
  // resolved sibling
  let store = { tickets: { a: { status: "closed_resolved", createdAt: "2026-07-05T11:00:00.000Z", dedupKey: key } }, counters: {} };
  assert.equal(dedup.rescueDedupBeforeMint(store, { client: "acme", failureClass: "gateway-down", ticketId: "b", now }).status, "mint");
  // stale open sibling (7h ago, window 6h)
  store = { tickets: { a: { status: "open", createdAt: "2026-07-05T05:00:00.000Z", dedupKey: key } }, counters: {} };
  assert.equal(dedup.rescueDedupBeforeMint(store, { client: "acme", failureClass: "gateway-down", ticketId: "b", now }).status, "mint");
});

test("rescueStampDedupKey stamps once and is idempotent", () => {
  const t = {};
  dedup.rescueStampDedupKey(t, "acme", "cron");
  assert.equal(t.dedupKey, dedup.rescueDedupKey("acme", "cron"));
  const prev = t.dedupKey;
  dedup.rescueStampDedupKey(t, "other", "other");
  assert.equal(t.dedupKey, prev, "does not overwrite an existing key");
});

test("relay auth: constant-time compare + fail-closed gate", () => {
  assert.equal(auth.rescueConstantTimeEqual("secret", "secret"), true);
  assert.equal(auth.rescueConstantTimeEqual("secret", "SECRET"), false);
  assert.equal(auth.rescueAuthOk("secret", "secret"), true);
  assert.equal(auth.rescueAuthOk("secret", ""), false, "no configured secret => deny");
  assert.equal(auth.rescueAuthOk("", "secret"), false, "empty presented => deny");
});
