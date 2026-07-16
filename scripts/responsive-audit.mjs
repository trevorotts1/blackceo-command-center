// scripts/responsive-audit.mjs
//
// Skill-6 U54 (spec crosswalk HL/U69) — stage 2 of the whole-app responsive
// audit PROGRAM: "Measure."
//
// Extends `dev-shots.mjs`'s EXISTING invocation to the full mechanical route
// inventory from responsive-route-inventory.mjs — dev-shots.mjs itself is
// never rewritten, only invoked more completely, per the spec ("it already
// accepts routes as arguments — no tool rebuild").
//
// dev-shots.mjs is invoked ONCE PER ROUTE (not one giant batch covering all
// routes) so a per-route/per-breakpoint ledger file lands on disk as each
// route finishes. That is the "standing per-item ledger" the spec calls
// for: an interrupted run always resumes from where it left off instead of
// re-shooting routes that already have a fresh ledger entry.
//
// Producing a REAL baseline (rather than an empty/skipped run) requires a
// live, seeded Next.js server reachable at SHOT_BASE/PORT — per the spec,
// that first real run happens on the OPERATOR's own box, never a client
// box. This script is the wiring for that run, not a substitute for it.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildRouteInventory, REPO_ROOT } from './responsive-route-inventory.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_LEDGER_DIR =
  process.env.RESPONSIVE_LEDGER_DIR || path.join(process.env.TMPDIR || '/tmp', 'skill6-u54-responsive');

const BREAKPOINT_NAMES = ['mobile-375', 'tablet-768', 'desktop-1440'];

const slugRoute = (pattern) => (pattern === '/' ? 'home' : pattern.replace(/^\//, '').replace(/\//g, '-'));

/** Default real invocation: shells out to the UNMODIFIED dev-shots.mjs for one route, all 3 breakpoints. */
export function defaultInvoke({ route, label, shotOutDir }) {
  const devShots = path.join(__dirname, 'dev-shots.mjs');
  const result = spawnSync(process.execPath, [devShots, label, shotOutDir, route], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`dev-shots.mjs exited ${result.status} for route ${route}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function ledgerPathFor(ledgerDir, pattern, bp) {
  return path.join(ledgerDir, `responsive-${slugRoute(pattern)}-${bp}.json`);
}

/**
 * Run (or resume) the full-inventory audit.
 *
 *   inventory  – array of { pattern, href, unresolved, ... } (buildRouteInventory() by default)
 *   invoke     – ({route, label, shotOutDir}) => [{route, bp, horizOverflow, wide, clipped, ...}, ...]
 *                for that ONE route's 3 breakpoints. Injectable so tests never spawn a real
 *                browser or require a live server.
 *
 * Returns a summary object; also persists a per-cell ledger file per route/breakpoint plus one
 * consolidated `responsive-ledger.json` (read by responsive-gate.mjs).
 */
export function runAuditForRoutes(
  inventory,
  {
    invoke = defaultInvoke,
    ledgerDir = DEFAULT_LEDGER_DIR,
    label = 'audit',
    shotOutDir = path.join(ledgerDir, 'shots'),
    force = false,
  } = {}
) {
  fs.mkdirSync(ledgerDir, { recursive: true });
  const ran = [];
  const skippedUnresolved = [];
  const skippedAlready = [];
  const cells = [];

  for (const entry of inventory) {
    if (entry.unresolved) {
      skippedUnresolved.push({ pattern: entry.pattern, reason: entry.reason });
      continue;
    }

    const perRouteLedgerPaths = BREAKPOINT_NAMES.map((bp) => ledgerPathFor(ledgerDir, entry.pattern, bp));
    if (!force && perRouteLedgerPaths.every((p) => fs.existsSync(p))) {
      skippedAlready.push(entry.pattern);
      for (const p of perRouteLedgerPaths) cells.push(JSON.parse(fs.readFileSync(p, 'utf8')));
      continue;
    }

    const cellsForRoute = invoke({ route: entry.href, label, shotOutDir });
    for (const cell of cellsForRoute) {
      const record = {
        ...cell,
        sourcePattern: entry.pattern,
        fixtureFallback: Boolean(entry.fallback),
      };
      fs.writeFileSync(ledgerPathFor(ledgerDir, entry.pattern, cell.bp), JSON.stringify(record, null, 2));
      cells.push(record);
    }
    ran.push(entry.pattern);
  }

  const consolidated = {
    generatedAt: new Date().toISOString(),
    routeCount: inventory.length,
    ran,
    skippedAlready,
    skippedUnresolved,
    cells,
  };
  fs.writeFileSync(path.join(ledgerDir, 'responsive-ledger.json'), JSON.stringify(consolidated, null, 2));
  return consolidated;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const inventory = buildRouteInventory();
  const summary = runAuditForRoutes(inventory, { force });
  console.log(
    JSON.stringify(
      {
        routeCount: summary.routeCount,
        ran: summary.ran.length,
        skippedAlready: summary.skippedAlready.length,
        skippedUnresolved: summary.skippedUnresolved,
        cellCount: summary.cells.length,
        ledgerDir: DEFAULT_LEDGER_DIR,
      },
      null,
      2
    )
  );
  if (summary.ran.length === 0 && summary.skippedAlready.length === 0) {
    console.error(
      '\nNo route produced a fresh cell (every dynamic route is unresolved, or SHOT_BASE has no live server behind it). ' +
        'Run against a live, seeded build on the operator\'s own box to produce a real baseline.'
    );
  }
}
