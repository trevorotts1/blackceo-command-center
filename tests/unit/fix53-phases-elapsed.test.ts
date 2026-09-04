/**
 * FIX 53 (W18a-B4) — phases route fills elapsed_s from stage timings.
 *
 * Drives the REAL GET /api/presentations/[taskId]/phases handler against an
 * isolated DB, mirroring the QC.md FIX 53 proof exactly:
 *   - POST stage-timing rows with task_id and error_class 'x' (through the
 *     real ingest handler, exercising the same write path the engine uses),
 *   - SELECT error_class FROM presentation_stage_timings WHERE task_id=? -> x,
 *   - GET phases shows NON-NULL elapsed_s for the mapped label.
 *
 * The POST path needs W18b's task_id column (migration 131) + validation to
 * accept it; this test PROVISIONS the column itself (the same ALTER the
 * migration ships) so the W18a slice is provable independently of W18b's
 * merge order — on an un-migrated box the route falls back to run_id.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll } from 'vitest';
import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';
import { phaseElapsedSeconds } from '../../src/lib/presentation-phases';

const RUN_ID = `fix53-itest-${Date.now()}`;
const TASK_ID = 'fix53-task-row';

async function postStageTimings(body: string) {
  const { POST } = await import('../../src/app/api/presentations/stage-timings/route');
  const secret = 'fix53-secret';
  process.env.WEBHOOK_SECRET = secret;
  const req = new NextRequest('http://localhost/api/presentations/stage-timings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-webhook-signature': createHmac('sha256', secret).update(body).digest('hex'),
    },
    body,
  });
  return POST(req);
}

beforeAll(() => {
  const db = getDb();
  // W18b-B3's migration 131 column — provisioned here so the ingest accepts
  // task_id rows and the route's task_id lookup path is exercised.
  const hasCol = (
    db.prepare(
      `SELECT count(*) AS n FROM pragma_table_info('presentation_stage_timings') WHERE name = 'task_id'`,
    ).get() as { n: number }
  ).n > 0;
  if (!hasCol) {
    db.exec(`ALTER TABLE presentation_stage_timings ADD COLUMN task_id TEXT`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_presentation_stage_timings_task
         ON presentation_stage_timings (task_id, event)`,
    );
  }
});

describe('FIX 53 — stage timings linked to tasks and shown', () => {
  it('POST with task_id + error_class persists; SELECT by task_id returns error_class x', async () => {
    const db = getDb();
    const body = JSON.stringify({
      rows: [
        {
          run_id: RUN_ID,
          task_id: TASK_ID,
          phase_id: 'P4-COPY',
          wave: 1,
          event: 'phase_exit',
          started_at: '2026-09-01T10:00:00Z',
          ended_at: '2026-09-01T10:00:12Z',
          duration_s: 12.4,
          status: 'done',
          return_code: 0,
          error_class: 'x',
        },
        {
          run_id: RUN_ID,
          task_id: TASK_ID,
          phase_id: 'PF-DESIGN',
          wave: 1,
          event: 'phase_exit',
          started_at: '2026-09-01T10:00:13Z',
          ended_at: '2026-09-01T10:00:20Z',
          duration_s: 7.1,
          status: 'done',
          return_code: 0,
          error_class: 'x',
        },
      ],
    });
    const res = await postStageTimings(body);
    expect(res.status).toBe(201);

    const row = db
      .prepare(
        `SELECT error_class FROM presentation_stage_timings WHERE task_id = ? AND phase_id = 'P4-COPY'`,
      )
      .get(TASK_ID) as { error_class: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.error_class).toBe('x');
  });

  it('GET phases shows non-null elapsed_s for the mapped labels (Script, Prompts)', async () => {
    // Task row must exist and be company-scope-visible (workspace_id NULL).
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, status, department, workspace_id, created_at, updated_at)
       VALUES (?, ?, 'in_progress', 'dept-presentations', NULL, ?, ?)`,
    ).run(TASK_ID, 'FIX53 proof run', new Date().toISOString(), new Date().toISOString());

    const { GET } = await import('../../src/app/api/presentations/[taskId]/phases/route');
    const req = new NextRequest(`http://localhost/api/presentations/${TASK_ID}/phases`);
    const res = await GET(req, { params: { taskId: TASK_ID } });
    expect(res.status).toBe(200);
    const json = await res.json();
    const byLabel = new Map<string, { elapsed_s: number | null }>(
      json.phases.map((p: { label: string; elapsed_s: number | null }) => [p.label, p]),
    );
    // P4-COPY -> Script (12.4s), PF-DESIGN -> Prompts (7.1s)
    expect(byLabel.get('Script')!.elapsed_s).toBeCloseTo(12.4, 5);
    expect(byLabel.get('Prompts')!.elapsed_s).toBeCloseTo(7.1, 5);
    // Labels with no timing row stay null.
    expect(byLabel.get('Intake')!.elapsed_s).toBeNull();
  });

  it('phaseElapsedSeconds: latest-run rows only; unmapped ids skipped; sums within a run', () => {
    // Two runs for the same task: only the LATEST run (second insert) counts.
    const a = phaseElapsedSeconds([
      { run_id: 'run-1', phase_id: 'P4-COPY', duration_s: 99 },
      { run_id: 'run-2', phase_id: 'P4-COPY', duration_s: 3 },
      { run_id: 'run-2', phase_id: 'P4-COPY', duration_s: 4.5 },
      { run_id: 'run-2', phase_id: 'NOT-A-REAL-PHASE', duration_s: 100 },
      { run_id: 'run-2', phase_id: null, duration_s: 5 },
    ]);
    expect(a).toEqual({ Script: 7.5 });

    expect(phaseElapsedSeconds([])).toEqual({});
    expect(phaseElapsedSeconds([{ run_id: 'r', phase_id: 'P4-COPY', duration_s: 1 }])).toEqual({
      Script: 1,
    });
    // Non-finite duration contributes nothing.
    expect(
      phaseElapsedSeconds([{ run_id: 'r', phase_id: 'P4-COPY', duration_s: Number.NaN }]),
    ).toEqual({});
  });
});
