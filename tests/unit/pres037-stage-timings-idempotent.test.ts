/**
 * PRES-037 (W3 WF12-B) — stage-timing ingestion is idempotent + transactional.
 *
 * node:test suite (runs under `npm run test:unit`). Drives the REAL POST
 * /api/presentations/stage-timings handler against an isolated DB, one test
 * per TODO acceptance clause:
 *   1. Same keyed batch repeated contributes once (identical replay → duplicate).
 *   2. Changed replay on the same key is a 409 conflict and writes nothing.
 *   3. Mid-batch failure rolls back the whole batch (no partial prefix).
 *   4. Replay after lost ACK preserves totals (duplicate, same sums).
 *   5. Foreign task binding refused 422, nothing written.
 *   6. Out-of-order old-run events do not change the current run (phases read
 *      + timing_breakdown split: provider time is not wall time).
 *   7. Per-event ACKs persist (accepted → duplicate across replays).
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts --test \
 *     tests/unit/pres037-stage-timings-idempotent.test.ts
 */

import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';

const RUN = `pres037-${Date.now()}`;
const OLD_RUN = `pres037-old-${Date.now()}`;
const TASK = `task-pres037-${Date.now()}`;
const FOREIGN_TASK = `task-pres037-foreign-${Date.now()}`;

