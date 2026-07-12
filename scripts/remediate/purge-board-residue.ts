/**
 * purge-board-residue.ts — P1-06 step 2 per-box REMEDIATION (residue purge).
 *
 * "Purge residue (remediation script for P6-01): archive tasks titled with
 * [DEMO]/[TEST]/smoke-test prefixes and the known synthetic anthology drill
 * cards; delete 'Dims Test SOP'-class rows from the SOP table."
 *
 * SCOPE NOTE (read the actual code before re-doing work — 2.4):
 *   The SOP-table half of that sentence is ALREADY DONE. `rekeyAndPurgeGhostSops()`
 *   (src/lib/db/migrations.ts, wired as migration 091) hard-DELETEs every `sops`
 *   row whose `department` is in `TEST_RESIDUE_SOP_DEPARTMENTS` — which is
 *   exactly the `test-dept` bucket the "Dims Test SOP A/B" rows live in (see
 *   `src/lib/test-residue.ts` header comment, which names them explicitly). That
 *   migration runs automatically on every DB upgrade; there is nothing left to
 *   build for the SOP table. This script covers the remaining, NOT-yet-built
 *   half: TASK-level demo/test residue, which `test-residue.ts` never touched
 *   (it only ever covered sops/workspaces/companies).
 *
 * THREE categories, in ascending order of confidence:
 *
 *   A. `[DEMO]` / `[TEST]` exact bracket-prefix titles — e.g. the incident's own
 *      "[DEMO] Sales Funnel Build" card (named in P1-01). High confidence:
 *      archived automatically.
 *   B. `smoke-test`-prefixed titles (token-boundary match, mirroring
 *      `TEST_RESIDUE_DETECT_PATTERN`'s anti-false-positive design so a real
 *      client task like "Smoke Testing Lab Signage" is never swept). High
 *      confidence: archived automatically.
 *   C. "Known synthetic anthology drill cards" — the spec's problem statement
 *      cites "6 synthetic anthology drill cards (G9)" but no source document in
 *      this build's pointer scope enumerates their exact titles/ids. Rather than
 *      fabricate a title list (2.4 / never-fabricate doctrine), this script
 *      FLAGS candidates (title contains "anthology" AND one of
 *      drill/synthetic/dummy/fixture as a distinct token) for OPERATOR REVIEW —
 *      it never auto-archives category C. Once the G9 finding's exact
 *      identifiers are available, extend `ANTHOLOGY_DRILL_EXACT_TITLES` below
 *      with them and they will archive on the next run exactly like category A.
 *
 * Archival is ALWAYS soft (`archived_at` stamp) — never DELETE, per the
 * v5.14.0 soft-archive pattern this whole spec cluster follows. A `blocked`
 * task is NEVER swept here even if its title matches (board-hygiene.ts rule 2
 * governs blocked-task handling exclusively; this script only ever touches
 * non-blocked residue so the two remediations can never race on the same row
 * with different outcomes).
 *
 * Dry-run by default; pass --apply to execute.
 *
 *   npx tsx scripts/remediate/purge-board-residue.ts            # dry-run
 *   npx tsx scripts/remediate/purge-board-residue.ts --apply    # execute
 */

import { getDb, run, queryAll, timeNow } from '../../src/lib/db';

function argvHasApply(): boolean {
  return process.argv.includes('--apply');
}

/** Populate once the G9 finding's exact card identifiers are available (see
 *  category C note above). Empty by design — never guessed. */
const ANTHOLOGY_DRILL_EXACT_TITLES: readonly string[] = [];

interface ResidueTaskRow {
  id: string;
  title: string;
  status: string;
}

function isBracketPrefixResidue(title: string): boolean {
  return /^\s*\[(DEMO|TEST)\]/.test(title);
}

/** Token-boundary match — mirrors test-residue.ts's anti-false-positive design. */
function isSmokeTestPrefixResidue(title: string): boolean {
  return /^\s*smoke[-_]test\b/i.test(title);
}

function isAnthologyDrillCandidate(title: string): boolean {
  const t = title.toLowerCase();
  if (!/\banthology\b/.test(t)) return false;
  return /\b(drill|synthetic|dummy|fixture)\b/.test(t);
}

