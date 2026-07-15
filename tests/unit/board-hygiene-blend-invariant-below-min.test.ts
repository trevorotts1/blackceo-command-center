/**
 * board-hygiene-blend-invariant-below-min.test.ts — A-U6 CC-half companion
 * proof (per the 2026-07-15 spec amendment's new criterion (f)).
 *
 * ONB's validate_blend_invariant (persona_blend.py) records the min-2/max-4
 * role-count reading on every content bundle as `rationale.invariant`; that
 * full bundle rides unmodified into `task_persona_bundle.bundle_json` via
 * persistPersonaBundle. This proves the board-hygiene Rule-6 COMPANION count
 * (processBlendInvariantRegressionCheck): from a SEEDED confirmed
 * content-task bundle still reading below-min in the trailing window, the
 * companion raises EXACTLY ONE `persona_blend_regression` alert on the
 * EXISTING lane (board-hygiene.ts:95) — deterministically, from seed rows,
 * with NO producer/funnel run and NO live box.
 *
 * A companion at-or-above-min row rides alongside in the SAME seeded window
 * to prove the count is SELECTIVE (only the genuinely below-min row counts),
 * not merely "any row present". The complementary "zero alerts when nothing
 * is below-min" proof lives in the sibling
 * board-hygiene-blend-invariant-at-min.test.ts (its OWN isolated DB — the
 * cooldown this check shares with Rule 6 would otherwise mask that path if
 * it ran second in the SAME process/db after this file's alert fires).
 *
 *   node --import tsx --test tests/unit/board-hygiene-blend-invariant-below-min.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.DISABLE_BOARD_HYGIENE_BLEND_INVARIANT;
// Isolate this proof to ONLY the invariant companion — the other five lanes
// (+ Rule 6's own zero-bundle check) have nothing to match against the seed
// below anyway, but disabling them keeps this a single-condition proof.
process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '1';
process.env.DISABLE_BOARD_HYGIENE_REVIEW = '1';
process.env.DISABLE_BOARD_HYGIENE_DONE = '1';
process.env.DISABLE_BOARD_HYGIENE_STALE = '1';
process.env.DISABLE_BOARD_HYGIENE_BLEND_REGRESSION = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(
  path.join(os.tmpdir(), 'bc-hygiene-blend-invariant-below-workspace-'),
);

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryAll } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';

getDb(); // apply full migration chain (090 creates task_persona_bundle)

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

// A CONFIRMED content-task bundle whose ONB-computed invariant reading is
// below-min (mirrors validate_blend_invariant's real shape from
// persona_blend.py — {ok, count, roles, collapsed, reason}).
const BELOW_MIN_BUNDLE = {
  content_task: true,
  confirm_required: false,
  voice: {
    collapsed: false,
    collapsed_persona_id: null,
    audience_persona: null,
    topic_persona: { id: 'topic-only-persona', why: 'seeded' },
  },
  task_personas: [],
  rationale: {
    invariant: { ok: false, count: 1, roles: [{ role: 'topic', persona_id: 'topic-only-persona' }],
                 collapsed: false, reason: 'below-min' },
  },
};

// A CONFIRMED content-task bundle at min (count=2, ok=true) — seeded ALONGSIDE
// the below-min row to prove the companion count is SELECTIVE.
const AT_MIN_BUNDLE = {
  content_task: true,
  confirm_required: false,
  voice: {
    collapsed: true,
    collapsed_persona_id: 'collapsed-persona',
    audience_persona: null,
    topic_persona: { id: 'collapsed-persona', why: 'seeded' },
  },
  task_personas: [],
  rationale: {
    invariant: { ok: true, count: 2, roles: [
      { role: 'voice', persona_id: 'collapsed-persona' },
      { role: 'topic', persona_id: 'collapsed-persona' },
    ], collapsed: true, reason: 'collapsed' },
  },
};

test.before(() => {
  const t1 = seedTask('Write the launch email sequence (below-min)', nowIso());
  seedBundle(t1, 'confirmed', BELOW_MIN_BUNDLE, nowIso());

  const t2 = seedTask('Write the sales page copy (at-min)', nowIso());
  seedBundle(t2, 'confirmed', AT_MIN_BUNDLE, nowIso());

  // A PENDING (unconfirmed) below-min bundle — must be EXCLUDED (only
  // confirm_state='confirmed' rows count; A.7's "the invariant binds the
  // POST-CONFIRM bundle" — a pending below-min row is a legal in-flight
  // state, not yet eligible for the regression alert).
  const t3 = seedTask('Write the newsletter (pending, below-min)', nowIso());
  seedBundle(t3, 'pending', BELOW_MIN_BUNDLE, nowIso());

  // A CONFIRMED non-content-task bundle reading "exempt" — must be EXCLUDED
  // (content_task !== true, mirrors the ONB validator's own exemption).
  const t4 = seedTask('Restart the deployment server (non-content)', nowIso());
  seedBundle(
    t4,
    'confirmed',
    { content_task: false, rationale: { invariant: { ok: true, count: 0, roles: [], collapsed: false, reason: 'exempt-non-content' } } },
    nowIso(),
  );
});

test('SEEDED confirmed below-min content bundle raises EXACTLY ONE persona_blend_regression alert', async () => {
  const result = await runBoardHygiene();

  assert.equal(result.blendInvariantBelowMinCount, 1, 'only the ONE genuinely below-min confirmed row counts');
  assert.equal(result.blendInvariantRegressionFlagged, true);

  const events = queryAll<{ message: string }>(
    `SELECT message FROM events WHERE type = 'persona_blend_regression'`,
    [],
  );
  assert.equal(events.length, 1, 'exactly one alert on the existing persona_blend_regression lane');
  assert.match(events[0].message, /INVARIANT REGRESSION/);
  assert.match(events[0].message, /1 CONFIRMED content-task bundle/);
});

test('a SECOND run within the cooldown does not double-fire (existing lane cooldown honored)', async () => {
  const before = queryAll(`SELECT id FROM events WHERE type = 'persona_blend_regression'`, []).length;
  await runBoardHygiene();
  const after = queryAll(`SELECT id FROM events WHERE type = 'persona_blend_regression'`, []).length;
  assert.equal(after, before, 'cooldown-guarded — no re-fire on an immediate second run');
});
