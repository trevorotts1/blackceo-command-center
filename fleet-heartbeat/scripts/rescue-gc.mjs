#!/usr/bin/env node
// === Rescue Rangers — DURABLE-STORE GC PASS (FIX-RESCUE-07) =================
//
// Deletes old CLOSED/RESOLVED tickets (their audit events cascade) and stale
// daily counters from the durable store so it does not grow unbounded. This is
// the durable-store counterpart to the interim GC that runs inside the n8n
// Relay Brain (see relay-brain-gc-snippet.js) during the migration window.
//
// Usage:
//   node rescue-gc.mjs [--db <path>] [--closed-days <n>] [--counter-days <n>] [--dry-run]
//
// Defaults: closed tickets older than 30 days, counters older than 2 days.
// ---------------------------------------------------------------------------
import { openStore } from "./lib/rescue-ticket-store.mjs";

function parseArgs(argv) {
  const a = { db: undefined, closedDays: 30, counterDays: 2, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--db") a.db = argv[++i];
    else if (t === "--closed-days") a.closedDays = Number(argv[++i]);
    else if (t === "--counter-days") a.counterDays = Number(argv[++i]);
    else if (t === "--dry-run") a.dryRun = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  let store;
  try {
    store = openStore(args.db);
  } catch (err) {
    process.stderr.write(`[rescue-gc] store open failed: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  let res;
  if (args.dryRun) {
    // Report what WOULD be deleted without mutating (count only).
    const now = Date.now();
    const ticketCutoff = new Date(now - args.closedDays * 86_400_000).toISOString();
    const counterCutoff = new Date(now - args.counterDays * 86_400_000).toISOString().slice(0, 10);
    const t = store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM tickets WHERE status IN ('CLOSED','RESOLVED') AND COALESCE(resolved_at, updated_at) < :c"
      )
      .get({ c: ticketCutoff });
    const staleC = store.db
      .prepare("SELECT day_key FROM counters")
      .all()
      .filter((r) => String(r.day_key).split("|")[1] < counterCutoff).length;
    res = { ticketsDeleted: t.n, countersDeleted: staleC, ticketCutoff, counterCutoff, dryRun: true };
  } else {
    res = store.gc({ closedOlderThanDays: args.closedDays, counterOlderThanDays: args.counterDays });
    res.dryRun = false;
  }
  store.close_();
  process.stdout.write(JSON.stringify({ ok: true, ...res }) + "\n");
}

main();
