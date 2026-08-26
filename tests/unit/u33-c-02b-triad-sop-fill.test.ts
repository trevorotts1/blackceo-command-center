/**
 * u33-c-02b-triad-sop-fill.test.ts — skill6-v2 U33 / C-02-b (the dispatch deadlock).
 *
 * THE BUG (an ORDERING bug — both halves were individually correct):
 *   GUARD 7 (the Triad gate) sits at the TOP of `autoDispatchTask` and `return`s
 *   when a card is Triad-incomplete. The PRD 2.12-cc SOP remedy engine — library
 *   pull → canonical-library copy → authoring fast loop — sat ~230 lines FURTHER
 *   DOWN the same function. So a card whose ONLY missing Triad leg was its SOP
 *   could never reach its own cure: the gate held it, backed it off, and after
 *   TRIAD_HOLD_MAX_ATTEMPTS parked it as `blocked`, while the library SOP that
 *   would have released it sat one query away, unreached.
 *
 * THE FIX: the engine is extracted into `resolveSopForTask()` and called from
 *   INSIDE the GUARD 7 branch when — and only when — `triad.missing` is exactly
 *   `['sop_id']`. It fills, re-checks, and falls through to dispatch in the SAME
 *   invocation. No second sweep pass, no re-entry, and the gate does not move.
 *
 * WHY THESE ARTIFACTS: test (1) is the load-bearing one — with the gate ON, a
 *   task whose `sop_id` starts NULL ending up dispatched WITH a persisted
 *   `sop_id` is a state the broken code cannot reach by ANY path, because it
 *   returned at the gate before the engine ever ran.
 *
 * Test (3) pins a DELIBERATE SEMANTIC CHANGE: gate ON + canonical dept + a true
 *   role-library gap now HOLDS loudly (gap event + Triad hold + park) where
 *   pre-U33 it dispatched SOP-LESS. Tests (5) and (6) pin that
 *   `TRIAD_ADVANCER_GATE=0` still yields the documented pre-U33 behaviour.
 *
 * Hermetic: OPENCLAW_GATEWAY_URL is a deliberately invalid URL (matching
 * u33-c-02-dispatch-triad-gate.test.ts) — `new URL()` throws synchronously in
 * OpenClawClient.connect(), so a task that clears GUARD 7 fails its gateway
 * connection cheaply with zero open sockets. Embedding keys are cleared so SOP
 * matching takes the deterministic keyword path, and the custom-dept fixture has
 * no research specialist, so `authorSOPForTask` short-circuits before any
 * Tavily/Gemini call.
 *
 *   node --import tsx --test tests/unit/u33-c-02b-triad-sop-fill.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-triad-sop-fill-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// Invalid on purpose — see the header note.
process.env.OPENCLAW_GATEWAY_URL = 'not-a-valid-url';
process.env.OPENCLAW_GATEWAY_TOKEN = '';

// Force the KEYWORD-only SOP matching path (sops.ts `isEmbeddingAvailable()`).
// Without this an operator's ambient key would make SOP selection depend on a
// live embedding API — non-hermetic and non-deterministic.
delete process.env.SOP_EMBEDDING_PROVIDER;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_AI_STUDIO_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type DispatcherModule = typeof import('../../src/lib/task-dispatcher');
let autoDispatchTask: DispatcherModule['autoDispatchTask'];

const AGENT_ID = 'agent-c02b-fill';
const VALID_PERSONA = 'hormozi-100m-offers';

/** The one library SOP the marketing fixture is meant to pull. */
const LIBRARY_SOP_ID = 'sop-c02b-marketing-library';
/** A canonical dept with NO library SOP — the true-gap fixture. */
const GAP_DEPT = 'legal';
/** Not in CANONICAL_SLUGS and has no role-library row → the custom-dept fixture. */
const CUSTOM_DEPT = 'underwater-basket-weaving';

test.before(async () => {
  const db: DbModule = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  queryAll = db.queryAll;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // runs the full migration chain — and the boot auto-seeders

  // getDb()'s boot auto-seeder installs a 16-SOP starter library. Clear it so
  // the SOP-resolution outcome of every fixture below is decided ONLY by rows
  // this file inserts — otherwise a seeded `legal` SOP would silently turn the
  // library-gap fixture into a library HIT and test (3) would pass vacuously.
  run(`DELETE FROM sops`, []);

  run(
    `INSERT INTO agents (id, name, role, is_master, workspace_id) VALUES (?, ?, ?, 0, NULL)`,
    [AGENT_ID, 'C-02-b Fill Test Agent', 'specialist'],
  );

  // Department match alone scores 0.5 in scoreSOPForTask, which is exactly
  // getBestSOPForTask's default threshold; the keyword hits add margin on top.
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department, task_keywords)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      LIBRARY_SOP_ID, 'Marketing Launch SOP', 'c02b-marketing-launch-sop',
      'Step 1. Draft. Step 2. Send.', 'Campaign shipped.', 'marketing',
      'launch campaign,email blast',
    ],
  );

  const dispatcher: DispatcherModule = await import('../../src/lib/task-dispatcher');
  autoDispatchTask = dispatcher.autoDispatchTask;
});

