/**
 * cc-board-dedup-reaper.test.ts — FM-6 board-health guards (DB-backed).
 *
 * Runs against a THROWAWAY DB. The harness MUST set DATABASE_PATH to a scratch
 * file BEFORE this process imports @/lib/db (getDb() is a lazy singleton keyed on
 * DATABASE_PATH at first call). Never point this at mission-control.db.
 *
 *   DATABASE_PATH=/tmp/scratch-dedup.db node --import tsx --test tests/unit/cc-board-dedup-reaper.test.ts
 *
 * Covers:
 *   • dedupeCanonicalWorkspaces — duplicate dept rows merge to the canonical
 *     keeper; agents/tasks reassigned; NO duplicate department slugs remain.
 *   • findCanonicalWorkspaceId — the seeding-path slug-uniqueness guard.
 *   • reapDuplicateOpenAuthoringTasks — keeps exactly one open "Author SOP" task
 *     and is idempotent (no duplicate open tasks).
 *   • migration 080 — tasks.process_certificate_sha exists (FIX C storage).
 *   • resolveSpecialistSessionKey — a legacy/aliased slug (ceo) resolves to its
 *     canonical runtime dir (dept-master-orchestrator).
 */

import './_isolated-db'; // MUST be first: points DATABASE_PATH at a throwaway DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import {
  dedupeCanonicalWorkspaces,
  reapDuplicateOpenAuthoringTasks,
  findCanonicalWorkspaceId,
} from '../../src/lib/db/task-dedup';
import { resolveSpecialistSessionKey } from '../../src/lib/task-dispatcher';
import type { Agent } from '../../src/lib/types';

// Isolated, freshly-migrated DB (080/081/082 applied; workspaces/tasks empty).
const db = getDb();

