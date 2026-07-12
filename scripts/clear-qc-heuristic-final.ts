#!/usr/bin/env tsx
/**
 * scripts/clear-qc-heuristic-final.ts
 *
 * P1-05 (c)2 — un-terminal the false finals.
 *
 * `qc-scorer.ts`'s no-key heuristic guard escalates a task stuck in `review`
 * to a TERMINAL `[QC-HEURISTIC-FINAL]` marker event after
 * QC_HEURISTIC_NO_KEY_MAX_PASSES passes (default 3) — see qc-scorer.ts around
 * line 3780. `qc-review-sweep.ts` then excludes that task PERMANENTLY (a
 * `NOT EXISTS ... message LIKE '%[QC-HEURISTIC-FINAL]%'` guard, no time
 * window — see qc-review-sweep.ts lines 90-95). That marker was correct
 * doctrine on a box with NO client Ollama Cloud judge: without it, a keyless
 * box would re-score the same task every ~10 minutes forever.
 *
 * BUT: before v19.48.0, 0/290 fleet agents had a judge provisioned at all, so
 * every one of those `[QC-HEURISTIC-FINAL]` markers was written by a box that
 * could NEVER have scored for real — the terminal state is FALSE, not a
 * legitimate "this box is permanently keyless" signal. Once a box's judge is
 * proven live (P1-05's `checkJudgeProvisioning()` / `GET
 * /api/system/qc-judge-probe` reports `judge_ok`), those tasks must re-enter
 * the QC review sweep so the now-real judge scores them.
 *
 * WHY THIS IS AN UPDATE, NOT A DELETE: the `events` table (src/lib/db/
 * schema.ts) is a flat append-only audit log with no soft-delete / superseded
 * flag, and this codebase's own doctrine (finished-work-recovery.ts, the
 * v5.14.0 soft-archive pattern) is "never discard evidence". The exclusion
 * mechanism in qc-review-sweep.ts is a literal SQL `LIKE` substring match on
 * the bracket token `[QC-HEURISTIC-FINAL]`, so "clearing" it can only mean
 * making that exact substring stop appearing in the message — there is no
 * separate flag to flip. This script therefore UPDATEs (never DELETEs) the
 * marker event's message: it renames the bracket token to
 * `[QC-HEURISTIC-FINAL-CLEARED-P1-05]` (which does NOT match
 * `%[QC-HEURISTIC-FINAL]%` — SQLite LIKE treats `[`/`]` as literal characters,
 * so the trailing `-CLEARED-P1-05` before the closing bracket breaks the
 * match) and APPENDS a remediation note. The original score, reason, and gaps
 * text is preserved verbatim inside the (renamed) message — nothing is lost.
 *
 * qc_reroute_attempts is intentionally left untouched: the heuristic path
 * never incremented it (qc-scorer.ts's own inline comment: "qc_reroute_
 * attempts unchanged"), so there is nothing to reset there — only the
 * marker event itself gates re-entry into the sweep.
 *
 * ── SAFE BY DEFAULT ─────────────────────────────────────────────────────────
 *   • DRY-RUN is the default and the only mode unless BOTH --apply AND --yes
 *     are passed. Dry-run performs ZERO writes; it prints + optionally writes
 *     (--out) a JSON ledger of every task that WOULD be cleared.
 *   • APPLY requires --apply --yes AND (by default) a live-proven judge:
 *     before writing anything, this script calls
 *     `checkJudgeProvisioning()` (P1-05's own judge probe) and refuses to run
 *     unless the verdict is `judge_ok` — clearing the exclusion on a box
 *     whose judge is still unprovisioned/dead just re-creates the exact same
 *     false-terminal state after QC_HEURISTIC_NO_KEY_MAX_PASSES more passes.
 *     Pass --skip-judge-check to bypass this gate (only for tests / a box
 *     where the judge check itself is already independently verified).
 *   • Only tasks currently `status = 'review'` AND `archived_at IS NULL` are
 *     touched (the spec's "tasks in review" scope) — a task that already
 *     moved on is left alone.
 *
 * Usage:
 *   npx tsx scripts/clear-qc-heuristic-final.ts                    # dry-run
 *   npx tsx scripts/clear-qc-heuristic-final.ts --out /tmp/x.json  # dry-run + ledger file
 *   npx tsx scripts/clear-qc-heuristic-final.ts --apply --yes      # MUTATES (after judge proven live)
 */

import { queryAll, run, getDb, closeDb } from '@/lib/db';
import { checkJudgeProvisioning } from '@/lib/probes/qc-judge-probe';
import fs from 'fs';
import path from 'path';

// ── Marker mechanics (must match qc-scorer.ts EXACTLY) ─────────────────────

/** The exact terminal marker token qc-scorer.ts writes (qc-scorer.ts:3785). */
export const FINAL_MARKER = '[QC-HEURISTIC-FINAL]';
/** The exact substring qc-review-sweep.ts's NOT EXISTS guard matches on. */
export const FINAL_MARKER_LIKE = '%[QC-HEURISTIC-FINAL]%';
/** Replacement token — deliberately still human-legible as "was FINAL". */
export const CLEARED_MARKER = '[QC-HEURISTIC-FINAL-CLEARED-P1-05]';

