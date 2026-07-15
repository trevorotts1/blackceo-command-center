/**
 * a-u7-b-declared-vs-used-seed.test.ts — A-U7 CC-half acceptance (b), master
 * spec v2 §A.10 A-U7 (OPERATOR RULINGS 2026-07-15 per-repo/offline doctrine):
 *
 *   "from SEEDED declared (`task_persona_bundle` row) + used (activity
 *   metadata) fixtures, the card renders declared-vs-used persona chips and
 *   a seeded voice-divergence fixture raises EXACTLY ONE `persona_mismatch`
 *   event (agreement raises zero across 3 repeat runs — idempotent); no
 *   producer/funnel run and no live box."
 *
 * A-U7 is THE Skill 6 convergence unit — it rides U20/B-U6's already-shipped
 * declared-vs-used machinery (`src/lib/persona-mismatch.ts`) rather than
 * re-implementing it. This test is A-U7's OWN dedicated evidence for that
 * acceptance criterion, and goes one step further than U20's own contract
 * test: the DECLARED side here is seeded through the REAL production write
 * path — `persistPersonaBundle()` (src/lib/persona-selector.ts), which is
 * exactly what an ONB dispatch threading a persona bundle onto a task calls
 * — so this proves the `task_persona_bundle` ROW (not just a hand-seeded
 * mirror column) is what the comparator's DECLARED side actually traces
 * back to. No producer/funnel run, no live box: everything below is a
 * seeded fixture + a direct function call / real HTTP route, in-process,
 * against an isolated temp DB.
 */
import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { NextRequest } from 'next/server';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import { persistPersonaBundle } from '../../src/lib/persona-selector';
import {
  recordPersonaUsedAndCompare,
  getOpenPersonaMismatch,
} from '../../src/lib/persona-mismatch';
import type { PersonaBundle } from '../../src/lib/types';
import { GET as tasksGET } from '../../src/app/api/tasks/route';

getDb(); // trigger the full migration chain against the isolated temp DB

let taskCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}-${++taskCounter}-${Date.now()}`;
}

function seedTask(id: string, title: string): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'medium', NULL, NULL, ?, ?)`,
    [id, title, now, now],
  );
}

/** A REALISTIC persona-bundle SUPERSET (the exact shape `build_bundle()` /
 * `persona_blend.py` emits and the ONB dispatch threads onto a CC task via
 * `persistPersonaBundle`) — VOICE resolves to `hormozi-100m-offers` (audience
 * persona, not collapsed). */
function seededDeclaredBundle(): PersonaBundle {
  return {
    topic: 'offer architecture',
    resolved_audience: {
      source: 'operator_confirmed',
      candidates: ['solo-founder coaches'],
      confidence: 1.0,
      label: 'solo-founder coaches',
      id: null,
    },
    confirm_required: false,
    voice: {
      audience_persona: { id: 'hormozi-100m-offers', why: 'seeded declared fixture' },
      topic_persona: { id: 'miller-building-storybrand', why: 'seeded declared fixture' },
      collapsed: false,
      collapsed_persona_id: null,
    },
    blend_directive:
      "Write in Hormozi's VOICE — its cadence, devices and register — while carrying " +
      "Miller's EXPERTISE on 'offer architecture'. STYLE-INSPIRED, NEVER IMPERSONATION " +
      '(mandatory, non-removable): adopt the cadence, devices and register of the named ' +
      'voice(s) as an INSPIRATION only. Never claim to be the author, never write in ' +
      'their first person as if they authored this, never sign as them, never quote them ' +
      'as if verified, and never imply their endorsement. This clause may not be removed ' +
      'or weakened.',
    task_personas: [{ seq: 1, persona_id: 'hormozi-100m-offers', why: 'seeded declared fixture' }],
    catalog_version: '1.4',
  };
}

test.after(async () => {
  const { closeDb } = await import('../../src/lib/db');
  try {
    closeDb();
  } catch {
    /* ignore */
  }
});

