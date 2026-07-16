// scripts/responsive-gate.mjs
//
// Skill-6 U54 (spec crosswalk HL/U69) — stage 4 of the whole-app responsive
// audit PROGRAM: "Gate." A repeatable check with two independent halves,
// wired into `qc-cc.sh` (section 15) so the whole-app property is enforced
// GOING FORWARD, not proven once:
//
//   (1) LEDGER gate — zero cells report horizOverflow > 0, zero cells
//       report a non-empty `clipped` (spec BINARY acceptance (b)/(c)).
//       Requires a baseline ledger written by responsive-audit.mjs; if none
//       exists yet, this reports BLOCKED — never a silent pass — because the
//       mechanism can be real and wired before the first live baseline
//       lands (that baseline is the operator-box leg).
//
//   (2) WAVE-C static scan — every `hidden sm:*` / `hidden md:*` utility
//       class on an interactive element (button / anchor / next/link / any
//       element carrying onClick, or a <nav>) must carry an adjacent
//       "mobile-substitute:" comment naming what replaces it below that
//       breakpoint (spec BINARY acceptance (d)). This half needs no live
//       server — it runs against source on disk and is fully real today.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './responsive-route-inventory.mjs';
import { DEFAULT_LEDGER_DIR } from './responsive-audit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

/** Ledger half: zero horizOverflow, zero clipped across every cell. */
export function evaluateLedgerCells(cells) {
  const failures = [];
  for (const cell of cells) {
    if ((cell.horizOverflow ?? 0) > 0) {
      failures.push({ route: cell.route, bp: cell.bp, defect: 'horizOverflow', value: cell.horizOverflow, offenders: cell.wide });
    }
    if (Array.isArray(cell.clipped) && cell.clipped.length > 0) {
      failures.push({ route: cell.route, bp: cell.bp, defect: 'clipped', offenders: cell.clipped });
    }
  }
  return { pass: failures.length === 0, failures, cellCount: cells.length };
}

export function loadLedger(ledgerDir = DEFAULT_LEDGER_DIR) {
  const p = path.join(ledgerDir, 'responsive-ledger.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const INTERACTIVE_HINTS = ['<button', '<a ', '<a>', '<Link', 'onClick', '<nav'];
const HIDDEN_CLASS = /\bhidden\s+(sm|md):/;
const JUSTIFY_MARKER = /mobile-substitute\s*:/i;

/**
 * Static wave-C scan. Deliberately conservative: a `hidden sm:*` /
 * `hidden md:*` match only counts as "on an interactive element" when a
 * small look-back window (handles multi-line opening tags) contains an
 * interactive hint or a <nav> tag. Every such match is either "justified"
 * (a mobile-substitute: comment within a small window) or reported as a
 * finding — never silently dropped. A hidden LABEL next to an always-visible
 * icon (e.g. `<span className="hidden sm:inline">Send</span>` beside an
 * icon button) is intentionally NOT flagged by INTERACTIVE_HINTS unless the
 * span itself is interactive — the icon remaining visible IS its mobile
 * substitute and needs no comment. Whole navs/sidebars that vanish below a
 * breakpoint (no replacement) ARE flagged.
 */
export function scanHiddenAffordances({ srcDir = path.join(REPO_ROOT, 'src') } = {}) {
  const findings = [];
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(tsx|jsx)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, idx) => {
        if (!HIDDEN_CLASS.test(line)) return;
        const windowStart = Math.max(0, idx - 3);
        const windowText = lines.slice(windowStart, idx + 1).join('\n');
        const isInteractive = INTERACTIVE_HINTS.some((hint) => windowText.includes(hint));
        if (!isInteractive) return; // a hidden label/decoration beside a visible substitute, not a vanished affordance
        const justifyWindow = lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 3)).join('\n');
        const justified = JUSTIFY_MARKER.test(justifyWindow);
        findings.push({
          file: path.relative(REPO_ROOT, full),
          line: idx + 1,
          snippet: line.trim().slice(0, 160),
          justified,
        });
      });
    }
  }
  walk(srcDir);
  return findings;
}

export function evaluateWaveC(opts = {}) {
  const findings = scanHiddenAffordances(opts);
  const unjustified = findings.filter((f) => !f.justified);
  return { pass: unjustified.length === 0, findings, unjustified };
}

/** Full stage-4 gate: BLOCKED (no ledger yet) | FAIL (a check failed) | PASS. */
export function runGate({ ledgerDir = DEFAULT_LEDGER_DIR, srcDir } = {}) {
  const waveC = evaluateWaveC({ srcDir });
  const ledger = loadLedger(ledgerDir);
  if (!ledger) {
    return {
      pass: false,
      blocked: true,
      reason:
        'no baseline ledger found — run `npm run audit:responsive` against a live, seeded build first ' +
        '(owed operator-box leg; see H+L.5.2 U69 acceptance (a)/(e))',
      ledgerDir,
      waveC,
    };
  }
  const ledgerResult = evaluateLedgerCells(ledger.cells);
  return {
    pass: ledgerResult.pass && waveC.pass,
    blocked: false,
    ledger: ledgerResult,
    waveC,
  };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runGate();
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}
