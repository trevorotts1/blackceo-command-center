/**
 * A-U5 (master spec v2 Section A.6) — per-page/scoped persona blends, CC side.
 *
 * Companion to `23-ai-workforce-blueprint/scripts/test-a-u5-scoped-bundle.py`
 * in `openclaw-onboarding` (the ONB matcher-side `build_bundle(scope_hint=...)`
 * proof). This suite proves the CC persistence + surface half against A-U5's
 * own binary acceptance criteria (Section A.10):
 *
 *   (b) `task_persona_bundle_scope` rows persist per (task_id, scope) and
 *       render as chips (snapshot test lives in the companion .test.tsx —
 *       this file proves the persist/load contract the chip reads from);
 *   (c) all existing single-bundle consumers pass unmodified — proven here by
 *       never touching `task_persona_bundle` (090) rows or mirror columns
 *       from any scoped-bundle write, and by the untouched suite in
 *       p4-02-persona-blend-visibility.test.ts staying green (CI re-runs it);
 *   (d) the 090 table's schema is byte-identical pre/post migration 104
 *       (schema-dump diff = empty) — proven directly against sqlite_master.
 *
 * Node built-in test runner under tsx (`npm run test:unit`). DB isolation
 * MUST be the first import (see dep5-persona-plan-multi.test.ts's C8 note).
 */
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne } from '../../src/lib/db';
import {
  persistPersonaBundleScope,
  loadPersonaBundleScopes,
  parsePersonaBundle,
} from '../../src/lib/persona-selector';
import type { PersonaBundle } from '../../src/lib/types';

getDb(); // apply the full migration chain (tasks, task_persona_bundle, task_persona_bundle_scope).

