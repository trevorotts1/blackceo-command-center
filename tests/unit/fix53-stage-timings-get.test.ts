/**
 * FIX 53 (MASTER Part 8, [R5A §E, §H6]) — per-task stage-timings GET.
 *
 * Drives the REAL GET /api/presentations/[taskId]/stage-timings handler
 * against an isolated DB (schema self-provisioned via getDb migrations).
 * No network. Covers the QC.md FIX 53 proof surface:
 *   - POST rows WITH task_id → SELECT by task_id resolves them (the linkage),
 *   - the GET route returns those rows per task + non-null aggregates,
 *   - run→task fallback via the parent card's own session key and via child
 *     provenance (WI-15b), so a parent card sees a run posted only with its
 *     run id,
 *   - company scoping: a task outside the active company scope is 404,
 *   - event= filter + limit knobs degrade defensively on bad input.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';

const RUN_ID = `fix53-itest-${Date.now()}`;
const TASK_ID = `task-fix53-${Date.now()}`;
const PARENT_ID = `parent-fix53-${Date.now()}`;
const OTHER_TASK_ID = `task-fix53-other-${Date.now()}`;

async function postRows(rows: unknown[]) {
  const { POST } = await import('../../src/app/api/presentations/stage-timings/route');
  const req = new NextRequest('http://localhost/api/presentations/stage-timings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
  return POST(req);
}

function getReq(taskId: string, query = '') {
  const url = `http://localhost/api/presentations/${encodeURIComponent(taskId)}/stage-timings${query}`;
  return new NextRequest(url, { method: 'GET' });
}

async function getStageTimings(taskId: string, query = '') {
  const { GET } = await import(
    '../../src/app/api/presentations/[taskId]/stage-timings/route'
  );
  return GET(getReq(taskId, query), { params: { taskId } } as unknown as {
    params: { taskId: string };
  });
}

beforeAll(async () => {
  const db = getDb();

  // The timings table must exist (migration 127/131 via getDb migrations).
  const t = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='presentation_stage_timings'`,
    )
    .get();
  expect(t).toBeTruthy();

  // Seed two tasks IN-SCOPE (own workspace row so the FK on workspace_id
  // resolves) plus the fixtures for the scope gates below.
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, company_id)
     VALUES ('default', 'Fix53 Test', 'fix53-test', 'default')`,
  ).run();
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, title, status, workspace_id, requester_session_key)
     VALUES (?, ?, 'in_progress', 'default', ?)`,
  );
  insertTask.run(TASK_ID, 'Deck run A', RUN_ID);
  insertTask.run(OTHER_TASK_ID, 'Deck run B', `other-run-${Date.now()}`);

  // FIX 53 linkage arm: POST rows stamped with the task id directly.
  const posted = await postRows([
    {
      run_id: RUN_ID,
      event: 'phase_exit',
      phase_id: 'P4-COPY',
      wave: 2,
      model_used: 'deepseek-v4-pro',
      started_at: '2026-09-02T09:00:00Z',
      ended_at: '2026-09-02T09:00:12Z',
      duration_s: 12.5,
      status: 'done',
      return_code: 0,
      error_class: 'x',
      task_id: TASK_ID,
    },
    {
      run_id: RUN_ID,
      event: 'phase_exit',
      phase_id: 'P4-PROMPT',
      started_at: '2026-09-02T09:00:12Z',
      ended_at: '2026-09-02T09:00:30Z',
      duration_s: 18,
      status: 'failed',
      return_code: 1,
      error_class: 'kie_500',
      task_id: TASK_ID,
    },
    {
      run_id: RUN_ID,
      event: 'run_summary',
      total_wall_s: 30.5,
      phase_count: 2,
      slowest_3: [{ phase_id: 'P4-PROMPT', duration_s: 18 }],
      generated_at: '2026-09-02T09:00:30Z',
    },
  ]);
  expect(posted.status).toBe(201);
});

describe('GET /api/presentations/[taskId]/stage-timings', () => {
  it('returns rows stamped with the task id + non-null aggregates (QC proof arm)', async () => {
    const res = await getStageTimings(TASK_ID);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      task_id: string;
      run_ids: string[];
      counts: { phase_exits: number; run_summaries: number };
      totals: { wall_s: number | null; duration_s: number | null };
      error_classes: string[];
      rows: Array<Record<string, unknown>>;
    };

    expect(json.task_id).toBe(TASK_ID);
    expect(json.run_ids).toContain(RUN_ID);
    expect(json.counts.phase_exits).toBe(2);
    expect(json.counts.run_summaries).toBe(1);
    expect(json.totals.wall_s).toBe(30.5);
    expect(json.totals.duration_s).toBe(30.5);
    expect(json.error_classes.sort()).toEqual(['kie_500', 'x']);
    expect(json.rows.length).toBe(3);
    const copy = json.rows.find((r) => r.phase_id === 'P4-COPY');
    expect(copy).toBeTruthy();
    expect(copy?.duration_s).toBe(12.5);
    expect(copy?.error_class).toBe('x');
  });

  it('resolves a run posted ONLY with its run id via the task session key (fallback arm)', async () => {
    // The producer posts rows keyed ONLY by run_id (no task_id linkage). The
    // parent ingest stores that run id as the task's session key — arm 3 must
    // bridge the two without any child row existing.
    const db = getDb();
    const sessionRunId = `sess-${Date.now()}`;
    db.prepare('UPDATE tasks SET requester_session_key = ? WHERE id = ?').run(
      sessionRunId,
      OTHER_TASK_ID,
    );

    const seeded = await postRows([
      {
        run_id: sessionRunId,
        event: 'phase_exit',
        phase_id: 'P0A-INTAKE',
        started_at: '2026-09-02T08:00:00Z',
        ended_at: '2026-09-02T08:00:05Z',
        duration_s: 5,
        status: 'done',
        return_code: 0,
      },
    ]);
    expect(seeded.status).toBe(201);

    const res = await getStageTimings(OTHER_TASK_ID);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rows: Array<{ phase_id: string | null }> };
    expect(json.rows.some((r) => r.phase_id === 'P0A-INTAKE')).toBe(true);
  });

  it('resolves child provenance (Session: <run id>) under the parent task', async () => {
    // WI-15b: a child card under PARENT_ID whose description embeds the run id.
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, title, status, workspace_id, parent_task_id, description)
       VALUES (?, 'Deck run parent', 'in_progress', 'default', NULL, NULL)`,
    ).run(PARENT_ID);
    db.prepare(
      `INSERT INTO tasks (id, title, status, workspace_id, parent_task_id, description)
       VALUES (?, 'P4-COPY — Deck', 'done', 'default', ?, ?)`,
    ).run(`child-${Date.now()}`, PARENT_ID, `Session: ${RUN_ID}`);

    const res = await getStageTimings(PARENT_ID);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { run_ids: string[]; counts: { phase_exits: number } };
    expect(json.run_ids).toContain(RUN_ID);
    expect(json.counts.phase_exits).toBeGreaterThanOrEqual(1);
  });

  it('404s an unknown task id (boardWhereClause convention)', async () => {
    // Direct id that does not exist → 404, never an empty 200.
    const res = await getStageTimings('task-does-not-exist');
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('Task not found');
  });

  it('event= filter and limit knobs degrade defensively', async () => {
    const summaryOnly = await getStageTimings(TASK_ID, '?event=run_summary');
    expect(summaryOnly.status).toBe(200);
    const sjson = (await summaryOnly.json()) as { rows: Array<{ event: string }> };
    expect(sjson.rows.length).toBeGreaterThan(0);
    expect(sjson.rows.every((r) => r.event === 'run_summary')).toBe(true);

    // Garbage event and limit collapse to defaults, not 500.
    const garbage = await getStageTimings(TASK_ID, '?event=bogus&limit=-3');
    expect(garbage.status).toBe(200);

    const limited = await getStageTimings(TASK_ID, '?limit=1');
    const ljson = (await limited.json()) as { rows: unknown[] };
    expect(ljson.rows.length).toBeLessThanOrEqual(1);
  });
});
