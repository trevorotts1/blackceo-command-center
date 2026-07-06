// === Relay Brain — SEMANTIC DEDUP BEFORE MINT (FIX-RESCUE-08) ==============
//
// WHERE THIS GOES
// ---------------
// Paste this block near the TOP of the n8n "Relay Brain" Code node, AFTER the
// store shape is ensured (and after the interim GC snippet if present), and use
// `rescueDedupBeforeMint(...)` at the exact point the node is about to mint a
// brand-new ticket + increment the daily cap:
//
//     const store = $getWorkflowStaticData('global');
//     if (!store.tickets)  store.tickets  = {};
//     if (!store.counters) store.counters = {};
//     if (!store.seq)      store.seq      = 0;
//     rescueBrainGc(store);                        // FIX-RESCUE-07 (if wired)
//
//     // ... derive: client, failureClass, ticketId, problem, dayKey ...
//     const dd = rescueDedupBeforeMint(store, { client, failureClass, ticketId, problem });
//     if (dd.status === 'deduped') {
//       // DO NOT mint, DO NOT increment store.counters[dayKey].
//       return [{ json: { status: 'deduped', ticketId: dd.ticketId } }];
//     }
//     // else fall through to the existing mint + cap-increment path.
//
// WHY: the previous dedup only matched an IDENTICAL ticketId, which client
// agents never persist — so a recurring problem minted a fresh ticket every
// time and burned the 25/day cap. This folds a recurrence onto the still-open
// ticket for the same (client + failure_class) inside a 6h window: it appends a
// "recurred" event and returns the EXISTING ticketId WITHOUT incrementing the
// cap. Exact-id repeats (n8n retries) are handled first and are also no-count.
//
// It is a pure function of the passed-in store object + fields; it mutates only
// the matched ticket's event log (never drops or mints tickets itself, and
// never touches counters). Mirrors the durable store's `mintOrRecur()` so the
// in-n8n path and the SQLite path make the SAME decision during migration.
//
// This file is client-name-free: client / failure_class / ticketId are runtime
// inputs; nothing here hardcodes an identifier.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

// Stable 16-hex semantic key — byte-identical to lib/rescue-ticket-store.mjs
// `dedupKey()` so a ticket minted on either path dedups against the other.
function rescueDedupKey(client, failureClass) {
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  return crypto
    .createHash('sha256')
    .update(norm(client) + '|' + norm(failureClass))
    .digest('hex')
    .slice(0, 16);
}

// Decide whether to mint or fold onto an existing ticket. Returns:
//   { status: 'exists',  ticketId }  exact ticketId already present (retry)
//   { status: 'deduped', ticketId }  folded onto an open sibling (NO cap ++)
//   { status: 'mint' }               genuinely new — caller mints + counts cap
function rescueDedupBeforeMint(store, opts) {
  const o = opts || {};
  const ticketId = o.ticketId;
  const client = o.client;
  const failureClass = o.failureClass;
  const problem = o.problem || '';
  const windowMs = o.windowMs || 6 * 60 * 60 * 1000;
  const now = o.now || Date.now();

  if (!store || !store.tickets) return { status: 'mint' };

  // (1) exact-id idempotency first — never dedup against a different ticket,
  // never double-count the cap on an n8n retry.
  if (ticketId && store.tickets[ticketId]) {
    return { status: 'exists', ticketId };
  }

  // (2) semantic dedup: newest still-open ticket with the same key in-window.
  const key = rescueDedupKey(client, failureClass);
  const TERMINAL = new Set(['resolved', 'closed', 'closed_resolved']);
  let best = null;
  let bestTs = -Infinity;
  for (const id of Object.keys(store.tickets)) {
    const t = store.tickets[id];
    if (!t || id === ticketId) continue;
    if (String(t.dedupKey || t.dedup_key) !== key) continue;
    if (TERMINAL.has(String(t.status || '').toLowerCase())) continue;
    const ts = Date.parse(t.createdAt || t.created_at || 0);
    if (!Number.isFinite(ts) || ts < now - windowMs) continue;
    if (ts > bestTs) {
      bestTs = ts;
      best = { id, t };
    }
  }

  if (best) {
    if (!Array.isArray(best.t.events)) best.t.events = [];
    best.t.events.push({
      at: new Date(now).toISOString(),
      type: 'recurred',
      note: 'recurred (would-be ' + (ticketId || 'n/a') + ')' + (problem ? ' — ' + String(problem).slice(0, 200) : ''),
    });
    best.t.updatedAt = new Date(now).toISOString();
    best.t.recurCount = (best.t.recurCount || 0) + 1;
    return { status: 'deduped', ticketId: best.id };
  }

  return { status: 'mint' };
}

// Attach the semantic dedup key to a ticket at mint time so future recurrences
// can find it. Call this in the existing mint block right before storing the
// new ticket object.
function rescueStampDedupKey(ticket, client, failureClass) {
  if (ticket && !ticket.dedupKey) ticket.dedupKey = rescueDedupKey(client, failureClass);
  return ticket;
}

// Exported for the unit test; harmless inside the n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rescueDedupKey, rescueDedupBeforeMint, rescueStampDedupKey };
}
