/**
 * GUARD 4c — a deck phase is never dispatched for a deck that names no run.
 *
 * THE LIVE DEFECT (2026-08-27, operator box). Phase cards for deck
 * `666924ec-f5b7-4886-a592-194fa8c091c2` ("Presentation pj_ab3c3") were
 * dispatched into a FRESH agent session carrying nothing that identified which
 * deck or run they belonged to. The phase agent could only have guessed or
 * fabricated an intake; it correctly refused, and the phases churned.
 *
 * WHAT THIS GATE IS NOT. An earlier draft blocked when the deck's run directory
 * was absent under `<workspace>/departments/<dept>/runs/<slug>`. That premise
 * was disproven on the live box: deck 666924ec's run was alive the entire time
 * at `/Users/blackceomacmini/webinar-decks/denise-calloway/trust-ledger/2026-08-27`
 * (state.json job_id `pj_ab3c329ca43a1b98117203f62a`, written throughout the
 * incident). Deck runs are NOT confined to the department tree, and CC does not
 * know the deck output root — so a department-rooted existence check would have
 * HARD-BLOCKED a healthy, running build. Run existence is undeterminable from
 * CC and is never treated as evidence here.
 *
 * WHAT IT DOES. It blocks on the one fact CC can establish from the board
 * itself: the parent deck card carries no `Ref:` run identity at all. Then the
 * phase is held and the deck blocked, both with visible deduped events; nothing
 * is silently dropped.
 *
 * Known-good controls are built in: a deck that names ANY run passes (including
 * the live incident's `Ref: 2026-08-27`, which is a real run leaf name), and a
 * non-deck task is untouched.
 */

import './_isolated-db'; // MUST be first — isolated temp DB, never the live board.

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne, queryAll } from '../../src/lib/db';
import { autoDispatchTask, deckPhaseRunIsInitialized } from '../../src/lib/task-dispatcher';
import type { Task } from '../../src/lib/types';

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
process.env.INTAKE_ADVANCE_SWEEP_ENABLED = '0';

const DEPARTMENT = 'presentations';
const REASON = 'deck_run_identity_missing';

function seedAgent(): { wsId: string; agentId: string } {
  const wsId = `ws-${uuidv4()}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [
    wsId, 'Deck Gate WS', `ws-${uuidv4().slice(0, 8)}`,
  ]);
  const agentId = `agent-${uuidv4()}`;
  run(
    `INSERT INTO agents (id, name, role, workspace_id, is_master, status)
     VALUES (?, ?, ?, ?, 0, 'standby')`,
    [agentId, `Deck Specialist ${agentId.slice(0, 8)}`, 'Deep Research Specialist', wsId],
  );
  return { wsId, agentId };
}

/**
 * Seed a deck parent whose `Ref:` line names `runSlug` (or omits it entirely),
 * plus one phase child. Mirrors the provenance block the ingest route writes.
 */
function seedDeck(
  ids: { wsId: string; agentId: string },
  runSlug: string | null,
): { parentId: string; phaseId: string } {
  const parentId = `task-${uuidv4()}`;
  const phaseId = `task-${uuidv4()}`;
  const now = new Date().toISOString();
  const provenance = [`Source: build_deck`, runSlug ? `Ref: ${runSlug}` : null]
    .filter(Boolean)
    .join('\n');

  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, department, source, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, ?, ?, 'build_deck', ?, ?)`,
    [
      parentId,
      'Presentation pj_ab3c3',
      `Deck build.\n\n— Captured via task-ingest —\n${provenance}`,
      ids.agentId,
      ids.wsId,
      DEPARTMENT,
      now,
      now,
    ],
  );
  run(
    `INSERT INTO tasks (id, title, description, status, priority, assigned_agent_id, workspace_id, department, source, parent_task_id, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, ?, ?, 'build_deck_phase', ?, ?, ?)`,
    [
      phaseId,
      'P-0.5-RESEARCH — deep-research-specialist-presentations',
      'Phase P-0.5-RESEARCH of the deck build.',
      ids.agentId,
      ids.wsId,
      DEPARTMENT,
      parentId,
      now,
      now,
    ],
  );
  return { parentId, phaseId };
}

function taskRow(taskId: string): Task {
  return queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId])!;
}

function statusOf(taskId: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [taskId])?.status;
}

function blockReasonOf(taskId: string): string | null {
  return queryOne<{ block_reason: string | null }>(
    'SELECT block_reason FROM tasks WHERE id = ?',
    [taskId],
  )?.block_reason ?? null;
}

function eventCount(taskId: string, type: string): number {
  return queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?',
    [taskId, type],
  )?.n ?? 0;
}

