/**
 * DEP-2 / finding F3.4-cc — SOP-aware persona matching (Command Center side).
 *
 * The running SOP now informs the persona match. Two hops are wired:
 *   1. At task CREATION, the SOP auto-suggest runs BEFORE persona selection and
 *      its slug + name + curated `persona_hints` are folded into the match via the
 *      selector's `--sop-slug` / `--sop-name` / `--sop-hints` inputs (DEP-1).
 *   2. At DISPATCH, if the resolved SOP differs from the one selection saw, the
 *      persona is RE-SCORED with the SOP context before the dispatch message is
 *      built — and a `persona_rescored_at_dispatch` event is persisted.
 *
 * Contract asserted here:
 *   - SOP context is forwarded to the selector ONLY when it carries something
 *     usable, and multiple `persona_hints` (a candidate pool for a DIFFERENT
 *     specialist to win) are all forwarded — the multi-persona-hint path.
 *   - persona_hints parsing is defensive (drops empties/sentinels, tolerates junk).
 *   - NO-NAKED / fail-closed: a null / mechanical / sentinel rescore result NEVER
 *     downgrades a persona the task already carries.
 *   - The rescore actually re-pins a concrete new persona and writes the
 *     `persona_rescored_at_dispatch` audit event.
 *
 * Isolated temp DB. No real Python selector — PERSONA_FIXTURE_JSON forces the
 * selector result, so the pure forwarding + DB behavior are tested hermetically.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dep2-sop-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let parsePersonaHints: TasksModule['parsePersonaHints'];
let sopSelectorContextFromRow: TasksModule['sopSelectorContextFromRow'];
let loadSopSelectorContextById: TasksModule['loadSopSelectorContextById'];
let rescorePersonaWithSOP: TasksModule['rescorePersonaWithSOP'];

type SelectorModule = typeof import('../../src/lib/persona-selector');
let buildSelectorArgv: SelectorModule['buildSelectorArgv'];
let hasSopContext: SelectorModule['hasSopContext'];
let persistPersonaBundle: SelectorModule['persistPersonaBundle'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

function insertTaskWithPersona(
  id: string,
  persona: { persona_id: string | null; persona_name?: string | null; persona_mode?: string | null },
) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, department,
                        persona_id, persona_name, persona_mode, created_at, updated_at)
     VALUES (?, ?, ?, 'backlog', 'medium', NULL, NULL, 'marketing', ?, ?, ?, ?, ?)`,
    [
      id, `SOP task ${id}`, 'Write a cold outreach email',
      persona.persona_id, persona.persona_name ?? null, persona.persona_mode ?? null,
      now, now,
    ],
  );
}

function insertSop(id: string, slug: string, name: string, personaHints: string[] | null) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO sops (id, name, slug, steps, persona_hints, department, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'marketing', ?, ?)`,
    [
      id, name, slug, JSON.stringify([{ name: 'Draft', checklist: [] }]),
      personaHints === null ? null : JSON.stringify(personaHints), now, now,
    ],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // run migration chain

  const tasks = await import('../../src/lib/tasks');
  parsePersonaHints = tasks.parsePersonaHints;
  sopSelectorContextFromRow = tasks.sopSelectorContextFromRow;
  loadSopSelectorContextById = tasks.loadSopSelectorContextById;
  rescorePersonaWithSOP = tasks.rescorePersonaWithSOP;

  const sel = await import('../../src/lib/persona-selector');
  buildSelectorArgv = sel.buildSelectorArgv;
  hasSopContext = sel.hasSopContext;
  persistPersonaBundle = sel.persistPersonaBundle;
});

test.after(() => {
  delete process.env.PERSONA_FIXTURE_JSON;
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── buildSelectorArgv: SOP flag forwarding ──────────────────────────────────
test('[DEP2] buildSelectorArgv: base argv carries NO --sop-* flags when no context', () => {
  const argv = buildSelectorArgv('/x/selector.py', 'do a thing', 'marketing', 'task-1');
  assert.ok(argv.includes('--task'), 'base --task present');
  assert.ok(argv.includes('--department'), 'base --department present');
  assert.ok(!argv.some((a) => a.startsWith('--sop-')), 'no --sop-* flags without context');
});

test('[DEP2] buildSelectorArgv: full context forwards slug + name + comma-joined hints (multi-persona pool)', () => {
  const argv = buildSelectorArgv('/x/selector.py', 'write copy', 'marketing', 'task-2', {
    slug: 'cold-email-outreach',
    name: 'Cold Email Outreach',
    hints: ['voss-never-split-difference', 'bly-copywriters-handbook'],
  });
  const slugIdx = argv.indexOf('--sop-slug');
  const nameIdx = argv.indexOf('--sop-name');
  const hintsIdx = argv.indexOf('--sop-hints');
  assert.ok(slugIdx >= 0 && argv[slugIdx + 1] === 'cold-email-outreach', '--sop-slug forwarded');
  assert.ok(nameIdx >= 0 && argv[nameIdx + 1] === 'Cold Email Outreach', '--sop-name forwarded');
  // Multiple hints → the whole candidate pool is forwarded so a DIFFERENT
  // specialist can win when relevant (multi-persona-hint path).
  assert.ok(
    hintsIdx >= 0 && argv[hintsIdx + 1] === 'voss-never-split-difference,bly-copywriters-handbook',
    'all persona_hints forwarded comma-joined',
  );
});

test('[DEP2] buildSelectorArgv: partial context (hints only) forwards ONLY --sop-hints; empties trimmed', () => {
  const argv = buildSelectorArgv('/x/selector.py', 't', 'sales', 'task-3', {
    slug: '',
    name: null,
    hints: ['  jordan-belfort-sales  ', '', '   '],
  });
  assert.ok(!argv.includes('--sop-slug'), 'no --sop-slug for empty slug');
  assert.ok(!argv.includes('--sop-name'), 'no --sop-name for null name');
  const hintsIdx = argv.indexOf('--sop-hints');
  assert.ok(hintsIdx >= 0 && argv[hintsIdx + 1] === 'jordan-belfort-sales', 'hint trimmed, empties dropped');
});

// ── hasSopContext ───────────────────────────────────────────────────────────
test('[DEP2] hasSopContext: false for null/empty, true when any field is usable', () => {
  assert.equal(hasSopContext(null), false);
  assert.equal(hasSopContext(undefined), false);
  assert.equal(hasSopContext({ slug: '', name: '', hints: [] }), false);
  assert.equal(hasSopContext({ slug: '  ' }), false);
  assert.equal(hasSopContext({ slug: 'x' }), true);
  assert.equal(hasSopContext({ name: 'X' }), true);
  assert.equal(hasSopContext({ hints: ['a'] }), true);
});

// ── parsePersonaHints: defensive parsing ────────────────────────────────────
test('[DEP2] parsePersonaHints: parses array, drops empties/sentinels, tolerates junk', () => {
  assert.deepEqual(parsePersonaHints(null), []);
  assert.deepEqual(parsePersonaHints(''), []);
  assert.deepEqual(parsePersonaHints('not json'), []);
  assert.deepEqual(parsePersonaHints('{"a":1}'), [], 'non-array → []');
  assert.deepEqual(
    parsePersonaHints('["voss-never-split-difference", "", "  ", "personas", "bly-copywriters-handbook"]'),
    ['voss-never-split-difference', 'bly-copywriters-handbook'],
    'drops empties + the "personas" sentinel id',
  );
});

// ── sopSelectorContextFromRow ───────────────────────────────────────────────
test('[DEP2] sopSelectorContextFromRow: builds context; undefined when the row carries nothing', () => {
  assert.equal(sopSelectorContextFromRow(null), undefined);
  assert.equal(sopSelectorContextFromRow({ slug: null, name: null, persona_hints: null }), undefined);
  const ctx = sopSelectorContextFromRow({
    slug: 'cold-email',
    name: 'Cold Email',
    persona_hints: '["voss-never-split-difference"]',
  });
  assert.ok(ctx, 'context built');
  assert.equal(ctx!.slug, 'cold-email');
  assert.equal(ctx!.name, 'Cold Email');
  assert.deepEqual(ctx!.hints, ['voss-never-split-difference']);
});

// ── loadSopSelectorContextById: end-to-end from a seeded sops row ────────────
test('[DEP2] loadSopSelectorContextById: reads slug+name+hints for a real SOP row', () => {
  const sopId = nextId('sop');
  insertSop(sopId, `cold-email-${sopId}`, 'Cold Email Outreach', [
    'voss-never-split-difference',
    'bly-copywriters-handbook',
  ]);
  const ctx = loadSopSelectorContextById(sopId);
  assert.ok(ctx, 'context loaded');
  assert.equal(ctx!.name, 'Cold Email Outreach');
  assert.equal(ctx!.hints!.length, 2, 'both persona hints surface for the candidate pool');
  assert.equal(loadSopSelectorContextById(null), undefined, 'null id → undefined');
  assert.equal(loadSopSelectorContextById('does-not-exist'), undefined, 'unknown id → undefined');
});

// ── NO-NAKED / fail-closed: rescore never downgrades an existing persona ─────
test('[DEP2] rescorePersonaWithSOP: null selector result NEVER downgrades the pinned persona (no-naked)', async () => {
  const id = nextId('task');
  insertTaskWithPersona(id, { persona_id: 'hormozi-100m-offers', persona_name: 'Alex Hormozi', persona_mode: 'leadership' });

  process.env.PERSONA_FIXTURE_JSON = '{}'; // selector returns no persona
  const res = await rescorePersonaWithSOP(
    id, 'Write a cold outreach email', 'marketing',
    { slug: 'cold-email', name: 'Cold Email', hints: [] },
  );
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(res.changed, false, 'a null result is not a change');
  assert.equal(res.persona_id, 'hormozi-100m-offers', 'prior persona preserved (never naked)');

  const row = queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [id]);
  assert.equal(row!.persona_id, 'hormozi-100m-offers', 'DB row persona unchanged');
  const evt = queryOne<{ n: number }>(
    "SELECT COUNT(*) as n FROM events WHERE task_id = ? AND type = 'persona_rescored_at_dispatch'",
    [id],
  );
  assert.equal(evt!.n, 0, 'no rescore event on a no-op');
});

test('[DEP2] rescorePersonaWithSOP: mechanical (no_persona_required) result never downgrades', async () => {
  const id = nextId('task');
  insertTaskWithPersona(id, { persona_id: 'hormozi-100m-offers', persona_name: 'Alex Hormozi', persona_mode: 'leadership' });

  process.env.PERSONA_FIXTURE_JSON = '{"no_persona_required": true}';
  const res = await rescorePersonaWithSOP(
    id, 'restart the box', 'marketing',
    { slug: 'x', name: null, hints: [] },
  );
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(res.changed, false);
  assert.equal(res.persona_id, 'hormozi-100m-offers', 'mechanical result must not wipe the persona');
});

// ── The happy path: a DIFFERENT persona re-pins + writes the audit event ─────
test('[DEP2] rescorePersonaWithSOP: a concrete new persona re-pins + writes persona_rescored_at_dispatch', async () => {
  const id = nextId('task');
  insertTaskWithPersona(id, { persona_id: 'generic-leader', persona_name: 'Generic Leader', persona_mode: 'leadership' });

  // SOP hints surface a copywriting specialist; the selector (fixture) returns it.
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'bly-copywriters-handbook',
    persona_name: 'Robert Bly',
    interaction_mode: 'leadership',
    score: 0.82,
  });
  const res = await rescorePersonaWithSOP(
    id, 'Write a cold outreach email', 'marketing',
    { slug: 'cold-email', name: 'Cold Email Outreach', hints: ['bly-copywriters-handbook'] },
  );
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(res.changed, true, 'a different persona is a change');
  assert.equal(res.persona_id, 'bly-copywriters-handbook', 'rescored persona returned');

  const row = queryOne<{ persona_id: string | null; persona_name: string | null }>(
    'SELECT persona_id, persona_name FROM tasks WHERE id = ?', [id],
  );
  assert.equal(row!.persona_id, 'bly-copywriters-handbook', 'task row re-pinned to the SOP-aware persona');
  assert.equal(row!.persona_name, 'Robert Bly');

  const evt = queryOne<{ message: string }>(
    "SELECT message FROM events WHERE task_id = ? AND type = 'persona_rescored_at_dispatch' ORDER BY created_at DESC LIMIT 1",
    [id],
  );
  assert.ok(evt, 'persona_rescored_at_dispatch event persisted');
  assert.ok(/generic-leader/.test(evt!.message) && /bly-copywriters-handbook/.test(evt!.message), 'audit records old → new');
});

// ── D9 — a changed rescore must not let a stale blend directive ride the NEW persona ─

function testBundle(): import('../../src/lib/types').PersonaBundle {
  return {
    topic: 'Cold outreach',
    confirm_required: false,
    resolved_audience: { source: 'onboarding_icp', candidates: [], confidence: 0.9, label: 'Founders', id: null },
    voice: {
      audience_persona: { id: 'generic-leader' },
      topic_persona: { id: 'voss-never-split-difference' },
      collapsed: false,
    },
    blend_directive: 'Write in generic-leader\'s VOICE; carry voss-never-split-difference\'s expertise.',
    task_personas: [{ seq: 1, part: 'body', persona_id: 'voss-never-split-difference', why: 'negotiation craft' }],
    catalog_version: '1.3',
  };
}

test('[D9] rescorePersonaWithSOP: a CHANGED rescore w/ an existing bundle row invalidates the stale blend directive', async () => {
  const id = nextId('task');
  insertTaskWithPersona(id, { persona_id: 'generic-leader', persona_name: 'Generic Leader', persona_mode: 'leadership' });
  persistPersonaBundle(id, testBundle());

  const before = queryOne<{ blend_directive: string | null; voice_persona_id: string | null }>(
    'SELECT blend_directive, voice_persona_id FROM tasks WHERE id = ?', [id],
  );
  assert.ok(before?.blend_directive, 'sanity: blend directive present pre-rescore');
  assert.equal(before?.voice_persona_id, 'generic-leader');

  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'bly-copywriters-handbook',
    persona_name: 'Robert Bly',
    interaction_mode: 'leadership',
    score: 0.82,
  });
  const res = await rescorePersonaWithSOP(
    id, 'Write a cold outreach email', 'marketing',
    { slug: 'cold-email', name: 'Cold Email Outreach', hints: ['bly-copywriters-handbook'] },
  );
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(res.changed, true);
  assert.equal(res.persona_id, 'bly-copywriters-handbook');
  assert.equal(res.blend_directive, null, 'D9: RescoreResult carries the neutralized (null) blend_directive for the caller to patch in-memory');

  const after = queryOne<{
    blend_directive: string | null; voice_persona_id: string | null; topic_persona_id: string | null; voice_collapsed: number | null;
  }>('SELECT blend_directive, voice_persona_id, topic_persona_id, voice_collapsed FROM tasks WHERE id = ?', [id]);
  assert.equal(after?.blend_directive, null, 'D9: stale blend_directive mirror is NULLed, never rides the new persona');
  assert.equal(after?.voice_persona_id, null, 'D9: voice mirror NULLed');
  assert.equal(after?.topic_persona_id, null, 'D9: topic mirror NULLed');
  assert.equal(after?.voice_collapsed, 0);

  const bundleRow = queryOne<{ confirm_state: string }>(
    'SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [id],
  );
  assert.equal(bundleRow?.confirm_state, 'not_required', 'D9: bundle confirm_state neutralized alongside the mirror columns');

  const invalidateEvt = queryOne<{ message: string }>(
    "SELECT message FROM events WHERE task_id = ? AND type = 'persona_blend_invalidated_by_rescore' ORDER BY created_at DESC LIMIT 1",
    [id],
  );
  assert.ok(invalidateEvt, 'D9: persona_blend_invalidated_by_rescore audit event written');
  assert.ok(/generic-leader/.test(invalidateEvt!.message) && /bly-copywriters-handbook/.test(invalidateEvt!.message));
});

test('[D9] rescorePersonaWithSOP: a CHANGED rescore w/ NO bundle row leaves blend_directive undefined (no regression for non-blend tasks)', async () => {
  const id = nextId('task');
  insertTaskWithPersona(id, { persona_id: 'generic-leader', persona_name: 'Generic Leader', persona_mode: 'leadership' });
  // No persistPersonaBundle call — this task never blended.

  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'bly-copywriters-handbook',
    persona_name: 'Robert Bly',
    interaction_mode: 'leadership',
    score: 0.82,
  });
  const res = await rescorePersonaWithSOP(
    id, 'Write a cold outreach email', 'marketing',
    { slug: 'cold-email', name: 'Cold Email Outreach', hints: [] },
  );
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(res.changed, true);
  assert.equal(res.blend_directive, undefined, 'no bundle → nothing to invalidate → undefined (caller leaves task.blend_directive untouched)');

  const evt = queryOne<{ n: number }>(
    "SELECT COUNT(*) as n FROM events WHERE task_id = ? AND type = 'persona_blend_invalidated_by_rescore'", [id],
  );
  assert.equal(evt!.n, 0, 'no invalidation event for a task that never blended');
});

test('[D9] rescorePersonaWithSOP: UNCHANGED rescore (same persona) never invalidates an existing blend', async () => {
  const id = nextId('task');
  insertTaskWithPersona(id, { persona_id: 'generic-leader', persona_name: 'Generic Leader', persona_mode: 'leadership' });
  persistPersonaBundle(id, testBundle());

  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'generic-leader', // SAME persona — not a change
    persona_name: 'Generic Leader',
    interaction_mode: 'leadership',
    score: 0.5,
  });
  const res = await rescorePersonaWithSOP(
    id, 'Write a cold outreach email', 'marketing',
    { slug: 'cold-email', name: 'Cold Email Outreach', hints: [] },
  );
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(res.changed, false);
  assert.equal(res.blend_directive, undefined, 'unchanged rescore never touches the blend mirror');

  const after = queryOne<{ blend_directive: string | null }>('SELECT blend_directive FROM tasks WHERE id = ?', [id]);
  assert.ok(after?.blend_directive, 'the ORIGINAL blend_directive survives an unchanged rescore');
});