export interface ClearCandidateRow {
  taskId: string;
  taskTitle: string;
  eventId: string;
  originalMessage: string;
}

export interface ClearLedgerEntry extends ClearCandidateRow {
  newMessage: string;
}

/**
 * Pure, testable rewrite of one marker event's message. Renames the bracket
 * token so it no longer matches FINAL_MARKER_LIKE, and appends a dated
 * remediation note. Never touches any other part of the original text.
 */
export function clearedMessage(original: string, clearedAtIso: string): string {
  // split/join instead of a regex — the marker is a fixed literal string, no
  // need to worry about regex metacharacters, and it reads more obviously
  // correct in review.
  const renamed = original.split(FINAL_MARKER).join(CLEARED_MARKER);
  return (
    `${renamed} | [P1-05-REMEDIATION] cleared ${clearedAtIso}: client Ollama ` +
    'Cloud judge proven live (judge_ok) — task re-enters the QC review sweep ' +
    'for a real judge score.'
  );
}

/**
 * Find every `[QC-HEURISTIC-FINAL]` marker event belonging to a task that is
 * currently `status = 'review'` and not archived. Read-only.
 */
export function findClearCandidates(): ClearCandidateRow[] {
  return queryAll<ClearCandidateRow>(
    `SELECT e.id AS eventId, e.task_id AS taskId, t.title AS taskTitle, e.message AS originalMessage
       FROM events e
       JOIN tasks t ON t.id = e.task_id
      WHERE e.type = 'qc_review'
        AND e.message LIKE ?
        AND t.status = 'review'
        AND t.archived_at IS NULL
      ORDER BY e.created_at ASC`,
    [FINAL_MARKER_LIKE],
  );
}

/** Build the full ledger (candidates + the rewritten message) without writing anything. */
export function buildClearLedger(clearedAtIso: string): ClearLedgerEntry[] {
  return findClearCandidates().map((row) => ({
    ...row,
    newMessage: clearedMessage(row.originalMessage, clearedAtIso),
  }));
}

/** Apply the ledger: UPDATE each event's message. Never DELETEs a row. */
export function applyClearLedger(ledger: ClearLedgerEntry[]): number {
  let cleared = 0;
  for (const entry of ledger) {
    const result = run(`UPDATE events SET message = ? WHERE id = ?`, [entry.newMessage, entry.eventId]);
    if (result.changes > 0) cleared++;
  }
  return cleared;
}

// ── CLI plumbing ─────────────────────────────────────────────────────────────

function argVal(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const confirmed = argv.includes('--yes');
  const skipJudgeCheck = argv.includes('--skip-judge-check');
  const mode: 'dry-run' | 'apply' = apply && confirmed ? 'apply' : 'dry-run';
  const outPath = argVal(argv, '--out');

  // Touch the DB so migrations run and the singleton connection is ready.
  getDb();

  console.log(`[clear-qc-heuristic-final] mode: ${mode.toUpperCase()}${mode === 'dry-run' ? ' (read-only — no writes)' : ' (MUTATING)'}`);
  if (apply && !confirmed) {
    console.warn('[clear-qc-heuristic-final] --apply requires --yes to actually mutate; running DRY-RUN instead.');
  }

  if (mode === 'apply' && !skipJudgeCheck) {
    console.log('[clear-qc-heuristic-final] verifying the client Ollama Cloud judge is live before clearing anything...');
    const probe = await checkJudgeProvisioning();
    console.log(`[clear-qc-heuristic-final] judge probe verdict: ${probe.verdict} — ${probe.reason}`);
    if (probe.verdict !== 'judge_ok') {
      closeDb();
      throw new Error(
        `APPLY aborted: judge probe verdict is "${probe.verdict}", not "judge_ok". Clearing the ` +
        '[QC-HEURISTIC-FINAL] exclusion on a box whose judge cannot actually score would just ' +
        'recreate the same false-terminal state after the next 3 heuristic passes. Provision a ' +
        'working client Ollama Cloud judge first, or pass --skip-judge-check if you have already ' +
        'verified this independently.',
      );
    }
  }

  const clearedAtIso = new Date().toISOString();
  const ledger = buildClearLedger(clearedAtIso);

  console.log(`[clear-qc-heuristic-final] ${ledger.length} [QC-HEURISTIC-FINAL] task(s) in review eligible to clear.`);
  for (const e of ledger) {
    console.log(`  - ${e.taskId} "${e.taskTitle}" (event ${e.eventId})`);
  }

  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ generatedAt: clearedAtIso, mode, ledger }, null, 2));
    console.log(`[clear-qc-heuristic-final] ledger written -> ${outPath}`);
  }

  if (mode === 'dry-run') {
    closeDb();
    console.log('\n[clear-qc-heuristic-final] DRY-RUN complete — nothing was changed. Re-run with --apply --yes once the judge is proven live.');
    return;
  }

  const cleared = applyClearLedger(ledger);
  closeDb();
  console.log(`\n[clear-qc-heuristic-final] APPLY complete — ${cleared}/${ledger.length} marker event(s) cleared. Affected tasks re-enter the qc-review-sweep on its next run.`);
}

// Run as a CLI only when invoked directly (importable by tests otherwise).
import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[clear-qc-heuristic-final] FATAL:', (err as Error).message);
    process.exit(1);
  });
}