function eventMessages(taskId: string, type: string): string[] {
  return queryAll<{ message: string }>(
    'SELECT message FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [taskId, type],
  ).map((r) => r.message);
}

// ── 1. The primitive ────────────────────────────────────────────────────────

test('[GUARD-4c] deck names no run at all ⇒ gate says NO', () => {
  const ids = seedAgent();
  const { phaseId } = seedDeck(ids, null);
  assert.equal(deckPhaseRunIsInitialized(taskRow(phaseId), 'test'), false);
});

test('[GUARD-4c CONTROL] deck names a run ⇒ gate says YES', () => {
  const ids = seedAgent();
  const { phaseId } = seedDeck(ids, `pres-real-${uuidv4().slice(0, 8)}`);
  assert.equal(
    deckPhaseRunIsInitialized(taskRow(phaseId), 'test'),
    true,
    'the gate must be able to say yes — otherwise it is not a gate, it is an outage',
  );
});

test('[GUARD-4c REGRESSION] the live deck\'s date-style run leaf "2026-08-27" is a VALID run id', () => {
  const ids = seedAgent();
  const { phaseId, parentId } = seedDeck(ids, '2026-08-27');
  // Deck 666924ec's run was live at .../trust-ledger/2026-08-27 throughout the
  // incident. A gate that rejects this slug hard-blocks a healthy build.
  assert.equal(
    deckPhaseRunIsInitialized(taskRow(phaseId), 'test'),
    true,
    'a run leaf that looks like a date is still a run id — never block on its shape',
  );
  assert.equal(eventCount(phaseId, 'deck_phase_dispatch_held'), 0);
  assert.equal(statusOf(parentId), 'backlog', 'a running deck must never be blocked by this gate');
});

test('[GUARD-4c CONTROL] a non-deck task is not touched by the gate', () => {
  const ids = seedAgent();
  const id = `task-${uuidv4()}`;
  run(
    `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, department, source, created_at, updated_at)
     VALUES (?, 'Ordinary task', 'backlog', 'medium', ?, ?, ?, 'telegram', ?, ?)`,
    [id, ids.agentId, ids.wsId, DEPARTMENT, new Date().toISOString(), new Date().toISOString()],
  );
  assert.equal(deckPhaseRunIsInitialized(taskRow(id), 'test'), true);
  assert.equal(eventCount(id, 'deck_phase_dispatch_held'), 0);
});

// ── 2. The chokepoint (autoDispatchTask GUARD 4c) ───────────────────────────

test('[GUARD-4c] autoDispatchTask holds the phase AND blocks the deck when no run is named', async () => {
  const ids = seedAgent();
  const { parentId, phaseId } = seedDeck(ids, null);

  await autoDispatchTask(phaseId, 'test-deck-gate');

  assert.equal(eventCount(phaseId, 'task_dispatched'), 0, 'the phase was never handed to an agent');
  assert.equal(statusOf(phaseId), 'blocked', 'the phase is blocked, not silently dropped');
  assert.equal(blockReasonOf(phaseId), REASON);
  assert.equal(eventCount(phaseId, 'deck_phase_dispatch_held'), 1);

  assert.equal(statusOf(parentId), 'blocked', 'the deck itself is the actionable card');
  assert.equal(blockReasonOf(parentId), REASON);
  assert.equal(eventCount(parentId, REASON), 1);

  assert.match(eventMessages(phaseId, 'deck_phase_dispatch_held')[0], /carries no run identity/);
});

test('[GUARD-4c] the hold is deduped across repeated sweep ticks', async () => {
  const ids = seedAgent();
  const { parentId, phaseId } = seedDeck(ids, null);

  await autoDispatchTask(phaseId, 'test-tick-1');
  // A blocked task is skipped by GUARD 3, so re-entry must not pile up rows.
  await autoDispatchTask(phaseId, 'test-tick-2');

  assert.equal(eventCount(phaseId, 'deck_phase_dispatch_held'), 1);
  assert.equal(eventCount(parentId, REASON), 1);
});

test('[GUARD-4c CONTROL] a deck that names its run is not interfered with by the gate', async () => {
  const ids = seedAgent();
  const { parentId, phaseId } = seedDeck(ids, `pres-real-${uuidv4().slice(0, 8)}`);

  await autoDispatchTask(phaseId, 'test-deck-gate');

  assert.equal(eventCount(phaseId, 'deck_phase_dispatch_held'), 0, 'the gate let it through');
  assert.equal(eventCount(parentId, REASON), 0);
  assert.notEqual(blockReasonOf(phaseId), REASON, 'whatever happens downstream, it is not this gate');
  assert.equal(statusOf(parentId), 'backlog', 'the deck was never blocked');
});