test.after(async () => {
  try {
    const { getOpenClawClient } = await import('../../src/lib/openclaw/client');
    getOpenClawClient().disconnect();
  } catch { /* ignore */ }
  try {
    const g = globalThis as Record<string, NodeJS.Timeout | undefined>;
    const timer = g['__openclaw_cache_cleanup_timer__'];
    if (timer) { clearInterval(timer); delete g['__openclaw_cache_cleanup_timer__']; }
  } catch { /* ignore */ }
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function seedTask(opts: {
  id: string;
  description: string | null;
  sopId: string | null;
  personaId: string | null;
  department: string | null;
  title?: string;
}): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks
       (id, title, description, status, priority, assigned_agent_id, workspace_id, business_id,
        department, sop_id, persona_id, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', ?, NULL, NULL, ?, ?, ?, ?, ?)`,
    [
      opts.id, opts.title ?? `Task ${opts.id}`, opts.description, AGENT_ID,
      opts.department, opts.sopId, opts.personaId, now, now,
    ],
  );
}

function eventsFor(id: string, type: string) {
  return queryAll<{ message: string }>(
    'SELECT message FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [id, type],
  );
}

function deferredFor(id: string) {
  return eventsFor(id, 'task_dispatch_deferred').map((e) => e.message);
}

/** Proof the task advanced PAST GUARD 7: only post-gate code can log gateway_down. */
function reachedGateway(id: string): boolean {
  return deferredFor(id).some((m) => /gateway_down/.test(m));
}

function sopIdOf(id: string): string | null {
  return queryOne<{ sop_id: string | null }>('SELECT sop_id FROM tasks WHERE id = ?', [id])?.sop_id ?? null;
}

function taskStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

// ── (1) THE DEADLOCK: gate ON, SOP-only gap, ONE call → filled AND dispatched ─
//
// This is the artifact the broken code CANNOT produce. Pre-fix, GUARD 7 returned
// before the remedy engine, so with the gate ON there was no path by which a
// task starting with sop_id NULL could end this call both SOP-attached and past
// the gate. Both halves of the assertion matter: the fill AND the fall-through.

test('[U33/C-02-b] gate ON: a card missing ONLY its SOP is FILLED from the library and dispatches in the SAME call', async () => {
  const taskId = 'task-c02b-library-fill';
  seedTask({
    id: taskId,
    title: 'Launch campaign for Q3',
    description: 'Plan and run the Q3 email blast for the launch campaign.',
    sopId: null,
    personaId: VALID_PERSONA,
    department: 'marketing',
  });

  // Precondition: the deadlock's entry state — Triad-incomplete on SOP alone.
  assert.equal(sopIdOf(taskId), null, 'fixture must START with no SOP');

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  // (a) The gate CURED the card instead of holding it, and persisted the cure.
  assert.equal(
    sopIdOf(taskId),
    LIBRARY_SOP_ID,
    'the Triad gate must resolve the library SOP and write it back to tasks.sop_id',
  );

  // (b) It was never held.
  assert.equal(
    eventsFor(taskId, 'triad_gate_hold').length,
    0,
    'a card the gate can cure must never be held',
  );

  // (c) It fell through to dispatch in the SAME invocation — no second pass.
  assert.ok(
    reachedGateway(taskId),
    'must reach the gateway-connection step, proving it fell through GUARD 7 after the fill',
  );
});

// ── (2) Custom dept → authoring fast loop fires, dispatch HOLDS ──────────────

test('[U33/C-02-b] gate ON: a custom-dept card with no SOP fires the authoring fast loop and records sop_authoring_pending', async () => {
  const taskId = 'task-c02b-custom-authoring';
  seedTask({
    id: taskId,
    title: 'Weave a display basket',
    description: 'Produce a woven display basket for the showroom.',
    sopId: null,
    personaId: VALID_PERSONA,
    department: CUSTOM_DEPT,
  });

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  // authorSOPForTask WAS invoked. Proof is a durable event written from INSIDE
  // it: the fixture dept has no research specialist, so it short-circuits there
  // (which is also what keeps this test off the network).
  assert.equal(
    eventsFor(taskId, 'sop_authoring_no_research_specialist').length,
    1,
    'authorSOPForTask must have been invoked (it wrote its own no-research-specialist event)',
  );

  // The pending attempt is accounted for (DISP-03 anti-furnace).
  assert.ok(
    deferredFor(taskId).some((m) => /sop_authoring_pending/.test(m)),
    'the hold must be recorded as sop_authoring_pending',
  );

  // And it did NOT dispatch.
  assert.ok(!reachedGateway(taskId), 'an authoring hold must never reach the gateway');
  assert.equal(taskStatus(taskId), 'backlog', 'the card stays in backlog for the authoring resume');

  // The resume contract: sop-authoring.ts §6 persists sop_id under
  // `WHERE status = 'backlog'` BEFORE re-firing dispatch, and the soft-backoff
  // branch of recordDispatchFailure never touches `status` — so the card is
  // still eligible for that write. A status flip here would be a SECOND deadlock.
});

// ── (3) Canonical dept + true library gap → HOLDS (the semantic change) ──────

test('[U33/C-02-b] gate ON: a canonical dept with a true library gap now HOLDS loudly instead of dispatching SOP-less', async () => {
  const taskId = 'task-c02b-canonical-gap';
  seedTask({
    id: taskId,
    title: 'Review the vendor contract',
    description: 'Review and redline the incoming vendor contract.',
    sopId: null,
    personaId: VALID_PERSONA,
    department: GAP_DEPT,
  });

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  // The gap is announced...
  assert.equal(
    eventsFor(taskId, 'sop_library_gap').length,
    1,
    'a canonical library gap must emit exactly one sop_library_gap event',
  );

  // ...and the card is then HELD by the existing triad machinery.
  assert.equal(
    eventsFor(taskId, 'triad_gate_hold').length,
    1,
    'after a library gap the card falls into the existing Triad hold',
  );
  assert.ok(
    deferredFor(taskId).some((m) => /triad_incomplete/.test(m)),
    'the hold is parked via recordDispatchFailure (TRIAD_HOLD_MAX_ATTEMPTS)',
  );

  // DELIBERATE SEMANTIC CHANGE: pre-U33 this card dispatched SOP-LESS.
  assert.ok(
    !reachedGateway(taskId),
    'SEMANTIC PIN: with the gate ON a canonical library gap must NOT dispatch SOP-less',
  );
  assert.equal(sopIdOf(taskId), null, 'no SOP was invented');
  assert.equal(taskStatus(taskId), 'backlog');
});

// ── (4) Anti-furnace: a missing description/persona attempts NO fill ─────────

test('[U33/C-02-b] gate ON: a card ALSO missing its description holds immediately — no SOP fill is attempted', async () => {
  const taskId = 'task-c02b-no-desc-no-fill';
  seedTask({
    id: taskId,
    description: null, // missing description AND missing SOP
    sopId: null,
    personaId: VALID_PERSONA,
    department: CUSTOM_DEPT,
  });

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  const holds = eventsFor(taskId, 'triad_gate_hold');
  assert.equal(holds.length, 1, 'the card is held');
  assert.match(holds[0].message, /Missing: description, SOP/, 'both missing legs are named');

  // The point of the guard: human grooming is required anyway, so the sweep's
  // hold loop must NOT pay for an embedding call or spawn an authoring run.
  assert.equal(
    eventsFor(taskId, 'sop_authoring_no_research_specialist').length,
    0,
    'ANTI-FURNACE: the authoring fast loop must NOT fire when description is also missing',
  );
  assert.equal(
    eventsFor(taskId, 'sop_library_gap').length,
    0,
    'ANTI-FURNACE: no SOP resolution is attempted at all',
  );
  assert.equal(sopIdOf(taskId), null);
});

// ── (5) Kill switch: gate=0 still bypasses the gate entirely ────────────────
//
// HARNESS REACH (stated so this test is not read as proving more than it does):
// the RETAINED in-line call site sits AFTER the OpenClaw connection step, and
// this suite's gateway URL is invalid on purpose, so `autoDispatchTask` always
// returns at `gateway_down` before reaching it. No unit test in this repo drives
// dispatch past that step (there is no mock precedent for a signed-handshake
// gateway), so the in-line engine's behaviour is NOT asserted here — only that
// the kill switch still fully disables GUARD 7, including its new fill branch.

test('[U33/C-02-b] TRIAD_ADVANCER_GATE=0: the gate — and its new SOP-fill branch — are fully disabled', async () => {
  const taskId = 'task-c02b-killswitch-gap';
  seedTask({
    id: taskId,
    title: 'Review the second vendor contract',
    description: 'Review and redline the second incoming vendor contract.',
    sopId: null,
    personaId: VALID_PERSONA,
    department: GAP_DEPT,
  });

  process.env.TRIAD_ADVANCER_GATE = '0';
  try {
    await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));
  } finally {
    delete process.env.TRIAD_ADVANCER_GATE;
  }

  assert.equal(eventsFor(taskId, 'triad_gate_hold').length, 0, 'the kill switch disables the gate');
  // The fill branch lives INSIDE the gate, so it must not run either.
  assert.equal(
    eventsFor(taskId, 'sop_library_gap').length,
    0,
    'the gate-side fill must not run when the gate is off',
  );
  assert.equal(sopIdOf(taskId), null, 'and nothing is written back to the row');
  assert.ok(
    reachedGateway(taskId),
    'pre-U33 behaviour: even a Triad-incomplete card advances past where GUARD 7 would have held it',
  );
});

