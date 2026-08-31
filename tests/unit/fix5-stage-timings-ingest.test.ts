/**
 * FIX 5 (presentation rev2 phase A) — stage-timings ingest route.
 *
 * Drives the REAL POST/GET /api/presentations/stage-timings handlers against
 * an isolated DB (schema self-provisioned via getDb migrations). No network.
 *
 * Covers, against the spec's "small CC ingest route" surface:
 *  - accepts the exact row shapes phases.py emits (phase_exit + run_summary),
 *  - rejects non-JSON (400), oversize body (413), bad schema (400),
 *  - HMAC: valid x-webhook-signature passes, invalid fails 401 when
 *    WEBHOOK_SECRET is set; production without the secret fail-loud 503,
 *  - rows land in presentation_stage_timings with typed columns + raw payload.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';

const RUN_ID = `fix5-itest-${Date.now()}`;

// Exact rows as emitted by presentation_job/phases.py run_phase_timed +
// _emit_run_summary (green probe FIX-05 captured this shape live).
const PHASE_EXIT_ROW = {
  run_id: RUN_ID,
  phase_id: 'FIX5A-SAMPLE',
  wave: 1,
  model_used: null,
  event: 'phase_exit',
  started_at: '2026-08-31T13:36:16-04:00',
  ended_at: '2026-08-31T13:36:17-04:00',
  duration_s: 0.467,
  status: 'done',
  return_code: 0,
};
const RUN_SUMMARY_ROW = {
  run_id: RUN_ID,
  event: 'run_summary',
  total_wall_s: 0.931,
  phase_count: 1,
  slowest_3: [{ phase_id: 'FIX5A-SAMPLE', duration_s: 0.467 }],
  generated_at: '2026-08-31T13:36:17-04:00',
};

async function postStageTimings(
  body: string,
  extraHeaders: Record<string, string> = {},
) {
  const { POST } = await import('../../src/app/api/presentations/stage-timings/route');
  const req = new NextRequest('http://localhost/api/presentations/stage-timings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body,
  });
  return POST(req);
}

function sign(secret: string, raw: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

beforeAll(() => {
  // Table must exist post-migration-127; getDb() ran migrations at first open.
  const t = getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='presentation_stage_timings'`)
    .get();
  expect(t).toBeTruthy();
});

afterAll(() => {
  getDb().prepare('DELETE FROM presentation_stage_timings WHERE run_id = ?').run(RUN_ID);
});

describe('POST /api/presentations/stage-timings', () => {
  it('accepts engine-shaped rows and persists typed columns + raw payload', async () => {
    const body = JSON.stringify({ rows: [PHASE_EXIT_ROW, RUN_SUMMARY_ROW] });
    const res = await postStageTimings(body);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toEqual({ ok: true, accepted: 2 });

    const db = getDb();
    const exit = db
      .prepare('SELECT * FROM presentation_stage_timings WHERE run_id = ? AND event = ?')
      .get(RUN_ID, 'phase_exit') as Record<string, unknown>;
    expect(exit.phase_id).toBe('FIX5A-SAMPLE');
    expect(exit.wave).toBe(1);
    expect(exit.duration_s).toBe(0.467);
    expect(exit.status).toBe('done');
    expect(exit.return_code).toBe(0);
    expect(JSON.parse(String(exit.payload))).toEqual(PHASE_EXIT_ROW);

    const sum = db
      .prepare('SELECT * FROM presentation_stage_timings WHERE run_id = ? AND event = ?')
      .get(RUN_ID, 'run_summary') as Record<string, unknown>;
    expect(sum.total_wall_s).toBe(0.931);
    expect(sum.phase_count).toBe(1);
    expect(JSON.parse(String(sum.slowest_3))).toEqual(RUN_SUMMARY_ROW.slowest_3);
  });

  it('rejects non-JSON with 400', async () => {
    const res = await postStageTimings('this is not json{{{');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/JSON/i);
  });

  it('rejects payloads over the 64KB cap with 413', async () => {
    const fat = {
      rows: [{ ...PHASE_EXIT_ROW, phase_id: 'x'.repeat(70 * 1024) }],
    };
    const res = await postStageTimings(JSON.stringify(fat));
    expect(res.status).toBe(413);
  });

  it('rejects schema violations with 400 (unknown event, missing fields)', async () => {
    const bad = { rows: [{ run_id: RUN_ID, event: 'nonsense' }] };
    const res = await postStageTimings(JSON.stringify(bad));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Validation/i);

    const empty = { rows: [] };
    const res2 = await postStageTimings(JSON.stringify(empty));
    expect(res2.status).toBe(400);
  });

  it('enforces HMAC when WEBHOOK_SECRET is set (valid passes, forged 401)', async () => {
    const secret = 'itest-fix5-secret-not-a-real-one';
    process.env.WEBHOOK_SECRET = secret;
    try {
      const body = JSON.stringify({ rows: [{ ...PHASE_EXIT_ROW, phase_id: 'FIX5-HMAC-A' }] });
      const good = await postStageTimings(body, { 'x-webhook-signature': sign(secret, body) });
      expect(good.status).toBe(201);

      const forged = await postStageTimings(body, { 'x-webhook-signature': sign('wrong', body) });
      expect(forged.status).toBe(401);

      const unsigned = await postStageTimings(body);
      expect(unsigned.status).toBe(401);

      getDb().prepare('DELETE FROM presentation_stage_timings WHERE phase_id = ?').run('FIX5-HMAC-A');
    } finally {
      delete process.env.WEBHOOK_SECRET;
    }
  });

  it('fail-loud 503 in production without WEBHOOK_SECRET', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSecret = process.env.WEBHOOK_SECRET;
    delete process.env.WEBHOOK_SECRET;
    process.env.NODE_ENV = 'production';
    try {
      const res = await postStageTimings(JSON.stringify({ rows: [PHASE_EXIT_ROW] }));
      expect(res.status).toBe(503);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevSecret !== undefined) process.env.WEBHOOK_SECRET = prevSecret;
    }
  });
});

describe('GET /api/presentations/stage-timings', () => {
  it('describes the endpoint contract', async () => {
    const { GET } = await import('../../src/app/api/presentations/stage-timings/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.endpoint).toBe('/api/presentations/stage-timings');
    expect(json.limits.maxBodyBytes).toBe(64 * 1024);
  });
});
