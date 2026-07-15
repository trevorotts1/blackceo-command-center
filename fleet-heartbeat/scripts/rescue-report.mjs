#!/usr/bin/env node
// === Rescue Rangers — READ VIEW / REPORT (FIX-RESCUE-07) ====================
//
// Small operational read view over the durable ticket store:
//   - open tickets by severity
//   - MTTR (mean time to resolve) over a trailing window
//   - repeat offenders (clients with >= threshold tickets in the window)
//   - daily cap usage per client (and who is at the cap)
//
// Usage:
//   node rescue-report.mjs [--json] [--db <path>] [--window <days>] [--cap <n>]
//
// Default output is a plain-text digest (safe to paste into the operator topic).
// `--json` prints the raw readView object.
// ---------------------------------------------------------------------------
import { openStore } from "./lib/rescue-ticket-store.mjs";

function parseArgs(argv) {
  const a = { json: false, db: undefined, windowDays: 7, cap: 25 };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--json") a.json = true;
    else if (t === "--db") a.db = argv[++i];
    else if (t === "--window") a.windowDays = Number(argv[++i]);
    else if (t === "--cap") a.cap = Number(argv[++i]);
  }
  return a;
}

function renderText(v) {
  const lines = [];
  lines.push("Rescue Rangers status");
  lines.push("Generated: " + v.generatedAt);
  lines.push("");
  lines.push("Open by severity:");
  if (v.openBySeverity.length === 0) lines.push("  (none open)");
  for (const r of v.openBySeverity) lines.push(`  ${r.severity}: ${r.n}`);
  lines.push("");
  lines.push(
    `MTTR (last ${v.windowDays}d): ` +
      (v.mttrMinutes != null ? `${v.mttrMinutes} min over ${v.resolvedInWindow} resolved` : "n/a (none resolved)")
  );
  lines.push("");
  lines.push(`Repeat offenders (>=3 in ${v.windowDays}d):`);
  if (v.repeatOffenders.length === 0) lines.push("  (none)");
  for (const r of v.repeatOffenders) lines.push(`  ${r.client}: ${r.tickets}`);
  lines.push("");
  lines.push("Cap usage today:");
  if (v.capUsage.length === 0) lines.push("  (no tickets today)");
  for (const c of v.capUsage) lines.push(`  ${c.client}: ${c.used}/${c.cap}${c.atCap ? "  AT CAP" : ""}`);
  lines.push("");
  // FIX-RESCUE-13 — the cap goes QUIET past its limit, so this is where the
  // suppressed volume must show up. A big number here is a real signal (a
  // client is flapping) that no longer arrives as one page per task.
  lines.push("Suppressed by the daily cap today:");
  if (!v.capSuppressed || v.capSuppressed.length === 0) lines.push("  (none suppressed)");
  else
    for (const c of v.capSuppressed)
      lines.push(
        `  ${c.client}: ${c.suppressed} suppressed (cap ${c.cap}) — last ${c.lastAt}` +
          `${c.notifiedAt ? "  [1 consolidated notice sent]" : "  [NO notice sent]"}`
      );
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv);
  let store;
  try {
    store = openStore(args.db);
  } catch (err) {
    process.stderr.write(`[rescue-report] store open failed: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }
  const view = store.readView({ windowDays: args.windowDays, capPerDay: args.cap });
  store.close_();
  if (args.json) process.stdout.write(JSON.stringify(view, null, 2) + "\n");
  else process.stdout.write(renderText(view) + "\n");
}

main();
