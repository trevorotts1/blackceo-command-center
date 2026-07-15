/**
 * sop-authoring-natural-key-idempotency.test.ts — F2 regression guard.
 *
 * The FM-6b guard only saw OPEN authoring cards (`status != 'done'` AND not
 * archived). The moment an "Author SOP: X" card was COMPLETED — or ARCHIVED by a
 * board-cleanup pass — the guard went blind and the next dispatch sweep minted an
 * IDENTICAL card for the same (workspace, department, title). With the original
 * task still SOP-less, that repeats on every ~2-minute tick: hundreds of identical
 * cards per workspace (the observed board flood).
 *
 * These tests pin the natural key `(workspace_id, department, title)` (plus the
 * `sop_authoring_for_task_id` back-link): a closed or archived card must SUPPRESS a
 * second card, and the skip must be LOUD (a `sop_authoring_subtask_deduped` event),
 * never silently swallowed.
 *
 * They FAIL on pre-fix code (count goes 1 → 2, and no dedupe event is written).
 *
 * No network: TAVILY_API_KEY is unset below, so the authoring run aborts at the
 * research step — AFTER the point where the pre-fix code would have inserted the
 * duplicate card. What we assert is the CARD COUNT, not the run's outcome.
 *
 *   node --import tsx --test tests/unit/sop-authoring-natural-key-idempotency.test.ts
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import { autoSeedTrioAgents } from '../../src/lib/db';
import { authorSOPForTask } from '../../src/lib/sop-authoring';

// Keep the authoring run OFFLINE and deterministic: with no Tavily key and no
// fixture, the research step throws and the run returns `error` — which happens
// strictly AFTER sub-task creation, so the duplicate-card assertion is unaffected.
delete process.env.TAVILY_API_KEY;
delete process.env.TAVILY_FIXTURE_JSON_PATH;

const db = getDb();

function countCards(title: string): number {
  return queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE title = ?', [title])!.n;
}

function countDedupeEvents(taskId: string): number {
  return queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM events WHERE type = 'sop_authoring_subtask_deduped' AND task_id = ?",
    [taskId],
  )!.n;
}

/** Seed a custom (non-canonical) department workspace with its trio agents. */
function seedWorkspace(dept: string): string {
  const wsId = `${dept}-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    wsId,
    dept,
    dept,
  ]);
  autoSeedTrioAgents(db); // seeds the dept research specialist so trio resolution succeeds
  return wsId;
}

test('a DONE authoring card suppresses a second card for the same (workspace, dept, title)', async () => {
  const dept = 'sprocket-forging-custom';
  const wsId = seedWorkspace(dept);
  const title = 'Welcome to Sprocket Forging';
  const authorTitle = `Author SOP: ${title}`;

  // The original task is NOT in backlog — exactly the live-board shape where §6's
  // `UPDATE ... WHERE status = 'backlog'` sop_id attach silently no-ops, so the task
  // stays SOP-less and the sweep re-enters forever.
  const orig = uuidv4();
  run('INSERT INTO tasks (id, title, department, workspace_id, status) VALUES (?, ?, ?, ?, ?)', [
    orig,
    title,
    dept,
    wsId,
    'pending_dispatch',
  ]);

  // A previous authoring pass already minted its card and CLOSED it.
  const closed = uuidv4();
  run(
    `INSERT INTO tasks (id, title, department, workspace_id, status, sop_authoring_for_task_id, completed_at)
     VALUES (?, ?, ?, ?, 'done', ?, datetime('now'))`,
    [closed, authorTitle, dept, wsId, orig],
  );

  assert.equal(countCards(authorTitle), 1, 'precondition: exactly one authoring card exists');

  await authorSOPForTask({
    originalTaskId: orig,
    title,
    description: null,
    department: dept,
    agentRoleSlug: null,
    workspaceId: wsId,
  });

  assert.equal(
    countCards(authorTitle),
    1,
    'a completed authoring card must NOT be re-minted — the generator is idempotent on (workspace, dept, title)',
  );
  assert.ok(
    countDedupeEvents(orig) >= 1,
    'the skip must be LOUD: a sop_authoring_subtask_deduped event is written, never silently swallowed',
  );
});

test('an ARCHIVED authoring card suppresses a second card (archiving the flood cannot restart it)', async () => {
  const dept = 'gizmo-polishing-custom';
  const wsId = seedWorkspace(dept);
  const title = 'Welcome to Gizmo Polishing';
  const authorTitle = `Author SOP: ${title}`;

  const orig = uuidv4();
  run('INSERT INTO tasks (id, title, department, workspace_id, status) VALUES (?, ?, ?, ?, ?)', [
    orig,
    title,
    dept,
    wsId,
    'backlog',
  ]);

  // The historical clone was ARCHIVED (never deleted — it carries real deliverables).
  // The guard must still see it, or the cleanup itself re-opens the furnace.
  const archived = uuidv4();
  run(
    `INSERT INTO tasks (id, title, department, workspace_id, status, sop_authoring_for_task_id, archived_at)
     VALUES (?, ?, ?, ?, 'in_progress', ?, datetime('now'))`,
    [archived, authorTitle, dept, wsId, orig],
  );

  assert.equal(countCards(authorTitle), 1, 'precondition: exactly one (archived) authoring card exists');

  await authorSOPForTask({
    originalTaskId: orig,
    title,
    description: null,
    department: dept,
    agentRoleSlug: null,
    workspaceId: wsId,
  });

  assert.equal(
    countCards(authorTitle),
    1,
    'an archived authoring card must NOT be re-minted — archive-based cleanup must not restart the furnace',
  );
  assert.ok(
    countDedupeEvents(orig) >= 1,
    'the skip must be LOUD: a sop_authoring_subtask_deduped event is written',
  );
});

test('repeated sweeps against a SOP-less task mint exactly ONE authoring card', async () => {
  const dept = 'widget-lacquering-custom';
  const wsId = seedWorkspace(dept);
  const title = 'Welcome to Widget Lacquering';
  const authorTitle = `Author SOP: ${title}`;

  const orig = uuidv4();
  run('INSERT INTO tasks (id, title, department, workspace_id, status) VALUES (?, ?, ?, ?, ?)', [
    orig,
    title,
    dept,
    wsId,
    'backlog',
  ]);

  const input = {
    originalTaskId: orig,
    title,
    description: null,
    department: dept,
    agentRoleSlug: null,
    workspaceId: wsId,
  };

  // Sweep 1 mints the card. It is then CLOSED (the authoring pass completed but the
  // original never received a sop_id — §6 only attaches `WHERE status = 'backlog'`).
  await authorSOPForTask(input);
  assert.equal(countCards(authorTitle), 1, 'first sweep mints exactly one card');
  run("UPDATE tasks SET status = 'done', completed_at = datetime('now') WHERE title = ?", [authorTitle]);

  // Sweeps 2..4 re-enter on the still-SOP-less task. Pre-fix, each one minted another
  // identical card (1 → 4). The board must stay at exactly one.
  await authorSOPForTask(input);
  await authorSOPForTask(input);
  await authorSOPForTask(input);

  assert.equal(
    countCards(authorTitle),
    1,
    'four dispatch sweeps must still leave exactly ONE authoring card on the board',
  );
});
