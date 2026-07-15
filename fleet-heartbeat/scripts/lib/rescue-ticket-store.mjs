// === Rescue Rangers — DURABLE TICKET STORE (FIX-RESCUE-07) ==================
//
// WHY THIS EXISTS
// ---------------
// The live ticket store used to be n8n workflow static data
// (`$getWorkflowStaticData('global')`). That store is WIPED on every workflow
// re-import (the ~15 dated relay export backups prove constant re-imports),
// was never garbage-collected, and had no durable ids, ownership, severity,
// SLA, audit trail, reopen, or reporting.
//
// This module is the durable replacement: a single SQLite database file that
// lives on the operator box filesystem, OUTSIDE n8n, so re-importing the relay
// workflow can never wipe it. It provides the full schema, monotonic
// human-facing `RR-000123` numbers, a validated state machine with a
// `ticket_events` audit trail, ownership, severity-derived SLAs, a read view,
// and a garbage-collection pass.
//
// BACKEND: node:sqlite (DatabaseSync) — built into Node >= 22.5, zero install,
// no native module. WAL mode keeps concurrent readers (report/sweep scripts)
// safe while the receiver writes. The store FAILS CLOSED: if node:sqlite is
// unavailable the module throws a clear, actionable error rather than silently
// dropping tickets.
//
// NO CLIENT NAMES: client / person / box identifiers are always passed in as
// runtime data. Nothing in this file hardcodes a client, box, or person — it is
// safe for a public repository.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (err) {
  throw new Error(
    "rescue-ticket-store requires node:sqlite (Node >= 22.5). " +
      "Upgrade Node or run with a build that includes the SQLite module. " +
      `underlying: ${err && err.message ? err.message : err}`
  );
}

// --- Default DB location (override with RESCUE_TICKET_DB) -------------------
// Kept under the fleet-heartbeat state dir so it sits with the other durable
// state and survives n8n re-imports. Resolved at CALL time (not module-load)
// so RESCUE_TICKET_DB set after import — or per test — is honored.
export function defaultDbPath() {
  return (
    process.env.RESCUE_TICKET_DB ||
    new URL("../../state/rescue-tickets.sqlite", import.meta.url).pathname
  );
}

// === STATE MACHINE ==========================================================
// OPEN -> ACK -> IN_PROGRESS -> (RESOLVED | ESCALATED | NEEDS_HUMAN) -> CLOSED
// plus REOPENED. Every transition is validated against this map and written to
// the ticket_events audit table. An illegal transition throws — the store never
// silently accepts an impossible lifecycle jump.
export const STATUSES = [
  "OPEN",
  "ACK",
  "IN_PROGRESS",
  "RESOLVED",
  "ESCALATED",
  "NEEDS_HUMAN",
  "CLOSED",
  "REOPENED",
];

