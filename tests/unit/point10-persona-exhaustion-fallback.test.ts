/**
 * Point 10 fix 1 — persona exhaustion → deterministic department-default pin.
 *
 * The founder's board invariant: EVERY task carries a persona. Before this fix,
 * resolvePersonaAndPin() left a task personaless after PERSONA_PIN_MAX_ATTEMPTS
 * failed selector spawns. Now, on exhaustion it pins a DETERMINISTIC
 * department-default persona and flags it persona_fallback=1 for audit.
 * `no_persona_required` (intentional) stays personaless.
 *
 * Coverage:
 *   (a) deriveDepartmentDefaultPersona → Tier-3 house-voice constant (no history).
 *   (b) deriveDepartmentDefaultPersona → Tier-1 department sticky lead persona
 *       (persona_assignment row present).
 *   (c) resolvePersonaAndPin exhaustion → task pinned to the department-default,
 *       persona_fallback=1, a [PERSONA-FALLBACK] audit event written.
 *   (d) no_persona_required → task stays personaless (persona_id NULL,
 *       persona_fallback 0), NO fallback event.
 *
 * Uses an isolated temp DB. No real Python selector — PERSONA_FIXTURE_JSON forces
 * the selector result.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-persona-exhaust-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let resolvePersonaAndPin: TasksModule['resolvePersonaAndPin'];
let deriveDepartmentDefaultPersona: TasksModule['deriveDepartmentDefaultPersona'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

function insertBacklogTask(id: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'backlog', 'medium', NULL, NULL, ?, ?)`,
    [id, `Exhaustion task ${id}`, now, now],
  );
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // run migration chain (incl. 083 persona_fallback)

  const tasks = await import('../../src/lib/tasks');
  resolvePersonaAndPin = tasks.resolvePersonaAndPin;
  deriveDepartmentDefaultPersona = tasks.deriveDepartmentDefaultPersona;
});

test.after(() => {
  delete process.env.PERSONA_FIXTURE_JSON;
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── (a) Tier-3 house-voice constant when there is no history / no config ─────
test('[Point10a] deriveDepartmentDefaultPersona: house-voice constant for a department with no history', () => {
  const fb = deriveDepartmentDefaultPersona('marketing');
  // Tier 3 of the F3.1 fallback chain: a REAL, embedded fleet persona (never a
  // synthetic id whose blueprint does not exist).
  assert.equal(fb.persona_id, 'blackceo-house-voice', 'tier-3 must be the house-voice constant');
  assert.equal(fb.source, 'house-voice-constant');
  assert.ok(fb.persona_name.length > 0, 'must have a display name');
  assert.ok(fb.persona_mode, 'must have an interaction mode');

  // Deterministic: same result every call, department-independent at tier 3.
  const fb2 = deriveDepartmentDefaultPersona('marketing');
  assert.equal(fb2.persona_id, fb.persona_id, 'derivation must be deterministic');

  const fb3 = deriveDepartmentDefaultPersona('dept-marketing');
  assert.equal(fb3.persona_id, 'blackceo-house-voice', 'tier-3 constant is stable across slugs');
});

// ── (b) Tier-1 department sticky "lead" persona when history exists ──────────
test('[Point10b] deriveDepartmentDefaultPersona: prefers the department sticky lead persona', () => {
  const now = new Date().toISOString();
  run(
    `INSERT INTO persona_assignment (id, department_id, task_category, persona_id, persona_name, persona_mode, last_assigned_at, switch_count)
     VALUES (?, 'sales', 'outreach', 'jordan-belfort-sales', 'Jordan Belfort', 'leadership', ?, 3)`,
    [nextId('assign'), now],
  );

  const fb = deriveDepartmentDefaultPersona('sales');
  assert.equal(fb.persona_id, 'jordan-belfort-sales', 'must reuse the department sticky persona');
  assert.equal(fb.persona_name, 'Jordan Belfort');
  assert.equal(fb.source, 'department-sticky');
});

// ── (c) exhaustion → department-default pin + persona_fallback flag ──────────
test('[Point10c] resolvePersonaAndPin: exhaustion pins a department-default + persona_fallback=1', async () => {
  // Force every selector attempt to return no persona → exhaustion.
  process.env.PERSONA_FIXTURE_JSON = '{}';

  const id = nextId('exhaust');
  insertBacklogTask(id);

  const pinned = await resolvePersonaAndPin(id, 'Some marketing deliverable', 'marketing');
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(pinned, 'blackceo-house-voice', 'exhaustion must return the fallback persona id (never null)');

  const row = queryOne<{ persona_id: string | null; persona_name: string | null; persona_fallback: number | null }>(
    'SELECT persona_id, persona_name, persona_fallback FROM tasks WHERE id = ?',
    [id],
  );
  assert.ok(row, 'task must exist');
  assert.equal(row.persona_id, 'blackceo-house-voice', 'task.persona_id must be the fallback persona');
  assert.ok(row.persona_name && row.persona_name.length > 0, 'persona_name must be set');
  assert.equal(row.persona_fallback, 1, 'persona_fallback must be flagged 1 for audit');

  // A queryable audit event must be written.
  const evt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'persona_fallback' LIMIT 1`,
    [id],
  );
  assert.ok(evt, 'a persona_fallback audit event must be written');
  assert.ok(evt.message.includes('[PERSONA-FALLBACK]'), 'event must carry the [PERSONA-FALLBACK] marker');
  assert.ok(evt.message.includes('persona_fallback=true'), 'event must state persona_fallback=true');
});

// ── (d) no_persona_required stays personaless (intentional) ──────────────────
test('[Point10d] resolvePersonaAndPin: no_persona_required stays personaless (no fallback)', async () => {
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({ no_persona_required: true });

  const id = nextId('no-persona');
  insertBacklogTask(id);

  const pinned = await resolvePersonaAndPin(id, 'A pure system task', 'general-task');
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(pinned, null, 'no_persona_required must return null (intentional)');

  const row = queryOne<{ persona_id: string | null; persona_fallback: number | null }>(
    'SELECT persona_id, persona_fallback FROM tasks WHERE id = ?',
    [id],
  );
  assert.ok(row, 'task must exist');
  assert.equal(row.persona_id, null, 'no_persona_required: persona_id must stay NULL');
  assert.notEqual(row.persona_fallback, 1, 'no_persona_required must NOT set persona_fallback');

  const evt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'persona_fallback' LIMIT 1`,
    [id],
  );
  assert.ok(!evt, 'no_persona_required must NOT write a persona_fallback event');
});

// ── (e) PERSONA-BLEND — a bundle-carrying selection persists the bundle + gate;
//        a legacy selection writes NO bundle row (backward compat) ─────────────
test('[Point10e] resolvePersonaAndPin: bundle-carrying result persists task_persona_bundle (pending gate)', async () => {
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'ogilvy-on-advertising',
    persona_name: 'David Ogilvy',
    interaction_mode: 'leadership',
    score: 0.9,
    // Bundle SUPERSET fields → parsePersonaBundle produces a bundle.
    confirm_required: true,
    resolved_audience: { source: 'onboarding_icp', candidates: ['Founders'], confidence: 0.9, label: 'Founders' },
    voice: { audience_persona: { id: 'ogilvy-on-advertising' }, topic_persona: { id: 'kennedy-copy' }, collapsed: false },
    blend_directive: 'Write in the audience voice; carry the topic expertise.',
  });

  const id = nextId('blend');
  insertBacklogTask(id);
  const pinned = await resolvePersonaAndPin(id, 'Write the launch page', 'marketing');
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(pinned, 'ogilvy-on-advertising', 'voice persona pinned onto tasks.persona_id (back-compat mirror)');

  const bundleRow = queryOne<{ confirm_state: string; bundle_json: string }>(
    'SELECT confirm_state, bundle_json FROM task_persona_bundle WHERE task_id = ?',
    [id],
  );
  assert.ok(bundleRow, 'a task_persona_bundle row must be written for a bundle-carrying result');
  assert.equal(bundleRow.confirm_state, 'pending', 'confirm_required → pending (gates dispatch)');
  assert.ok(/impersonation/i.test(bundleRow.bundle_json), 'persisted bundle carries the guardrail');

  const mirror = queryOne<{ topic_persona_id: string | null; voice_collapsed: number | null; blend_directive: string | null }>(
    'SELECT topic_persona_id, voice_collapsed, blend_directive FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(mirror?.topic_persona_id, 'kennedy-copy', 'topic persona mirrored onto the task row');
  assert.equal(mirror?.voice_collapsed, 0, 'voice_collapsed mirrored (0 = distinct audience+topic)');
  assert.ok(mirror?.blend_directive && /impersonation/i.test(mirror.blend_directive), 'blend_directive mirrored with guardrail');
});

test('[Point10e] resolvePersonaAndPin: legacy (no-bundle) result writes NO task_persona_bundle row', async () => {
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'jordan-belfort-sales',
    persona_name: 'Jordan Belfort',
    interaction_mode: 'leadership',
    score: 0.8,
    // NO bundle SUPERSET fields — a non-content task.
  });

  const id = nextId('legacy');
  insertBacklogTask(id);
  await resolvePersonaAndPin(id, 'Cold-call the lead list', 'sales');
  delete process.env.PERSONA_FIXTURE_JSON;

  const bundleRow = queryOne<{ task_id: string }>(
    'SELECT task_id FROM task_persona_bundle WHERE task_id = ?',
    [id],
  );
  assert.ok(!bundleRow, 'a legacy result must NOT create a bundle row (no gate, no regression)');
});