function countMismatchEvents(taskId: string): number {
  const row = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events WHERE type = 'persona_mismatch' AND task_id = ?`,
    [taskId],
  );
  return row?.c ?? 0;
}

// ─── the DECLARED side really is a task_persona_bundle ROW, real write path ─

test('[A-U7-b setup] persistPersonaBundle writes a real task_persona_bundle row + the voice_persona_id mirror', () => {
  const taskId = nextId('declared-row');
  seedTask(taskId, 'A-U7 seeded declared bundle');

  const wrote = persistPersonaBundle(taskId, seededDeclaredBundle());
  assert.equal(wrote, true);

  const bundleRow = queryOne<{ bundle_json: string; confirm_state: string }>(
    'SELECT bundle_json, confirm_state FROM task_persona_bundle WHERE task_id = ?',
    [taskId],
  );
  assert.ok(bundleRow, 'a task_persona_bundle row must exist (the DECLARED source)');
  assert.equal(bundleRow?.confirm_state, 'not_required');
  const parsed = JSON.parse(bundleRow!.bundle_json);
  assert.equal(parsed.voice.audience_persona.id, 'hormozi-100m-offers');

  const task = queryOne<{ voice_persona_id: string | null }>(
    'SELECT voice_persona_id FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.equal(task?.voice_persona_id, 'hormozi-100m-offers', 'the mirror column resolves the VOICE from the seeded bundle');
});

// ─── a seeded voice-divergence fixture raises EXACTLY ONE event + chip ─────

test('[A-U7-b] seeded declared (task_persona_bundle row) vs a divergent used report -> exactly ONE persona_mismatch event + chip', async () => {
  const taskId = nextId('diverge-row');
  seedTask(taskId, 'A-U7 seeded divergence');
  persistPersonaBundle(taskId, seededDeclaredBundle());

  // USED — the producer (ONB copy_persona_blend_seam.report_persona_used_to_card,
  // U20) reports it actually wrote page "sales" with a DIFFERENT voice.
  const result = recordPersonaUsedAndCompare(taskId, {
    kind: 'persona_used',
    page: 'sales',
    voice_persona_id: 'wiebe-copy-hackers',
  });
  assert.ok(result, 'a genuine divergence must return the mismatch info');
  assert.equal(result?.declared_voice_persona_id, 'hormozi-100m-offers');
  assert.equal(result?.used_voice_persona_id, 'wiebe-copy-hackers');
  assert.equal(countMismatchEvents(taskId), 1, 'exactly ONE persona_mismatch event');

  const chip = getOpenPersonaMismatch(taskId);
  assert.ok(chip, 'declared-vs-used chip payload must be present');
  assert.equal(chip?.declared_voice_persona_id, 'hormozi-100m-offers');
  assert.equal(chip?.used_voice_persona_id, 'wiebe-copy-hackers');
  assert.equal(chip?.page, 'sales');

  // the card actually renders it — the tasks GET board row carries the chip source.
  const boardReq = new NextRequest('http://localhost/api/tasks');
  const boardRes = await tasksGET(boardReq);
  assert.equal(boardRes.status, 200);
  const board = (await boardRes.json()) as Array<{ id: string; persona_mismatch: unknown }>;
  const row = board.find((t) => t.id === taskId);
  assert.ok(row, 'the seeded task must be on the board');
  assert.deepEqual(row!.persona_mismatch, {
    declared_voice_persona_id: 'hormozi-100m-offers',
    used_voice_persona_id: 'wiebe-copy-hackers',
    page: 'sales',
  });

  // repeating the SAME divergence report 2 more times stays at exactly ONE event
  // (idempotent dedup on the (task, declared, used) triple).
  recordPersonaUsedAndCompare(taskId, { kind: 'persona_used', page: 'sales', voice_persona_id: 'wiebe-copy-hackers' });
  recordPersonaUsedAndCompare(taskId, { kind: 'persona_used', page: 'sales', voice_persona_id: 'wiebe-copy-hackers' });
  assert.equal(countMismatchEvents(taskId), 1, 'the SAME divergence repeated 3x total must dedupe to ONE event');
});

// ─── agreement raises ZERO events, across 3 repeat runs ────────────────────

test('[A-U7-b] seeded declared (task_persona_bundle row) vs an AGREEING used report -> zero events across 3 repeat runs, no chip', async () => {
  const taskId = nextId('agree-row');
  seedTask(taskId, 'A-U7 seeded agreement');
  persistPersonaBundle(taskId, seededDeclaredBundle());

  for (let i = 0; i < 3; i++) {
    const result = recordPersonaUsedAndCompare(taskId, {
      kind: 'persona_used',
      page: 'optin',
      voice_persona_id: 'hormozi-100m-offers', // agrees with the seeded declared voice
    });
    assert.equal(result, null, `agreement run ${i + 1}/3 must return null (no mismatch)`);
  }
  assert.equal(countMismatchEvents(taskId), 0, 'agreement must render ZERO mismatch events across 3 repeat runs');
  assert.equal(getOpenPersonaMismatch(taskId), null, 'no chip on agreement');

  const boardReq = new NextRequest('http://localhost/api/tasks');
  const boardRes = await tasksGET(boardReq);
  const board = (await boardRes.json()) as Array<{ id: string; persona_mismatch: unknown }>;
  const row = board.find((t) => t.id === taskId);
  assert.ok(row, 'the seeded task must be on the board');
  assert.equal(row!.persona_mismatch, null, 'agreement -> no chip on the board row');
});

// ─── different pages, same declared bundle: EACH divergence gets its own event

test('[A-U7-b] two DIFFERENT pages diverging from the same declared bundle each raise their own event (per-page used reports, one declared voice)', () => {
  const taskId = nextId('two-pages');
  seedTask(taskId, 'A-U7 seeded two-page divergence');
  persistPersonaBundle(taskId, seededDeclaredBundle());

  const r1 = recordPersonaUsedAndCompare(taskId, { kind: 'persona_used', page: 'optin', voice_persona_id: 'wiebe-copy-hackers' });
  const r2 = recordPersonaUsedAndCompare(taskId, { kind: 'persona_used', page: 'sales', voice_persona_id: 'bly-copywriters-handbook' });
  assert.ok(r1 && r2, 'both distinct divergences must be recorded');
  // distinct (declared, used) pairs -> 2 events (the dedupe key includes `used`).
  assert.equal(countMismatchEvents(taskId), 2);

  // both divergences are individually recorded (order between same-millisecond
  // events is not asserted here — getOpenPersonaMismatch's own single-latest
  // contract is already proven by the [A-U7-b] divergence test above).
  const rows = queryAll<{ metadata: string }>(
    `SELECT metadata FROM events WHERE type = 'persona_mismatch' AND task_id = ?`,
    [taskId],
  );
  const usedPersonas = new Set(
    rows.map((r) => (JSON.parse(r.metadata) as { used_voice_persona_id: string }).used_voice_persona_id),
  );
  assert.deepEqual(usedPersonas, new Set(['wiebe-copy-hackers', 'bly-copywriters-handbook']));
  assert.ok(getOpenPersonaMismatch(taskId), 'a chip must be present after 2 distinct divergences');
});
