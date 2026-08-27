/**
 * GUARD 4c — a deck phase is never dispatched for an uninitialized deck run.
 *
 * THE LIVE DEFECT (2026-08-27, operator box). Deck card
 * `666924ec-f5b7-4886-a592-194fa8c091c2` ("Presentation pj_ab3c3") was ingested
 * with `source_ref="2026-08-27"` — a DATE where the canonical producer puts the
 * run directory name. Its `Ref:` line therefore named a run that does not
 * exist. Phase children (P-0.5-RESEARCH `3672e694…` and others) were minted
 * under it and dispatched anyway, so the phase agent was handed work with no
 * intake, no working/ tree, and nowhere to write. It correctly refused to
 * fabricate an intake.json and the deck churned at 0 phases for hours.
 *
 * The contrast case is the same box's healthy deck `a79f97cb…`, whose
 * `Ref: pres-mta0y199-qj40j3` names a run directory that DOES exist and whose
 * 21 phase children ran.
 *
 * THE GATE: for `source="build_deck_phase"`, resolve the deck's run from the
 * PARENT card's `Ref:` provenance line under
 * `<workspace>/departments/<dept>/runs/`. Missing run ⇒ hold the phase and
 * block the deck, both with visible events. Present run ⇒ dispatch is
 * untouched.
 *
 * FAIL-OPEN CLAUSE (deliberate, and tested): when the department `runs/` root
 * is not readable from this process, CC cannot observe run state at all. That
 * is an instrument failure, not evidence about the deck — so the gate stands
 * down and says so in an event, rather than blocking every deck on a box where
 * CC cannot see the department workspace.
 *
 * Known-good controls are built in: an initialized deck passes the gate (the
 * gate can say yes), and a non-deck task is untouched by it.
 */

import './_isolated-db'; // MUST be first — isolated temp DB, never the live board.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne, queryAll } from '../../src/lib/db';
import { autoDispatchTask, deckPhaseRunIsInitialized } from '../../src/lib/task-dispatcher';
import type { Task } from '../../src/lib/types';

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
process.env.INTAKE_ADVANCE_SWEEP_ENABLED = '0';

const DEPARTMENT = 'presentations';
const REASON = 'deck_run_initialization_missing';

/** A temp workspace laid out like a live box: departments/<Dept>/runs/. */
function makeWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deck-gate-ws-'));
  // Capitalized on disk while tasks.department is a lowercase slug — exactly
  // the live mismatch the resolver has to tolerate.
  fs.mkdirSync(path.join(ws, 'departments', 'Presentations', 'runs'), { recursive: true });
  return ws;
}

const WORKSPACE = makeWorkspace();
process.env.OPENCLAW_WORKSPACE_PATH = WORKSPACE;

function runsDir(): string {
  return path.join(WORKSPACE, 'departments', 'Presentations', 'runs');
}

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
 * Seed a deck parent whose `Ref:` line names `runSlug`, plus one phase child.
 * Mirrors the live provenance block the ingest route writes.
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

test('[GUARD-4c] run directory missing ⇒ gate says NO', () => {
  const ids = seedAgent();
  // The literal slug from the live incident: a date, not a run id.
  const { phaseId } = seedDeck(ids, '2026-08-27');
  assert.equal(deckPhaseRunIsInitialized(taskRow(phaseId), 'test'), false);
});

test('[GUARD-4c CONTROL] run directory present ⇒ gate says YES', () => {
  const ids = seedAgent();
  const slug = `pres-real-${uuidv4().slice(0, 8)}`;
  fs.mkdirSync(path.join(runsDir(), slug));
  const { phaseId } = seedDeck(ids, slug);
  assert.equal(
    deckPhaseRunIsInitialized(taskRow(phaseId), 'test'),
    true,
    'the gate must be able to say yes — otherwise it is not a gate, it is an outage',
  );
});

