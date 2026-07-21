/**
 * T0-01 / T0-42 — completion-evidence gate: a task with no registered
 * deliverable can never be recorded `done`, by any path.
 *
 * ── WHAT WAS BROKEN ───────────────────────────────────────────────────────────
 * T0-01: `deriveAcceptanceCriteria()` returned `[]` for every task that was not
 * an image or a deck. Its caller derives `isArtifactTask` from that array being
 * non-empty, so empty criteria meant "not an artifact task", which skipped the
 * "no artifact registered" invariant, which dropped scoring into a
 * description-only mode where the judge graded the prose the executing agent had
 * itself written. Score ≥8.5 then called `transition(taskId,'done')` and wrote a
 * durable `task_completed`. Document, book, report, operations, video and
 * content-writer tasks all took that route.
 *
 * T0-42: a master-role caller could PATCH a task to `done` with no score in
 * existence at all — every gate on that route checked WHO was asking, none
 * checked whether the work had ever been judged.
 *
 * ── WHAT THESE TESTS PIN ──────────────────────────────────────────────────────
 * Each test below is written to FAIL against the pre-fix code and pass after.
 * They assert behaviour (a task cannot reach done / a promotion is refused), not
 * implementation, so they keep their meaning if the internals move.
 *
 * The no-regression cases matter as much as the blocking ones: a gate that also
 * fails legitimate work gets switched off, and then it protects nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-t0-evidence-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;
process.env.MC_API_TOKEN = 'test-t0-mc-token';

const RUN_ID = Math.random().toString(36).slice(2, 10);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type QcScorerModule = typeof import('../../src/lib/qc-scorer');
let runQCOnReview: QcScorerModule['runQCOnReview'];
let deriveAcceptanceCriteria: QcScorerModule['deriveAcceptanceCriteria'];

type LifecycleModule = typeof import('../../src/lib/task-lifecycle');
let transition: LifecycleModule['transition'];
let TransitionError: LifecycleModule['TransitionError'];

type TaskRouteModule = typeof import('../../src/app/api/tasks/[id]/route');
let taskPATCH: TaskRouteModule['PATCH'];

let counter = 0;
const nextId = (p: string) => `t0-${p}-${++counter}-${RUN_ID}`;

/** A real, non-empty file on disk — genuine completion evidence. */
function makeRealFile(name: string): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, 'delivered content, non-empty\n');
  return p;
}

/** Seed a review-status task with an SOP that HAS success_criteria.
 *
 * The SOP matters: pre-fix, a task with no SOP fell to the 'no-criteria' path
 * which already refused to pass. It was specifically a task WITH an SOP that
 * reached the description-only judge and could score ≥8.5. Seeding the SOP is
 * what puts the pre-fix code on its actual defective path — without it these
 * tests would pass before the fix for the wrong reason and prove nothing. */
function seedTask(id: string, title: string, description: string): void {
  const now = new Date().toISOString();
  const sopId = `${id}-sop`;
  run(
    `INSERT INTO sops (id, name, slug, department, success_criteria, steps, created_at, updated_at)
     VALUES (?, ?, ?, 'operations', ?, ?, ?, ?)`,
    [
      sopId,
      `SOP for ${id}`,
      `sop-${id}`,
      'The deliverable is complete, accurate, and addresses every point in the brief.',
      JSON.stringify(['Do the work', 'Deliver it']),
      now,
      now,
    ],
  );
  run(
    `INSERT INTO tasks (id, title, description, status, priority, sop_id, department,
                        workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, 'review', 'medium', ?, 'operations', NULL, NULL, ?, ?)`,
    [id, title, description, sopId, now, now],
  );
}

function addDeliverable(
  taskId: string,
  type: 'file' | 'artifact' | 'image' | 'url',
  p: string,
): void {
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [nextId('deliv'), taskId, type, `deliverable for ${taskId}`, p, new Date().toISOString()],
  );
}

const statusOf = (id: string): string | undefined =>
  queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;