// ── (6) Recursion guard: an authoring sub-task never re-enters authoring ─────

test('[U33/C-02-b] gate ON: the sopAuthoringLink recursion guard survives — an authoring sub-task never re-fires authoring', async () => {
  const taskId = 'task-c02b-recursion-guard';
  seedTask({
    id: taskId,
    title: 'Author SOP: weave a display basket',
    description: 'Research and author the missing SOP for the custom department.',
    sopId: null,
    personaId: VALID_PERSONA,
    department: CUSTOM_DEPT,
  });
  // GUARD 5's marker: this task IS a SOP-authoring sub-task.
  run(`UPDATE tasks SET sop_authoring_for_task_id = ? WHERE id = ?`, ['task-c02b-custom-authoring', taskId]);

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  // The gate's fill branch DID run (missing is exactly ['sop_id']) but the
  // recursion guard must stop it before the authoring loop — otherwise an
  // authoring sub-task would spawn its own authoring sub-task, forever.
  assert.equal(
    eventsFor(taskId, 'sop_authoring_no_research_specialist').length,
    0,
    'RECURSION GUARD: an authoring sub-task must never re-enter authorSOPForTask',
  );
  // With no SOP resolvable and the remedy engine correctly refused, it holds.
  assert.equal(eventsFor(taskId, 'triad_gate_hold').length, 1, 'it is held, not dispatched');
  assert.ok(!reachedGateway(taskId));
});