export const LEGAL_TRANSITIONS = {
  OPEN: ["ACK", "IN_PROGRESS", "RESOLVED", "ESCALATED", "NEEDS_HUMAN", "CLOSED"],
  ACK: ["IN_PROGRESS", "RESOLVED", "ESCALATED", "NEEDS_HUMAN", "CLOSED"],
  IN_PROGRESS: ["RESOLVED", "ESCALATED", "NEEDS_HUMAN", "CLOSED", "ACK"],
  ESCALATED: ["IN_PROGRESS", "RESOLVED", "NEEDS_HUMAN", "CLOSED"],
  NEEDS_HUMAN: ["IN_PROGRESS", "RESOLVED", "ESCALATED", "CLOSED"],
  RESOLVED: ["CLOSED", "REOPENED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["ACK", "IN_PROGRESS", "RESOLVED", "ESCALATED", "NEEDS_HUMAN", "CLOSED"],
};

// Operationally-open = still needs attention (counts in open-by-severity).
const OPEN_STATUSES = ["OPEN", "ACK", "IN_PROGRESS", "ESCALATED", "NEEDS_HUMAN", "REOPENED"];
// Terminal for SLA purposes (never auto-escalate these).
const SLA_TERMINAL = ["RESOLVED", "CLOSED", "ESCALATED", "NEEDS_HUMAN"];

// === SEVERITY + SLA =========================================================
// Severity is derived from the failure class. Higher severity => tighter SLA.
// SLA window is in MINUTES; sla_due_at = created_at + window.
export const SEVERITY_SLA_MINUTES = { SEV1: 15, SEV2: 60, SEV3: 240, SEV4: 1440 };

// Failure-class -> severity. Matching is substring, case-insensitive, most
// severe wins. Unknown classes default to SEV3 (medium) so nothing is silently
// treated as trivial.
const SEVERITY_RULES = [
  { sev: "SEV1", patterns: ["gateway-down", "gateway_down", "box-down", "box_down", "down", "unreachable", "receiver", "billing", "credential", "secret", "outage", "offline", "crash"] },
  { sev: "SEV2", patterns: ["agent-error", "agent_error", "provider", "cron", "delivery", "timeout", "queue", "error", "fail"] },
  { sev: "SEV4", patterns: ["deliver-answer", "just-an-answer", "info", "question", "how-to", "howto", "test", "synthetic"] },
  { sev: "SEV3", patterns: ["coach", "config", "setup"] },
];

export function severityForClass(failureClass) {
  const s = String(failureClass || "").toLowerCase();
  if (!s) return "SEV3";
  for (const rule of SEVERITY_RULES) {
    for (const p of rule.patterns) {
      if (s.includes(p)) return rule.sev;
    }
  }
  return "SEV3";
}

export function slaDueAt(createdAtISO, severity) {
  const mins = SEVERITY_SLA_MINUTES[severity] || SEVERITY_SLA_MINUTES.SEV3;
  return new Date(new Date(createdAtISO).getTime() + mins * 60_000).toISOString();
}

// === DAILY ESCALATION CAP (FIX-RESCUE-13) ===================================
// The per-client, per-day ceiling on NEW minted escalations. Historically this
// number lived only in the relay's head; it is exported here so the durable
// store, the relay snippet, and the report all read ONE constant.
//
// THE CAP IS A BRAKE, NOT A MEGAPHONE. Past the cap the store SUPPRESSES: it
// mints nothing and — after a single consolidated notice — posts nothing. The
// suppressed events are still COUNTED durably (cap_suppressions) so the signal
// is never lost, only quieted. See `capGate()` for the full contract.
export const DEFAULT_DAILY_CAP = 25;

/** A cap of 0 / negative / non-finite means NO CAP — fail-open, always post. */
function capEnabled(cap) {
  return Number.isFinite(cap) && cap > 0;
}

// === HELPERS ================================================================
export function formatRr(n) {
  return "RR-" + String(n).padStart(6, "0");
}

// Semantic dedup key (supports FIX-RESCUE-08): stable hash of client + class.
export function dedupKey(client, failureClass) {
  return createHash("sha256")
    .update(String(client || "").trim().toLowerCase() + "|" + String(failureClass || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

function dayKey(client, iso) {
  return String(client || "unknown") + "|" + String(iso).slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

// === STORE ==================================================================
export class TicketStore {
  constructor(dbPath = defaultDbPath()) {
    this.path = dbPath;
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
    } catch (_) {
      /* directory may already exist */
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_id         TEXT PRIMARY KEY,
        rr_number         INTEGER UNIQUE,
        client            TEXT,
        box               TEXT,
        box_type          TEXT,
        agent             TEXT,
        person            TEXT,
        failure_class     TEXT,
        severity          TEXT,
        status            TEXT NOT NULL,
        owner             TEXT,
        source            TEXT,
        problem           TEXT,
        answer            TEXT,
        decision_mode     TEXT,
        created_at        TEXT NOT NULL,
        first_response_at TEXT,
        resolved_at       TEXT,
        resolved_by       TEXT,
        sla_due_at        TEXT,
        escalated_at      TEXT,
        dedup_key         TEXT,
        day_count_key     TEXT,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tickets_status   ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_dedup    ON tickets(dedup_key);
      CREATE INDEX IF NOT EXISTS idx_tickets_client   ON tickets(client);
      CREATE INDEX IF NOT EXISTS idx_tickets_sla      ON tickets(sla_due_at);

      CREATE TABLE IF NOT EXISTS ticket_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id     TEXT NOT NULL,
        seq           INTEGER NOT NULL,
        at            TEXT NOT NULL,
        from_status   TEXT,
        to_status     TEXT,
        actor         TEXT,
        decision_mode TEXT,
        note          TEXT,
        FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id);

      CREATE TABLE IF NOT EXISTS counters (
        day_key TEXT PRIMARY KEY,
        count   INTEGER NOT NULL
      );

      -- FIX-RESCUE-13 — the durable record of what the cap SUPPRESSED.
      -- Suppression must never mean amnesia: every escalation the cap swallows
      -- is counted here (with the first/last timestamps and the last problem
      -- text) so a human can always answer "what did we stop paging about?".
      -- notified_at is the single-notice latch: it is stamped exactly ONCE
      -- per client per day, the moment the cap is first crossed, and that one
      -- consolidated notice is the ONLY message the cap branch is ever allowed
      -- to emit. A per-task "cap reached" message is the defect this fixes.
      CREATE TABLE IF NOT EXISTS cap_suppressions (
        day_key      TEXT PRIMARY KEY,
        count        INTEGER NOT NULL,
        first_at     TEXT NOT NULL,
        last_at      TEXT NOT NULL,
        last_problem TEXT,
        notified_at  TEXT
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    // Seed the monotonic RR sequence once.
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('rr_seq', '0')")
      .run();
  }

  // --- monotonic RR number (atomic increment) -------------------------------
  #nextRrNumber() {
    const row = this.db
      .prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rr_seq' RETURNING value")
      .get();
    return Number(row.value);
  }

  #nextEventSeq(ticketId) {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM ticket_events WHERE ticket_id = :t")
      .get({ t: ticketId });
    return Number(row.m) + 1;
  }

  #recordEvent(ticketId, fromStatus, toStatus, { actor, decisionMode, note } = {}) {
    this.db
      .prepare(
        `INSERT INTO ticket_events(ticket_id, seq, at, from_status, to_status, actor, decision_mode, note)
         VALUES (:ticket_id, :seq, :at, :from_status, :to_status, :actor, :decision_mode, :note)`
      )
      .run({
        ticket_id: ticketId,
        seq: this.#nextEventSeq(ticketId),
        at: nowISO(),
        from_status: fromStatus ?? null,
        to_status: toStatus ?? null,
        actor: actor ?? null,
        decision_mode: decisionMode ?? null,
        note: note ?? null,
      });
  }

  getTicket(ticketId) {
    return this.db.prepare("SELECT * FROM tickets WHERE ticket_id = :t").get({ t: ticketId }) || null;
  }

  getByRrNumber(rrNumber) {
    const n = typeof rrNumber === "string" ? Number(String(rrNumber).replace(/[^0-9]/g, "")) : rrNumber;
    return this.db.prepare("SELECT * FROM tickets WHERE rr_number = :n").get({ n }) || null;
  }

  events(ticketId) {
    return this.db
      .prepare("SELECT * FROM ticket_events WHERE ticket_id = :t ORDER BY seq ASC")
      .all({ t: ticketId });
  }

  countToday(client, iso = nowISO()) {
    const row = this.db
      .prepare("SELECT count FROM counters WHERE day_key = :k")
      .get({ k: dayKey(client, iso) });
    return row ? Number(row.count) : 0;
  }

  // --- daily cap: suppression accounting (FIX-RESCUE-13) --------------------

  /** How many escalations the cap has SUPPRESSED for this client today. */
  countSuppressedToday(client, iso = nowISO()) {
    const row = this.db
      .prepare("SELECT count FROM cap_suppressions WHERE day_key = :k")
      .get({ k: dayKey(client, iso) });
    return row ? Number(row.count) : 0;
  }

  /** The consolidated, human-readable state of today's cap for one client. */
  capState(client, { cap = DEFAULT_DAILY_CAP, now = Date.now() } = {}) {
    const iso = new Date(now).toISOString();
    const row =
      this.db.prepare("SELECT * FROM cap_suppressions WHERE day_key = :k").get({ k: dayKey(client, iso) }) || null;
    const used = this.countToday(client, iso);
    return {
      client: client ?? null,
      day: iso.slice(0, 10),
      cap,
      used,
      capReached: capEnabled(cap) && used >= cap,
      suppressed: row ? Number(row.count) : 0,
      notifiedAt: row ? row.notified_at : null,
      firstSuppressedAt: row ? row.first_at : null,
      lastSuppressedAt: row ? row.last_at : null,
    };
  }

  /**
   * The ONE consolidated line a human ever sees about the cap. Deliberately
   * carries the running suppressed count so the single notice (and the report)
   * both answer "how much are we NOT paging you about?".
   */
  capSummaryLine(client, opts = {}) {
    const s = this.capState(client, opts);
    return (
      `Daily escalation cap reached (${s.used}/${s.cap}). Further escalations today are ` +
      `RECORDED and SUPPRESSED — no further per-task pages. Suppressed so far: ${s.suppressed}. ` +
      `Open tickets are unaffected and still reach a human.`
    );
  }

  /**
   * THE CAP GATE — the fix for the brake that had become the amplifier.
   *
   * Called at the exact moment the store is about to mint a NEW ticket. It
   * answers two questions in ONE atomic step:
   *
   *   suppress — is this client past its daily cap? (do not mint, do not page)
   *   notice   — is this the FIRST suppression today? (the single consolidated
   *              message a human is allowed to receive about the cap)
   *
   * The `notified_at` latch is set inside the same transaction as the counter
   * bump, so N concurrent sweeps past the cap yield exactly ONE notice — never
   * one message per task. Everything after that is counted and silent.
   *
   * NEVER-SILENCE INVARIANTS (all enforced here):
   *   • Under the cap, NOTHING is suppressed — a stuck task always pages.
   *   • Suppressed events are COUNTED durably (never dropped, never deleted).
   *   • A disabled/absent cap (cap <= 0) suppresses nothing.
   *   • The caller (`mintOrRecur`) FAILS OPEN if this throws: a broken cap
   *     table must let the escalation through, not silence it.
   */
  capGate({ client, cap = DEFAULT_DAILY_CAP, now = Date.now(), problem = "" } = {}) {
    const iso = new Date(now).toISOString();
    const used = this.countToday(client, iso);
    if (!capEnabled(cap) || used < cap) {
      return { suppress: false, notice: false, used, cap, suppressed: 0 };
    }

    const k = dayKey(client, iso);
    const txn = this.db.prepare("BEGIN IMMEDIATE");
    txn.run();
    try {
      this.db
        .prepare(
          `INSERT INTO cap_suppressions(day_key, count, first_at, last_at, last_problem, notified_at)
             VALUES (:k, 1, :at, :at, :p, NULL)
           ON CONFLICT(day_key) DO UPDATE SET
             count        = count + 1,
             last_at      = :at,
             last_problem = :p`
        )
        .run({ k, at: iso, p: problem ? String(problem).slice(0, 500) : null });

      // Single-notice latch: stamp notified_at only if it is still NULL. The
      // `changes` count tells us — atomically — whether WE were the one that
      // stamped it, i.e. whether this call owns today's one consolidated notice.
      const stamped = this.db
        .prepare("UPDATE cap_suppressions SET notified_at = :at WHERE day_key = :k AND notified_at IS NULL")
        .run({ k, at: iso });
      const row = this.db.prepare("SELECT count FROM cap_suppressions WHERE day_key = :k").get({ k });
      this.db.prepare("COMMIT").run();

      return {
        suppress: true,
        notice: Number(stamped.changes) === 1,
        used,
        cap,
        suppressed: row ? Number(row.count) : 1,
      };
    } catch (err) {
      try {
        this.db.prepare("ROLLBACK").run();
      } catch (_) {
        /* ignore */
      }
      throw err;
    }
  }

  // Look up an existing OPEN ticket by semantic dedup key within a time window.
  // Underpins FIX-RESCUE-08; returns the most recent match or null.
  findByDedup(key, windowMs = 6 * 60 * 60 * 1000, now = Date.now()) {
    const cutoff = new Date(now - windowMs).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM tickets
          WHERE dedup_key = :k AND created_at >= :cutoff
            AND status NOT IN ('RESOLVED','CLOSED')
          ORDER BY created_at DESC LIMIT 1`
      )
      .all({ k: key, cutoff });
    return rows[0] || null;
  }

  // --- create (mint) --------------------------------------------------------
  // Idempotent on ticket_id: a repeat call (n8n retry) returns the existing
  // ticket with `{ deduped: true }` and never double-mints an RR number or
  // double-counts the daily cap.
  createTicket({
    ticketId,
    client,
    box = null,
    boxType = null,
    agent = null,
    person = null,
    failureClass = null,
    source = "pathA",
    problem = "",
    decisionMode = null,
    countTowardCap = true,
  }) {
    if (!ticketId) throw new Error("createTicket: ticketId is required");
    const existing = this.getTicket(ticketId);
    if (existing) return { ticket: existing, deduped: true, created: false };

    const created_at = nowISO();
    const severity = severityForClass(failureClass);
    const sla_due_at = slaDueAt(created_at, severity);
    const dk = dedupKey(client, failureClass);
    const dck = dayKey(client, created_at);

    const txn = this.db.prepare("BEGIN");
    txn.run();
    try {
      const rr = this.#nextRrNumber();
      this.db
        .prepare(
          `INSERT INTO tickets(
             ticket_id, rr_number, client, box, box_type, agent, person,
             failure_class, severity, status, owner, source, problem, answer,
             decision_mode, created_at, first_response_at, resolved_at,
             resolved_by, sla_due_at, escalated_at, dedup_key, day_count_key, updated_at)
           VALUES (
             :ticket_id, :rr_number, :client, :box, :box_type, :agent, :person,
             :failure_class, :severity, 'OPEN', 'rescue-agent', :source, :problem, NULL,
             :decision_mode, :created_at, NULL, NULL,
             NULL, :sla_due_at, NULL, :dedup_key, :day_count_key, :created_at)`
        )
        .run({
          ticket_id: ticketId,
          rr_number: rr,
          client: client ?? null,
          box: box ?? null,
          box_type: boxType ?? null,
          agent: agent ?? null,
          person: person ?? null,
          failure_class: failureClass ?? null,
          severity,
          source: source ?? null,
          problem: problem ?? null,
          decision_mode: decisionMode ?? null,
          created_at,
          sla_due_at,
          dedup_key: dk,
          day_count_key: dck,
        });

      if (countTowardCap) {
        this.db
          .prepare(
            `INSERT INTO counters(day_key, count) VALUES (:k, 1)
             ON CONFLICT(day_key) DO UPDATE SET count = count + 1`
          )
          .run({ k: dck });
      }

      this.#recordEvent(ticketId, null, "OPEN", {
        actor: "rescue-agent",
        decisionMode,
        note: `minted ${formatRr(rr)} severity=${severity} source=${source}`,
      });
      this.db.prepare("COMMIT").run();
      return { ticket: this.getTicket(ticketId), deduped: false, created: true };
    } catch (err) {
      try {
        this.db.prepare("ROLLBACK").run();
      } catch (_) {
        /* ignore */
      }
      throw err;
    }
  }

  // --- semantic dedup: recurrence event (FIX-RESCUE-08) ---------------------
  // Append a "recurred" audit event to an EXISTING ticket without changing its
  // state. Bumps updated_at so aging/GC sees the fresh activity. This is how a
  // repeated outage / a client agent that never persists its ticketId folds
  // back onto the open ticket instead of minting (and cap-counting) a duplicate.
  recurrence(ticketId, { note = "recurred", decisionMode = null, actor = "rescue-agent" } = {}) {
    const t = this.getTicket(ticketId);
    if (!t) throw new Error(`recurrence: unknown ticket ${ticketId}`);
    this.db.prepare("UPDATE tickets SET updated_at = :u WHERE ticket_id = :t").run({ u: nowISO(), t: ticketId });
    this.#recordEvent(ticketId, t.status, t.status, { actor, decisionMode, note });
    return this.getTicket(ticketId);
  }

  // --- semantic dedup: mint decision (FIX-RESCUE-08) ------------------------
  // The single entry point the mint path should call INSTEAD of createTicket.
  // Order of precedence:
  //   1. EXACT ticket_id already exists  -> return it (createTicket idempotency;
  //      never dedups against a different ticket, never double-counts the cap).
  //   2. A still-open ticket shares the semantic dedup key (client + class)
  //      inside `dedupWindowMs` (default 6h) -> append a "recurred" event to
  //      THAT ticket and return { status:"deduped", ticketId:<existing> }
  //      WITHOUT minting an RR number and WITHOUT touching the 25/day cap.
  //   3. PAST THE DAILY CAP (FIX-RESCUE-13) -> do NOT mint. Count the
  //      suppression durably and return { status:"cap_suppressed", post:false }.
  //      EXACTLY ONE call per client per day (the first past the cap) comes back
  //      with post:true + postKind:"cap_summary" — the single consolidated
  //      notice. There is NEVER a per-task "cap reached" message: that message
  //      WAS the flood it claimed to prevent.
  //   4. Otherwise mint a fresh ticket (counts toward the cap by default).
  //
  // The uniform return shape lets the caller decide cap accounting once:
  //   { status:"minted"|"deduped"|"exists"|"cap_suppressed", deduped, minted,
  //     post, postKind, ticketId, rrNumber, ticket }.
  // `post` is the ONLY thing a sender needs to read: post===true => send this
  // one message; post===false => stay silent (the event is already recorded).
  mintOrRecur(opts = {}) {
    const {
      ticketId,
      client,
      failureClass = null,
      dedupWindowMs = 6 * 60 * 60 * 1000,
      now = Date.now(),
      problem = "",
      decisionMode = null,
      capPerDay = DEFAULT_DAILY_CAP,
      enforceCap = true,
    } = opts;
    if (!ticketId) throw new Error("mintOrRecur: ticketId is required");

    // (1) exact-id idempotency ALWAYS wins over semantic dedup.
    const exact = this.getTicket(ticketId);
    if (exact) {
      return { status: "exists", deduped: true, minted: false, post: false, postKind: null, ticketId: exact.ticket_id, rrNumber: exact.rr_number, ticket: exact };
    }

    // (2) semantic dedup against an open sibling. Checked BEFORE the cap: a
    // recurrence folds onto a ticket a human already has, so it neither burns
    // the cap nor gets swallowed by it.
    const open = this.findByDedup(dedupKey(client, failureClass), dedupWindowMs, now);
    if (open && open.ticket_id !== ticketId) {
      const suffix = problem ? " — " + String(problem).slice(0, 200) : "";
      this.recurrence(open.ticket_id, { decisionMode, note: `recurred (would-be ${ticketId})${suffix}` });
      return { status: "deduped", deduped: true, minted: false, post: false, postKind: null, ticketId: open.ticket_id, rrNumber: open.rr_number, ticket: this.getTicket(open.ticket_id) };
    }

    // (3) the daily cap. FAIL-OPEN: if the cap machinery itself errors we mint
    // and post. A broken counter must never be able to silence an escalation —
    // the cost of a duplicate page is trivial next to the cost of a stuck task
    // no human ever hears about.
    if (enforceCap) {
      let gate = null;
      try {
        gate = this.capGate({ client, cap: capPerDay, now, problem });
      } catch (err) {
        gate = null; // fail-open
      }
      if (gate && gate.suppress) {
        return {
          status: "cap_suppressed",
          deduped: false,
          minted: false,
          // The single consolidated notice, or silence. Never per-task.
          post: gate.notice,
          postKind: gate.notice ? "cap_summary" : null,
          message: gate.notice ? this.capSummaryLine(client, { cap: capPerDay, now }) : null,
          ticketId: null,
          rrNumber: null,
          ticket: null,
          cap: gate.cap,
          used: gate.used,
          suppressedToday: gate.suppressed,
        };
      }
    }

    // (4) genuinely new -> mint (counts toward the cap unless caller opts out).
    const res = this.createTicket(opts);
    return { status: "minted", deduped: false, minted: true, post: true, postKind: "ticket", ticketId: res.ticket.ticket_id, rrNumber: res.ticket.rr_number, ticket: res.ticket };
  }

  // --- transition -----------------------------------------------------------
  // Validates against LEGAL_TRANSITIONS, updates lifecycle timestamps + owner,
  // and writes an audit event. Throws on an unknown ticket or illegal jump.
  transition(ticketId, toStatus, { actor = "rescue-agent", decisionMode = null, note = null } = {}) {
    if (!STATUSES.includes(toStatus)) throw new Error(`transition: unknown status ${toStatus}`);
    const t = this.getTicket(ticketId);
    if (!t) throw new Error(`transition: unknown ticket ${ticketId}`);
    const from = t.status;
    if (from === toStatus) {
      // No-op transition: still audit it (useful for re-affirming state) but
      // change nothing about timestamps.
      this.#recordEvent(ticketId, from, toStatus, { actor, decisionMode, note: note || "re-affirm (no-op)" });
      return this.getTicket(ticketId);
    }
    const allowed = LEGAL_TRANSITIONS[from] || [];
    if (!allowed.includes(toStatus)) {
      throw new Error(`transition: illegal ${from} -> ${toStatus} for ${ticketId}`);
    }

    const now = nowISO();
    const fields = { status: toStatus, updated_at: now };

    if (!t.first_response_at && toStatus !== "OPEN") fields.first_response_at = now;
    if (toStatus === "ESCALATED" && !t.escalated_at) fields.escalated_at = now;
    if (toStatus === "RESOLVED") {
      fields.resolved_at = now;
      fields.resolved_by = actor;
    }
    if (toStatus === "CLOSED" && !t.resolved_at) {
      fields.resolved_at = now;
      fields.resolved_by = actor;
    }

    // Ownership: operator owns anything that needs a human; the rescue agent
    // owns the auto-working states.
    if (toStatus === "ESCALATED" || toStatus === "NEEDS_HUMAN") fields.owner = "operator";
    else if (toStatus === "ACK" || toStatus === "IN_PROGRESS" || toStatus === "REOPENED") {
      if (t.owner !== "operator") fields.owner = "rescue-agent";
    }

    const setClause = Object.keys(fields).map((k) => `${k} = :${k}`).join(", ");
    this.db.prepare(`UPDATE tickets SET ${setClause} WHERE ticket_id = :ticket_id`).run({ ...fields, ticket_id: ticketId });
    this.#recordEvent(ticketId, from, toStatus, { actor, decisionMode, note });
    return this.getTicket(ticketId);
  }

  // Record an answer and move the lifecycle. `resolved:true` -> RESOLVED,
  // otherwise IN_PROGRESS. Sets first_response_at if this is the first response.
  answer(ticketId, { answer = "", decisionMode = null, resolved = false, actor = "rescue-agent" } = {}) {
    const t = this.getTicket(ticketId);
    if (!t) throw new Error(`answer: unknown ticket ${ticketId}`);
    this.db
      .prepare("UPDATE tickets SET answer = :a, decision_mode = COALESCE(:d, decision_mode), updated_at = :u WHERE ticket_id = :t")
      .run({ a: answer, d: decisionMode, u: nowISO(), t: ticketId });
    const target = resolved ? "RESOLVED" : "IN_PROGRESS";
    // If already terminal, just re-affirm; otherwise transition legally.
    const allowed = LEGAL_TRANSITIONS[t.status] || [];
    if (t.status !== target && allowed.includes(target)) {
      return this.transition(ticketId, target, { actor, decisionMode, note: "answer recorded" });
    }
    this.#recordEvent(ticketId, t.status, t.status, { actor, decisionMode, note: "answer recorded (no state change)" });
    return this.getTicket(ticketId);
  }

  escalate(ticketId, { actor = "operator", note = "SLA/queue escalation", decisionMode = "HUMAN_NEEDED" } = {}) {
    return this.transition(ticketId, "ESCALATED", { actor, note, decisionMode });
  }

  reopen(ticketId, { actor = "rescue-agent", note = "reopened" } = {}) {
    return this.transition(ticketId, "REOPENED", { actor, note });
  }

  close(ticketId, { actor = "rescue-agent", note = "closed" } = {}) {
    return this.transition(ticketId, "CLOSED", { actor, note });
  }

  // --- SLA sweep source -----------------------------------------------------
  // Tickets whose SLA has expired and that are still auto-working (not already
  // terminal or escalated). The sweep script escalates these.
  dueForEscalation(now = Date.now()) {
    const nowStr = new Date(now).toISOString();
    const placeholders = SLA_TERMINAL.map((_, i) => `:s${i}`).join(",");
    const params = { now: nowStr };
    SLA_TERMINAL.forEach((s, i) => (params[`s${i}`] = s));
    return this.db
      .prepare(
        `SELECT * FROM tickets
          WHERE sla_due_at IS NOT NULL AND sla_due_at <= :now
            AND status NOT IN (${placeholders})
          ORDER BY sla_due_at ASC`
      )
      .all(params);
  }

  // --- garbage collection (interim GC pass) ---------------------------------
  // Deletes old CLOSED/RESOLVED tickets (their events cascade) and stale daily
  // counters. Mirrors the interim GC the Relay Brain runs against the in-n8n
  // static-data store, but for the durable store.
  gc({ closedOlderThanDays = 30, counterOlderThanDays = 2, suppressionOlderThanDays = 30, now = Date.now() } = {}) {
    const ticketCutoff = new Date(now - closedOlderThanDays * 86_400_000).toISOString();
    const counterCutoff = new Date(now - counterOlderThanDays * 86_400_000).toISOString().slice(0, 10);
    // Cap-suppression rows are EVIDENCE (what we stopped paging about), not
    // bookkeeping — they are kept far longer than the daily counters they
    // shadow, so a flood is still reconstructible weeks later.
    const suppressionCutoff = new Date(now - suppressionOlderThanDays * 86_400_000).toISOString().slice(0, 10);

    const delTickets = this.db
      .prepare(
        `DELETE FROM tickets
          WHERE status IN ('CLOSED','RESOLVED')
            AND COALESCE(resolved_at, updated_at) < :cut`
      )
      .run({ cut: ticketCutoff });

    // Stale counters: any day_key whose date is older than the cutoff day.
    const staleCounters = this.db
      .prepare("SELECT day_key FROM counters")
      .all()
      .filter((r) => String(r.day_key).split("|")[1] < counterCutoff);
    const delCounter = this.db.prepare("DELETE FROM counters WHERE day_key = :k");
    for (const r of staleCounters) delCounter.run({ k: r.day_key });

    const staleSuppressions = this.db
      .prepare("SELECT day_key FROM cap_suppressions")
      .all()
      .filter((r) => String(r.day_key).split("|")[1] < suppressionCutoff);
    const delSuppression = this.db.prepare("DELETE FROM cap_suppressions WHERE day_key = :k");
    for (const r of staleSuppressions) delSuppression.run({ k: r.day_key });

    return {
      ticketsDeleted: delTickets.changes,
      countersDeleted: staleCounters.length,
      suppressionsDeleted: staleSuppressions.length,
      ticketCutoff,
      counterCutoff,
      suppressionCutoff,
    };
  }

  // --- read view ------------------------------------------------------------
  readView({ windowDays = 7, repeatThreshold = 3, capPerDay = DEFAULT_DAILY_CAP, now = Date.now() } = {}) {
    const openBySeverity = this.db
      .prepare(
        `SELECT severity, COUNT(*) AS n FROM tickets
          WHERE status IN (${OPEN_STATUSES.map((_, i) => `:o${i}`).join(",")})
          GROUP BY severity ORDER BY severity`
      )
      .all(Object.fromEntries(OPEN_STATUSES.map((s, i) => [`o${i}`, s])));

    const windowCut = new Date(now - windowDays * 86_400_000).toISOString();
    const mttrRow = this.db
      .prepare(
        `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24 * 60) AS mttr_min,
                COUNT(*) AS resolved_count
           FROM tickets
          WHERE resolved_at IS NOT NULL AND resolved_at >= :cut`
      )
      .get({ cut: windowCut });

    const repeatOffenders = this.db
      .prepare(
        `SELECT client, COUNT(*) AS tickets FROM tickets
          WHERE created_at >= :cut
          GROUP BY client HAVING COUNT(*) >= :thr
          ORDER BY tickets DESC`
      )
      .all({ cut: windowCut, thr: repeatThreshold });

    const today = new Date(now).toISOString().slice(0, 10);
    const capUsage = this.db
      .prepare("SELECT day_key, count FROM counters WHERE day_key LIKE :today ORDER BY count DESC")
      .all({ today: "%|" + today })
      .map((r) => ({
        client: String(r.day_key).split("|")[0],
        used: Number(r.count),
        cap: capPerDay,
        atCap: Number(r.count) >= capPerDay,
      }));

    // FIX-RESCUE-13 — SUPPRESSION IS NOT AMNESIA. The cap stops the pages, not
    // the accounting: everything it swallowed today surfaces HERE (and in
    // rescue-report), which is what makes "post once, then go quiet" safe.
    const capSuppressed = this.db
      .prepare("SELECT * FROM cap_suppressions WHERE day_key LIKE :today ORDER BY count DESC")
      .all({ today: "%|" + today })
      .map((r) => ({
        client: String(r.day_key).split("|")[0],
        suppressed: Number(r.count),
        cap: capPerDay,
        firstAt: r.first_at,
        lastAt: r.last_at,
        notifiedAt: r.notified_at,
      }));

    return {
      generatedAt: new Date(now).toISOString(),
      windowDays,
      openBySeverity,
      mttrMinutes: mttrRow && mttrRow.mttr_min != null ? Math.round(mttrRow.mttr_min * 10) / 10 : null,
      resolvedInWindow: mttrRow ? Number(mttrRow.resolved_count) : 0,
      repeatOffenders,
      capUsage,
      capSuppressed,
    };
  }

  close_() {
    this.db.close();
  }
}

export function openStore(dbPath) {
  return new TicketStore(dbPath || defaultDbPath());
}
