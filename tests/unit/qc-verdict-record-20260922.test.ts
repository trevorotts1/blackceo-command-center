/**
 * QC-VERDICT-RECORD / FALSE-COMPARISON / DELIVERABLE-HOUSEKEEPING — 2026-09-22.
 *
 * Three measured faults on a client box, all of them the same silence:
 *
 *   1. FALSE COMPARISON. The board event for a re-routed card formatted the
 *      score as `X/10 < 8.5` unconditionally, so a card that scored 9.0 and
 *      failed on a mandatory gap published "9.0/10 < 8.5". With no stored
 *      verdict reason (fault 2) that nonsense line was the ONLY thing a human
 *      ever saw.
 *   2. UNRECORDABLE VERDICTS. `task_qc_results` carried score, passed,
 *      scoring_path, attempt — and nothing about WHY. A card failed twice at
 *      9.5 and 9.0 against an 8.5 bar and the reason was not recoverable from
 *      the database or from either pm2 log.
 *   3. UNBOUNDED DELIVERABLE ROWS. Nothing ever retired a re-route's
 *      deliverable rows, so one card held 27 rows for 5 real files. This is
 *      housekeeping, NOT a correctness fault — `currentExecutionDeliverables`
 *      already scopes the conformance gate to the current attempt — so rows are
 *      stamped, never deleted.
 *
 * Plus the rework instruction: a re-route names the files that still exist and
 * says to re-register rather than regenerate them.
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];

type ScorerModule = typeof import('../../src/lib/qc-scorer');
let qcScoreVerdictClause: ScorerModule['qcScoreVerdictClause'];
let qcGapSummary: ScorerModule['qcGapSummary'];
let qcCapBlockReason: ScorerModule['qcCapBlockReason'];
let storedVerdictGaps: ScorerModule['storedVerdictGaps'];
let reuseInstruction: ScorerModule['reuseInstruction'];
let rerouteOrBlock: ScorerModule['rerouteOrBlock'];

type ExecModule = typeof import('../../src/lib/execution-attempts');
let supersedeStaleDeliverables: ExecModule['supersedeStaleDeliverables'];

type ConformanceModule = typeof import('../../src/lib/persona-conformance');
let currentExecutionDeliverables: ConformanceModule['currentExecutionDeliverables'];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-verdict-'));
let AGENT_ID = '';

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  getDb = db.getDb;
  closeDb = db.closeDb;
  getDb(); // migrations 160 + 161
  const now = new Date().toISOString();
  // Reuse a seeded agent rather than inventing one: `task_executions.agent_id`
  // is a foreign key, and `agents.workspace_id` is another, so a hand-rolled
  // fixture agent fails opaquely on whichever one the seed has not created.
  AGENT_ID = queryOne<{ id: string }>('SELECT id FROM agents LIMIT 1')?.id ?? '';
  assert.ok(AGENT_ID, 'the seeded database must carry at least one agent');
  void now;

  const scorer = await import('../../src/lib/qc-scorer');
  qcScoreVerdictClause = scorer.qcScoreVerdictClause;
  qcGapSummary = scorer.qcGapSummary;
  qcCapBlockReason = scorer.qcCapBlockReason;
  storedVerdictGaps = scorer.storedVerdictGaps;
  reuseInstruction = scorer.reuseInstruction;
  rerouteOrBlock = scorer.rerouteOrBlock;

  supersedeStaleDeliverables = (await import('../../src/lib/execution-attempts')).supersedeStaleDeliverables;
  currentExecutionDeliverables = (await import('../../src/lib/persona-conformance')).currentExecutionDeliverables;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
});

let n = 0;
function newTask(title = 'verdict card'): string {
  const id = `qcv-${Date.now()}-${++n}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'review', 'medium', NULL, ?, ?)`,
    [id, title, now, now],
  );
  return id;
}

function addExecution(taskId: string, generation: number): string {
  const id = `exec-${taskId}-${generation}`;
  const now = new Date().toISOString();
  run(
    `INSERT INTO task_executions
       (id, task_id, assignment_version, agent_id, generation, session_key, session_id,
        state, lease_owner, lease_expires_at, idempotency_key, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, 'succeeded', 'test', ?, ?, ?, ?)`,
    [id, taskId, AGENT_ID, generation, `sk-${id}`, `sid-${id}`, now, `idem-${id}`, now, now],
  );
  return id;
}

function addDeliverable(taskId: string, executionId: string | null, filePath: string, type = 'file'): string {
  const id = `deliv-${taskId}-${++n}`;
  run(
    `INSERT INTO task_deliverables (id, task_id, execution_id, deliverable_type, title, path)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, taskId, executionId, type, path.basename(filePath), filePath],
  );
  return id;
}

// ─── 1. The false comparison ─────────────────────────────────────────────────

test('a failing score AT or ABOVE the bar is never published as "< 8.5"', () => {
  const high = qcScoreVerdictClause(9.0);
  assert.ok(!high.includes('<'), `a 9.0 verdict must not claim "<", got: ${high}`);
  assert.ok(high.includes('PASSED'), 'it must say the score passed');
  assert.ok(high.includes('9.0/10'), 'it must still name the score');

  // Exactly at the bar is still a pass, not a "<".
  const atBar = qcScoreVerdictClause(8.5);
  assert.ok(!atBar.includes('<'), `8.5 is not below 8.5, got: ${atBar}`);

  // A genuinely low score keeps the comparison, because there it is TRUE.
  const low = qcScoreVerdictClause(4.2);
  assert.ok(low.includes('< 8.5'), `a 4.2 verdict must keep the honest "<", got: ${low}`);
  assert.ok(!low.includes('PASSED'), 'a failing score must not be called passing');
});

test('every site that states a failing score uses the shared clause', () => {
  // block_reason (the cap path)
  const blocked = qcCapBlockReason({ attempts: 5, score: 9.0, gaps: ['logo missing'], reason: 'r' });
  assert.ok(!blocked.includes('< 8.5'), `block_reason must not claim "<" at 9.0, got: ${blocked}`);
  assert.ok(blocked.includes('PASSED'), 'block_reason says the score passed');

  const blockedLow = qcCapBlockReason({ attempts: 5, score: 3.0, gaps: ['nothing delivered'], reason: 'r' });
  assert.ok(blockedLow.includes('< 8.5'), `a low block_reason keeps "<", got: ${blockedLow}`);
});

test('the board event and kickback note are built from the shared clause, not a literal "<"', () => {
  // A static guard: no template in the scorer may pair a formatted score with a
  // bare `< ${QC_PASS_THRESHOLD}` again. That literal is what shipped the bug.
  const src = fs.readFileSync(path.join(process.cwd(), 'src/lib/qc-scorer.ts'), 'utf8');
  const offenders = src
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    // `${result.score...}` / `${p.score...}` — a CALLER stating a verdict.
    // The shared helper states it on its own bare `score` parameter inside a
    // ternary, which is the one correct use and is deliberately not matched.
    .filter(({ line }) => /\$\{(?:result|p|task)\.[A-Za-z.]*score[A-Za-z.]*\.toFixed\(1\)\}\/10 < \$\{QC_PASS_THRESHOLD\}/.test(line));
  assert.deepEqual(
    offenders.map((o) => o.n),
    [],
    `unconditional "< threshold" comparison(s) reintroduced at line(s): ${offenders.map((o) => o.n).join(', ')}`,
  );
});

test('the gap summary names every gap and falls back to the reason', () => {
  assert.equal(qcGapSummary(['a', 'b'], 'reason'), 'a; b');
  assert.equal(qcGapSummary([], 'reason'), 'reason');
  assert.equal(qcGapSummary(['', '  '], 'reason'), 'reason', 'blank gaps are not a summary');
});

// ─── 2. The verdict is recordable ────────────────────────────────────────────

test('a failing verdict persists its gaps, and a passing verdict persists its reason', () => {
  const id = newTask();
  const now = new Date().toISOString();

  run(
    `INSERT INTO task_qc_results (id, task_id, score, passed, scoring_path, attempt, scored_at, reason, gaps)
     VALUES (?, ?, 9.0, 0, 'llm', 1, ?, ?, ?)`,
    [`qcr-${id}-1`, id, now, 'blocked on a mandatory gap', JSON.stringify(['logo missing on slides 3 and 7'])],
  );

  const failed = queryOne<{ reason: string | null; gaps: string | null; score: number }>(
    'SELECT reason, gaps, score FROM task_qc_results WHERE task_id = ?', [id],
  );
  assert.ok(failed);
  assert.equal(failed.reason, 'blocked on a mandatory gap', 'the WHY is answerable from the database');
  assert.deepEqual(JSON.parse(failed.gaps ?? '[]'), ['logo missing on slides 3 and 7']);
  assert.equal(failed.score, 9.0, 'a 9.0 that still failed — the case that was unanswerable');

  const passId = newTask();
  run(
    `INSERT INTO task_qc_results (id, task_id, score, passed, scoring_path, attempt, scored_at, reason, gaps)
     VALUES (?, ?, 9.6, 1, 'llm', 1, ?, ?, ?)`,
    [`qcr-${passId}-1`, passId, new Date().toISOString(), 'all criteria met', JSON.stringify([])],
  );
  const passed = queryOne<{ reason: string | null; gaps: string | null }>(
    'SELECT reason, gaps FROM task_qc_results WHERE task_id = ?', [passId],
  );
  assert.equal(passed?.reason, 'all criteria met', 'a PASS records its reason too');
  assert.deepEqual(JSON.parse(passed?.gaps ?? 'null'), []);
});

test('rows written before the columns existed read cleanly as NULL', () => {
  const id = newTask();
  run(
    `INSERT INTO task_qc_results (id, task_id, score, passed, scoring_path, attempt, scored_at)
     VALUES (?, ?, 7.0, 0, 'llm', 1, ?)`,
    [`qcr-${id}-old`, id, new Date().toISOString()],
  );
  const row = queryOne<{ reason: string | null; gaps: string | null }>(
    'SELECT reason, gaps FROM task_qc_results WHERE task_id = ?', [id],
  );
  assert.equal(row?.reason, null);
  assert.equal(row?.gaps, null);
  assert.equal(storedVerdictGaps(id), null, 'a pre-160 row yields no stored gaps, never a crash');
});

test('the owner alert quotes the STORED gaps, not a value that lived only in memory', () => {
  const id = newTask();
  // The stored verdict deliberately differs from what the caller will hand in,
  // so reading the database is the only way this text can appear.
  run(
    `INSERT INTO task_qc_results (id, task_id, score, passed, scoring_path, attempt, scored_at, reason, gaps)
     VALUES (?, ?, 9.0, 0, 'llm', 5, ?, ?, ?)`,
    [`qcr-${id}-5`, id, new Date().toISOString(), 'persisted reason', JSON.stringify(['THE STORED GAP'])],
  );
  assert.deepEqual(storedVerdictGaps(id), ['THE STORED GAP']);
});

// ─── 3. Deliverable housekeeping ─────────────────────────────────────────────

test('three attempts leave only the latest set active, and nothing is deleted', () => {
  const id = newTask();
  const e1 = addExecution(id, 1);
  const e2 = addExecution(id, 2);
  const e3 = addExecution(id, 3);
  addDeliverable(id, e1, '/tmp/a1.md');
  addDeliverable(id, e1, '/tmp/a2.md');
  addDeliverable(id, e2, '/tmp/b1.md');
  addDeliverable(id, e3, '/tmp/c1.md');
  addDeliverable(id, e3, '/tmp/c2.md');

  const retired = supersedeStaleDeliverables(id, e3);
  assert.equal(retired, 3, 'the two earlier attempts retire, the current one does not');

  const rows = queryAll<{ execution_id: string | null; superseded_at: string | null; superseded_by_execution_id: string | null }>(
    'SELECT execution_id, superseded_at, superseded_by_execution_id FROM task_deliverables WHERE task_id = ?', [id],
  );
  assert.equal(rows.length, 5, 'NOTHING is deleted — a client file record is never destroyed');
  const active = rows.filter((r) => r.superseded_at === null);
  assert.equal(active.length, 2, 'only the latest attempt stays active');
  assert.ok(active.every((r) => r.execution_id === e3));
  assert.ok(
    rows.filter((r) => r.superseded_at !== null).every((r) => r.superseded_by_execution_id === e3),
    'every retired row names the attempt that superseded it',
  );

  // Idempotent: running it again retires nothing further.
  assert.equal(supersedeStaleDeliverables(id, e3), 0, 're-running retires nothing new');
});

test('rows with no execution attribution are left alone', () => {
  const id = newTask();
  const e1 = addExecution(id, 1);
  addDeliverable(id, null, '/tmp/pre158.md');
  addDeliverable(id, e1, '/tmp/current.md');

  supersedeStaleDeliverables(id, e1);
  const orphan = queryOne<{ superseded_at: string | null }>(
    'SELECT superseded_at FROM task_deliverables WHERE task_id = ? AND execution_id IS NULL', [id],
  );
  assert.equal(orphan?.superseded_at, null, 'a pre-158 row cannot be attributed, so it is never retired on a guess');
});

test('the conformance gate ignores retired rows when this attempt registered nothing', () => {
  const id = newTask();
  const e1 = addExecution(id, 1);
  const e2 = addExecution(id, 2);
  addDeliverable(id, e1, '/tmp/old1.md');
  addDeliverable(id, e1, '/tmp/old2.md');
  supersedeStaleDeliverables(id, e2); // e2 registered nothing yet

  const scoped = currentExecutionDeliverables(id, e2);
  assert.equal(scoped.length, 0, 'a retired row is not something this attempt can be held to');

  // Once this attempt registers its own row, it is measured on that.
  addDeliverable(id, e2, '/tmp/new.md');
  const mine = currentExecutionDeliverables(id, e2);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].path, '/tmp/new.md');
});

test('the 22-vs-7 pile-up self-heals on upgrade (migration 161 backfill)', async () => {
  const id = newTask('pileup card');
  const executions = [1, 2, 3].map((g) => addExecution(id, g));
  const current = executions[executions.length - 1];
  // 22 rows across three attempts; the current attempt registered 7.
  for (let i = 0; i < 8; i++) addDeliverable(id, executions[0], `/tmp/p1-${i}.md`);
  for (let i = 0; i < 7; i++) addDeliverable(id, executions[1], `/tmp/p2-${i}.md`);
  for (let i = 0; i < 7; i++) addDeliverable(id, current, `/tmp/p3-${i}.md`);
  assert.equal(
    queryAll<{ id: string }>('SELECT id FROM task_deliverables WHERE task_id = ?', [id]).length,
    22,
    'the seeded pile-up',
  );

  // Re-run the migration body against the live database — the upgrade path.
  const { migrations } = await import('../../src/lib/db/migrations');
  const backfill = migrations.find((m) => m.id === '161');
  assert.ok(backfill, 'migration 161 exists');
  backfill.up(getDb());

  const rows = queryAll<{ superseded_at: string | null }>(
    'SELECT superseded_at FROM task_deliverables WHERE task_id = ?', [id],
  );
  assert.equal(rows.length, 22, 'the backfill deletes nothing');
  assert.equal(rows.filter((r) => r.superseded_at === null).length, 7, '22 rows become 7 active');
});

// ─── 4. The rework instruction ───────────────────────────────────────────────

test('a re-route names the files that still exist and says not to regenerate them', () => {
  const id = newTask();
  const kept = path.join(TMP, 'week-1.md');
  fs.writeFileSync(kept, 'content');
  const note = reuseInstruction(id, () => [{ path: kept }]);

  assert.ok(note.includes('do NOT regenerate'), 'the instruction is explicit');
  assert.ok(note.includes(kept), 'it names the file that already exists');
  assert.ok(note.includes('Re-register'), 'it says how to claim it for this attempt');
  assert.ok(
    note.includes(`/api/tasks/${id}/deliverables`),
    'it names the EXISTING registration endpoint — no new agent-facing API',
  );
  assert.ok(note.includes('ONLY what the gaps'), 'it scopes the work to the gaps');
});

test('no surviving files means no instruction, not an empty promise', () => {
  const id = newTask();
  assert.equal(reuseInstruction(id, () => []), '', 'nothing to reuse adds nothing to the note');
});

test('a re-route through the shared primitive carries the reuse instruction and retires old rows', async () => {
  const id = newTask('rework card');
  const e1 = addExecution(id, 1);
  const e2 = addExecution(id, 2);
  addDeliverable(id, e1, path.join(TMP, 'old-attempt.md'));
  const keptPath = path.join(TMP, 'kept.md');
  fs.writeFileSync(keptPath, 'x');
  addDeliverable(id, e2, keptPath);

  const outcome = await rerouteOrBlock({
    taskId: id,
    taskTitle: 'rework card',
    taskDescription: 'original brief',
    attempts: 1,
    cap: 5,
    score: 9.0,
    reason: 'a mandatory gap',
    gaps: ['the bookkeeping report is missing'],
    kickbackNote: '[QC-FAIL] note',
  });
  assert.equal(outcome, 'rerouted');

  const stale = queryOne<{ superseded_at: string | null }>(
    'SELECT superseded_at FROM task_deliverables WHERE task_id = ? AND execution_id = ?', [id, e1],
  );
  assert.ok(stale?.superseded_at, 'the earlier attempt’s row is retired by a landed re-route');

  const current = queryOne<{ superseded_at: string | null }>(
    'SELECT superseded_at FROM task_deliverables WHERE task_id = ? AND execution_id = ?', [id, e2],
  );
  assert.equal(current?.superseded_at, null, 'the attempt that just ran keeps its rows active');
});
