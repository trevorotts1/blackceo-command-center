// === Relay Brain — INTERIM GC PASS (FIX-RESCUE-07) =========================
//
// Paste this block near the TOP of the n8n "Relay Brain" Code node, immediately
// AFTER the store is obtained and its shape is ensured:
//
//     const store = $getWorkflowStaticData('global');
//     if (!store.tickets)  store.tickets  = {};
//     if (!store.counters) store.counters = {};
//     if (!store.seq)      store.seq      = 0;
//     rescueBrainGc(store);            // <-- add this line
//
// WHY: until the durable SQLite store (lib/rescue-ticket-store.mjs) fully takes
// over, the in-workflow static-data store still accumulates every ticket and
// every daily counter forever. This pass runs on every invocation and prunes:
//   - closed_resolved tickets older than TICKET_TTL_DAYS
//   - answered/closed tickets with no activity older than TICKET_TTL_DAYS
//   - daily counters for days older than COUNTER_TTL_DAYS
// It is intentionally conservative: OPEN / pending / in-progress tickets are
// NEVER pruned, so nothing that still needs a human is dropped. It is a pure
// function of the store object and mutates it in place; it is safe to run on
// every relay invocation (idempotent once nothing is stale).
//
// This is client-name-free: it only reads timestamps and status fields.
// ---------------------------------------------------------------------------

function rescueBrainGc(store, opts) {
  const o = opts || {};
  const TICKET_TTL_DAYS = o.ticketTtlDays || 30;
  const COUNTER_TTL_DAYS = o.counterTtlDays || 2;
  const now = o.now || Date.now();

  const ticketCutoff = now - TICKET_TTL_DAYS * 86400000;
  const counterCutoffDay = new Date(now - COUNTER_TTL_DAYS * 86400000)
    .toISOString()
    .slice(0, 10);

  // Terminal states that are safe to prune once old enough. OPEN / pending /
  // answered-in-progress are preserved.
  const PRUNABLE = new Set(["closed_resolved", "closed", "resolved"]);

  let tickets = 0;
  let counters = 0;

  if (store.tickets && typeof store.tickets === "object") {
    for (const id of Object.keys(store.tickets)) {
      const t = store.tickets[id];
      if (!t || !PRUNABLE.has(String(t.status))) continue;
      const stamp = t.resolvedAt || t.answeredAt || t.createdAt;
      const ts = stamp ? Date.parse(stamp) : NaN;
      // Prune only when we can prove it is old; if the timestamp is unparseable,
      // keep the ticket (fail safe, never drop an unknown-age record).
      if (Number.isFinite(ts) && ts < ticketCutoff) {
        delete store.tickets[id];
        tickets++;
      }
    }
  }

  if (store.counters && typeof store.counters === "object") {
    for (const key of Object.keys(store.counters)) {
      const day = String(key).split("|")[1] || "";
      if (day && day < counterCutoffDay) {
        delete store.counters[key];
        counters++;
      }
    }
  }

  return { ticketsPruned: tickets, countersPruned: counters };
}

// Export for local unit testing (n8n ignores module.exports in a Code node).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { rescueBrainGc };
}
