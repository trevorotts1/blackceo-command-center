/**
 * B-U7 (ingest parity) — closes the Path-B structural divergence.
 *
 * `cc_board.ingest_task()` gains optional `voice_persona_id / topic_persona_id
 * / task_persona_ids / bundle_sha`; `createTaskCore` SKIPS
 * resolvePersonaAndPin/resolvePersonaPlanAndPin's selector re-match when
 * ingest carried them, pinning the producer's actual personas instead.
 * Fail-soft: absent fields → today's async pin exactly.
 *
 * BINARY acceptance (spec B-U7):
 *   (a) ingest carrying producer personas → the card's pinned persona ids
 *       equal the producer's verbatim and NO resolvePersonaAndPin selector
 *       spawn occurs (assert via its log line absence).
 *   (b) ingest without the fields → async pin fires exactly as today.
 *
 * Proof strategy for "no selector spawn": TWO independent signals, so a
 * regression that merely stops LOGGING (but still spawns) cannot false-pass:
 *   1. console.log is captured for the duration of the call; no captured
 *      line carries the `[resolvePersonaAndPin]` prefix (every real pin
 *      resolvePersonaAndPin performs logs under that exact prefix).
 *   2. PERSONA_FIXTURE_JSON is set to a DIFFERENT ("poisoned") persona id
 *      before the producer-pin call. If the code path incorrectly still
 *      routed through the selector, the fixture's poisoned id would land on
 *      the row instead of the producer's — so a value match against the
 *      producer's id is itself proof the selector was never consulted.
 *
 * Isolated temp DB. Node built-in test runner under tsx (established
 * convention — see tests/unit/point10-persona-exhaustion-fallback.test.ts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-bu7-ingest-persona-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type TasksModule = typeof import('../../src/lib/tasks');
let createTaskCore: TasksModule['createTaskCore'];
let pinProducerPersonaBundle: TasksModule['pinProducerPersonaBundle'];

let counter = 0;
const nextId = (p: string) => `${p}-${++counter}`;

function insertWorkspace(id: string, slug: string, name: string): void {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, sort_order)
     VALUES (?, ?, ?, ?, ?)`,
    [id, name, slug, 'Test dept', 900 + counter],
  );
}

/** Capture every console.log/warn/error line emitted while `fn` runs. */
async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = ((...args: unknown[]) => { record(...args); }) as typeof console.log;
  console.warn = ((...args: unknown[]) => { record(...args); }) as typeof console.warn;
  console.error = ((...args: unknown[]) => { record(...args); }) as typeof console.error;
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  ({ run, queryOne, closeDb } = db);
  db.getDb(); // full migration chain (incl. 090 task_persona_bundle)

  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, industry, config) VALUES (?, ?, ?, ?, ?)`,
    ['default', 'Test Company', 'test-company', '', '{}'],
  );

  const tasks = await import('../../src/lib/tasks');
  ({ createTaskCore, pinProducerPersonaBundle } = tasks);
});

test.after(() => {
  delete process.env.PERSONA_FIXTURE_JSON;
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DB, { force: true }); } catch { /* ignore */ }
  try { fs.rmdirSync(path.dirname(TMP_DB)); } catch { /* ignore */ }
});

// ── (a) producer personas present → pinned verbatim, NO selector spawn ───────
test('[B-U7 a] createTaskCore: producer persona fields → pinned verbatim, resolvePersonaAndPin never spawns', async () => {
  const wsId = nextId('ws-bu7-full');
  insertWorkspace(wsId, 'marketing', 'Marketing Department');

  // Poison: if the code incorrectly fell through to the selector, THIS id
  // would land on the row instead of the producer's.
  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'poison-should-never-be-used',
    persona_name: 'Poison Persona',
    interaction_mode: 'leadership',
    score: 9,
  });

  const { result, lines } = await captureConsole(() =>
    createTaskCore({
      title: 'Producer-pinned funnel build',
      workspace_id: wsId,
      department: 'marketing',
      skipWindowDedup: true,
      voice_persona_id: 'hormozi-100m-offers',
      topic_persona_id: 'miller-building-storybrand',
      task_persona_ids: ['hormozi-100m-offers', 'wiebe-copy-hackers'],
      bundle_sha: 'abc123def456',
    }),
  );
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.ok(result, 'createTaskCore must return a result');
  const taskId = result!.task.id;

  // Signal 1 — no [resolvePersonaAndPin]-prefixed log line anywhere.
  const selectorLines = lines.filter((l) => l.includes('[resolvePersonaAndPin]'));
  assert.deepEqual(selectorLines, [], `resolvePersonaAndPin must never log — got: ${JSON.stringify(selectorLines)}`);
  // A distinct producer-pin log line IS expected.
  assert.ok(
    lines.some((l) => l.includes('[createTaskCore] producer-pinned persona')),
    'the producer-pin path must log its own distinct line',
  );

  // Signal 2 — the pinned id is the PRODUCER's, never the poisoned fixture id.
  const row = queryOne<{
    persona_id: string | null;
    voice_persona_id: string | null;
    topic_persona_id: string | null;
    blend_directive: string | null;
  }>(
    'SELECT persona_id, voice_persona_id, topic_persona_id, blend_directive FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(row, 'task row must exist');
  assert.equal(row.persona_id, 'hormozi-100m-offers', 'legacy tasks.persona_id must equal the producer id verbatim');
  assert.notEqual(row.persona_id, 'poison-should-never-be-used', 'the selector fixture id must NEVER land');
  assert.equal(row.voice_persona_id, 'hormozi-100m-offers', 'voice_persona_id mirror must equal the producer id verbatim');
  assert.equal(row.topic_persona_id, 'miller-building-storybrand', 'topic_persona_id mirror must equal the producer id verbatim');
  assert.ok(row.blend_directive && row.blend_directive.length > 0, 'blend_directive must be populated (never NULL — sweep-heal guard)');

  // task_persona_bundle row carries the producer's task_persona_ids + bundle_sha.
  const bundleRow = queryOne<{ bundle_json: string; confirm_state: string }>(
    'SELECT bundle_json, confirm_state FROM task_persona_bundle WHERE task_id = ?',
    [taskId],
  );
  assert.ok(bundleRow, 'task_persona_bundle row must be written (same write path as resolvePersonaAndPin)');
  const parsed = JSON.parse(bundleRow.bundle_json);
  assert.deepEqual(
    parsed.task_personas.map((t: { persona_id: string }) => t.persona_id),
    ['hormozi-100m-offers', 'wiebe-copy-hackers'],
    'task_personas must carry the producer task_persona_ids verbatim, in order',
  );
  assert.equal(parsed.rationale.bundle_sha, 'abc123def456', 'bundle_sha must be recorded on the bundle row');
  assert.equal(bundleRow.confirm_state, 'not_required', 'a producer-pinned bundle is not_required (already resolved upstream)');

  // A queryable producer-pin audit event.
  const evt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND type = 'persona_producer_pinned' LIMIT 1`,
    [taskId],
  );
  assert.ok(evt, 'a persona_producer_pinned audit event must be written');
  assert.ok(evt.message.includes('[PERSONA-PRODUCER-PIN]'), 'event must carry the [PERSONA-PRODUCER-PIN] marker');
});

