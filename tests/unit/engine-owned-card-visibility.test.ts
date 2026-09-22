/**
 * STRANDED-02 — an engine-owned card the board refuses is visible, not silent.
 *
 * THE REFUSAL IS CORRECT AND STAYS. A card whose ingest `source` belongs to an
 * engine (build_deck / build_deck_phase / podcast-engine) is created, sequenced
 * and completed by that engine; a board dispatch would put a SECOND executor on
 * the same work (FIX 38a/38b). Every advancer excludes these rows in its SELECT
 * and GUARD 4d refuses any direct call.
 *
 * THE DEFECT was that the refusal left no trace a human reads. Live evidence:
 * card e9393e31 (source=podcast-engine) sat in backlog looking exactly like
 * ordinary queued work while its owning engine's last run had failed hours
 * earlier with a file-lock deadlock, and nobody was told. A client saw a card
 * that never moved and no explanation.
 *
 * Covered here:
 *   1. the first refusal writes the visible reason on the card,
 *   2. repeated refusals do not spam it,
 *   3. a card refused past the stale window earns exactly ONE operator alert,
 *      naming the engine and the last recorded failure,
 *   4. a card the engine later runs clears the marker and re-arms,
 *   5. a non-engine card is untouched by all of it.
 */
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_BOARD_HYGIENE;

// Only the engine-owned lane runs: every other lane is an unrelated rule with
// its own fixtures and its own network/LLM reach.
process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '1';
process.env.DISABLE_BOARD_HYGIENE_REVIEW = '1';
process.env.DISABLE_BOARD_HYGIENE_DONE = '1';
process.env.DISABLE_BOARD_HYGIENE_STALE = '1';
process.env.DISABLE_BOARD_HYGIENE_TRIAD = '1';
process.env.DISABLE_BOARD_HYGIENE_BLEND_REGRESSION = '1';
process.env.DISABLE_BOARD_HYGIENE_BLEND_INVARIANT = '1';
process.env.DISABLE_BOARD_HYGIENE_WINNER_HARVEST = '1';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-engine-owned-workspace-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryAll } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';
import {
  ENGINE_OWNED_SOURCES,
  engineOwnedWaitingLabel,
  boardSourceLabel,
} from '../../src/lib/board-sources';

getDb();

const HOUR = 3_600_000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

const AGENT_ID = 'agent-engine-owned';

test.before(() => {
  run(`INSERT INTO agents (id, name, role, is_master, workspace_id) VALUES (?, ?, 'specialist', 0, NULL)`,
    [AGENT_ID, 'Engine Owned Test Agent']);
});

function seedCard(id: string, source: string | null, opts: { status?: string; updatedHoursAgo?: number } = {}): void {
  const updated = hoursAgo(opts.updatedHoursAgo ?? 0);
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id,
        business_id, sop_id, persona_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', ?, NULL, NULL, NULL, 'hormozi-100m-offers', ?, ?, ?)`,
    [id, `Engine card ${id}`, 'seeded card', opts.status ?? 'backlog', AGENT_ID, source, updated, updated],
  );
}

/** Rows that carry the visible "the board does not dispatch this card" reason. */
const holdRows = (taskId: string) =>
  queryAll<{ message: string }>(
    `SELECT message FROM task_activities
      WHERE task_id = ? AND message LIKE '%the board does not dispatch this card%'`,
    [taskId],
  );