// ── (7) DISABLE_SOP_FAST_LOOP=1 still suppresses authoring ──────────────────

test('[U33/C-02-b] gate ON: DISABLE_SOP_FAST_LOOP=1 suppresses the authoring loop and the card holds', async () => {
  const taskId = 'task-c02b-fastloop-disabled';
  seedTask({
    id: taskId,
    title: 'Weave a second display basket',
    description: 'Produce a second woven display basket for the showroom.',
    sopId: null,
    personaId: VALID_PERSONA,
    department: CUSTOM_DEPT,
  });

  process.env.DISABLE_SOP_FAST_LOOP = '1';
  try {
    await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));
  } finally {
    delete process.env.DISABLE_SOP_FAST_LOOP;
  }

  assert.equal(
    eventsFor(taskId, 'sop_authoring_no_research_specialist').length,
    0,
    'the fast-loop kill switch must suppress authoring even on the gate-side fill path',
  );
  assert.equal(eventsFor(taskId, 'triad_gate_hold').length, 1, 'the card holds instead');
  assert.ok(!reachedGateway(taskId));
});

// ── (8) An already-complete card takes no remedy path at all ────────────────

test('[U33/C-02-b] gate ON: a Triad-complete card triggers NO fill side effects and its SOP is untouched', async () => {
  const taskId = 'task-c02b-already-complete';
  seedTask({
    id: taskId,
    title: 'Launch campaign for Q1',
    description: 'Plan and run the Q1 email blast for the launch campaign.',
    sopId: LIBRARY_SOP_ID,
    personaId: VALID_PERSONA,
    department: 'marketing',
  });

  await assert.doesNotReject(() => autoDispatchTask(taskId, 'test'));

  // `missing` is empty, so the fill branch is never entered.
  assert.equal(eventsFor(taskId, 'triad_gate_hold').length, 0);
  assert.equal(eventsFor(taskId, 'sop_library_gap').length, 0, 'no remedy path runs');
  assert.equal(eventsFor(taskId, 'sop_authoring_no_research_specialist').length, 0, 'no authoring runs');
  assert.equal(sopIdOf(taskId), LIBRARY_SOP_ID, 'the existing SOP is left exactly as it was');
  assert.ok(reachedGateway(taskId), 'and it dispatches normally');
});
