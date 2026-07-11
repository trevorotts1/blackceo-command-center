/**
 * PERSONA-BLEND / AUDIENCE-CONFIRM — Command Center consumption of the matcher's
 * persona-bundle SUPERSET (migration 090 + the audience-confirm write gate).
 *
 * Proves the CC-owned guarantees end to end WITHOUT Python:
 *
 *   A. Migration 090 — the mirror columns exist on `tasks` and the
 *      `task_persona_bundle` table exists (fresh-DB schema + migration parity).
 *
 *   B. persistPersonaBundle — writes ONE bundle row (confirm_required → 'pending',
 *      else 'not_required'), mirrors the resolved VOICE decision + confirmed
 *      audience onto tasks.*, and the persisted directive ALWAYS carries the
 *      non-removable style-inspired-NOT-impersonation guardrail. Idempotent
 *      (task_id UNIQUE → upsert).
 *
 *   C. evaluateAudienceConfirmGate — the pure decision the dispatcher calls BEFORE
 *      its write step: no-bundle / not_required / confirmed → proceed; pending
 *      within the deadline → HOLD; pending past the deadline → NEVER-NAKED
 *      house-voice release (hold:false, state deadline_fallback).
 *
 *   D. Side effects — holdForAudienceConfirm surfaces the operator ONCE (firstHold),
 *      markAudienceDeadlineFallback flips + records once, confirmTaskAudience flips
 *      to 'confirmed' + mirrors source='operator_confirmed'.
 *
 * Node built-in test runner under tsx (`npm run test:unit`). DATABASE_PATH points
 * at a throwaway file BEFORE `@/lib/db` is imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-blend-confirm-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;
// Keep the suite hermetic — no real selector spawns / no external notify config.
process.env.OPENCLAW_ROOT = '/nonexistent/openclaw-root-for-tests';
process.env.DISABLE_QC_AUTO_SCORER = 'true';

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let queryAll: DbModule['queryAll'];
let getDb: DbModule['getDb'];
let closeDb: DbModule['closeDb'];

type SelectorModule = typeof import('../../src/lib/persona-selector');
let persistPersonaBundle: SelectorModule['persistPersonaBundle'];

type TasksModule = typeof import('../../src/lib/tasks');
let evaluateAudienceConfirmGate: TasksModule['evaluateAudienceConfirmGate'];
let holdForAudienceConfirm: TasksModule['holdForAudienceConfirm'];
let markAudienceDeadlineFallback: TasksModule['markAudienceDeadlineFallback'];
let confirmTaskAudience: TasksModule['confirmTaskAudience'];
let AUDIENCE_CONFIRM_DEADLINE_MS: TasksModule['AUDIENCE_CONFIRM_DEADLINE_MS'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

function insertTask(id: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, department, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', NULL, NULL, 'marketing', ?, ?)`,
    [id, `Blend task ${id}`, now, now],
  );
}

function bundle(overrides: Partial<import('../../src/lib/types').PersonaBundle> = {}): import('../../src/lib/types').PersonaBundle {
  return {
    topic: 'SaaS pricing page',
    confirm_required: true,
    resolved_audience: {
      source: 'onboarding_icp',
      candidates: ['Founders', 'RevOps leads'],
      confidence: 0.4,
      label: null,
      id: null,
    },
    voice: {
      audience_persona: { id: 'audience-voice-persona', why: 'writes for founders' },
      topic_persona: { id: 'ogilvy-on-advertising', why: 'pricing craft' },
      collapsed: false,
      topic_as_task_guidance: true,
    },
    blend_directive: 'Write in the audience voice; carry the topic persona expertise.',
    task_personas: [
      { seq: 1, part: 'headline', persona_id: 'ogilvy-on-advertising', why: 'headline craft' },
    ],
    catalog_version: '1.3',
    ...overrides,
  };
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  ({ run, queryOne, queryAll, getDb, closeDb } = db);
  getDb(); // run schema + full migration chain (incl. 090)

  ({ persistPersonaBundle } = await import('../../src/lib/persona-selector'));
  const tasks = await import('../../src/lib/tasks');
  evaluateAudienceConfirmGate = tasks.evaluateAudienceConfirmGate;
  holdForAudienceConfirm = tasks.holdForAudienceConfirm;
  markAudienceDeadlineFallback = tasks.markAudienceDeadlineFallback;
  confirmTaskAudience = tasks.confirmTaskAudience;
  AUDIENCE_CONFIRM_DEADLINE_MS = tasks.AUDIENCE_CONFIRM_DEADLINE_MS;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── A. Migration 090 shape ───────────────────────────────────────────────────

test('[090] tasks mirror columns + task_persona_bundle table exist', () => {
  const cols = (queryAll<{ name: string }>('PRAGMA table_info(tasks)')).map((c) => c.name);
  for (const col of ['voice_persona_id', 'topic_persona_id', 'audience_id', 'audience_label', 'audience_source', 'voice_collapsed', 'blend_directive']) {
    assert.ok(cols.includes(col), `tasks.${col} must exist (migration 090)`);
  }
  const tbl = queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='task_persona_bundle'",
  );
  assert.ok(tbl, 'task_persona_bundle table must exist');
  const bcols = (queryAll<{ name: string }>('PRAGMA table_info(task_persona_bundle)')).map((c) => c.name);
  for (const col of ['task_id', 'bundle_json', 'catalog_version', 'confirm_state', 'created_at']) {
    assert.ok(bcols.includes(col), `task_persona_bundle.${col} must exist`);
  }
});

// ── B. persistPersonaBundle ──────────────────────────────────────────────────

test('[persist] confirm_required=true → pending; mirror columns written; guardrail present', () => {
  const id = nextId('persist');
  insertTask(id);
  const wrote = persistPersonaBundle(id, bundle());
  assert.equal(wrote, true);

  const row = queryOne<{ confirm_state: string; catalog_version: string | null; bundle_json: string }>(
    'SELECT confirm_state, catalog_version, bundle_json FROM task_persona_bundle WHERE task_id = ?',
    [id],
  );
  assert.ok(row);
  assert.equal(row.confirm_state, 'pending', 'confirm_required → pending (gates dispatch)');
  assert.equal(row.catalog_version, '1.3');
  assert.ok(/style-inspired/i.test(row.bundle_json) && /impersonation/i.test(row.bundle_json), 'persisted directive carries the guardrail');

  const mirror = queryOne<{
    voice_persona_id: string | null; topic_persona_id: string | null;
    audience_source: string | null; voice_collapsed: number | null; blend_directive: string | null;
  }>(
    'SELECT voice_persona_id, topic_persona_id, audience_source, voice_collapsed, blend_directive FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(mirror?.voice_persona_id, 'audience-voice-persona', 'voice persona = audience persona (distinct blend)');
  assert.equal(mirror?.topic_persona_id, 'ogilvy-on-advertising');
  assert.equal(mirror?.audience_source, 'onboarding_icp');
  assert.equal(mirror?.voice_collapsed, 0);
  assert.ok(mirror?.blend_directive && /impersonation/i.test(mirror.blend_directive));
});

test('[persist] collapsed voice → voice_persona_id is the collapsed persona; voice_collapsed=1', () => {
  const id = nextId('persist-collapsed');
  insertTask(id);
  persistPersonaBundle(id, bundle({
    voice: {
      audience_persona: { id: 'ogilvy-on-advertising' },
      topic_persona: { id: 'ogilvy-on-advertising' },
      collapsed: true,
      collapsed_persona_id: 'ogilvy-on-advertising',
    },
  }));
  const mirror = queryOne<{ voice_persona_id: string | null; voice_collapsed: number | null }>(
    'SELECT voice_persona_id, voice_collapsed FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(mirror?.voice_persona_id, 'ogilvy-on-advertising');
  assert.equal(mirror?.voice_collapsed, 1);
});

test('[persist] confirm_required=false → not_required; idempotent upsert (task_id UNIQUE)', () => {
  const id = nextId('persist-notreq');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: false }));
  persistPersonaBundle(id, bundle({ confirm_required: false })); // second call → upsert, not a 2nd row
  const rows = queryAll<{ id: string }>('SELECT id FROM task_persona_bundle WHERE task_id = ?', [id]);
  assert.equal(rows.length, 1, 'task_id UNIQUE → exactly one bundle row');
  const row = queryOne<{ confirm_state: string }>('SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [id]);
  assert.equal(row?.confirm_state, 'not_required');
});

// ── C. evaluateAudienceConfirmGate ───────────────────────────────────────────

test('[gate] no bundle → hold:false (non-content task is never gated)', () => {
  const id = nextId('gate-none');
  insertTask(id);
  const g = evaluateAudienceConfirmGate(id);
  assert.equal(g.hold, false);
  assert.equal(g.state, 'no_bundle');
});

test('[gate] pending within deadline → HOLD with an operator prompt', () => {
  const id = nextId('gate-pending');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true })); // → pending
  const g = evaluateAudienceConfirmGate(id); // nowMs = now, well within deadline
  assert.equal(g.hold, true, 'pending within deadline must HOLD the write');
  assert.equal(g.state, 'pending');
  assert.ok(g.prompt && /What audience are we dealing with\?/.test(g.prompt), 'low-confidence multi → the exact ASK');
  assert.ok(g.prompt.includes('Founders') && g.prompt.includes('RevOps leads'), 'enumerates known ICP audiences');
  assert.equal(g.firstHold, true, 'first hold surfaces the operator');
});

test('[gate] single high-confidence ICP → CONFIRM prompt (not the open ask)', () => {
  const id = nextId('gate-highconf');
  insertTask(id);
  persistPersonaBundle(id, bundle({
    confirm_required: true,
    resolved_audience: { source: 'onboarding_icp', candidates: ['Founders'], confidence: 0.95, label: 'Founders', id: null },
  }));
  const g = evaluateAudienceConfirmGate(id);
  assert.equal(g.hold, true);
  assert.ok(g.prompt && /Confirm the audience/.test(g.prompt), 'high-confidence single → confirm prompt');
  assert.ok(g.prompt.includes('Founders'));
});

test('[gate] pending PAST deadline → NEVER-NAKED release (hold:false, deadline_fallback)', () => {
  const id = nextId('gate-deadline');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));
  const future = Date.now() + AUDIENCE_CONFIRM_DEADLINE_MS + 60_000;
  const g = evaluateAudienceConfirmGate(id, future);
  assert.equal(g.hold, false, 'past the deadline the task is released (never stalls forever)');
  assert.equal(g.state, 'deadline_fallback');
});

test('[gate] confirmed → hold:false (write proceeds)', () => {
  const id = nextId('gate-confirmed');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));
  confirmTaskAudience(id, { audienceLabel: 'Founders' });
  const g = evaluateAudienceConfirmGate(id);
  assert.equal(g.hold, false);
  assert.equal(g.state, 'confirmed');
});

// ── D. Side effects ──────────────────────────────────────────────────────────

test('[hold] surfaces the operator ONCE, defers the task, never client-spams', () => {
  const id = nextId('hold');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  const first = evaluateAudienceConfirmGate(id);
  assert.equal(first.firstHold, true);
  holdForAudienceConfirm(id, null, first);

  // The task is deferred (sweeps won't hammer it).
  const t1 = queryOne<{ next_dispatch_eligible_at: string | null }>('SELECT next_dispatch_eligible_at FROM tasks WHERE id = ?', [id]);
  assert.ok(t1?.next_dispatch_eligible_at, 'held task is deferred with a poll window');

  // A single operator-facing event was written.
  let events = queryAll<{ id: string }>("SELECT id FROM events WHERE task_id = ? AND type = 'audience_confirm_pending'", [id]);
  assert.equal(events.length, 1, 'first hold writes exactly one pending event');

  // Second hold must NOT duplicate the operator surface (firstHold=false now).
  const second = evaluateAudienceConfirmGate(id);
  assert.equal(second.firstHold, false, 'a prior pending event suppresses re-surfacing');
  holdForAudienceConfirm(id, null, second);
  events = queryAll<{ id: string }>("SELECT id FROM events WHERE task_id = ? AND type = 'audience_confirm_pending'", [id]);
  assert.equal(events.length, 1, 'no duplicate operator surface on a repeat hold (no spam)');
});

test('[deadline] markAudienceDeadlineFallback flips state once + records a visible event', () => {
  const id = nextId('deadline-mark');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  markAudienceDeadlineFallback(id);
  markAudienceDeadlineFallback(id); // second call is a no-op (state already flipped)

  const row = queryOne<{ confirm_state: string }>('SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [id]);
  assert.equal(row?.confirm_state, 'deadline_fallback');
  const events = queryAll<{ id: string }>("SELECT id FROM events WHERE task_id = ? AND type = 'audience_confirm_deadline_fallback'", [id]);
  assert.equal(events.length, 1, 'the fallback event is written exactly once');
});

test('[confirm] confirmTaskAudience flips to confirmed + mirrors source=operator_confirmed', () => {
  const id = nextId('confirm');
  insertTask(id);
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  confirmTaskAudience(id, { audienceId: 'aud-founders', audienceLabel: 'Founders', changed: true });

  const row = queryOne<{ confirm_state: string }>('SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [id]);
  assert.equal(row?.confirm_state, 'confirmed');
  const mirror = queryOne<{ audience_id: string | null; audience_label: string | null; audience_source: string | null }>(
    'SELECT audience_id, audience_label, audience_source FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(mirror?.audience_id, 'aud-founders');
  assert.equal(mirror?.audience_label, 'Founders');
  assert.equal(mirror?.audience_source, 'operator_confirmed');
  const evt = queryOne<{ message: string }>("SELECT message FROM events WHERE task_id = ? AND type = 'audience_confirmed'", [id]);
  assert.ok(evt && /operator confirmed audience "Founders"/.test(evt.message));
});

// ── E. D5 — deadline fallback never ships the unconfirmed audience voice ────

test('[D5] markAudienceDeadlineFallback neutralizes the stale audience-voice directive + repoints persona to topic', () => {
  const id = nextId('d5-repoint');
  insertTask(id);
  // Simulate the REAL post-selection state (D1): tasks.persona_id mirrors the
  // blend's VOICE (audience) persona — never the topic persona.
  run(`UPDATE tasks SET persona_id = ?, persona_name = ? WHERE id = ?`, ['audience-voice-persona', 'Audience Voice Persona', id]);
  persistPersonaBundle(id, bundle({ confirm_required: true })); // → pending; voice_persona_id = 'audience-voice-persona'

  const beforeMirror = queryOne<{ voice_persona_id: string | null; blend_directive: string | null }>(
    'SELECT voice_persona_id, blend_directive FROM tasks WHERE id = ?', [id],
  );
  assert.equal(beforeMirror?.voice_persona_id, 'audience-voice-persona', 'sanity: voice mirror set pre-fallback');
  assert.ok(beforeMirror?.blend_directive && /audience voice/i.test(beforeMirror.blend_directive), 'sanity: original directive names the audience voice');

  markAudienceDeadlineFallback(id);

  const row = queryOne<{ confirm_state: string }>('SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?', [id]);
  assert.equal(row?.confirm_state, 'deadline_fallback');

  const after = queryOne<{
    voice_persona_id: string | null; blend_directive: string | null;
    persona_id: string | null; persona_name: string | null;
  }>('SELECT voice_persona_id, blend_directive, persona_id, persona_name FROM tasks WHERE id = ?', [id]);
  assert.equal(after?.voice_persona_id, null, 'D5: unconfirmed voice mirror is NULLed');
  assert.ok(after?.blend_directive, 'a neutral directive is still present (never naked)');
  assert.ok(!/write in the audience voice/i.test(after!.blend_directive!), 'D5: the unconfirmed audience-voice instruction is GONE');
  assert.ok(/neutral/i.test(after!.blend_directive!), 'D5: replaced with an explicit neutral house-voice directive');
  assert.ok(/style-inspired/i.test(after!.blend_directive!) && /impersonation/i.test(after!.blend_directive!), 'guardrail still present');
  assert.equal(after?.persona_id, 'ogilvy-on-advertising', 'D5: repointed to the bundle TOPIC persona (was pinned to the audience/voice persona)');
  assert.equal(after?.persona_name, 'Ogilvy On Advertising');

  const evt = queryOne<{ message: string }>(
    "SELECT message FROM events WHERE task_id = ? AND type = 'audience_confirm_deadline_fallback'", [id],
  );
  assert.ok(evt && /neutralized/i.test(evt.message));
});

test('[D5] markAudienceDeadlineFallback: persona_id NOT pinned to the audience persona → neutralizes voice only, no repoint', () => {
  const id = nextId('d5-norepoint');
  insertTask(id);
  // persona_id already points somewhere ELSE (not the bundle's audience persona) —
  // never invent/repoint away from an existing, unrelated pin.
  run(`UPDATE tasks SET persona_id = ?, persona_name = ? WHERE id = ?`, ['some-other-persona', 'Some Other Persona', id]);
  persistPersonaBundle(id, bundle({ confirm_required: true }));

  markAudienceDeadlineFallback(id);

  const after = queryOne<{ voice_persona_id: string | null; persona_id: string | null; blend_directive: string | null }>(
    'SELECT voice_persona_id, persona_id, blend_directive FROM tasks WHERE id = ?', [id],
  );
  assert.equal(after?.voice_persona_id, null, 'voice mirror still NULLed regardless of the repoint decision');
  assert.equal(after?.persona_id, 'some-other-persona', 'no repoint — the existing unrelated pin is left untouched');
  assert.ok(after?.blend_directive && /neutral/i.test(after.blend_directive), 'directive still neutralized');
});

test('[D5] markAudienceDeadlineFallback: no bundle row → no-op (pre-existing tolerance, no crash)', () => {
  const id = nextId('d5-nobundle');
  insertTask(id);
  assert.doesNotThrow(() => markAudienceDeadlineFallback(id));
});