export interface PurgeBoardResidueResult {
  scanned: number;
  bracketArchived: number;
  bracketArchivedIds: string[];
  smokeTestArchived: number;
  smokeTestArchivedIds: string[];
  anthologyExactArchived: number;
  anthologyExactArchivedIds: string[];
  anthologyCandidatesFlagged: string[]; // "<id>: <title>" — never auto-archived
  applied: boolean;
}

export function purgeBoardResidue(opts?: { apply?: boolean }): PurgeBoardResidueResult {
  const apply = opts?.apply ?? argvHasApply();
  getDb(); // ensure migrations are applied before touching the schema

  const rows = queryAll<ResidueTaskRow>(
    `SELECT id, title, status FROM tasks
      WHERE archived_at IS NULL AND status != 'blocked'`,
    [],
  );

  const result: PurgeBoardResidueResult = {
    scanned: rows.length,
    bracketArchived: 0,
    bracketArchivedIds: [],
    smokeTestArchived: 0,
    smokeTestArchivedIds: [],
    anthologyExactArchived: 0,
    anthologyExactArchivedIds: [],
    anthologyCandidatesFlagged: [],
    applied: apply,
  };

  const archive = (id: string): void => {
    if (!apply) return;
    run(`UPDATE tasks SET archived_at = ? WHERE id = ? AND archived_at IS NULL AND status != 'blocked'`, [
      timeNow(),
      id,
    ]);
    run(
      `INSERT INTO events (id, type, task_id, message, created_at)
       VALUES (lower(hex(randomblob(16))), 'board_hygiene_residue_purged', ?, ?, datetime('now'))`,
      [id, '[PURGE-BOARD-RESIDUE] Soft-archived demo/test residue card.'],
    );
  };

  for (const task of rows) {
    if (isBracketPrefixResidue(task.title)) {
      result.bracketArchived++;
      result.bracketArchivedIds.push(task.id);
      archive(task.id);
      continue;
    }
    if (isSmokeTestPrefixResidue(task.title)) {
      result.smokeTestArchived++;
      result.smokeTestArchivedIds.push(task.id);
      archive(task.id);
      continue;
    }
    if (ANTHOLOGY_DRILL_EXACT_TITLES.includes(task.title)) {
      result.anthologyExactArchived++;
      result.anthologyExactArchivedIds.push(task.id);
      archive(task.id);
      continue;
    }
    if (isAnthologyDrillCandidate(task.title)) {
      result.anthologyCandidatesFlagged.push(`${task.id}: ${task.title}`);
    }
  }

  return result;
}

function main(): void {
  const result = purgeBoardResidue();
  console.log(
    `[purge-board-residue] scanned ${result.scanned} live task(s)` +
      (result.applied ? '' : ' — DRY RUN (pass --apply to execute)'),
  );
  console.log(
    `[purge-board-residue] [DEMO]/[TEST] bracket-prefix: ${result.bracketArchived} archived` +
      (result.bracketArchivedIds.length ? ` (${result.bracketArchivedIds.join(', ')})` : ''),
  );
  console.log(
    `[purge-board-residue] smoke-test-prefix: ${result.smokeTestArchived} archived` +
      (result.smokeTestArchivedIds.length ? ` (${result.smokeTestArchivedIds.join(', ')})` : ''),
  );
  console.log(
    `[purge-board-residue] anthology drill (exact allowlist): ${result.anthologyExactArchived} archived`,
  );
  if (result.anthologyCandidatesFlagged.length > 0) {
    console.log(
      `[purge-board-residue] ${result.anthologyCandidatesFlagged.length} anthology-drill CANDIDATE(S) flagged ` +
        `for operator review (never auto-archived — no verified exact-title source in scope):`,
    );
    for (const line of result.anthologyCandidatesFlagged) console.log(`  - ${line}`);
  }
  console.log(`[purge-board-residue] SOP-table residue ("Dims Test SOP"-class): already purged by migration 091 on every box — nothing to do here.`);
}

if (require.main === module) {
  main();
}
