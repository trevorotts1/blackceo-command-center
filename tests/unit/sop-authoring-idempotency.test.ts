/**
 * sop-authoring-idempotency.test.ts — FM-6b runtime guard (DB-backed).
 *
 * Proves the dispatch-time furnace is stopped at the source: when an OPEN
 * "Author SOP: X" sub-task already exists for an original task, a re-entry of
 * authorSOPForTask returns `deduped` and creates NO new sub-task. The guard runs
 * before any research/synthesis, so this never touches Tavily/Gemini.
 *
 *   DATABASE_PATH=/tmp/scratch-sopauth.db node --import tsx --test tests/unit/sop-authoring-idempotency.test.ts
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { autoSeedTrioAgents } from '../../src/lib/db';
import { authorSOPForTask } from '../../src/lib/sop-authoring';

// Isolated, freshly-migrated DB (workspaces/tasks/agents empty).
const db = getDb();

test('authorSOPForTask dedupes when an open authoring sub-task already exists (no duplicate created)', async () => {
  const dept = 'widget-research-custom'; // custom (non-canonical) dept
  const wsId = `${dept}-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [wsId, 'Widget Research', dept]);
  autoSeedTrioAgents(db); // seeds the dept research specialist so trio resolution succeeds

  const orig = uuidv4();
  run('INSERT INTO tasks (id, title, workspace_id, status) VALUES (?, ?, ?, ?)', [
    orig, 'Build a custom widget', wsId, 'backlog',
  ]);
  // Pre-existing OPEN authoring sub-task for this original task (the first sweep's output).
  const pre = uuidv4();
  run(
    'INSERT INTO tasks (id, title, department, workspace_id, status, sop_authoring_for_task_id) VALUES (?, ?, ?, ?, ?, ?)',
    [pre, 'Author SOP: Build a custom widget', dept, wsId, 'in_progress', orig],
  );

  const countBefore = (queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Author SOP: Build a custom widget'",
  ))!.n;

  const result = await authorSOPForTask({
    originalTaskId: orig,
    title: 'Build a custom widget',
    description: null,
    department: dept,
    agentRoleSlug: null,
    workspaceId: wsId,
  });

  assert.equal(result.status, 'deduped', 'a second pass must dedupe, not author');
  assert.equal(result.sub_task_id, pre, 'it reuses the existing open authoring sub-task');

  const countAfter = (queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Author SOP: Build a custom widget'",
  ))!.n;
  assert.equal(countAfter, countBefore, 'no new authoring sub-task was created');
});
