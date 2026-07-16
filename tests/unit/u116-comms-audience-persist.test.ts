/**
 * U116 (E6-2; master spec v2 Section E6-2, implements ADD-2, closes G8) —
 * Command Center leg, the persist/parse half feeding BINARY acceptance (e)
 * (the board-card render proof lives in the companion
 * tests/unit/u116-comms-audience-chip-render.test.tsx).
 *
 * Proves:
 *   1. Migration 108 adds `tasks.comms_audience_source` / `tasks.comms_type`,
 *      additive-only (never touches migration 090's `audience_source`
 *      column or its own value).
 *   2. `parsePersonaBundle` reads the bundle-ROOT `audience_source` /
 *      `comms_type` fields into `PersonaBundle.comms_audience_source` /
 *      `.comms_type` — NEVER the nested `resolved_audience.source`.
 *   3. `persistPersonaBundle` writes those parsed fields to the NEW mirror
 *      columns, leaving the migration-090 `audience_source` mirror column
 *      (which mirrors `resolved_audience.source`) completely independent —
 *      a bundle can legitimately carry BOTH fields with DIFFERENT values on
 *      the SAME task at the SAME time.
 *   4. A bundle with no U116 fields (pre-U116-shaped, or `COMMS_AUDIENCE_
 *      PROMPT=0` revert path) leaves both new columns null — the render
 *      layer's empty-state contract depends on this.
 *
 * THE NAME-COLLISION TRAP (this is the load-bearing assertion in this file):
 * `bundle.resolved_audience.source` (migration 090 vocabulary:
 * onboarding_icp | operator_confirmed | asked) and `bundle.audience_source`
 * (U116 bundle-ROOT vocabulary: standard | specific) are TWO DIFFERENT
 * fields that a real comms bundle carries SIMULTANEOUSLY with DIFFERENT
 * values. A regression that collapses them (reads the wrong one, or writes
 * one to both mirror columns) is exactly what this file's collision test
 * catches.
 *
 * Node built-in test runner under tsx (`npm run test:unit`). DB isolation
 * MUST be the first import (see dep5-persona-plan-multi.test.ts's C8 note).
 */
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import { persistPersonaBundle, parsePersonaBundle } from '../../src/lib/persona-selector';
import type { PersonaBundle } from '../../src/lib/types';

getDb(); // apply the full migration chain, including 108.