function seedTask(title: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, department, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'marketing', NULL, ?, ?)`,
    [id, title, new Date().toISOString(), new Date().toISOString()],
  );
  return id;
}

// A bundle-shaped fixture mirroring the ONB matcher's scoped output (post
// parsePersonaBundle normalization) — distinct audience+topic, NOT collapsed.
function scopedBundle(overrides: Partial<PersonaBundle> = {}): PersonaBundle {
  return {
    topic: 'email marketing',
    resolved_audience: { source: 'onboarding_icp', confidence: 'high', candidates: ['black women'] },
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
    scope: 'sales',
    scope_hint: { page_role: 'sales', page_slug: 'sales', conversion_goal: 'book-a-call' },
    rationale: { scope: 'scope=sales, page_role=sales, conversion_goal=book-a-call — distinct audience + topic personas (blend)' },
    ...overrides,
  } as PersonaBundle;
}

// ── (b) persist + load round trip ───────────────────────────────────────────

test('persistPersonaBundleScope writes a row keyed (task_id, scope) with the resolved voice persona', () => {
  const taskId = seedTask('build the sales page');
  const wrote = persistPersonaBundleScope(taskId, 'sales', scopedBundle());
  assert.equal(wrote, true);

  const rows = loadPersonaBundleScopes(taskId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, 'sales');
  assert.equal(rows[0].page_role, 'sales');
  assert.equal(rows[0].page_slug, 'sales');
  assert.equal(rows[0].conversion_goal, 'book-a-call');
  // NOT collapsed -> voice persona = the audience persona (same precedence
  // persistPersonaBundle uses for the unscoped mirror columns).
  assert.equal(rows[0].persona_id, 'shonda-rhimes');
  assert.ok(rows[0].scope_reason && rows[0].scope_reason.includes('scope=sales'));
});

test('a COLLAPSED scoped bundle mirrors the collapsed persona as the voice', () => {
  const taskId = seedTask('write a budgeting email for our members');
  const collapsed = scopedBundle({
    voice: {
      audience_persona: null,
      topic_persona: { id: 'aliche-get-good-with-money', why: 'covers both' },
      collapsed: true,
      collapsed_persona_id: 'aliche-get-good-with-money',
    },
    scope: 'opt-in',
    scope_hint: { page_role: 'opt-in', page_slug: 'opt-in', conversion_goal: 'lead-capture' },
  });
  persistPersonaBundleScope(taskId, 'opt-in', collapsed);

  const rows = loadPersonaBundleScopes(taskId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].persona_id, 'aliche-get-good-with-money');
  assert.equal(rows[0].persona_name, 'Aliche Get Good With Money');
});

test('multiple pages on the SAME task each persist their own scope row (real funnel shape)', () => {
  const taskId = seedTask('build the 3-page launch funnel');
  const optIn = scopedBundle({
    scope: 'opt-in',
    scope_hint: { page_role: 'opt-in', page_slug: 'opt-in', conversion_goal: 'lead-capture' },
    voice: {
      audience_persona: null,
      topic_persona: { id: 'aliche-get-good-with-money', why: 'covers both' },
      collapsed: true,
      collapsed_persona_id: 'aliche-get-good-with-money',
    },
  });
  const sales = scopedBundle({ scope: 'sales', scope_hint: { page_role: 'sales', page_slug: 'sales', conversion_goal: 'book-a-call' } });
  const thankYou = scopedBundle({ scope: 'thank-you', scope_hint: { page_role: 'thank-you', page_slug: 'thank-you', conversion_goal: 'confirm-booking' } });

  assert.equal(persistPersonaBundleScope(taskId, 'opt-in', optIn), true);
  assert.equal(persistPersonaBundleScope(taskId, 'sales', sales), true);
  assert.equal(persistPersonaBundleScope(taskId, 'thank-you', thankYou), true);

  const rows = loadPersonaBundleScopes(taskId);
  assert.equal(rows.length, 3, 'exactly N=3 scope rows, one per page');
  const scopes = rows.map((r) => r.scope).sort();
  assert.deepEqual(scopes, ['opt-in', 'sales', 'thank-you']);

  const distinctPersonas = new Set(rows.map((r) => r.persona_id));
  assert.ok(distinctPersonas.size >= 2, `expected >=2 distinct voice personas, got ${[...distinctPersonas]}`);
});

test('persistPersonaBundleScope UPSERTs on a repeat (task_id, scope) — idempotent, never duplicates', () => {
  const taskId = seedTask('re-run the sales page blend');
  persistPersonaBundleScope(taskId, 'sales', scopedBundle());
  persistPersonaBundleScope(
    taskId,
    'sales',
    scopedBundle({
      voice: {
        audience_persona: { id: 'edwards-copywriting-secrets', why: 'a different audience voice' },
        topic_persona: { id: 'russell-brunson', why: 'topic expertise' },
        collapsed: false,
        collapsed_persona_id: null,
      },
    }),
  );

  const rows = loadPersonaBundleScopes(taskId);
  assert.equal(rows.length, 1, 'a second write to the same scope UPDATEs, never inserts a duplicate row');
  assert.equal(rows[0].persona_id, 'edwards-copywriting-secrets', 'the update won — latest write is authoritative');

  const count = queryOne<{ n: number }>(
    'SELECT COUNT(*) AS n FROM task_persona_bundle_scope WHERE task_id = ?',
    [taskId],
  );
  assert.equal(count?.n, 1);
});

test('persistPersonaBundleScope refuses an empty scope key (never writes a keyless row)', () => {
  const taskId = seedTask('a task with no resolvable scope');
  const wrote = persistPersonaBundleScope(taskId, '', scopedBundle());
  assert.equal(wrote, false);
  assert.equal(loadPersonaBundleScopes(taskId).length, 0);
});

test('loadPersonaBundleScopes is tolerant: a task with zero scoped bundles returns []', () => {
  const taskId = seedTask('a plain single-bundle task');
  assert.deepEqual(loadPersonaBundleScopes(taskId), []);
});

test('persistPersonaBundleScope NEVER touches task_persona_bundle (090) rows or the tasks mirror columns', () => {
  const taskId = seedTask('scoped-only task, no unscoped bundle ever written');
  persistPersonaBundleScope(taskId, 'sales', scopedBundle());

  const unscoped = queryOne('SELECT * FROM task_persona_bundle WHERE task_id = ?', [taskId]);
  assert.equal(unscoped, undefined, 'no task_persona_bundle row was created by the scoped write');

  const task = queryOne<{ voice_persona_id: string | null; blend_directive: string | null }>(
    'SELECT voice_persona_id, blend_directive FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.voice_persona_id, null, 'the task-level mirror column is untouched by a scoped write');
  assert.equal(task?.blend_directive, null);
});

// ── parsePersonaBundle carries scope/scope_hint through additively ─────────

test('parsePersonaBundle echoes scope + scope_hint through when the raw result carries them', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: { id: 'russell-brunson', why: 'y' }, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
    scope: 'sales',
    scope_hint: { page_role: 'sales', page_slug: 'sales', conversion_goal: 'book-a-call' },
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.scope, 'sales');
  assert.deepEqual(bundle!.scope_hint, {
    page_role: 'sales',
    page_slug: 'sales',
    conversion_goal: 'book-a-call',
    part_id: null,
  });
});

test('NO-WEAKENING / back-compat: parsePersonaBundle on a raw result with no scope fields carries neither', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: { id: 'russell-brunson', why: 'y' }, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.scope, null);
  assert.equal(bundle!.scope_hint, null);
});

// ── (d) migration 104 is additive-only: 090's schema is byte-identical ─────

test('(d) migration 104 never alters task_persona_bundle (090) — schema byte-identical', () => {
  const sql = queryOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_persona_bundle'",
    [],
  );
  assert.ok(sql, 'task_persona_bundle table exists (090 ran)');
  // The EXACT CREATE TABLE statement migration 090 shipped — any ALTER/DROP/
  // recreate by 104 (or anything after) would change this string.
  const expected =
    `CREATE TABLE task_persona_bundle (\n` +
    `  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),\n` +
    `  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,\n` +
    `  bundle_json TEXT,\n` +
    `  catalog_version TEXT,\n` +
    `  confirm_state TEXT,\n` +
    `  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n` +
    `)`;
  assert.equal(sql!.sql, expected, '090 table schema must be byte-identical pre/post migration 104');

  // The UNIQUE constraint on task_id (the structural fact that MADE scoped
  // bundles necessary in the first place) is still exactly one bundle/task.
  assert.match(sql!.sql, /task_id TEXT NOT NULL UNIQUE/);
});

test('the NEW task_persona_bundle_scope table has a composite UNIQUE(task_id, scope), never task_id alone', () => {
  const sql = queryOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_persona_bundle_scope'",
    [],
  );
  assert.ok(sql, 'task_persona_bundle_scope table exists (104 ran)');
  assert.match(sql!.sql, /UNIQUE \(task_id, scope\)/);
  assert.doesNotMatch(sql!.sql, /task_id TEXT NOT NULL UNIQUE/, 'must NOT reuse 090\'s single-bundle-per-task constraint');
});

test('NO-WEAKENING: a duplicate (task_id, scope) insert attempted directly (bypassing the upsert helper) is rejected by the DB', () => {
  const taskId = seedTask('constraint probe');
  run(
    `INSERT INTO task_persona_bundle_scope (task_id, scope, bundle_json) VALUES (?, ?, ?)`,
    [taskId, 'sales', '{}'],
  );
  assert.throws(() => {
    run(
      `INSERT INTO task_persona_bundle_scope (task_id, scope, bundle_json) VALUES (?, ?, ?)`,
      [taskId, 'sales', '{}'],
    );
  }, /UNIQUE constraint failed/, 'the composite UNIQUE(task_id, scope) constraint has teeth');
});