/** Durable completion evidence in the legacy events table. */
const completedEventCount = (id: string): number =>
  queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND type = 'task_completed'`,
    [id],
  )?.c ?? 0;

/**
 * Force a deterministic PASSING judge verdict through the sanctioned fixture
 * seam. This is the crux of the T0-01 proof: we make the judge say 9.5/10 —
 * exactly what a well-written description used to earn — and assert the task
 * STILL cannot reach done without a deliverable. The gate must not depend on
 * the judge being harsh, because the defect was that a generous score was
 * enough on its own.
 */
async function withPassingJudge<T>(fn: () => Promise<T>): Promise<T> {
  const fixturePath = path.join(TMP_DIR, `verdict-${++counter}.json`);
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({ score: 9.5, pass: true, reason: 'Looks thorough and complete.', gaps: [] }),
  );
  process.env.QC_FIXTURE_JSON_PATH = fixturePath;
  try {
    return await fn();
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // trigger migrations

  const scorer = await import('../../src/lib/qc-scorer');
  runQCOnReview = scorer.runQCOnReview;
  deriveAcceptanceCriteria = scorer.deriveAcceptanceCriteria;

  const lifecycle = await import('../../src/lib/task-lifecycle');
  transition = lifecycle.transition;
  TransitionError = lifecycle.TransitionError;

  const route = await import('../../src/app/api/tasks/[id]/route');
  taskPATCH = route.PATCH;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// T0-01 (a) — criteria are derived for EVERY task type, never empty
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The root cause, pinned directly. Every one of these task types returned `[]`
 * before the fix — that empty array is what disabled the invariant downstream.
 * Video and content-writer are listed explicitly because they were found on a
 * later pass than the rest: they are not special cases, they are two more
 * things the exemption swallowed because it was a default, not a decision.
 */
test('[T0-01a] deriveAcceptanceCriteria returns criteria for every task type — never empty', () => {
  const cases: Array<[string, string, string]> = [
    ['document', 'Write the Q3 board memo', 'Draft a two-page memo for the board.'],
    ['book', 'Write chapter 4 of the manuscript', 'Continue the narrative arc.'],
    ['report', 'Produce the quarterly revenue report', 'Summarise revenue by segment.'],
    ['operations', 'Reconcile the vendor invoices', 'Match invoices to POs.'],
    ['video', 'Produce the 60-second promo video', 'Edit the sizzle reel for launch.'],
    ['content-writer', 'Write the launch blog post', 'A 900-word post announcing the product.'],
  ];

  for (const [label, title, description] of cases) {
    const criteria = deriveAcceptanceCriteria(title, description);
    assert.ok(
      criteria.length > 0,
      `${label}: expected at least one acceptance criterion, got none — an empty ` +
        'criteria list is exactly what disables the no-artifact invariant',
    );
    assert.ok(
      criteria.some((c) => c.type === 'deliverable_registered'),
      `${label}: expected the baseline deliverable_registered criterion, got: ${criteria
        .map((c) => c.type)
        .join(', ')}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T0-01 (b) — no artifact ⇒ cannot reach done, even with a passing judge
// ─────────────────────────────────────────────────────────────────────────────

