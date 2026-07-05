// === Rescue Receiver <-> Durable Store HOOK (FIX-RESCUE-07) =================
//
// A THIN, FAIL-OPEN bridge the receiver calls to persist ticket lifecycle into
// the durable store. The receiver already emits `decisionMode` + `status` on
// every post (postAnswerBack) and knows the inbound `ticketId`, `client`,
// `agent`, and `message` — this hook turns those side-effects into durable
// tickets + audit events WITHOUT ever being able to break the answer path.
//
// DESIGN RULES
//   1. FAIL-OPEN: every call is wrapped so a store error only logs and returns
//      false. The receiver's Telegram answer must never be blocked by an audit
//      write. (Enforcement of SLA/escalation lives in the store's own sweep and
//      in the relay; this hook is the durable ledger, not the critical path.)
//   2. LAZY: the store module is imported on first use, so a receiver running on
//      a Node build without node:sqlite still serves tickets (it just skips the
//      durable ledger and logs once).
//   3. IDEMPOTENT: createTicket is idempotent on ticketId, so n8n retries and
//      the receiver's own multi-post flow never double-mint or double-count.
//
// WIRING (in rescue-receiver.mjs) — two touch points, both optional/best-effort:
//   import * as store from "./lib/rescue-receiver-store-hook.mjs";
//   // when a ticket is accepted (async escalate branch), after send(res,202,...):
//   store.recordInbound({ ticketId, client: returnExtras.client,
//     agent: returnExtras.agent, message, failureClass: fixMode.mode,
//     source: parsed.source || "pathA" });
//   // inside postAnswerBack(), right after the relay POST resolves:
//   store.recordAnswerEvent({ ticketId, answer, decisionMode: merged.decisionMode,
//     status: merged.status, statusPrefix: merged.statusPrefix });
//
// This file is client-name-free.
// ---------------------------------------------------------------------------

let _store = null;
let _disabled = false;
let _warned = false;

function log(msg) {
  try {
    process.stderr.write(`[rr-store-hook] ${msg}\n`);
  } catch (_) {
    /* ignore */
  }
}

// Test-only: drop the cached connection so a fresh openStore() (e.g. a new
// RESCUE_TICKET_DB) is used on the next call. Never called in production — the
// long-lived receiver process keeps one connection for its lifetime.
export function __resetStoreForTest() {
  try {
    if (_store) _store.close_();
  } catch (_) {
    /* ignore */
  }
  _store = null;
  _disabled = false;
  _warned = false;
}

async function getStore() {
  if (_disabled) return null;
  if (_store) return _store;
  try {
    const mod = await import("./rescue-ticket-store.mjs");
    _store = mod.openStore();
    return _store;
  } catch (err) {
    _disabled = true; // never retry-thrash on a broken runtime
    if (!_warned) {
      _warned = true;
      log(`durable store unavailable, continuing without ledger: ${err && err.message ? err.message : err}`);
    }
    return null;
  }
}

// Ensure a ticket row exists for an inbound escalation. Best-effort.
export async function recordInbound({ ticketId, client, agent, message, failureClass, box, boxType, person, source = "pathA", decisionMode } = {}) {
  if (!ticketId) return false;
  const s = await getStore();
  if (!s) return false;
  try {
    s.createTicket({
      ticketId,
      client: client || null,
      agent: agent || null,
      person: person || null,
      box: box || null,
      boxType: boxType || null,
      failureClass: failureClass || null,
      problem: (message || "").slice(0, 4000),
      source,
      decisionMode: decisionMode || null,
    });
    return true;
  } catch (err) {
    log(`recordInbound(${ticketId}) failed: ${err.message}`);
    return false;
  }
}

// Map the receiver's (status, decisionMode) onto a durable transition + answer.
// Best-effort; illegal/duplicate transitions are swallowed (already-terminal
// tickets simply record an answer note).
export async function recordAnswerEvent({ ticketId, answer, decisionMode, status, statusPrefix } = {}) {
  if (!ticketId) return false;
  const s = await getStore();
  if (!s) return false;
  try {
    // If the receiver never minted this ticket (sync/probe path), create a
    // minimal row so the event has somewhere to land.
    if (!s.getTicket(ticketId)) {
      s.createTicket({ ticketId, failureClass: null, source: "pathA", countTowardCap: false });
    }

    const dm = String(decisionMode || "").toUpperCase();
    const st = String(status || "").toUpperCase();
    const prefix = String(statusPrefix || "").toLowerCase();

    // Decide the terminal-ish target from the receiver's own contract fields.
    let resolved = false;
    let target = null;
    if (dm === "HUMAN_NEEDED") target = "ESCALATED";
    else if (st === "RESOLVED" || prefix.startsWith("fixed") || prefix.startsWith("do this")) resolved = true;
    else if (st === "IN_PROGRESS" || dm === "WE_ARE_FIXING") target = "IN_PROGRESS";

    if (target === "ESCALATED") {
      try {
        s.escalate(ticketId, { actor: "operator", decisionMode: dm, note: "receiver escalated to human" });
      } catch (_) {
        s.answer(ticketId, { answer: (answer || "").slice(0, 4000), decisionMode: dm, resolved: false });
      }
    } else {
      s.answer(ticketId, { answer: (answer || "").slice(0, 4000), decisionMode: dm || null, resolved });
      // answer() only advances to IN_PROGRESS/RESOLVED; if the receiver reported
      // a bare IN_PROGRESS that answer() could not apply (already past it), that
      // is fine — the audit note is still written.
      void target;
    }
    return true;
  } catch (err) {
    log(`recordAnswerEvent(${ticketId}) failed: ${err.message}`);
    return false;
  }
}

// Explicit close hook (e.g. client-resolution-signal path). Best-effort.
export async function recordClose({ ticketId, actor = "client", note = "closed by resolution signal" } = {}) {
  if (!ticketId) return false;
  const s = await getStore();
  if (!s) return false;
  try {
    const t = s.getTicket(ticketId);
    if (!t) return false;
    if (t.status !== "RESOLVED" && t.status !== "CLOSED") {
      // Resolve first if we can, then close.
      const allowed = (await import("./rescue-ticket-store.mjs")).LEGAL_TRANSITIONS[t.status] || [];
      if (allowed.includes("RESOLVED")) s.transition(ticketId, "RESOLVED", { actor, note });
    }
    const cur = s.getTicket(ticketId);
    const allowedNow = (await import("./rescue-ticket-store.mjs")).LEGAL_TRANSITIONS[cur.status] || [];
    if (allowedNow.includes("CLOSED")) s.close(ticketId, { actor, note });
    return true;
  } catch (err) {
    log(`recordClose(${ticketId}) failed: ${err.message}`);
    return false;
  }
}