// ── (b) absent producer fields → today's async selector pin, unchanged ───────
test('[B-U7 b] createTaskCore: NO producer persona fields → async selector pin fires exactly as today', async () => {
  const wsId = nextId('ws-bu7-legacy');
  insertWorkspace(wsId, 'operations', 'Operations Department');

  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'generic-leader',
    persona_name: 'Generic Leader',
    interaction_mode: 'leadership',
    score: 5,
  });

  const result = await createTaskCore({
    title: 'restart the app server',
    workspace_id: wsId,
    department: 'operations',
    skipWindowDedup: true,
    // voice_persona_id / topic_persona_id / task_persona_ids / bundle_sha
    // deliberately OMITTED — this is the legacy/absent branch.
  });
  const taskId = result!.task.id;

  // The (fast, fixture-backed) async pin needs a tick to land.
  const deadline = Date.now() + 5000;
  let row: { persona_id: string | null } | undefined;
  while (Date.now() < deadline) {
    row = queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [taskId]);
    if (row?.persona_id) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(row?.persona_id, 'generic-leader', 'absent producer fields must fall back to the async selector pin, unchanged');

  const bundleRow = queryOne<{ id: string }>('SELECT id FROM task_persona_bundle WHERE task_id = ?', [taskId]);
  assert.equal(bundleRow, undefined, 'no bundle row — the fixture carried no bundle SUPERSET (legacy result)');

  const producerEvt = queryOne<{ id: string }>(
    `SELECT id FROM events WHERE task_id = ? AND type = 'persona_producer_pinned' LIMIT 1`,
    [taskId],
  );
  assert.equal(producerEvt, undefined, 'the legacy path must NEVER write a persona_producer_pinned event');
});

// ── partial producer fields (topic without voice) → legacy path, not a
//    half-formed pin ─────────────────────────────────────────────────────────
test('[B-U7] createTaskCore: topic_persona_id WITHOUT voice_persona_id → legacy async pin (voice gates the whole group)', async () => {
  const wsId = nextId('ws-bu7-partial');
  insertWorkspace(wsId, 'operations', 'Operations Department');

  process.env.PERSONA_FIXTURE_JSON = JSON.stringify({
    persona_id: 'generic-leader',
    persona_name: 'Generic Leader',
    interaction_mode: 'leadership',
    score: 5,
  });

  const result = await createTaskCore({
    title: 'archive the old reports',
    workspace_id: wsId,
    department: 'operations',
    skipWindowDedup: true,
    topic_persona_id: 'miller-building-storybrand', // no voice_persona_id
  });
  const taskId = result!.task.id;

  const deadline = Date.now() + 5000;
  let row: { persona_id: string | null } | undefined;
  while (Date.now() < deadline) {
    row = queryOne<{ persona_id: string | null }>('SELECT persona_id FROM tasks WHERE id = ?', [taskId]);
    if (row?.persona_id) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  delete process.env.PERSONA_FIXTURE_JSON;

  assert.equal(row?.persona_id, 'generic-leader', 'a voice-less partial payload must take the legacy selector path, never a half-formed pin');
});

// ── pinProducerPersonaBundle is fail-soft on a DB write error ────────────────
test('[B-U7] pinProducerPersonaBundle: never throws, even for a nonexistent task row', () => {
  assert.doesNotThrow(() => {
    const id = pinProducerPersonaBundle('nonexistent-task-id-xyz', {
      voice_persona_id: 'hormozi-100m-offers',
    });
    assert.equal(id, 'hormozi-100m-offers', 'must still return the pinned id even when the row read-back misses');
  });
});
