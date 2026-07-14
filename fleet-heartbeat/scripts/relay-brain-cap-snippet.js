// === Relay Brain — DAILY CAP SUPPRESSES, IT DOES NOT ANNOUNCE (FIX-RESCUE-13) =
//
// THE DEFECT THIS REPLACES
// -----------------------
// The cap branch computed `{ status: 'cap_exceeded', cap: 25, used: 25 }` and
// then STILL set `_post: true`, emitting
//
//     "Daily Rescue Rangers cap reached (25/25). Escalating to a human."
//
// once PER TASK, with the ticket id literally "(cap)". A sweep re-running every
// 10 minutes over a backlog of blocked tasks therefore paged a human hundreds of
// times an hour — the brake had become the amplifier. A cap that announces
// itself per task is not a cap; it is the flood with extra words.
//
// THE CONTRACT
// ------------
//   under the cap        -> post: true   (mint + page as before — NEVER silenced)
//   first past the cap   -> post: true   ONE consolidated notice, per client/day
//   every one after that -> post: false  counted durably, never sent
//
// NEVER-SILENCE INVARIANTS
//   • Under the cap nothing is suppressed. A genuinely-stuck task still pages.
//   • Suppressed events are COUNTED (store.capSuppressions[dayKey].count) — the
//     signal is quieted, never lost. `rescueCapSummary()` renders it, and the
//     durable store surfaces it in `readView().capSuppressed` / rescue-report.
//   • FAIL-OPEN: any missing/hostile store shape returns post:true. A broken cap
//     must let the page through, never swallow it.
//   • Open tickets are untouched. This gate only decides whether to MINT+POST a
//     NEW one. Nothing is ever deleted.
//
// WHERE THIS GOES
// ---------------
// Paste near the TOP of the n8n "Relay Brain" Code node (with the FIX-RESCUE-07
// GC + FIX-RESCUE-08 dedup snippets), then REPLACE the old cap branch:
//
//     const store = $getWorkflowStaticData('global');
//     if (!store.tickets)  store.tickets  = {};
//     if (!store.counters) store.counters = {};
//     if (!store.seq)      store.seq      = 0;
//     rescueBrainGc(store);
//
//     const dd = rescueDedupBeforeMint(store, { client, failureClass, ticketId, problem });
//     if (dd.status === 'deduped') return [{ json: { status: 'deduped', ticketId: dd.ticketId, _post: false } }];
//
//     // >>> the cap. Was: `{ status:'cap_exceeded', _post: true }` PER TASK. <<<
//     const cg = rescueCapGate(store, { client, dayKey, cap: 25, problem });
//     if (cg.suppress) {
//       return [{ json: {
//         status: 'cap_suppressed',
//         _post: cg.notice,                                   // exactly once/day
//         message: cg.notice ? rescueCapSummary(cg) : null,   // consolidated
//         suppressedToday: cg.suppressed, used: cg.used, cap: cg.cap,
//       } }];
//     }
//     // else: existing mint path (rescueStampDedupKey + store.counters[dayKey]++).
//
// Mirrors `TicketStore.capGate()` in lib/rescue-ticket-store.mjs so the in-n8n
// path and the SQLite path make the SAME decision during the migration window.
//
// This file is client-name-free: client / dayKey / problem are runtime inputs.
// ---------------------------------------------------------------------------

// A cap of 0 / negative / non-finite means NO CAP — fail-open, always post.
function rescueCapEnabled(cap) {
  return Number.isFinite(cap) && cap > 0;
}

// Mirrors dayKey() in lib/rescue-ticket-store.mjs: `client|YYYY-MM-DD`.
function rescueDayKey(client, now) {
  const iso = new Date(now == null ? Date.now() : now).toISOString();
  return String(client == null || client === '' ? 'unknown' : client) + '|' + iso.slice(0, 10);
}

// The single consolidated line a human is allowed to receive about the cap.
// Carries the running suppressed count, so the one notice still answers
// "how much am I NOT being paged about?".
function rescueCapSummary(gate) {
  const g = gate || {};
  return (
    'Daily escalation cap reached (' + g.used + '/' + g.cap + '). Further escalations today are ' +
    'RECORDED and SUPPRESSED — no further per-task pages. Suppressed so far: ' + (g.suppressed || 0) + '. ' +
    'Open tickets are unaffected and still reach a human.'
  );
}

// THE GATE. Returns:
//   { suppress:false, notice:false, ... }  under the cap  -> mint + post as usual
//   { suppress:true,  notice:true,  ... }  FIRST past cap -> ONE consolidated post
//   { suppress:true,  notice:false, ... }  past the cap   -> counted, SILENT
function rescueCapGate(store, opts) {
  const o = opts || {};
  const cap = o.cap == null ? 25 : Number(o.cap);
  const now = o.now || Date.now();
  const client = o.client;
  const dayKey = o.dayKey || rescueDayKey(client, now);
  const problem = o.problem || '';

  // FAIL-OPEN: no usable store shape => never suppress, never go quiet.
  if (!store || typeof store !== 'object') {
    return { suppress: false, notice: false, used: 0, cap: cap, suppressed: 0 };
  }
  if (!store.counters) store.counters = {};
  if (!store.capSuppressions) store.capSuppressions = {};

  const used = Number(store.counters[dayKey] || 0);
  if (!rescueCapEnabled(cap) || used < cap) {
    return { suppress: false, notice: false, used: used, cap: cap, suppressed: 0 };
  }

  // Past the cap: record the suppression (never drop it) ...
  const at = new Date(now).toISOString();
  let s = store.capSuppressions[dayKey];
  if (!s) {
    s = { count: 0, firstAt: at, lastAt: at, lastProblem: null, notifiedAt: null };
    store.capSuppressions[dayKey] = s;
  }
  s.count = Number(s.count || 0) + 1;
  s.lastAt = at;
  s.lastProblem = problem ? String(problem).slice(0, 500) : null;

  // ... and post EXACTLY ONCE. `notifiedAt` is the latch: stamped the first time
  // the cap is crossed today, checked on every call after. This one boolean is
  // the whole fix — the old branch had `_post: true` unconditionally here.
  const notice = !s.notifiedAt;
  if (notice) s.notifiedAt = at;

  // Prune cap-suppression rows older than 2 days so the static-data store cannot
  // grow without bound (mirrors the counter TTL in the GC snippet). Today's row
  // is never pruned.
  const cutoffDay = new Date(now - 2 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(store.capSuppressions)) {
    const day = String(k).split('|')[1];
    if (day && day < cutoffDay) delete store.capSuppressions[k];
  }

  return { suppress: true, notice: notice, used: used, cap: cap, suppressed: s.count };
}

// Exported for the unit test; harmless inside the n8n Code node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { rescueCapGate, rescueCapSummary, rescueCapEnabled, rescueDayKey };
}
