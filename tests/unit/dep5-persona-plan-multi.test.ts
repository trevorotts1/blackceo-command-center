/**
 * DEP-5 / F3.7 + F3.9 — multi-persona decomposition, CC side.
 *
 * Proves the CC wiring of the decomposition engine end to end at the seams the
 * CC owns (the matcher-side selection itself is DEP-4):
 *
 *   1. Migration 088 creates `task_subtask_persona` with the `_SUBTASK_PERSONA_DDL`
 *      column set + the `slot` column (F3.9) + the task_id index; and the SAME
 *      table works when a hand-run CLI created it first WITHOUT the slot column
 *      (the migration ALTER-adds it) — `loadSubtaskPersonas` round-trips rows.
 *   2. `decideMultiPersona` / `heuristicDecompose` picks combined mode on the
 *      worked example ("build a website … write the copy, build the funnel,
 *      design the hero images"), single mode on a one-part task, and NEVER on a
 *      mechanical task; and >1 SOP persona_slot forces combined regardless.
 *   3. `getPersonaSlots` extracts declared slots from a SOP's steps JSON, and a
 *      slot survives a round-trip through `parseAndValidateSteps` (the SOP-edit
 *      API validator) — so a declared slot is a durable contract, not stripped.
 *   4. `buildPersonaPlanBlock` renders ONE Section-4 load pointer per
 *      NON-mechanical sub-task, ≥2 distinct personas, the image sub-task resolved
 *      to a visual-storytelling persona, a mechanical sub-task as a governance
 *      pointer (not a full load), and ZERO "AUTO-SELECT" prose.
 *
 * Node built-in test runner under tsx (`npm run test:unit`). The DB section
 * points DATABASE_PATH at a throwaway file BEFORE `@/lib/db` is imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildPersonaPlanBlock,
  personaBlueprintPath,
  type PersonaPlanSubtask,
} from '../../src/lib/persona-dispatch';
import {
  heuristicDecompose,
  heuristicSubtaskCount,
  isMechanicalTask,
  decideMultiPersona,
} from '../../src/lib/tasks';
import {
  getPersonaSlots,
  parseAndValidateSteps,
  type PersonaSlot,
} from '../../src/lib/sops';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dep5-plan-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let getDb: DbModule['getDb'];
let queryAll: DbModule['queryAll'];
let run: DbModule['run'];
let closeDb: DbModule['closeDb'];
let runMigrations: DbModule['runMigrations'];
let loadSubtaskPersonas: typeof import('../../src/lib/persona-selector')['loadSubtaskPersonas'];

const settings = { persona: 'auto', personaSource: 'hardcoded_default' as const, personaMode: 'leadership' };

test.before(async () => {
  const db = await import('../../src/lib/db');
  getDb = db.getDb;
  queryAll = db.queryAll;
  run = db.run;
  closeDb = db.closeDb;
  runMigrations = db.runMigrations;
  ({ loadSubtaskPersonas } = await import('../../src/lib/persona-selector'));
  getDb(); // runs the full migration chain incl. 088
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
});

// ── 1. Migration 088 ────────────────────────────────────────────────────────

test('migration 088: task_subtask_persona exists with the DDL columns + slot + task_id index', () => {
  const tbl = queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='task_subtask_persona'",
  );
  assert.equal(tbl.length, 1, 'task_subtask_persona table must exist after migrations');

  const cols = new Set(queryAll<{ name: string }>('PRAGMA table_info(task_subtask_persona)').map((c) => c.name));
  for (const col of ['id', 'task_id', 'seq', 'subtask_text', 'persona_id', 'persona_name', 'score', 'department', 'task_category', 'slot', 'created_at']) {
    assert.ok(cols.has(col), `task_subtask_persona must have column ${col}`);
  }

  const idx = queryAll<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_subtask_persona' AND name='idx_subtask_persona_task'",
  );
  assert.equal(idx.length, 1, 'idx_subtask_persona_task index must exist');
});

test('loadSubtaskPersonas round-trips plan rows (incl. the slot column)', () => {
  const taskId = 'dep5-plan-task-1';
  run(
    `INSERT INTO task_subtask_persona (task_id, seq, subtask_text, persona_id, persona_name, score, department, task_category, slot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [taskId, 1, 'write the copy', 'bly-copywriters-handbook', 'Bly', 0.82, 'marketing', 'content-write', 'content'],
  );
  run(
    `INSERT INTO task_subtask_persona (task_id, seq, subtask_text, persona_id, persona_name, score, department, task_category, slot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [taskId, 2, 'design the hero images', 'opara-color-works', 'Opara', 0.77, 'graphics', 'design', 'image'],
  );

  const rows = loadSubtaskPersonas(taskId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].seq, 1);
  assert.equal(rows[0].slot, 'content');
  assert.equal(rows[1].persona_id, 'opara-color-works');
  assert.equal(rows[1].slot, 'image');
});

test('loadSubtaskPersonas tolerates a CLI-created table missing the slot column (ALTER-added)', () => {
  // Simulate the older decompose-task.py defensive DDL: drop + recreate WITHOUT slot,
  // then re-run migrations to prove the ALTER path adds the column non-destructively.
  const db = getDb();
  db.exec('DROP TABLE task_subtask_persona');
  db.exec(`CREATE TABLE task_subtask_persona (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    task_id TEXT NOT NULL, seq INTEGER NOT NULL, subtask_text TEXT,
    persona_id TEXT, persona_name TEXT, score REAL, department TEXT,
    task_category TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  db.exec("INSERT INTO task_subtask_persona (task_id, seq, persona_id) VALUES ('legacy-1', 1, 'covey-7-habits')");

  // Forget migration 088 so re-running the chain re-applies it against the
  // now-CLI-created (slot-less) table — proving the ALTER path adds the column.
  db.exec("DELETE FROM _migrations WHERE id = '088'");
  runMigrations(db);

  const cols = new Set(queryAll<{ name: string }>('PRAGMA table_info(task_subtask_persona)').map((c) => c.name));
  assert.ok(cols.has('slot'), 'migration must ALTER-add slot onto a CLI-created table');
  const rows = loadSubtaskPersonas('legacy-1');
  assert.equal(rows.length, 1, 'existing rows survive the ALTER');
  assert.equal(rows[0].slot ?? null, null, 'the ALTER-added slot is NULL for the pre-existing row');
});

// ── 2. Single-vs-combined decision ──────────────────────────────────────────

test('decideMultiPersona: the worked example decomposes into >1 sub-task → combined', () => {
  const text = 'Build a website for an audience of Black women: write the copy, build the funnel, and design the hero images';
  const parts = heuristicDecompose(text);
  assert.ok(parts.length >= 2, `expected >1 sub-task, got ${parts.length}: ${JSON.stringify(parts)}`);
  assert.equal(heuristicSubtaskCount(text) > 1, true);
  const d = decideMultiPersona(text, []);
  assert.equal(d.combined, true, `worked example must be combined (reason: ${d.reason})`);
});

test('decideMultiPersona: a single-deliverable task stays single', () => {
  const text = 'Write a blog post about our new pricing page';
  assert.equal(heuristicSubtaskCount(text), 1);
  assert.equal(decideMultiPersona(text, []).combined, false);
});

test('decideMultiPersona: a mechanical task never triggers decomposition', () => {
  assert.equal(isMechanicalTask('deploy the site and publish to production'), true);
  const d = decideMultiPersona('deploy the site and publish to production', []);
  assert.equal(d.combined, false);
  assert.equal(d.reason, 'mechanical');
});

test('decideMultiPersona: >1 SOP persona_slot forces combined even on a 1-part task text', () => {
  const slots: PersonaSlot[] = [
    { slot: 'content', task_category: 'content-write', required: true },
    { slot: 'image', task_category: 'design', required: false },
  ];
  const d = decideMultiPersona('build the thing', slots);
  assert.equal(d.combined, true);
  assert.match(d.reason, /sop-slots/);
});

// ── 3. SOP slot contract durability ─────────────────────────────────────────

test('getPersonaSlots extracts declared slots; slot survives parseAndValidateSteps', () => {
  const steps = [
    { name: 'Write the landing copy', persona_slot: { slot: 'content', task_category: 'content-write', domains: ['copywriting'], audience_from: 'task', required: true } },
    { name: 'Build the funnel', persona_slot: { slot: 'code', task_category: 'code', domains: ['software-craft'], required: true } },
    { name: 'Design the hero image', persona_slot: { slot: 'image', task_category: 'design', domains: ['visual-storytelling'], required: false } },
  ];
  const json = JSON.stringify(steps);

  const slots = getPersonaSlots(json);
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((s) => s.slot), ['content', 'code', 'image']);
  assert.equal(slots[0].required, true);
  assert.equal(slots[2].required, false);

  // The SOP-edit API re-validates steps via parseAndValidateSteps — the slot must
  // NOT be stripped (durable contract).
  const revalidated = parseAndValidateSteps(json);
  const slotsAfter = getPersonaSlots(revalidated);
  assert.equal(slotsAfter.length, 3, 'persona_slot must survive parseAndValidateSteps');
  assert.equal(slotsAfter[1].slot, 'code');
});

test('getPersonaSlots is tolerant of malformed / slot-less steps', () => {
  assert.deepEqual(getPersonaSlots(null), []);
  assert.deepEqual(getPersonaSlots('not json'), []);
  assert.deepEqual(getPersonaSlots('[{"name":"a step"}]'), []);
});

// ── 4. Dispatch PERSONA PLAN block ──────────────────────────────────────────

const workedPlan: PersonaPlanSubtask[] = [
  { seq: 1, slot: 'content', subtask_text: 'write the copy for Black women', persona_id: 'bly-copywriters-handbook', persona_name: 'Bly', why: 'lived-experience copy fit' },
  { seq: 2, slot: 'code', subtask_text: 'build the funnel', persona_id: 'hunt-thomas-pragmatic-programmer', persona_name: 'Pragmatic Programmer' },
  { seq: 3, slot: 'image', subtask_text: 'design the hero images', persona_id: 'opara-color-works', persona_name: 'Opara' },
  { seq: 4, slot: 'delivery', subtask_text: 'deploy the site', persona_id: null, no_persona_required: true, governance_persona_id: 'covey-7-habits' },
];

test('buildPersonaPlanBlock: one Section-4 pointer per non-mechanical sub-task, ≥2 distinct personas', () => {
  const block = buildPersonaPlanBlock(workedPlan, settings);
  assert.ok(block.includes('PERSONA PLAN'), 'renders a PERSONA PLAN block');

  // One load contract ("Read the blueprint") per NON-mechanical sub-task (3 here).
  const loadPointers = block.match(/Read the blueprint:/g) ?? [];
  assert.equal(loadPointers.length, 3, `expected 3 Section-4 load pointers, got ${loadPointers.length}`);

  // ≥2 distinct personas appear as blueprint paths.
  assert.ok(block.includes(personaBlueprintPath('bly-copywriters-handbook')));
  assert.ok(block.includes(personaBlueprintPath('hunt-thomas-pragmatic-programmer')));
  assert.ok(block.includes(personaBlueprintPath('opara-color-works')));

  // The image sub-task resolved to the visual-storytelling persona (Q3).
  assert.ok(block.includes('opara-color-works'));

  // The mechanical sub-task is a governance pointer, NOT a full load.
  assert.ok(block.includes('none required') || block.includes('Governance oversight'), 'mechanical sub-task → governance pointer');

  // NEVER a self-selection instruction.
  assert.ok(!/AUTO-SELECT/i.test(block), 'no AUTO-SELECT prose');
  assert.ok(!/5-Layer Persona Matching Protocol/i.test(block), 'no self-selection protocol');
});

test('buildPersonaPlanBlock returns empty for a single-persona task (no regression)', () => {
  assert.equal(buildPersonaPlanBlock([workedPlan[0]], settings), '');
  assert.equal(buildPersonaPlanBlock([], settings), '');
});

// ── PERSONA-BLEND × multi-persona — the task-level voice directive must NOT be
//    duplicated onto every sub-task. The blend directive is a TASK-level voice
//    property; sub-task plan rows carry no blend_directive, so buildPersonaPlanBlock
//    renders ZERO blend directives (the guardrail rides ONCE on the primary block
//    that task-dispatcher renders alongside the plan). ─────────────────────────
test('buildPersonaPlanBlock does NOT render the task-level blend directive per sub-task', () => {
  const block = buildPersonaPlanBlock(workedPlan, settings);
  assert.ok(!block.includes('Voice blend directive'), 'plan sub-tasks must not each carry the blend directive');
});