function seed() {
  const db = getDb();
  db.exec(`INSERT OR IGNORE INTO companies (id,name,slug) VALUES ('c037','Real Client Co','real-client-co')`);
  db.exec(`INSERT OR IGNORE INTO workspaces (id,name,slug,company_id) VALUES ('w037','W037','w037','c037')`);
  db.exec(`INSERT OR IGNORE INTO companies (id,name,slug) VALUES ('c037f','Foreign Co','foreign-co')`);
  db.exec(`INSERT OR IGNORE INTO workspaces (id,name,slug,company_id) VALUES ('w037f','W037F','w037f','c037f')`);
  process.env.COMPANY_SLUG = 'real-client-co';
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id,title,status,workspace_id,requester_session_key) VALUES (?,?, 'in_progress','w037',?)`,
  ).run(TASK, 'PRES-037 proof task', RUN);
  db.prepare(
    `INSERT OR IGNORE INTO tasks (id,title,status,workspace_id) VALUES (?,?, 'in_progress','w037f')`,
  ).run(FOREIGN_TASK, 'PRES-037 foreign task');
}

async function postRows(rows: unknown[]) {
  const { POST } = await import('../../src/app/api/presentations/stage-timings/route');
  const req = new NextRequest('http://localhost/api/presentations/stage-timings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  return POST(req);
}

const exit = (eventId: string, phase: string, duration: number, extra: Record<string, unknown> = {}) => ({
  run_id: RUN,
  event: 'phase_exit',
  phase_id: phase,
  started_at: '2026-09-01T10:00:00Z',
  ended_at: '2026-09-01T10:00:10Z',
  duration_s: duration,
  status: 'done',
  task_id: TASK,
  event_id: eventId,
  attempt_id: 'att-1',
  sequence: 1,
  provider_s: 8,
  queue_s: 1,
  qc_s: 1,
  ...extra,
});

function countRunRows(): number {
  return (
    getDb().prepare('SELECT count(*) AS n FROM presentation_stage_timings WHERE run_id = ?').get(RUN) as {
      n: number;
    }
  ).n;
}

function cleanup() {
  delete process.env.COMPANY_SLUG;
  const db = getDb();
  db.prepare('DELETE FROM presentation_stage_timings WHERE run_id IN (?,?)').run(RUN, OLD_RUN);
  db.prepare('DELETE FROM presentation_stage_acks WHERE run_id IN (?,?)').run(RUN, OLD_RUN);
  db.prepare('DELETE FROM tasks WHERE id IN (?,?)').run(TASK, FOREIGN_TASK);
}

seed();

test('PRES-037: same keyed batch repeated contributes once', async () => {
  const batch = [exit('e1', 'P4-COPY', 10), exit('e2', 'PF-DESIGN', 7)];
  const first = await postRows(batch);
  assert.equal(first.status, 201);
  assert.equal(((await first.json()) as { accepted: number }).accepted, 2);
  assert.equal(countRunRows(), 2);

  const replay = await postRows(batch);
  assert.equal(replay.status, 201);
  const j = (await replay.json()) as { accepted: number; duplicates: number };
  assert.equal(j.accepted, 0);
  assert.equal(j.duplicates, 2);
  assert.equal(countRunRows(), 2);
});

test('PRES-037: changed replay on the same key is a 409 conflict, writes nothing', async () => {
  const before = countRunRows();
  const res = await postRows([exit('e1', 'P4-COPY', 999)]);
  assert.equal(res.status, 409);
  assert.equal(countRunRows(), before);
});

test('PRES-037: mid-batch failure rolls back the whole batch', async () => {
  const before = countRunRows();
  const res = await postRows([exit('e3', 'P4-RENDER', 5), exit('e1', 'P4-COPY', 111)]);
  assert.equal(res.status, 409);
  assert.equal(countRunRows(), before);
  const e3 = getDb()
    .prepare('SELECT id FROM presentation_stage_timings WHERE run_id = ? AND event_id = ?')
    .get(RUN, 'e3');
  assert.equal(e3, undefined);
});

test('PRES-037: replay after lost ACK preserves totals', async () => {
  const again = await postRows([exit('e1', 'P4-COPY', 10), exit('e2', 'PF-DESIGN', 7)]);
  const j = (await again.json()) as { accepted: number; duplicates: number };
  assert.equal(j.duplicates, 2);
  const total = (
    getDb()
      .prepare(
        `SELECT sum(duration_s) AS s FROM presentation_stage_timings WHERE run_id = ? AND event = 'phase_exit'`,
      )
      .get(RUN) as { s: number }
  ).s;
  assert.ok(Math.abs(total - 17) < 1e-5, `expected total 17, got ${total}`);
});

test('PRES-037: foreign task binding refused 422, nothing written', async () => {
  const before = (getDb().prepare('SELECT count(*) AS n FROM presentation_stage_timings').get() as { n: number }).n;
  const res = await postRows([{ ...exit('ef', 'P4-COPY', 3), task_id: FOREIGN_TASK }]);
  assert.equal(res.status, 422);
  const after = (getDb().prepare('SELECT count(*) AS n FROM presentation_stage_timings').get() as { n: number }).n;
  assert.equal(after, before);
});

test('PRES-037: old-run events do not change the current run; split reported', async () => {
  const res = await postRows([{ ...exit('e-old', 'P4-COPY', 999), run_id: OLD_RUN }]);
  assert.equal(res.status, 201);
  const { GET } = await import('../../src/app/api/presentations/[taskId]/phases/route');
  const got = await GET(new NextRequest(`http://localhost/api/presentations/${TASK}/phases`), {
    params: Promise.resolve({ taskId: TASK }),
  } as unknown as { params: Promise<{ taskId: string }> });
  assert.equal(got.status, 200);
  const json = (await got.json()) as {
    phases: Array<{ label: string; elapsed_s: number | null }>;
    timing_breakdown: Record<string, { wall_s: number; provider_s: number; queue_s: number; qc_s: number }>;
  };
  const byLabel = new Map(json.phases.map((p) => [p.label, p.elapsed_s]));
  assert.ok(Math.abs((byLabel.get('Script') ?? 0) - 10) < 1e-5);
  assert.ok(Math.abs((byLabel.get('Prompts') ?? 0) - 7) < 1e-5);
  assert.ok(Math.abs(json.timing_breakdown.Script.provider_s - 8) < 1e-5);
  assert.ok(Math.abs(json.timing_breakdown.Script.wall_s - 10) < 1e-5);
});

test('PRES-037: per-event ACKs persist across replays', async () => {
  const rows = getDb()
    .prepare(`SELECT event_id, status FROM presentation_stage_acks WHERE run_id = ? ORDER BY event_id`)
    .all(RUN) as Array<{ event_id: string; status: string }>;
  const byEvent = new Map(rows.map((r) => [r.event_id, r.status]));
  assert.equal(byEvent.get('e1'), 'duplicate');
  assert.equal(byEvent.get('e2'), 'duplicate');
  cleanup();
});