function seedTask(title: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, department, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'marketing', NULL, ?, ?)`,
    [id, title, new Date().toISOString(), new Date().toISOString()],
  );
  return id;
}

function readMirrors(taskId: string) {
  return queryOne<{
    audience_source: string | null;
    comms_audience_source: string | null;
    comms_type: string | null;
  }>(
    'SELECT audience_source, comms_audience_source, comms_type FROM tasks WHERE id = ?',
    [taskId],
  );
}

// A bundle-shaped fixture mirroring the ONB matcher's comms-trigger output
// (post parsePersonaBundle normalization) — carries BOTH audience_source
// fields at once, with DELIBERATELY DIFFERENT values, exactly as a real
// comms_audience_trigger.py-produced bundle would.
function commsBundle(overrides: Partial<PersonaBundle> = {}): PersonaBundle {
  return {
    topic: 'spring sale announcement',
    // migration-090 provenance field: how the audience was RESOLVED.
    resolved_audience: { source: 'onboarding_icp', confidence: 0.9, candidates: ['black women entrepreneurs'] },
    confirm_required: false,
    voice: {
      audience_persona: { id: 'shonda-rhimes', why: 'audience voice' },
      topic_persona: { id: 'russell-brunson', why: 'topic expertise' },
      collapsed: false,
      collapsed_persona_id: null,
    },
    blend_directive: "Write in Shonda Rhimes's VOICE while carrying Russell Brunson's EXPERTISE.",
    task_personas: [],
    catalog_version: '1.3',
    // U116 bundle-ROOT fields: the ADD-2 standard-vs-specific CONFIRMATION outcome.
    comms_audience_source: 'specific',
    comms_type: 'email',
    ...overrides,
  } as PersonaBundle;
}

// ── migration 108 additive-only ─────────────────────────────────────────────

test('migration 108 adds comms_audience_source + comms_type columns to tasks, additive-only', () => {
  const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name);
  assert.ok(cols.includes('comms_audience_source'), 'tasks.comms_audience_source must exist post-108');
  assert.ok(cols.includes('comms_type'), 'tasks.comms_type must exist post-108');
  // The migration-090 column this must NEVER be conflated with must still
  // exist, completely unmodified in shape.
  assert.ok(cols.includes('audience_source'), 'migration 090 audience_source column untouched');
});

// ── parsePersonaBundle reads the bundle ROOT, never the nested field ───────

test('parsePersonaBundle reads the bundle-ROOT audience_source into comms_audience_source', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: { id: 'russell-brunson', why: 'y' }, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
    // bundle ROOT — what comms_audience_trigger.py:350 actually stamps.
    audience_source: 'specific',
    comms_type: 'sms',
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.comms_audience_source, 'specific');
  assert.equal(bundle!.comms_type, 'sms');
});

test('COLLISION GUARD: a raw result carrying BOTH the nested resolved_audience.source AND the bundle-root audience_source keeps them independent', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: { id: 'russell-brunson', why: 'y' }, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
    // Nested — migration-090 provenance vocabulary.
    resolved_audience: { source: 'onboarding_icp', confidence: 'high', candidates: ['x'] },
    // Bundle ROOT — U116 standard/specific vocabulary. Deliberately a
    // DIFFERENT value family so a collapse bug is unmistakable.
    audience_source: 'standard',
    comms_type: 'blog',
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.resolved_audience?.source, 'onboarding_icp', 'the nested provenance field is untouched');
  assert.equal(bundle!.comms_audience_source, 'standard', 'the bundle-root U116 field is read independently');
});

test('parsePersonaBundle rejects an unrecognized bundle-root audience_source value (never fabricates standard|specific)', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: null, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
    // A caller-programming mistake: the migration-090 vocabulary value
    // leaked into the bundle-root field. Must NOT pass through.
    audience_source: 'onboarding_icp',
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.comms_audience_source, null);
});

test('parsePersonaBundle rejects an unrecognized comms_type value', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: null, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
    comms_type: 'not-a-real-comms-type',
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.comms_type, null);
});

test('back-compat: a raw result with no U116 fields carries neither comms_audience_source nor comms_type', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: { id: 'russell-brunson', why: 'y' }, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.comms_audience_source, null);
  assert.equal(bundle!.comms_type, null);
});

// ── persistPersonaBundle writes the new mirror columns, independent of 090 ─

test('persistPersonaBundle writes comms_audience_source/comms_type to the NEW mirror columns without touching audience_source', () => {
  const taskId = seedTask('write the spring sale email');
  const wrote = persistPersonaBundle(taskId, commsBundle());
  assert.equal(wrote, true);

  const row = readMirrors(taskId);
  assert.ok(row);
  // The migration-090 field, mirroring resolved_audience.source.
  assert.equal(row!.audience_source, 'onboarding_icp');
  // The U116 fields, mirroring the bundle-ROOT fields — a DIFFERENT value,
  // proving the two columns are independently written.
  assert.equal(row!.comms_audience_source, 'specific');
  assert.equal(row!.comms_type, 'email');
});

test('persistPersonaBundle on a STANDARD-audience comms bundle records comms_audience_source="standard"', () => {
  const taskId = seedTask('write the standard-audience newsletter');
  persistPersonaBundle(
    taskId,
    commsBundle({
      comms_audience_source: 'standard',
      comms_type: 'blog',
      resolved_audience: { source: 'operator_confirmed', confidence: 0.7, candidates: ['general list'] },
    }),
  );

  const row = readMirrors(taskId);
  assert.equal(row?.comms_audience_source, 'standard');
  assert.equal(row?.comms_type, 'blog');
  // Again independent: resolved_audience.source is 'operator_confirmed'
  // here (a DIFFERENT value family from 'standard'), proving no collapse.
  assert.equal(row?.audience_source, 'operator_confirmed');
});

test('a non-comms bundle (no U116 fields) leaves both new mirror columns null — the render-empty-state contract', () => {
  const taskId = seedTask('an ordinary non-comms task');
  const plainBundle: PersonaBundle = {
    topic: null,
    resolved_audience: null,
    confirm_required: false,
    voice: { audience_persona: null, topic_persona: null, collapsed: false, collapsed_persona_id: null },
    blend_directive: 'Write in X voice.',
    task_personas: [],
  };
  persistPersonaBundle(taskId, plainBundle);

  const row = readMirrors(taskId);
  assert.equal(row?.comms_audience_source, null);
  assert.equal(row?.comms_type, null);
});

test('persistPersonaBundle UPSERT semantics apply identically to the new mirror columns on a repeat write', () => {
  const taskId = seedTask('re-run the comms bundle');
  persistPersonaBundle(taskId, commsBundle({ comms_audience_source: 'standard' }));
  assert.equal(readMirrors(taskId)?.comms_audience_source, 'standard');

  persistPersonaBundle(taskId, commsBundle({ comms_audience_source: 'specific' }));
  assert.equal(readMirrors(taskId)?.comms_audience_source, 'specific', 'the second write wins, no duplicate row');

  const count = queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE id = ?', [taskId]);
  assert.equal(count?.n, 1);
});
