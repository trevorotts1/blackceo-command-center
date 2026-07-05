#!/usr/bin/env node
// === Rescue Rangers — SLA AUTO-ESCALATION SWEEP (FIX-RESCUE-07) =============
//
// Finds tickets whose SLA has expired while still auto-working and escalates
// them (status -> ESCALATED, owner -> operator, audit event written). Designed
// to be fired every 5 minutes by an n8n Schedule trigger OR a launchd/cron
// entry (matching how the poller and watchdog already run as direct commands).
//
// It NEVER talks to Telegram directly (no secrets in this file). Instead it
// prints a JSON `page` payload to stdout for each newly-escalated ticket; the
// caller (n8n node or a wrapper cron) routes that to the operator via the
// existing credential-backed Telegram node. `--quiet` suppresses the per-ticket
// human log lines but still prints the final JSON summary.
//
// Exit code 0 = ran clean (including "nothing due"); 2 = store error.
//
// Usage:
//   node rescue-sla-sweep.mjs [--quiet] [--db <path>] [--dry-run]
// ---------------------------------------------------------------------------
import { openStore, formatRr } from "./lib/rescue-ticket-store.mjs";

function parseArgs(argv) {
  const a = { quiet: false, dryRun: false, db: undefined };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--quiet") a.quiet = true;
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === "--db") a.db = argv[++i];
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  let store;
  try {
    store = openStore(args.db);
  } catch (err) {
    process.stderr.write(`[rescue-sla-sweep] store open failed: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const now = Date.now();
  const due = store.dueForEscalation(now);
  const pages = [];

  for (const t of due) {
    const overdueMin = Math.round((now - new Date(t.sla_due_at).getTime()) / 60_000);
    if (!args.dryRun) {
      store.escalate(t.ticket_id, {
        actor: "operator",
        decisionMode: "HUMAN_NEEDED",
        note: `SLA breach: ${t.severity} due ${t.sla_due_at}, overdue ${overdueMin}m`,
      });
    }
    const page = {
      ticketId: t.ticket_id,
      rr: formatRr(t.rr_number),
      client: t.client,
      severity: t.severity,
      failureClass: t.failure_class,
      overdueMinutes: overdueMin,
      slaDueAt: t.sla_due_at,
      text:
        `[RR SLA BREACH] ${formatRr(t.rr_number)} ${t.severity} client=${t.client || "?"} ` +
        `class=${t.failure_class || "?"} overdue ${overdueMin}m -- auto-escalated to operator.`,
    };
    pages.push(page);
    if (!args.quiet) {
      process.stderr.write(
        `[rescue-sla-sweep] escalated ${page.rr} ${page.severity} client=${page.client || "?"} overdue=${overdueMin}m\n`
      );
    }
  }

  const summary = {
    ok: true,
    ranAt: new Date(now).toISOString(),
    scannedDue: due.length,
    escalated: args.dryRun ? 0 : pages.length,
    dryRun: args.dryRun,
    pages,
  };
  store.close_();
  process.stdout.write(JSON.stringify(summary) + "\n");
}

main();
