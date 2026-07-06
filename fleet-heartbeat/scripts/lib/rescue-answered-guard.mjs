// === Rescue Rangers — CROSS-RESTART ANSWER GUARD (FIX-RESCUE-11 i) ==========
//
// The receiver deduped already-answered tickets with a PROCESS-LOCAL Set
// (`_answeredTickets`). That Set is empty after every restart — and the
// receiver was crash-looping (FIX-RESCUE-01), so the same ticket could be
// answered twice (double Telegram post) across restarts.
//
// This guard makes "already answered?" DURABLE:
//   1. PRIMARY  — consult the durable ticket store: a ticket whose `answer` is
//      set, or whose status is past active handling (RESOLVED/CLOSED/ESCALATED/
//      NEEDS_HUMAN), has already been acted on — skip re-answering.
//   2. FALLBACK — when the durable store is unavailable (older Node without
//      node:sqlite, or a store error), fall back to a small on-disk JSON set of
//      claimed ticket ids under the git-ignored state dir, self-pruned to a
//      retention window so it can never grow unbounded.
//
// FAIL-OPEN on the guard itself: if BOTH the store and the disk set error, the
// functions default to "not answered" — the receiver's job is to answer, so an
// unknowable state must never silently swallow a real answer; the durable store
// remains the authority once healthy.
//
// CLIENT-NAME-FREE: only opaque ticket ids flow through here. The disk set
// lives in the state dir (git-ignored) alongside the ticket DB.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Statuses that mean the ticket has already been handled — re-answering would
// double-post. (OPEN / ACK are still awaiting a first answer.)
const HANDLED_STATES = new Set(["IN_PROGRESS", "RESOLVED", "CLOSED", "ESCALATED", "NEEDS_HUMAN"]);

const DISK_TTL_MS = 7 * 24 * 60 * 60 * 1000; // prune claimed ids after 7 days

let _store = null;
let _storeDisabled = false;

function log(msg) {
  try {
    process.stderr.write(`[rr-answered-guard] ${msg}\n`);
  } catch (_) {
    /* ignore */
  }
}

export function __resetForTest() {
  try {
    if (_store) _store.close_();
  } catch (_) {
    /* ignore */
  }
  _store = null;
  _storeDisabled = false;
}

async function getStore() {
  if (_storeDisabled) return null;
  if (_store) return _store;
  try {
    const mod = await import("./rescue-ticket-store.mjs");
    _store = mod.openStore();
    return _store;
  } catch (err) {
    _storeDisabled = true;
    log(`durable store unavailable, using disk fallback: ${err && err.message ? err.message : err}`);
    return null;
  }
}

function diskPath() {
  return (
    process.env.RESCUE_ANSWERED_DB ||
    new URL("../../state/rescue-answered-tickets.json", import.meta.url).pathname
  );
}

function readDisk() {
  try {
    const raw = readFileSync(diskPath(), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (_) {
    return {}; // missing/corrupt => empty set
  }
}

function writeDisk(map, now = Date.now()) {
  // Prune expired entries so the file stays bounded.
  const pruned = {};
  for (const [id, ts] of Object.entries(map)) {
    if (Number.isFinite(Date.parse(ts)) && Date.parse(ts) >= now - DISK_TTL_MS) pruned[id] = ts;
  }
  try {
    mkdirSync(dirname(diskPath()), { recursive: true });
    writeFileSync(diskPath(), JSON.stringify(pruned), "utf8");
  } catch (err) {
    log(`disk write failed: ${err && err.message ? err.message : err}`);
  }
  return pruned;
}

// True if this ticket has already been answered/handled (durably).
export async function wasAnswered(ticketId) {
  if (!ticketId) return false;
  const s = await getStore();
  if (s) {
    try {
      const t = s.getTicket(ticketId);
      if (t) {
        if (t.answer != null && String(t.answer).length > 0) return true;
        if (HANDLED_STATES.has(String(t.status || "").toUpperCase())) return true;
        return false;
      }
      // Not in the durable store yet — fall through to the disk set (covers the
      // window before the best-effort store hook has persisted the ticket).
    } catch (err) {
      log(`store check failed for ${ticketId}, using disk: ${err.message}`);
    }
  }
  return Object.prototype.hasOwnProperty.call(readDisk(), ticketId);
}

// Record that this ticket has been answered. Writes the disk fallback set
// (durable store answer state is written by the store hook on the answer path;
// this guarantees dedup even if the store is unavailable).
export async function markAnswered(ticketId, now = Date.now()) {
  if (!ticketId) return false;
  const map = readDisk();
  map[ticketId] = new Date(now).toISOString();
  writeDisk(map, now);
  return true;
}

// Atomic-ish claim: returns true if THIS call is the first to claim the ticket
// (caller should answer), false if it was already answered/handled (skip). The
// mark is written immediately so a rapid double-delivery in the same process
// also dedups.
export async function claimAnswer(ticketId) {
  if (!ticketId) return true; // no id to dedup on — let the answer proceed
  if (await wasAnswered(ticketId)) return false;
  await markAnswered(ticketId);
  return true;
}
