/**
 * DEP-5 / F3.7 + F3.9 — the NO-NAKED contract for the multi-persona path.
 *
 * The board invariant "every task carries a persona and every REQUIRED slot is
 * filled" must hold for a DECOMPOSED task exactly as it does for a single one.
 * This test drives the two CC-owned guarantees:
 *
 *   A. Render layer (`buildPersonaPlanBlock`) — across a matrix of sub-task
 *      states (matched / unresolved / mechanical / hybrid), EVERY sub-task emits
 *      either a Section-4 load contract or a governance oversight pointer. It is
 *      NEVER empty, NEVER emits `'auto'`, NEVER emits a self-selection protocol.
 *
 *   B. Persist layer (`resolvePersonaPlanAndPin`) — the FDN-1 guarantee:
 *      - the primary (seq-1) persona is pinned onto `tasks.persona_id` (never
 *        NULL — the board card always shows a persona);
 *      - a REQUIRED slot whose sub-task came back persona-less is backfilled with
 *        the deterministic department-default persona (never an empty required
 *        slot) and a `persona_fallback` audit event is written.
 *      Driven WITHOUT Python via the `PERSONA_PLAN_FIXTURE_JSON` escape hatch +
 *      pre-seeded plan rows (as the decompose script would have written).
 *
 * Node built-in test runner under tsx (`npm run test:unit`). DATABASE_PATH is
 * pointed at a throwaway file BEFORE `@/lib/db` is imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildPersonaPlanBlock,
  type PersonaPlanSubtask,
} from '../../src/lib/persona-dispatch';
import type { PersonaSlot } from '../../src/lib/sops';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dep5-nonaked-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let run: DbModule['run'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];
let resolvePersonaPlanAndPin: typeof import('../../src/lib/tasks')['resolvePersonaPlanAndPin'];

const settings = { persona: 'auto', personaSource: 'hardcoded_default' as const, personaMode: 'leadership' };

const AUTO_MARKERS = [/AUTO-SELECT/i, /5-Layer Persona Matching Protocol/i, /Run the 5-Layer/i];

test.before(async () => {
  const db = await import('../../src/lib/db');
  ({ queryOne, queryAll, run, getDb, closeDb } = db);
  ({ resolvePersonaPlanAndPin } = await import('../../src/lib/tasks'));
  getDb();
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

// ── A. Render-layer no-naked matrix ─────────────────────────────────────────

test('buildPersonaPlanBlock: every sub-task is governed — never naked, never auto', () => {
  const plan: PersonaPlanSubtask[] = [
    { seq: 1, slot: 'content', persona_id: 'bly-copywriters-handbook', persona_name: 'Bly' },              // matched
    { seq: 2, slot: 'image', persona_id: null },                                                          // unresolved (no persona)
    { seq: 3, slot: 'delivery', persona_id: null, no_persona_required: true },                            // mechanical
    { seq: 4, slot: 'lead', persona_id: 'covey-7-habits', persona_name: 'Covey' }, // resolved
  ];
  const block = buildPersonaPlanBlock(plan, settings);

  // Not empty, and no self-selection anywhere.
  assert.ok(block.trim().length > 0);
  for (const m of AUTO_MARKERS) assert.ok(!m.test(block), `must not contain ${m}`);

  // Each of the 4 sub-tasks is present as a numbered section and each carries a
  // persona directive (either a load contract OR a governance pointer) — proven
  // by there being no sub-task section that lacks BOTH markers.
  for (let seq = 1; seq <= 4; seq++) {
    assert.ok(block.includes(`${seq}.`), `sub-task ${seq} must appear in the plan`);
  }
  const loads = block.match(/Read the blueprint:/g) ?? [];
  const governance = block.match(/Governance oversight:|governing under the house fallback/g) ?? [];
  // matched (1) + hybrid (4) = 2 loads; unresolved (2) + mechanical (3) = 2 governance pointers.
  assert.equal(loads.length, 2, `expected 2 load contracts, got ${loads.length}`);
  assert.ok(governance.length >= 2, `expected ≥2 governance pointers, got ${governance.length}`);
});

// ── B. Persist-layer FDN-1 required-slot + primary guarantee ─────────────────

test('resolvePersonaPlanAndPin: primary pinned + required empty slot backfilled (never naked)', async () => {
  const taskId = 'dep5-nonaked-1';

  // A task row (workspace_id NULL to avoid the 'default' FK on an unseeded DB).
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, department) VALUES (?, ?, 'backlog', 'medium', NULL, ?)`,
    [taskId, 'Build the launch site', 'marketing'],
  );

  // Pre-seed the plan rows the decompose script would have written: seq-1 content
  // resolved, seq-2 image REQUIRED but persona-less (no specialist available).
  run(
    `INSERT INTO task_subtask_persona (task_id, seq, subtask_text, persona_id, persona_name, score, department, task_category, slot)
     VALUES (?, 1, 'write the copy', 'bly-copywriters-handbook', 'Bly', 0.8, 'marketing', 'content-write', 'content')`,
    [taskId],
  );
  run(
    `INSERT INTO task_subtask_persona (task_id, seq, subtask_text, persona_id, persona_name, score, department, task_category, slot)
     VALUES (?, 2, 'design the hero image', NULL, NULL, NULL, 'graphics', 'design', 'image')`,
    [taskId],
  );

  const slots: PersonaSlot[] = [
    { slot: 'content', task_category: 'content-write', required: true },
    { slot: 'image', task_category: 'design', required: true }, // REQUIRED and empty → must backfill
  ];

  // Drive the plan WITHOUT Python: the fixture returns the same 2-row plan so
  // selectPersonaPlanForTask short-circuits the subprocess.
  process.env.PERSONA_PLAN_FIXTURE_JSON = JSON.stringify({
    subtask_personas: [
      { seq: 1, persona_id: 'bly-copywriters-handbook', persona_name: 'Bly', slot: 'content' },
      { seq: 2, persona_id: null, persona_name: null, slot: 'image' },
    ],
  });

  try {
    const primary = await resolvePersonaPlanAndPin(taskId, 'Build the launch site', 'marketing', slots);
    // Primary is the seq-1 persona — never null.
    assert.equal(primary, 'bly-copywriters-handbook');
  } finally {
    delete process.env.PERSONA_PLAN_FIXTURE_JSON;
  }

  // tasks.persona_id is pinned (board invariant: never naked).
  const taskRow = queryOne<{ persona_id: string | null; persona_name: string | null }>(
    'SELECT persona_id, persona_name FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(taskRow?.persona_id, 'bly-copywriters-handbook', 'primary persona must be pinned onto the task');

  // The REQUIRED image slot (seq-2) was empty → backfilled with a non-null persona.
  const seq2 = queryOne<{ persona_id: string | null }>(
    'SELECT persona_id FROM task_subtask_persona WHERE task_id = ? AND seq = 2',
    [taskId],
  );
  assert.ok(seq2?.persona_id, 'required slot must never be left persona-less');
  assert.ok(seq2!.persona_id!.length > 0);

  // An audit event records the slot fallback.
  const events = queryAll<{ message: string }>(
    "SELECT message FROM events WHERE task_id = ? AND type = 'persona_fallback'",
    [taskId],
  );
  assert.ok(
    events.some((e) => /PERSONA-SLOT-FALLBACK/.test(e.message) && /Required slot "image"/.test(e.message)),
    'a persona_fallback audit event must record the required-slot backfill',
  );
});

test('resolvePersonaPlanAndPin: a NON-required empty slot is left empty (not force-filled)', async () => {
  const taskId = 'dep5-nonaked-2';
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, department) VALUES (?, ?, 'backlog', 'medium', NULL, ?)`,
    [taskId, 'Ship the update', 'marketing'],
  );
  run(
    `INSERT INTO task_subtask_persona (task_id, seq, persona_id, persona_name, slot, task_category)
     VALUES (?, 1, 'bly-copywriters-handbook', 'Bly', 'content', 'content-write')`,
    [taskId],
  );
  run(
    `INSERT INTO task_subtask_persona (task_id, seq, persona_id, persona_name, slot, task_category)
     VALUES (?, 2, NULL, NULL, 'image', 'design')`,
    [taskId],
  );

  const slots: PersonaSlot[] = [
    { slot: 'content', required: true },
    { slot: 'image', required: false }, // optional — stays empty
  ];
  process.env.PERSONA_PLAN_FIXTURE_JSON = JSON.stringify({
    subtask_personas: [
      { seq: 1, persona_id: 'bly-copywriters-handbook', slot: 'content' },
      { seq: 2, persona_id: null, slot: 'image' },
    ],
  });
  try {
    await resolvePersonaPlanAndPin(taskId, 'Ship the update', 'marketing', slots);
  } finally {
    delete process.env.PERSONA_PLAN_FIXTURE_JSON;
  }

  const seq2 = queryOne<{ persona_id: string | null }>(
    'SELECT persona_id FROM task_subtask_persona WHERE task_id = ? AND seq = 2',
    [taskId],
  );
  assert.equal(seq2?.persona_id ?? null, null, 'an OPTIONAL empty slot is not force-filled');
});
