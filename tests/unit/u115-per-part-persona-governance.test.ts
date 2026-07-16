/**
 * U115 (E6-1, closes G7; master spec v2 Section E6, ADD-1) — per-part /
 * per-persona governance across multi-item & long-horizon tasks. CC leg.
 *
 * The ONB leg landed on openclaw-onboarding main (merge commit
 * c396225187a5b61d028a95b2e1aa256b3a4fae0e) and explicitly recorded the CC
 * leg as OWED: "CC leg (kanban card per-part persona-assignment row) OWED -
 * ONB leg only." This suite + its render-level companion
 * (u115-per-part-chips-render.test.tsx) prove that leg against U115's
 * CC-side acceptance criterion, spec line 2467:
 *
 *   (c) the board card AND the task-detail modal each render one per-part
 *       persona-assignment row per part, naming its blend + audience, with
 *       the SAME ids the map records (single source, no divergence).
 *
 * Reuses the U5 scoped-bundle table + persist/load/chip pattern verbatim
 * (never a new bundle store — master spec L2465), extended by migration 107
 * with the 5 mirror columns migration 105 had no home for. The ONB matcher's
 * `govern_task_parts` (23-ai-workforce-blueprint/scripts/persona_blend.py)
 * emits an 8-key record PER PART into routing/part-persona-map.json:
 *   part_id, part_role, voice_persona_id, topic_persona_id, audience_label,
 *   audience_source, stage, reason.
 * Every fixture below is copied field-for-field from that shape so the two
 * repos cannot silently drift (per the scope analysis's own recommendation).
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

getDb(); // apply the full migration chain, including 107.

function seedTask(title: string): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, status, department, workspace_id, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'marketing', NULL, ?, ?)`,
    [id, title, new Date().toISOString(), new Date().toISOString()],
  );
  return id;
}

// A bundle-shaped fixture mirroring a PER-PART governed call: scope_hint
// carries {part_id, part_role, stage} (the CC-side persist contract — see
// PersonaBundleScopeHint's header comment for why this differs from the ONB
// matcher's own internal build_bundle(scope_hint={"part_id": ...}) call),
// resolved_audience carries {label, source}, voice carries a DISTINCT
// audience_persona (VOICE) + topic_persona (TOPIC EXPERTISE).
function partBundle(overrides: Partial<PersonaBundle> = {}): PersonaBundle {
  return {
    topic: 'launch copywriting',
    resolved_audience: { source: 'onboarding_icp', confidence: 'high', candidates: ['founders'] } as PersonaBundle['resolved_audience'],
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
    scope: 'sales-page',
    scope_hint: { part_id: 'sales-page', part_role: 'sales-page', stage: 'launch-week-1' },
    rationale: { scope: 'part=sales-page — distinct audience + topic personas (blend)' },
    ...overrides,
  } as PersonaBundle;
}

// ── migration 107 — additive-only column proof ─────────────────────────────

test('migration 107 adds all 5 per-part columns to task_persona_bundle_scope', () => {
  const info = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pragma_table_info('task_persona_bundle_scope')
      WHERE name IN ('part_role','stage','topic_persona_id','audience_label','audience_source')`,
    [],
  );
  assert.equal(info?.n, 5, 'all 5 U115 mirror columns exist on task_persona_bundle_scope');
});

test('migration 107 never touches task_persona_bundle (090) — schema byte-identical', () => {
  const sql = queryOne<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='task_persona_bundle'",
    [],
  );
  assert.ok(sql, 'task_persona_bundle table exists (090 ran)');
  const expected =
    `CREATE TABLE task_persona_bundle (\n` +
    `  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),\n` +
    `  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,\n` +
    `  bundle_json TEXT,\n` +
    `  catalog_version TEXT,\n` +
    `  confirm_state TEXT,\n` +
    `  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n` +
    `)`;
  assert.equal(sql!.sql, expected, '090 table schema must be byte-identical pre/post migration 107');
});

test('NO-WEAKENING: migration 107 never touches task_persona_bundle_scope (105)\'s composite UNIQUE(task_id, scope)', () => {
  const taskId = seedTask('constraint probe, post-107');
  run(
    `INSERT INTO task_persona_bundle_scope (task_id, scope, bundle_json, part_role) VALUES (?, ?, ?, ?)`,
    [taskId, 'sales-page', '{}', 'sales-page'],
  );
  assert.throws(() => {
    run(
      `INSERT INTO task_persona_bundle_scope (task_id, scope, bundle_json, part_role) VALUES (?, ?, ?, ?)`,
      [taskId, 'sales-page', '{}', 'sales-page-dupe'],
    );
  }, /UNIQUE constraint failed/, 'the composite UNIQUE(task_id, scope) constraint still has teeth after 107');
});

// ── persist + load round trip, the 5 new fields ─────────────────────────────

test('persistPersonaBundleScope writes part_role, stage, topic_persona_id, audience_label, audience_source', () => {
  const taskId = seedTask('build the sales page (per-part)');
  const wrote = persistPersonaBundleScope(taskId, 'sales-page', partBundle({
    resolved_audience: { source: 'onboarding_icp', confidence: 'high', candidates: ['founders'], label: 'early-stage SaaS founders' } as PersonaBundle['resolved_audience'],
  }));
  assert.equal(wrote, true);

  const rows = loadPersonaBundleScopes(taskId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].scope, 'sales-page');
  assert.equal(rows[0].part_role, 'sales-page');
  assert.equal(rows[0].stage, 'launch-week-1');
  assert.equal(rows[0].topic_persona_id, 'russell-brunson', 'topic_persona_id is the TOPIC persona, distinct from the VOICE persona_id');
  assert.equal(rows[0].persona_id, 'shonda-rhimes', 'persona_id (voice column) stays the VOICE persona, unchanged by this unit');
  assert.equal(rows[0].audience_label, 'early-stage SaaS founders');
  assert.equal(rows[0].audience_source, 'onboarding_icp');
});

test('a row with NO resolved_audience.label persists a null audience_label — never fabricated', () => {
  const taskId = seedTask('a part with an unresolved audience');
  persistPersonaBundleScope(taskId, 'social-post-1', partBundle({
    scope: 'social-post-1',
    scope_hint: { part_id: 'social-post-1', part_role: 'social-post', stage: 'launch-week-1' },
    resolved_audience: { source: 'onboarding_icp', confidence: 0.4, candidates: ['founders'] } as PersonaBundle['resolved_audience'],
  }));
  const rows = loadPersonaBundleScopes(taskId);
  assert.equal(rows[0].audience_label, null);
  assert.equal(rows[0].audience_source, 'onboarding_icp');
});

// ── (a)/(c) fixture parity — mirrors the ONB 8-key map_records contract ────
//
// The spec's own campaign fixture: a sales page + a 3-email nurture sequence
// + 2 social posts = 6 parts. >=2 parts must carry DISTINCT blends, each with
// its OWN audience + topic (part count == bundle-scope count).

test('(a)/(c) a 6-part campaign fixture persists ONE scope row PER PART, >=2 with DISTINCT blends + audiences', () => {
  const taskId = seedTask('campaign: launch sequence (sales page + 3-email nurture + 2 social posts)');

  const parts: { part_id: string; part_role: string; stage: string; voice: string; topic: string; audience: string }[] = [
    { part_id: 'sales-page', part_role: 'sales-page', stage: 'launch-week-1', voice: 'shonda-rhimes', topic: 'russell-brunson', audience: 'early-stage SaaS founders' },
    { part_id: 'nurture-email-1', part_role: 'nurture-email', stage: 'launch-week-1', voice: 'aliche-get-good-with-money', topic: 'aliche-get-good-with-money', audience: 'existing newsletter subscribers' },
    { part_id: 'nurture-email-2', part_role: 'nurture-email', stage: 'launch-week-1', voice: 'aliche-get-good-with-money', topic: 'aliche-get-good-with-money', audience: 'existing newsletter subscribers' },
    { part_id: 'nurture-email-3', part_role: 'nurture-email', stage: 'launch-week-2', voice: 'aliche-get-good-with-money', topic: 'aliche-get-good-with-money', audience: 'existing newsletter subscribers' },
    { part_id: 'social-post-1', part_role: 'social-post', stage: 'launch-week-1', voice: 'edwards-copywriting-secrets', topic: 'russell-brunson', audience: 'cold social audience' },
    { part_id: 'social-post-2', part_role: 'social-post', stage: 'launch-week-2', voice: 'edwards-copywriting-secrets', topic: 'russell-brunson', audience: 'cold social audience' },
  ];

  for (const p of parts) {
    const wrote = persistPersonaBundleScope(taskId, p.part_id, partBundle({
      scope: p.part_id,
      scope_hint: { part_id: p.part_id, part_role: p.part_role, stage: p.stage },
      voice: {
        audience_persona: { id: p.voice, why: 'audience voice' },
        topic_persona: { id: p.topic, why: 'topic expertise' },
        collapsed: p.voice === p.topic,
        collapsed_persona_id: p.voice === p.topic ? p.voice : null,
      },
      resolved_audience: { source: 'onboarding_icp', confidence: 0.9, candidates: [p.audience], label: p.audience } as PersonaBundle['resolved_audience'],
      rationale: { scope: `part=${p.part_id} — ${p.part_role} governed independently` },
    }));
    assert.equal(wrote, true, `part ${p.part_id} persisted`);
  }

  const rows = loadPersonaBundleScopes(taskId);
  // part count == bundle-scope count (spec acceptance (a))
  assert.equal(rows.length, parts.length, 'exactly one scope row per declared part');

  const scopeIds = rows.map((r) => r.scope).sort();
  assert.deepEqual(scopeIds, [...parts.map((p) => p.part_id)].sort());

  // >=2 parts carry DISTINCT blends, each with its own audience + topic.
  const distinctBlendKeys = new Set(rows.map((r) => `${r.persona_id}::${r.topic_persona_id}`));
  assert.ok(distinctBlendKeys.size >= 2, `expected >=2 distinct (voice,topic) blends, got ${[...distinctBlendKeys]}`);

  const distinctAudiences = new Set(rows.map((r) => r.audience_label));
  assert.ok(distinctAudiences.size >= 2, `expected >=2 distinct audiences, got ${[...distinctAudiences]}`);

  // Every row's ids match what the ONB map_records contract would have
  // recorded for that part — single source, no divergence (acceptance c).
  for (const p of parts) {
    const row = rows.find((r) => r.scope === p.part_id);
    assert.ok(row, `row for part ${p.part_id} exists`);
    assert.equal(row!.part_role, p.part_role);
    assert.equal(row!.stage, p.stage);
    assert.equal(row!.persona_id, p.voice);
    assert.equal(row!.topic_persona_id, p.topic);
    assert.equal(row!.audience_label, p.audience);
  }

  // The A.6 "different-blends-allowed" invariant: a legitimately SHARED
  // blend (the 3 nurture emails) still carries its own logged reason.
  const nurtureRows = rows.filter((r) => r.part_role === 'nurture-email');
  assert.equal(nurtureRows.length, 3);
  for (const r of nurtureRows) {
    assert.ok(r.scope_reason && r.scope_reason.includes('governed independently'), 'shared blend carries a logged reason');
  }
});

// ── (d) back-compat: an UNSCOPED / pre-U115-shaped bundle is unaffected ────

test('(d) back-compat: a plain A-U5 per-PAGE bundle (no part_role/stage/topic/audience) still round-trips, new columns null', () => {
  const taskId = seedTask('a plain per-page funnel task, pre-U115 shape');
  const legacyBundle: PersonaBundle = {
    topic: 'email marketing',
    resolved_audience: { source: 'onboarding_icp', confidence: 'high', candidates: ['black women'] } as PersonaBundle['resolved_audience'],
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
    rationale: { scope: 'scope=sales, page_role=sales — distinct audience + topic personas (blend)' },
  } as PersonaBundle;

  persistPersonaBundleScope(taskId, 'sales', legacyBundle);
  const rows = loadPersonaBundleScopes(taskId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].page_role, 'sales');
  assert.equal(rows[0].persona_id, 'shonda-rhimes');
  // U115's 5 new columns are all null — no fabrication for a bundle that
  // never declared a part.
  assert.equal(rows[0].part_role, null);
  assert.equal(rows[0].stage, null);
  // topic_persona_id IS populated because it derives from voice.topic_persona
  // (an A-U5-era field, not U115-only) — proves the mirror is additive, not
  // gated behind a part declaration.
  assert.equal(rows[0].topic_persona_id, 'russell-brunson');
  assert.equal(rows[0].audience_label, null, 'this legacy fixture never resolved a confirmed label');
});

// ── parsePersonaBundle carries part_role/stage through additively ──────────

test('parsePersonaBundle echoes scope_hint.part_role + scope_hint.stage through when the raw result carries them', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: { id: 'russell-brunson', why: 'y' }, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
    scope: 'sales-page',
    scope_hint: { part_id: 'sales-page', part_role: 'sales-page', stage: 'launch-week-1' },
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.scope_hint?.part_role, 'sales-page');
  assert.equal(bundle!.scope_hint?.stage, 'launch-week-1');
});

test('NO-WEAKENING / back-compat: parsePersonaBundle on a raw result with no scope fields still carries neither part_role nor stage', () => {
  const raw = {
    voice: { audience_persona: { id: 'shonda-rhimes', why: 'x' }, topic_persona: { id: 'russell-brunson', why: 'y' }, collapsed: false },
    blend_directive: 'Write in X voice.',
    confirm_required: false,
  };
  const bundle = parsePersonaBundle(raw);
  assert.ok(bundle);
  assert.equal(bundle!.scope_hint, null);
});
