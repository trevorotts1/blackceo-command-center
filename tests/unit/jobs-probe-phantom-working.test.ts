/**
 * jobs-probe-phantom-working.test.ts — C-09 / U40 part 2: the phantom
 * `'working'` status defect in src/lib/probes/jobs.ts.
 *
 * GROUNDING: `'working'` is not one of the 10 canonical task statuses
 * (src/lib/types.ts TaskStatus — the real in-flight value is `'in_progress'`),
 * so `probes/jobs.ts`'s working-task count and its "oldest in-flight task"
 * stuck-detection query both matched `status = 'working'` — zero rows, on
 * every box, always. This is the FAIL-FIRST proof: seed one `in_progress`
 * task and assert `probeJobs()` now reports it. Against the pre-fix query
 * (`status = 'working'`) this assertion fails (workingTasks stays 0).
 *
 * Also covers the archived_at IS NULL addition to the pending-count filter
 * (a soft-archived non-done/review task must not inflate the queue depth).
 *
 * Run: node --import tsx --test tests/unit/jobs-probe-phantom-working.test.ts
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run } from '../../src/lib/db';
import { probeJobs } from '../../src/lib/probes/jobs';

getDb(); // apply full migration chain

function seedTask(opts: { status: string; archivedAt?: string | null }): string {
  const id = uuidv4();
  // workspace_id explicitly NULL (not the 'default' column default) — this
  // isolated test DB never seeds a 'default' workspace row, and workspace_id
  // carries a REFERENCES workspaces(id) foreign key, so the DEFAULT would
  // otherwise 400 with a FK violation. Mirrors board-hygiene.test.ts's
  // seedTask fixture.
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, business_id, archived_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, ?, ?)`,
    [id, `probe fixture ${id.slice(0, 8)}`, opts.status, opts.archivedAt ?? null, new Date().toISOString()],
  );
  return id;
}

test('probeJobs: reports a nonzero working count for a fixture with one in_progress task', async () => {
  const taskId = seedTask({ status: 'in_progress' });

  const result = await probeJobs();

  assert.equal(result.component, 'jobs');
  const detail = result.detail as { workingTasks: number; oldestWorkingTask: string | null } | undefined;
  assert.ok(detail, 'probeJobs must return a detail object');
  assert.equal(
    detail!.workingTasks,
    1,
    'FAIL-FIRST: the pre-fix query filtered on status = \'working\' (not a real status) and always reported 0',
  );
  assert.equal(detail!.oldestWorkingTask, taskId);
});

test('probeJobs: a task literally carrying the phantom string "working" (never a real status, but belt-and-suspenders) is NOT counted', async () => {
  // The 'status' column CHECK constraint rejects any value outside the 10
  // canonical statuses, so this insert itself must fail — the strongest
  // possible proof that 'working' can never be a live row's status.
  const id = uuidv4();
  assert.throws(() => {
    run(`INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)`, [id, 'phantom status fixture', 'working']);
  }, /CHECK constraint failed/);
});

test('probeJobs: pending count excludes archived tasks (archived_at IS NULL filter)', async () => {
  // A soft-archived task outside done/review must not inflate the pending
  // (queue-depth) count used for the busy/degraded thresholds. Delta-based
  // (before/after) so this test is independent of any tasks earlier tests in
  // this file already seeded.
  const before = (await probeJobs()).detail as { pendingTasks: number } | undefined;
  assert.ok(before);

  seedTask({ status: 'blocked', archivedAt: new Date().toISOString() }); // archived — must be excluded
  seedTask({ status: 'blocked', archivedAt: null }); // live — must be counted

  const after = (await probeJobs()).detail as { pendingTasks: number } | undefined;
  assert.ok(after);
  assert.equal(
    after!.pendingTasks,
    before!.pendingTasks + 1,
    'exactly the one non-archived blocked task should raise the pending count; the archived one must be excluded',
  );
});