test('[GUARD-4c] parent with no Ref: run id at all ⇒ gate says NO', () => {
  const ids = seedAgent();
  const { phaseId } = seedDeck(ids, null);
  assert.equal(deckPhaseRunIsInitialized(taskRow(phaseId), 'test'), false);
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

test('[GUARD-4c] runs root unreadable ⇒ UNDETERMINED: gate stands down, loudly', () => {
  const ids = seedAgent();
  const { phaseId, parentId } = seedDeck(ids, 'pres-whatever');
  const saved = process.env.OPENCLAW_WORKSPACE_PATH;
  process.env.OPENCLAW_WORKSPACE_PATH = path.join(os.tmpdir(), `cc-absent-${uuidv4()}`);
  try {
    assert.equal(
      deckPhaseRunIsInitialized(taskRow(phaseId), 'test'),
      true,
      'an unreadable runs root is an instrument failure, never evidence the deck is uninitialized',
    );
  } finally {
    process.env.OPENCLAW_WORKSPACE_PATH = saved;
  }
  assert.equal(eventCount(phaseId, 'deck_run_check_unavailable'), 1, 'the skip is visible, not silent');
  assert.equal(eventCount(phaseId, 'deck_phase_dispatch_held'), 0, 'nothing was held');
  assert.equal(statusOf(parentId), 'backlog', 'the deck was NOT blocked on an unknowable');
});

// ── 2. The chokepoint (autoDispatchTask GUARD 4c) ───────────────────────────

test('[GUARD-4c] autoDispatchTask holds the phase AND blocks the deck when the run is missing', async () => {
  const ids = seedAgent();
  const { parentId, phaseId } = seedDeck(ids, '2026-08-27');

  await autoDispatchTask(phaseId, 'test-deck-gate');

  assert.equal(eventCount(phaseId, 'task_dispatched'), 0, 'the phase was never handed to an agent');
  assert.equal(statusOf(phaseId), 'blocked', 'the phase is blocked, not silently dropped');
  assert.equal(blockReasonOf(phaseId), REASON);
  assert.equal(eventCount(phaseId, 'deck_phase_dispatch_held'), 1);

  assert.equal(statusOf(parentId), 'blocked', 'the deck itself is the actionable card');
  assert.equal(blockReasonOf(parentId), REASON);
  assert.equal(eventCount(parentId, REASON), 1);

  const held = eventMessages(phaseId, 'deck_phase_dispatch_held')[0];
  assert.match(held, /2026-08-27/, 'the reason names the run that is missing');
  assert.match(held, /does not exist under/);
});

test('[GUARD-4c] the hold is deduped across repeated sweep ticks', async () => {
  const ids = seedAgent();
  const { parentId, phaseId } = seedDeck(ids, '2026-08-27');

  await autoDispatchTask(phaseId, 'test-tick-1');
  // A blocked task is skipped by GUARD 3, so re-entry must not pile up rows.
  await autoDispatchTask(phaseId, 'test-tick-2');

  assert.equal(eventCount(phaseId, 'deck_phase_dispatch_held'), 1);
  assert.equal(eventCount(parentId, REASON), 1);
});

test('[GUARD-4c CONTROL] an initialized deck is not interfered with by the gate', async () => {
  const ids = seedAgent();
  const slug = `pres-real-${uuidv4().slice(0, 8)}`;
  fs.mkdirSync(path.join(runsDir(), slug));
  const { parentId, phaseId } = seedDeck(ids, slug);

  await autoDispatchTask(phaseId, 'test-deck-gate');

  assert.equal(eventCount(phaseId, 'deck_phase_dispatch_held'), 0, 'the gate let it through');
  assert.equal(eventCount(parentId, REASON), 0);
  assert.notEqual(blockReasonOf(phaseId), REASON, 'whatever happens downstream, it is not this gate');
  assert.equal(statusOf(parentId), 'backlog', 'the deck was never blocked');
});