function seedWorkspace(slug: string, name = slug): string {
  const id = `${slug}-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [id, name, slug]);
  return id;
}

test('migration 080 added tasks.process_certificate_sha (FIX C storage)', () => {
  const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('process_certificate_sha'), 'process_certificate_sha column must exist');
});

test('dedupeCanonicalWorkspaces merges `ceo` into `master-orchestrator` and reassigns agents+tasks', () => {
  const moId = seedWorkspace('master-orchestrator', 'Master');
  const ceoId = seedWorkspace('ceo', 'CEO');

  const agentId = uuidv4();
  run('INSERT INTO agents (id, name, role, workspace_id, is_master) VALUES (?, ?, ?, ?, 0)', [
    agentId, 'Legacy Agent', 'Lead', ceoId,
  ]);
  const taskId = uuidv4();
  run('INSERT INTO tasks (id, title, status, workspace_id) VALUES (?, ?, ?, ?)', [
    taskId, 'Legacy task', 'backlog', ceoId,
  ]);

  const r = dedupeCanonicalWorkspaces(db);
  assert.ok(r.groups_merged >= 1, 'at least one group merged');

  const survivors = queryAll<{ id: string; slug: string }>(
    'SELECT id, slug FROM workspaces WHERE id IN (?, ?)',
    [moId, ceoId],
  );
  assert.equal(survivors.length, 1, 'exactly one workspace survives the merge');
  assert.equal(survivors[0].id, moId, 'the canonical-slug row is the keeper');
  assert.equal(survivors[0].slug, 'master-orchestrator');

  assert.equal(
    queryOne<{ workspace_id: string }>('SELECT workspace_id FROM agents WHERE id = ?', [agentId])?.workspace_id,
    moId,
    'agent reassigned to keeper',
  );
  assert.equal(
    queryOne<{ workspace_id: string }>('SELECT workspace_id FROM tasks WHERE id = ?', [taskId])?.workspace_id,
    moId,
    'task reassigned to keeper',
  );

  const dupSlugs = queryAll<{ slug: string; n: number }>(
    'SELECT slug, COUNT(*) AS n FROM workspaces GROUP BY slug HAVING n > 1',
  );
  assert.equal(dupSlugs.length, 0, 'no duplicate department slugs remain');
});

test('dedupeCanonicalWorkspaces collapses `app-development` into the canonical `engineering`', () => {
  const engId = seedWorkspace('engineering');
  const appId = seedWorkspace('app-development');

  dedupeCanonicalWorkspaces(db);

  const survivors = queryAll<{ id: string; slug: string }>(
    'SELECT id, slug FROM workspaces WHERE id IN (?, ?)',
    [engId, appId],
  );
  assert.equal(survivors.length, 1);
  assert.equal(survivors[0].slug, 'engineering', 'engineering is the canonical keeper (2026-06-28 UNIT-ENG)');
});

test('findCanonicalWorkspaceId recognises an aliased slug as an existing department', () => {
  // `master-orchestrator` exists from the merge test above.
  const owner = findCanonicalWorkspaceId(db, 'ceo');
  assert.ok(owner, 'ceo resolves to the existing master-orchestrator workspace');
  const slug = queryOne<{ slug: string }>('SELECT slug FROM workspaces WHERE id = ?', [owner!])?.slug;
  assert.equal(slug, 'master-orchestrator');
  assert.equal(findCanonicalWorkspaceId(db, 'dept-ceo'), owner, 'dept- prefixed alias resolves the same');
  assert.equal(findCanonicalWorkspaceId(db, 'totally-unrelated-xyz'), null, 'an unrelated slug has no owner');
});

test('reapDuplicateOpenAuthoringTasks collapses reapable (non-live) "Author SOP" clones and is idempotent', () => {
  const orig = uuidv4();
  const dept = 'widget-research'; // custom (non-canonical) dept
  const wsId = seedWorkspace('widget-research'); // real workspace (mirrors production authoring tasks)
  // Spurious clones in a NON-live state (DATA-04: only idle clones are reapable).
  for (let i = 0; i < 4; i++) {
    run(
      'INSERT INTO tasks (id, title, department, workspace_id, status, sop_authoring_for_task_id) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), 'Author SOP: Widget', dept, wsId, 'backlog', orig],
    );
  }
  // A real client deliverable that must NEVER be reaped.
  const realId = uuidv4();
  run('INSERT INTO tasks (id, title, department, workspace_id, status) VALUES (?, ?, ?, ?, ?)', [
    realId, 'Build the widget onboarding deck', dept, wsId, 'in_progress',
  ]);

  const r1 = reapDuplicateOpenAuthoringTasks(db);
  assert.ok(r1.deleted >= 3, 'reaps the 3 spurious clones');

  const openAuthoring = queryAll<{ id: string }>(
    "SELECT id FROM tasks WHERE title = 'Author SOP: Widget' AND status != 'done'",
  );
  assert.equal(openAuthoring.length, 1, 'exactly one open authoring task remains');
  assert.ok(queryOne('SELECT id FROM tasks WHERE id = ?', [realId]), 'the real deliverable is untouched');

  const r2 = reapDuplicateOpenAuthoringTasks(db);
  assert.equal(r2.deleted, 0, 'idempotent — a clean board reaps nothing on the second pass');
});

test('reapDuplicateOpenAuthoringTasks NEVER reaps a live in_progress/assigned authoring task (DATA-04)', () => {
  const orig = uuidv4();
  const dept = 'gizmo-research';
  const wsId = seedWorkspace('gizmo-research');
  // Four IDENTICAL open authoring rows, ALL with a live dispatch (two in_progress,
  // two assigned). A live dispatch = an ACTIVE specialist session; deleting any of
  // them would strand its run, so the reaper must protect EVERY one.
  const liveIds: string[] = [];
  for (const status of ['in_progress', 'in_progress', 'assigned', 'assigned']) {
    const id = uuidv4();
    liveIds.push(id);
    run(
      'INSERT INTO tasks (id, title, department, workspace_id, status, sop_authoring_for_task_id) VALUES (?, ?, ?, ?, ?, ?)',
      [id, 'Author SOP: Gizmo', dept, wsId, status, orig],
    );
  }

  reapDuplicateOpenAuthoringTasks(db);

  const survivors = queryAll<{ id: string }>(
    "SELECT id FROM tasks WHERE title = 'Author SOP: Gizmo' AND status != 'done'",
  );
  assert.equal(survivors.length, 4, 'all four live authoring rows survive — none reaped');
  for (const id of liveIds) {
    assert.ok(queryOne('SELECT id FROM tasks WHERE id = ?', [id]), `live row ${id} untouched`);
  }
});

test('reapDuplicateOpenAuthoringTasks keeps a LIVE row as keeper and reaps only the idle clones (DATA-04)', () => {
  const orig = uuidv4();
  const dept = 'sprocket-research';
  const wsId = seedWorkspace('sprocket-research');
  // One live (in_progress) row + three idle (planning) clones of the same task.
  const liveId = uuidv4();
  run(
    'INSERT INTO tasks (id, title, department, workspace_id, status, sop_authoring_for_task_id) VALUES (?, ?, ?, ?, ?, ?)',
    [liveId, 'Author SOP: Sprocket', dept, wsId, 'in_progress', orig],
  );
  for (let i = 0; i < 3; i++) {
    run(
      'INSERT INTO tasks (id, title, department, workspace_id, status, sop_authoring_for_task_id) VALUES (?, ?, ?, ?, ?, ?)',
      [uuidv4(), 'Author SOP: Sprocket', dept, wsId, 'planning', orig],
    );
  }

  reapDuplicateOpenAuthoringTasks(db);

  assert.ok(queryOne('SELECT id FROM tasks WHERE id = ?', [liveId]), 'the LIVE row is kept as the keeper');
  const survivors = queryAll<{ id: string }>(
    "SELECT id FROM tasks WHERE title = 'Author SOP: Sprocket' AND status != 'done'",
  );
  assert.equal(survivors.length, 1, 'exactly one row remains — the three idle clones were reaped');
  assert.equal(survivors[0].id, liveId, 'and the survivor is the live one');
});

test('resolveSpecialistSessionKey resolves a legacy slug (ceo) to its canonical runtime dir', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
  fs.mkdirSync(path.join(tmpHome, '.openclaw', 'agents', 'dept-master-orchestrator'), { recursive: true });
  const prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    // A workspace whose slug is the LEGACY alias `ceo` (canonical: master-orchestrator).
    const wsId = seedWorkspace('ceo', 'CEO');
    const agent = { id: uuidv4(), name: 'No Match Agent', role: 'Nonexistent Role', workspace_id: wsId } as unknown as Agent;
    const key = resolveSpecialistSessionKey(agent, 'sess-123', wsId, 'test');
    assert.equal(
      key,
      'agent:dept-master-orchestrator:sess-123',
      'legacy ceo slug resolves to the canonical dept-master-orchestrator runtime',
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
