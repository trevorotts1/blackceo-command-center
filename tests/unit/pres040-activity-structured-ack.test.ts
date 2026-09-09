/**
 * PRES-040 (W3 WF12-B) — authenticated activity fallback keeps structured data.
 *
 * node:test suite (runs under `npm run test:unit`). Drives the REAL POST
 * /api/tasks/[id]/activities handler against an isolated DB, one test per
 * TODO acceptance clause:
 *   1. Structured POST (phase_id + scores + event_id + schema_version)
 *      persists scores + metadata, returns a structured_ack.
 *   2. Forced 422-shape gap: a text note WITHOUT event_id posts fine but
 *      yields structured_ack null and NO event-key claim — the structured
 *      event stays unacknowledged (pending), never conflated with the note.
 *   3. Replay of the same event_id returns the ORIGINAL activity once
 *      (replay-once, 200 duplicate, single phase event row).
 *   4. Changed payload on the same event_id is a 409 conflict.
 *   5. Score metadata + phase id preserved through the round trip; legacy
 *      text-only activities carry no event key (historical/unverified —
 *      phaseIdOf still reads them, activitySchemaInfo marks them version 0).
 *   6. Unit: activitySchemaInfo versions + unknown-version flag.
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test \
 *     tests/unit/pres040-activity-structured-ack.test.ts
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';
import { activitySchemaInfo, phaseIdOf } from '../../src/lib/presentation-phases';

const TASK = `task-pres040-${process.pid}-${Math.random().toString(36).slice(2)}`;

function seed() {
  const db = getDb();
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('ws040')) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)').run(
      'ws040', 'WS040', 'ws040', 'X', 990,
    );
  }
  db.prepare(`INSERT INTO tasks (id,title,status,priority,workspace_id) VALUES (?,?,'in_progress','medium','ws040')`).run(
    TASK, 'PRES-040 proof task',
  );
}

async function postActivity(body: Record<string, unknown>) {
  const { POST } = await import('../../src/app/api/tasks/[id]/activities/route');
  const req = new NextRequest(`http://localhost/api/tasks/${TASK}/activities`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ id: TASK }) } as unknown as { params: Promise<{ id: string }> });
}

const structuredBody = (eventId: string, extra: Record<string, unknown> = {}) => ({
  activity_type: 'phase_completed',
  message: '[P4-COPY] done avg=9.1 pass=true autofails=0',
  metadata: {
    phase_id: 'P4-COPY',
    event_id: eventId,
    schema_version: 1,
    run_id: 'run-040',
    attempt_id: 'att-1',
    sequence: 3,
    stage_units: { slides: 12 },
    ...extra,
  },
  scores: { gate: 'P4-COPY', average: 9.1, pass: true, autofails_count: 0 },
});

function countEventRows(eventId: string): number {
  return (
    getDb()
      .prepare(`SELECT count(*) AS n FROM task_activity_events WHERE task_id = ? AND event_id = ?`)
      .get(TASK, eventId) as { n: number }
  ).n;
}

seed();

test('PRES-040: structured POST persists scores + metadata, returns structured_ack', async () => {
  const res = await postActivity(structuredBody('ev-040-a'));
  assert.equal(res.status, 201);
  const json = (await res.json()) as {
    activity_type: string;
    metadata: string;
    scores: string | null;
    structured_ack: { event_id: string; status: string } | null;
  };
  assert.equal(json.activity_type, 'phase_completed');
  assert.equal(json.structured_ack?.event_id, 'ev-040-a');
  assert.equal(json.structured_ack?.status, 'accepted');
  // Scores persisted to the scores column (not stripped).
  const row = getDb().prepare('SELECT scores FROM task_activities WHERE id = ?').get(
    (json as { id: string }).id,
  ) as { scores: string | null };
  assert.ok(row.scores);
  assert.equal((JSON.parse(row.scores!) as { average: number }).average, 9.1);
  // Phase id + schema version survive in metadata.
  const md = JSON.parse(json.metadata) as Record<string, unknown>;
  assert.equal(md.phase_id, 'P4-COPY');
  assert.equal(md.schema_version, 1);
  assert.equal(phaseIdOf({ metadata: json.metadata }), 'P4-COPY');
  assert.equal(countEventRows('ev-040-a'), 1);
});

test('PRES-040: text note without event_id posts but leaves structured event pending', async () => {
  const res = await postActivity({ activity_type: 'comment', message: '[P4-RENDER] done (text fallback)' });
  assert.equal(res.status, 201);
  const json = (await res.json()) as { structured_ack: unknown };
  assert.equal(json.structured_ack, null);
  // No event key claimed — the structured event for this phase is still pending.
  const keys = getDb()
    .prepare(`SELECT count(*) AS n FROM task_activity_events WHERE task_id = ?`)
    .get(TASK) as { n: number };
  assert.equal(keys.n, 1); // only ev-040-a from the previous test
});

test('PRES-040: replay of the same event returns the original once (replay-once)', async () => {
  const first = await postActivity(structuredBody('ev-040-replay'));
  assert.equal(first.status, 201);
  const firstId = ((await first.json()) as { id: string }).id;
  const second = await postActivity(structuredBody('ev-040-replay'));
  assert.equal(second.status, 200);
  const sj = (await second.json()) as { id: string; structured_ack: { status: string } };
  assert.equal(sj.id, firstId);
  assert.equal(sj.structured_ack.status, 'duplicate');
  // Exactly one phase event row + one key claim.
  const rows = (
    getDb().prepare(`SELECT count(*) AS n FROM task_activities WHERE task_id = ? AND metadata LIKE ?`).get(TASK, '%ev-040-replay%') as {
      n: number;
    }
  ).n;
  assert.equal(rows, 1);
  assert.equal(countEventRows('ev-040-replay'), 1);
});

test('PRES-040: changed payload on the same event is a 409 conflict', async () => {
  const first = await postActivity(structuredBody('ev-040-conflict'));
  assert.equal(first.status, 201);
  const res = await postActivity(structuredBody('ev-040-conflict', { phase_id: 'P4-RENDER' }));
  assert.equal(res.status, 409);
});

test('PRES-040: legacy text-only activity is historical (version 0, no key)', async () => {
  const res = await postActivity({ activity_type: 'comment', message: '[P-SP-STRUCTURE] old note' });
  assert.equal(res.status, 201);
  const json = (await res.json()) as { metadata: null };
  assert.equal(json.metadata, null);
  assert.equal(phaseIdOf({ metadata: null }), null);
  assert.deepEqual(activitySchemaInfo({ metadata: null }), { version: 0, eventId: null, known: true });
  assert.deepEqual(activitySchemaInfo({ metadata: JSON.stringify({ phase_id: 'P4-COPY' }) }), {
    version: 0,
    eventId: null,
    known: true,
  });
});

test('PRES-040: activitySchemaInfo versions + unknown-version flag (unit)', () => {
  assert.deepEqual(activitySchemaInfo({ metadata: { phase_id: 'P4-COPY', event_id: 'e', schema_version: 1 } }), {
    version: 1,
    eventId: 'e',
    known: true,
  });
  assert.deepEqual(activitySchemaInfo({ metadata: { phase_id: 'P4-COPY', event_id: 'e', schema_version: 2 } }), {
    version: 2,
    eventId: 'e',
    known: false,
  });
  assert.deepEqual(activitySchemaInfo({ metadata: 'not-json{{{' }), { version: 0, eventId: null, known: true });
  getDb().prepare('DELETE FROM task_activity_events WHERE task_id = ?').run(TASK);
  getDb().prepare('DELETE FROM task_activities WHERE task_id = ?').run(TASK);
  getDb().prepare('DELETE FROM tasks WHERE id = ?').run(TASK);
});
