/**
 * board-hygiene-blend-invariant-at-min.test.ts — A-U6 CC-half companion proof,
 * the "zero alerts" complement to
 * board-hygiene-blend-invariant-below-min.test.ts (per the 2026-07-15 spec
 * amendment's criterion (f)).
 *
 * A SEEDED at-or-above-min confirmed content-task bundle window must raise
 * ZERO `persona_blend_regression` alerts — proven from its own isolated DB
 * (own temp DATABASE_PATH, per this repo's `_isolated-db.ts` convention) so
 * this is a fully independent proof, not merely "the cooldown from another
 * test suppressed it".
 *
 *   node --import tsx --test tests/unit/board-hygiene-blend-invariant-at-min.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.DISABLE_BOARD_HYGIENE_BLEND_INVARIANT;
process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '1';
process.env.DISABLE_BOARD_HYGIENE_REVIEW = '1';
process.env.DISABLE_BOARD_HYGIENE_DONE = '1';
process.env.DISABLE_BOARD_HYGIENE_STALE = '1';
process.env.DISABLE_BOARD_HYGIENE_BLEND_REGRESSION = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(
  path.join(os.tmpdir(), 'bc-hygiene-blend-invariant-at-workspace-'),
);

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryAll } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';

getDb();

function seedTask(title: string, createdAt: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'done', NULL, NULL, ?, ?)`,
    [id, title, createdAt, createdAt],
  );
  return id;
}

function seedBundle(taskId: string, confirmState: string, bundle: Record<string, unknown>, createdAt: string): void {
  run(
    `INSERT INTO task_persona_bundle (id, task_id, bundle_json, catalog_version, confirm_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), taskId, JSON.stringify(bundle), '1.3', confirmState, createdAt],
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

// A CONFIRMED content-task bundle with a genuine BLEND (2 distinct personas,
// not collapsed) — count=3 with the primary task-side persona, comfortably
// inside [2,4].
const BLEND_BUNDLE = {
  content_task: true,
  confirm_required: false,
  voice: {
    collapsed: false,
    collapsed_persona_id: null,
    audience_persona: { id: 'audience-persona', why: 'seeded' },
    topic_persona: { id: 'topic-persona', why: 'seeded' },
  },
  task_personas: [{ persona_id: 'task-side-persona', why: 'seeded' }],
  rationale: {
    invariant: {
      ok: true, count: 3, collapsed: false, reason: 'ok',
      roles: [
        { role: 'voice', persona_id: 'audience-persona' },
        { role: 'topic', persona_id: 'topic-persona' },
        { role: 'task', persona_id: 'task-side-persona' },
      ],
    },
  },
};

// A CONFIRMED content-task bundle that COLLAPSED (D-A2 role count = 2) — also
// at-or-above-min, must NOT be flagged.
const COLLAPSED_AT_MIN_BUNDLE = {
  content_task: true,
  confirm_required: false,
  voice: {
    collapsed: true,
    collapsed_persona_id: 'collapsed-persona-2',
    audience_persona: null,
    topic_persona: { id: 'collapsed-persona-2', why: 'seeded' },
  },
  task_personas: [],
  rationale: {
    invariant: {
      ok: true, count: 2, collapsed: true, reason: 'collapsed',
      roles: [
        { role: 'voice', persona_id: 'collapsed-persona-2' },
        { role: 'topic', persona_id: 'collapsed-persona-2' },
      ],
    },
  },
};

test.before(() => {
  const t1 = seedTask('Write the funnel launch email (blend, at-min)', nowIso());
  seedBundle(t1, 'confirmed', BLEND_BUNDLE, nowIso());

  const t2 = seedTask('Write the budgeting newsletter (collapsed, at-min)', nowIso());
  seedBundle(t2, 'confirmed', COLLAPSED_AT_MIN_BUNDLE, nowIso());
});

test('SEEDED at-or-above-min confirmed content bundles raise ZERO persona_blend_regression alerts', async () => {
  const result = await runBoardHygiene();

  assert.equal(result.blendInvariantBelowMinCount, 0);
  assert.equal(result.blendInvariantRegressionFlagged, false);

  const events = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE type = 'persona_blend_regression'`,
    [],
  );
  assert.equal(events.length, 0, 'no alert fires when everything in the window is at-or-above-min');
});