const stallAlerts = (taskId: string) =>
  queryAll<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'board_hygiene_engine_owned_stalled'`,
    [taskId],
  );

// ── The vocabulary the refusal and the label share ──────────────────────────

test('[STRANDED-02] the display vocabulary matches the sources the dispatcher refuses', () => {
  // If an engine source is ever added to the dispatcher's guard without being
  // added here, its cards would be refused with no label — the exact silence
  // this fix removes.
  assert.deepEqual(
    [...ENGINE_OWNED_SOURCES].sort(),
    ['build_deck', 'build_deck_phase', 'podcast-engine'],
  );
  for (const source of ENGINE_OWNED_SOURCES) {
    assert.ok(boardSourceLabel(source), `${source} must have a human name`);
    assert.match(
      String(engineOwnedWaitingLabel(source, 'backlog')),
      /^Waiting on .+ — the board does not dispatch this card$/,
    );
  }
});

test('[STRANDED-02] the board label appears only while the card is waiting, and never for a board card', () => {
  assert.ok(engineOwnedWaitingLabel('podcast-engine', 'backlog'));
  assert.ok(engineOwnedWaitingLabel('podcast-engine', 'inbox'));
  // Moving — the engine took it. The label clears itself.
  assert.equal(engineOwnedWaitingLabel('podcast-engine', 'in_progress'), null);
  assert.equal(engineOwnedWaitingLabel('podcast-engine', 'done'), null);
  // An ordinary board card is never labelled.
  assert.equal(engineOwnedWaitingLabel('anthology', 'backlog'), null);
  assert.equal(engineOwnedWaitingLabel(null, 'backlog'), null);
});

// ── 1 + 2: the first refusal is recorded, repeats are not ───────────────────

test('[STRANDED-02] the first dispatch refusal writes the visible reason; repeats do not spam', async () => {
  const taskId = `engine-refusal-${uuidv4().slice(0, 8)}`;
  seedCard(taskId, 'podcast-engine');

  const { autoDispatchTask } = await import('../../src/lib/task-dispatcher');
  const first = await autoDispatchTask(taskId, 'test');
  assert.equal(first.status, 'held', 'the refusal itself is unchanged');

  const afterFirst = holdRows(taskId);
  assert.equal(afterFirst.length, 1, 'the card carries the reason after the first refusal');
  assert.match(afterFirst[0].message, /waiting on the Podcast Engine/i);
  assert.match(afterFirst[0].message, /only executor/);

  await autoDispatchTask(taskId, 'test');
  await autoDispatchTask(taskId, 'test');
  assert.equal(holdRows(taskId).length, 1, 'a card refused repeatedly carries ONE row, not one per tick');

  // The status is untouched — the board still refuses to dispatch it.
  const status = queryAll<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])[0].status;
  assert.equal(status, 'backlog');
});

// ── 3: the stale window earns exactly one alert ─────────────────────────────

test('[STRANDED-02] a card past the stale window earns exactly one alert naming the engine and the failure', async () => {
  const taskId = `engine-stalled-${uuidv4().slice(0, 8)}`;
  seedCard(taskId, 'podcast-engine', { updatedHoursAgo: 9 });
  // The engine's own last run failed hours earlier — the fact a human needs.
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'engine_run_failed', ?, ?, ?)`,
    [uuidv4(), taskId, 'episode build aborted: file-lock deadlock on podcast-engine.db', hoursAgo(9)],
  );

  const first = await runBoardHygiene();
  assert.ok(first.engineOwnedStalledIds.includes(taskId), 'the stalled card is alerted');
  const alerts = stallAlerts(taskId);
  assert.equal(alerts.length, 1, 'exactly one alert');
  assert.match(alerts[0].message, /the Podcast Engine/, 'the alert names the owning engine');
  assert.match(alerts[0].message, /file-lock deadlock/, 'the alert carries the last recorded engine failure');
  assert.match(alerts[0].message, /the engine stopped, not the board/);

  // The reason is on the card too, even though nothing ever dispatched it.
  assert.equal(holdRows(taskId).length, 1);

  const second = await runBoardHygiene();
  assert.ok(!second.engineOwnedStalledIds.includes(taskId), 'a later tick does not re-alert');
  assert.equal(stallAlerts(taskId).length, 1, 'still exactly one alert');
});

test('[STRANDED-02] a card inside the stale window is not alerted', async () => {
  const taskId = `engine-fresh-${uuidv4().slice(0, 8)}`;
  seedCard(taskId, 'podcast-engine', { updatedHoursAgo: 1 });

  const result = await runBoardHygiene();
  assert.ok(!result.engineOwnedStalledIds.includes(taskId), 'a card the engine touched recently is not alerted');
  assert.equal(stallAlerts(taskId).length, 0);
  assert.equal(holdRows(taskId).length, 1, 'it still carries the visible reason');
});

// ── 4: the engine runs it → the marker clears and re-arms ───────────────────

test('[STRANDED-02] a card the engine later runs clears the marker, and a NEW stall alerts again', async () => {
  const taskId = `engine-recovered-${uuidv4().slice(0, 8)}`;
  seedCard(taskId, 'podcast-engine', { updatedHoursAgo: 20 });

  await runBoardHygiene();
  assert.equal(stallAlerts(taskId).length, 1, 'the first stall alerted');
  // That alert went out 15h ago — backdate it so the rest of this history is
  // expressible without waiting real hours.
  run(
    `UPDATE events SET created_at = ? WHERE task_id = ? AND type = 'board_hygiene_engine_owned_stalled'`,
    [hoursAgo(15), taskId],
  );

  // The owning engine picks the card up and runs it, 10h ago.
  run(`UPDATE tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`, [hoursAgo(10), taskId]);
  assert.equal(
    engineOwnedWaitingLabel('podcast-engine', 'in_progress'),
    null,
    'the board label clears the moment the engine advances the card',
  );
  const running = await runBoardHygiene();
  assert.ok(!running.engineOwnedStalledIds.includes(taskId), 'a running card is not alerted');
  assert.equal(stallAlerts(taskId).length, 1);

  // It lands back on the board after that run and stops moving again. The old
  // alert is now OLDER than the engine's last touch, so the suppression lifts
  // by itself — a new stall episode is reported, not swallowed forever.
  run(`UPDATE tasks SET status = 'backlog' WHERE id = ?`, [taskId]);
  const relapse = await runBoardHygiene();
  assert.ok(relapse.engineOwnedStalledIds.includes(taskId), 'a fresh stall is reported, not suppressed forever');
  assert.equal(stallAlerts(taskId).length, 2, 'once per stall episode');
});

// ── 5: an ordinary board card is untouched ──────────────────────────────────

test('[STRANDED-02] a non-engine card is unaffected', async () => {
  const boardCard = `board-card-${uuidv4().slice(0, 8)}`;
  seedCard(boardCard, null, { updatedHoursAgo: 48 });
  const anthology = `anthology-card-${uuidv4().slice(0, 8)}`;
  seedCard(anthology, 'anthology', { updatedHoursAgo: 48 });

  const result = await runBoardHygiene();

  for (const id of [boardCard, anthology]) {
    assert.ok(!result.engineOwnedStalledIds.includes(id), `${id} is not an engine card`);
    assert.equal(stallAlerts(id).length, 0);
    assert.equal(holdRows(id).length, 0, 'no engine-hold reason is written onto a board card');
  }
});