for (const [label, title, description] of [
  ['document', 'Write the Q3 board memo', 'Draft a two-page memo for the board covering revenue, risk and hiring.'],
  ['book', 'Write chapter 4 of the manuscript', 'Continue the narrative arc through the midpoint reversal.'],
  ['report', 'Produce the quarterly revenue report', 'Summarise revenue by segment with commentary.'],
  ['operations', 'Reconcile the vendor invoices', 'Match every invoice to its purchase order and flag variances.'],
  ['video', 'Produce the 60-second promo video', 'Edit the sizzle reel for the product launch.'],
  ['content-writer', 'Write the launch blog post', 'A 900-word announcement post with SEO headings.'],
] as Array<[string, string, string]>) {
  test(`[T0-01b:${label}] no registered artifact + PASSING judge → cannot reach done`, async () => {
    const id = nextId(label);
    seedTask(id, title, description);

    const result = await withPassingJudge(() => runQCOnReview(id));

    assert.ok(result !== null, 'QC must return a result');
    assert.equal(
      result.pass,
      false,
      `${label}: QC passed a task with no deliverable — the judge scored the agent's own description`,
    );
    assert.notEqual(
      statusOf(id),
      'done',
      `${label}: task reached done with no deliverable in existence`,
    );
    assert.equal(
      completedEventCount(id),
      0,
      `${label}: a durable task_completed event was written for work that does not exist`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// T0-01 (c) — no regression: a real artifact meeting criteria still passes
// ─────────────────────────────────────────────────────────────────────────────

test('[T0-01c] task WITH a real registered artifact still passes and reaches done', async () => {
  const id = nextId('with-artifact');
  seedTask(id, 'Write the Q3 board memo', 'Draft a two-page memo for the board.');
  addDeliverable(id, 'file', makeRealFile(`${id}.md`));

  const result = await withPassingJudge(() => runQCOnReview(id));

  assert.ok(result !== null, 'QC must return a result');
  assert.equal(result.pass, true, `a delivered, judged-passing task must still pass: ${result.reason}`);
  assert.equal(statusOf(id), 'done', 'a genuinely delivered task must still reach done');
  assert.equal(completedEventCount(id), 1, 'exactly one durable completion event expected');
});

// ─────────────────────────────────────────────────────────────────────────────
// T0-01 (d) — the legitimately artifact-free task: judged, not exempted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The blast-radius case. Some work genuinely produces no file — a decision, a
 * review, a change made in someone else's system. The fix must not exempt those
 * (an exemption is a hole) and must not false-fail them either. They are served
 * by the `url` deliverable type: say where the work landed.
 *
 * Pre-fix this ALSO failed, for a different reason worth noting: `url` was not
 * in the scorer's accepted deliverable set, so an agent that did the right thing
 * for artifact-free work still presented an empty manifest and got scored on its
 * description anyway.
 */
test('[T0-01d] artifact-free task with a url deliverable → judged by a real criterion, passes', async () => {
  const id = nextId('url-evidence');
  seedTask(id, 'Decide the Q3 pricing model', 'Choose between tiered and usage-based pricing.');
  addDeliverable(id, 'url', 'https://example.com/decisions/q3-pricing');

  const result = await withPassingJudge(() => runQCOnReview(id));

  assert.ok(result !== null, 'QC must return a result');
  assert.equal(
    result.pass,
    true,
    `an artifact-free task that recorded where the work landed must not be false-failed: ${result.reason}`,
  );
  assert.equal(statusOf(id), 'done', 'url-evidenced task must be able to complete');
});

test('[T0-01d2] url deliverable that is not a real URL → refused (evidence must be reachable)', async () => {
  const id = nextId('url-junk');
  seedTask(id, 'Decide the Q3 pricing model', 'Choose between tiered and usage-based pricing.');
  addDeliverable(id, 'url', 'see my earlier message');

  const result = await withPassingJudge(() => runQCOnReview(id));

  assert.ok(result !== null, 'QC must return a result');
  assert.equal(result.pass, false, 'an unreachable "deliverable" is not evidence');
  assert.notEqual(statusOf(id), 'done', 'task reached done on a non-URL placeholder');
});

test('[T0-01e] registered file deliverable that does not exist on disk → refused', async () => {
  const id = nextId('ghost-file');
  seedTask(id, 'Produce the quarterly revenue report', 'Summarise revenue by segment.');
  addDeliverable(id, 'file', path.join(TMP_DIR, 'this-file-was-never-written.md'));

  const result = await withPassingJudge(() => runQCOnReview(id));

  assert.ok(result !== null, 'QC must return a result');
  assert.equal(result.pass, false, 'a registered path that does not exist is not evidence');
  assert.notEqual(statusOf(id), 'done', 'task reached done on a deliverable that is not there');
});

// ─────────────────────────────────────────────────────────────────────────────
// T0-42 — master-role promotion without a score is refused
// ─────────────────────────────────────────────────────────────────────────────

function seedMaster(id: string): string {
  // Must be a real UUID: UpdateTaskSchema validates updated_by_agent_id as
  // z.string().uuid(), so a non-UUID id 400s before any gate is reached and the
  // test would "pass" on a validation error instead of on the gate.
  const agentId = randomUUID();
  run(
    `INSERT INTO agents (id, name, role, is_master, workspace_id, status, created_at, updated_at)
     VALUES (?, ?, 'Master Orchestrator', 1, NULL, 'standby', ?, ?)`,
    [agentId, `Master ${id}`, new Date().toISOString(), new Date().toISOString()],
  );
  return agentId;
}

async function patchStatus(id: string, body: Record<string, unknown>) {
  const req = new Request(`http://localhost/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return taskPATCH(req as any, { params: Promise.resolve({ id }) } as any);
}

test('[T0-42a] master-role promotion to done with NO score on record → refused', async () => {
  const id = nextId('master-noscore');
  seedTask(id, 'Reconcile the vendor invoices', 'Match invoices to POs.');
  addDeliverable(id, 'file', makeRealFile(`${id}.csv`)); // evidence present — isolate the SCORE gate
  const masterId = seedMaster(id);

  const res = await patchStatus(id, { status: 'done', updated_by_agent_id: masterId });

  assert.equal(res.status, 403, 'a master promoting with no QC score on record must be refused');
  assert.notEqual(statusOf(id), 'done', 'task was promoted with no score in existence');
  assert.equal(completedEventCount(id), 0, 'a durable completion event was written with no score');
});

test('[T0-42b] master-role promotion with no deliverable → refused (evidence gate)', async () => {
  const id = nextId('master-noevidence');
  seedTask(id, 'Reconcile the vendor invoices', 'Match invoices to POs.');
  const masterId = seedMaster(id);

  const res = await patchStatus(id, { status: 'done', updated_by_agent_id: masterId });

  assert.equal(res.status, 403, 'promotion with no deliverable must be refused');
  assert.notEqual(statusOf(id), 'done', 'task reached done with nothing delivered');
});

/**
 * The bypass the score gate would have had if it kept the original
 * `existing.status === 'review'` condition: an agent that never moved the task
 * to review at all. Requiring `review` as the source status meant the gate could
 * be skipped by skipping the state the gate watched.
 */
test('[T0-42c] agent promotion straight from in_progress → done → refused', async () => {
  const id = nextId('master-inprogress');
  seedTask(id, 'Reconcile the vendor invoices', 'Match invoices to POs.');
  run(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`, [id]);
  addDeliverable(id, 'file', makeRealFile(`${id}-b.csv`));
  const masterId = seedMaster(id);

  const res = await patchStatus(id, { status: 'done', updated_by_agent_id: masterId });

  assert.equal(res.status, 403, 'skipping review must not skip the gate');
  assert.notEqual(statusOf(id), 'done', 'task jumped in_progress → done unjudged');
});

// ─────────────────────────────────────────────────────────────────────────────
// Central chokepoint — transition() itself refuses, override included
// ─────────────────────────────────────────────────────────────────────────────

test('[T0-GATE] transition(id,"done") with no evidence throws — and operatorOverride cannot skip it', async () => {
  const id = nextId('transition-gate');
  seedTask(id, 'Write the launch blog post', 'A 900-word announcement post.');

  await assert.rejects(
    () => transition(id, 'done', { actor: 'test', expectedFrom: 'review' }),
    (err: unknown) =>
      err instanceof TransitionError && (err as InstanceType<typeof TransitionError>).code === 'PRECONDITION_EVIDENCE',
    'transition() must refuse a done with no completion evidence',
  );

  // The override exists to waive ROUTING preconditions. It must not waive the
  // question of whether the work exists — that is not a routing decision, and a
  // waivable existence check is a private door.
  await assert.rejects(
    () => transition(id, 'done', { actor: 'operator', operatorOverride: true, expectedFrom: 'review' }),
    (err: unknown) =>
      err instanceof TransitionError && (err as InstanceType<typeof TransitionError>).code === 'PRECONDITION_EVIDENCE',
    'operatorOverride must not bypass the completion-evidence invariant',
  );

  assert.notEqual(statusOf(id), 'done', 'no path may leave the task done');
  assert.equal(completedEventCount(id), 0, 'no durable completion event may be written');
});

test('[T0-GATE-ok] transition(id,"done") WITH evidence still succeeds', async () => {
  const id = nextId('transition-ok');
  seedTask(id, 'Write the launch blog post', 'A 900-word announcement post.');
  addDeliverable(id, 'file', makeRealFile(`${id}.txt`));

  const updated = await transition(id, 'done', { actor: 'test', expectedFrom: 'review' });
  assert.equal(updated.status, 'done', 'a delivered task must still complete normally');
});
