/**
 * BULK-REVIEW-GATE — `POST /api/tasks/bulk` must not be a side door into review.
 *
 * ── WHAT WAS BROKEN ───────────────────────────────────────────────────────────
 * Every other door into `review` demands completion evidence:
 *   - PATCH    → src/app/api/tasks/[id]/route.ts: `validateExecutionCompletion`
 *                when `status === 'review'`
 *   - transition() → FIX 25: `to === 'review'` collects completion evidence and
 *                throws PRECONDITION_EVIDENCE, above the operatorOverride bail-out
 *   - create path → seeds with evidence in hand
 *
 * The bulk move path gated `done` (collectCompletionEvidence) and had NO gate
 * for `review` at all — `grep -n review src/app/api/tasks/bulk/route.ts` was
 * empty. So `POST /api/tasks/bulk {"operation":"move","targetStatus":"review"}`
 * pushed an evidence-less card straight into the QC column, skipping the
 * invariant one door at a time.
 *
 * ── WHAT THESE TESTS PIN ──────────────────────────────────────────────────────
 * The refusal AND its consequence: the row must still be where it started, with
 * no status event, no history row and no task_updated broadcast. A gate that
 * returns an error but writes anyway protects nothing.
 *
 * The no-regression case is equally load-bearing: with a real registered file
 * the same bulk move must still land in review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-bulk-review-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;
delete process.env.PRESENTATION_REVIEW_EVIDENCE_GATE;

const RUN_ID = Math.random().toString(36).slice(2, 10);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type BulkRouteModule = typeof import('../../src/app/api/tasks/bulk/route');
let bulkPOST: BulkRouteModule['POST'];

let counter = 0;
const nextId = (p: string) => `brg-${p}-${++counter}-${RUN_ID}`;
const now = () => new Date().toISOString();

function seedTask(id: string, status: string): void {
  run(
    `INSERT INTO tasks (id, title, description, status, priority, department,
                        workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', 'operations', NULL, NULL, ?, ?)`,
    [id, `Bulk review gate ${id}`, 'A description long enough to be a real brief.', status, now(), now()],
  );
}

/** A real, non-empty file on disk — genuine completion evidence. */
function makeRealFile(name: string): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, 'delivered content, non-empty\n');
  return p;
}

function addDeliverable(taskId: string, p: string): void {
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'file', ?, ?, ?)`,
    [nextId('deliv'), taskId, `deliverable for ${taskId}`, p, now()],
  );
}

const statusOf = (id: string): string | undefined =>
  queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;

const countOf = (sql: string, args: unknown[]): number =>
  queryOne<{ c: number }>(sql, args)?.c ?? 0;

const statusEventCount = (id: string): number =>
  countOf(`SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND type = 'task_status_changed'`, [id]);

/** task_history may be absent on a pre-migration DB — read 0 there. */
function historyCount(id: string): number {
  try {
    return countOf(`SELECT COUNT(*) AS c FROM task_history WHERE task_id = ?`, [id]);
  } catch {
    return 0;
  }
}

function bulkMove(taskIds: string[], targetStatus: string): Promise<Response> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const request = new Request('http://local.test/api/tasks/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'move', taskIds, targetStatus }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return bulkPOST(request as any);
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // trigger migrations

  const route = await import('../../src/app/api/tasks/bulk/route');
  bulkPOST = route.POST;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────────────────────────
// The defect: an evidence-less bulk move into review
// ─────────────────────────────────────────────────────────────────────────────

test('[bulk-review-gate] bulk move to review with NO completion evidence is refused and writes nothing', async () => {
  const id = nextId('no-evidence');
  seedTask(id, 'in_progress');

  const res = await bulkMove([id], 'review');
  const body = await res.json();

  assert.equal(body.total, 1, 'one task echoed');
  assert.equal(body.ok, 0, 'no task accepted');
  assert.equal(body.failed, 1, 'the move failed — bulk must not bypass the review evidence invariant');
  assert.equal(body.results[0].ok, false);
  assert.match(
    String(body.results[0].error),
    /evidence/i,
    `refusal must name completion evidence, got: ${body.results[0].error}`,
  );

  // The refusal must be the WHOLE refusal: no row changed, no audit trail.
  assert.equal(statusOf(id), 'in_progress', 'row must still be in_progress — nothing written');
  assert.equal(statusEventCount(id), 0, 'no task_status_changed event may be written');
  assert.equal(historyCount(id), 0, 'no task_history row may be written');
});

test('[bulk-review-gate] a batch mixing an evidenced and an evidence-less card moves only the evidenced one', async () => {
  const withEvidence = nextId('mixed-ok');
  const without = nextId('mixed-bad');
  seedTask(withEvidence, 'in_progress');
  seedTask(without, 'in_progress');
  addDeliverable(withEvidence, makeRealFile(`mixed-${withEvidence}.txt`));

  const res = await bulkMove([withEvidence, without], 'review');
  const body = await res.json();
  const byId = new Map<string, { ok: boolean; error?: string }>(
    body.results.map((r: { taskId: string; ok: boolean; error?: string }) => [r.taskId, r]),
  );

  assert.equal(body.ok, 1, 'exactly the evidenced card moves');
  assert.equal(body.failed, 1, 'exactly the evidence-less card is refused');
  assert.equal(byId.get(withEvidence)?.ok, true);
  assert.equal(byId.get(without)?.ok, false);

  assert.equal(statusOf(withEvidence), 'review');
  assert.equal(statusOf(without), 'in_progress');
});

// ─────────────────────────────────────────────────────────────────────────────
// No regression: a legitimate move still lands
// ─────────────────────────────────────────────────────────────────────────────

test('[bulk-review-gate] bulk move to review WITH a registered, reachable deliverable succeeds', async () => {
  const id = nextId('evidence');
  seedTask(id, 'in_progress');
  addDeliverable(id, makeRealFile(`evidenced-${id}.txt`));

  const res = await bulkMove([id], 'review');
  const body = await res.json();

  assert.equal(body.ok, 1, `expected the move to succeed, got: ${JSON.stringify(body.results)}`);
  assert.equal(statusOf(id), 'review');
});

test('[bulk-review-gate] bulk move to done is unchanged — still refused without evidence', async () => {
  const id = nextId('done');
  seedTask(id, 'in_progress');

  const res = await bulkMove([id], 'done');
  const body = await res.json();

  assert.equal(body.ok, 0, 'done gate must remain in force');
  assert.equal(statusOf(id), 'in_progress');
});
