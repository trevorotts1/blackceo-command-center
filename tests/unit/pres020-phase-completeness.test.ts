/**
 * PRES-020 — stepper label-vs-ID defect.
 *
 * Old behavior (locked by the failing half of these tests against the old
 * code): computePhaseProgress collected completed LABELS, so ONE
 * completion-typed activity (P4-COPY alone) flipped the whole Script label
 * `done` before structure, copy QC, or speech ran; percent was a fabricated
 * 50/100; elapsed picked the latest INSERTED run so delayed older events
 * hijacked the display.
 *
 * New behavior: a label is `done` only when EVERY applicable required phase
 * id of that label has a completion signal with a valid QC receipt; stale
 * run/attempt rows are obsolete; out-of-order/replayed activity is
 * idempotent; units/durations match engine receipts; canonical run wins over
 * arrival order.
 *
 * Pure-reducer tests (no DB, no server) + one route-shape test driving the
 * REAL GET /api/presentations/[taskId]/phases handler on an isolated DB.
 */

import './_isolated-db';
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';
import {
  computePhaseProgress,
  phaseElapsedSeconds,
  selectCanonicalRunId,
  requiredPhaseIdsForLabel,
  PHASE_TO_LABEL,
} from '../../src/lib/presentation-phases';

// All five Script ids: P4-COPY, P-SP-STRUCTURE, P-SP-P3-HYGIENE, P1Q-COPY-QC, P9-SPEECH.
const SCRIPT_IDS = requiredPhaseIdsForLabel('Script');
const doneActivity = (phase_id: string, extra?: Record<string, unknown>) => ({
  activity_type: 'phase_completed',
  metadata: { phase_id, ...extra },
});

describe('PRES-020 — one of five done is partial, all required done is done', () => {
  it('P4-COPY alone leaves Script in_progress with units 1/5', () => {
    const r = computePhaseProgress([doneActivity('P4-COPY')], []);
    const script = r.phases.find((p) => p.label === 'Script')!;
    expect(SCRIPT_IDS.length).toBe(5);
    expect(script.status).toBe('in_progress');
    expect(script.doneIds).toBe(1);
    expect(script.totalIds).toBe(5);
  });

  it('all five Script ids done flips Script done with units 5/5', () => {
    const r = computePhaseProgress(SCRIPT_IDS.map((id) => doneActivity(id)), []);
    const script = r.phases.find((p) => p.label === 'Script')!;
    expect(script.status).toBe('done');
    expect(script.doneIds).toBe(5);
    expect(script.totalIds).toBe(5);
  });

  it('four of five done is still partial (4/5)', () => {
    const r = computePhaseProgress(
      SCRIPT_IDS.slice(0, 4).map((id) => doneActivity(id)),
      [],
    );
    const script = r.phases.find((p) => p.label === 'Script')!;
    expect(script.status).toBe('in_progress');
    expect(script.doneIds).toBe(4);
    expect(script.totalIds).toBe(5);
  });

  it('untouched labels stay not_started with full totals', () => {
    const r = computePhaseProgress([doneActivity('P4-COPY')], []);
    const prompts = r.phases.find((p) => p.label === 'Prompts')!;
    expect(prompts.status).toBe('not_started');
    expect(prompts.doneIds).toBe(0);
    expect(prompts.totalIds).toBe(4);
  });
});

describe('PRES-020 — late completion from an old attempt does not override retry', () => {
  const allDone = (run_id: string, attempt_id: string) =>
    SCRIPT_IDS.map((id) => ({ ...doneActivity(id), run_id, attempt_id }));

  it('stale-attempt completions are obsolete under the active scope', () => {
    const r = computePhaseProgress(allDone('run-1', '1'), [], {
      activeScope: { run_id: 'run-1', attempt_id: '2' },
    });
    const script = r.phases.find((p) => p.label === 'Script')!;
    expect(script.status).toBe('not_started');
    expect(script.doneIds).toBe(0);
  });

  it('current-attempt completions still count under the active scope', () => {
    const r = computePhaseProgress(allDone('run-1', '2'), [], {
      activeScope: { run_id: 'run-1', attempt_id: '2' },
    });
    expect(r.phases.find((p) => p.label === 'Script')!.status).toBe('done');
  });

  it('unscoped legacy rows still count when a scope is active', () => {
    const r = computePhaseProgress(SCRIPT_IDS.map((id) => doneActivity(id)), [], {
      activeScope: { run_id: 'run-9', attempt_id: '9' },
    });
    expect(r.phases.find((p) => p.label === 'Script')!.status).toBe('done');
  });

  it('no active scope means nothing is obsolete (legacy callers)', () => {
    const r = computePhaseProgress(allDone('run-old', '1'), []);
    expect(r.phases.find((p) => p.label === 'Script')!.status).toBe('done');
  });
});

describe('PRES-020 — optional phases excluded only by approved manifest', () => {
  it('excluding one id shrinks the required set (4/4 done)', () => {
    const excluded = ['P9-SPEECH'];
    expect(requiredPhaseIdsForLabel('Script', excluded).length).toBe(4);
    const r = computePhaseProgress(
      SCRIPT_IDS.filter((id) => id !== 'P9-SPEECH').map((id) => doneActivity(id)),
      [],
      { excludedPhaseIds: excluded },
    );
    const script = r.phases.find((p) => p.label === 'Script')!;
    expect(script.status).toBe('done');
    expect(script.totalIds).toBe(4);
  });

  it('a fully waived label is done only when a completion touched it', () => {
    const all = Object.keys(PHASE_TO_LABEL).filter((id) => PHASE_TO_LABEL[id] === 'Script');
    const untouched = computePhaseProgress([], [], { excludedPhaseIds: all });
    expect(untouched.phases.find((p) => p.label === 'Script')!.status).toBe('not_started');
    const touched = computePhaseProgress([doneActivity('P4-COPY')], [], {
      excludedPhaseIds: all,
    });
    expect(touched.phases.find((p) => p.label === 'Script')!.status).toBe('done');
  });
});

describe('PRES-020 — deliverable presence without QC does not complete', () => {
  it('a bare completion without a QC receipt leaves the id unfinished', () => {
    const r = computePhaseProgress(SCRIPT_IDS.map((id) => doneActivity(id)), [], {
      completionReceipts: { 'P4-COPY': true },
    });
    const script = r.phases.find((p) => p.label === 'Script')!;
    expect(script.status).toBe('in_progress');
    expect(script.doneIds).toBe(1);
  });

  it('explicit-false and missing receipts both withhold completion', () => {
    const acts = SCRIPT_IDS.map((id) => doneActivity(id));
    const r = computePhaseProgress(acts, [], {
      completionReceipts: {
        'P4-COPY': true,
        'P-SP-STRUCTURE': false,
        'P-SP-P3-HYGIENE': null,
      },
    });
    expect(r.phases.find((p) => p.label === 'Script')!.doneIds).toBe(1);
  });

  it('teleprompter still completes only via the deliverable signal', () => {
    const withDel = computePhaseProgress([], [
      { deliverable_type: 'artifact', path: 'working/deliverables/presenter-teleprompter.html' },
    ]);
    expect(withDel.phases.find((p) => p.label === 'Teleprompter')!.status).toBe('done');
    const withoutDel = computePhaseProgress(
      [{ activity_type: 'phase_completed', metadata: { phase_id: 'P8-ASSEMBLE' } }],
      [{ deliverable_type: 'artifact', path: 'working/deliverables/PRESENTER-GUIDE.pdf' }],
    );
    expect(withoutDel.phases.find((p) => p.label === 'Teleprompter')!.status).toBe('not_started');
  });
});

describe('PRES-020 — out-of-order and replayed activity is idempotent', () => {
  it('reversed order and duplicates reduce identically', () => {
    const fwd = SCRIPT_IDS.map((id) => doneActivity(id));
    const rev = [...fwd].reverse();
    const dup = [...fwd, ...fwd, { activity_type: 'status_changed', metadata: { phase_id: 'P4-COPY' } }];
    const a = computePhaseProgress(fwd, []);
    const b = computePhaseProgress(rev, []);
    const c = computePhaseProgress(dup, []);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.phases.find((p) => p.label === 'Script')!.status).toBe('done');
  });

  it('a started-but-uncompleted id stays in_progress across replays', () => {
    const acts = [
      { activity_type: 'status_changed', metadata: { phase_id: 'P4-COPY' } },
      { activity_type: 'progress', metadata: { phase_id: 'P4-COPY' } },
      { activity_type: 'status_changed', metadata: { phase_id: 'P4-COPY' } },
    ];
    const r = computePhaseProgress(acts, []);
    const script = r.phases.find((p) => p.label === 'Script')!;
    expect(script.status).toBe('in_progress');
    expect(script.doneIds).toBe(0);
  });
});

describe('PRES-020 — units and durations match engine receipts', () => {
  it('elapsed sums only the canonical run, not arrival order', () => {
    const rows = [
      { run_id: 'run-old', phase_id: 'P4-COPY', duration_s: 100 },
      { run_id: 'run-new', phase_id: 'P4-COPY', duration_s: 7.5 },
    ];
    // No authoritative run: latest-inserted fallback (run-new).
    expect(phaseElapsedSeconds(rows)).toEqual({ Script: 7.5 });
    // Authoritative run pins run-new even when a delayed old row arrives LAST.
    const late = [...rows, { run_id: 'run-old', phase_id: 'P-SP-STRUCTURE', duration_s: 50 }];
    expect(phaseElapsedSeconds(late, 'run-new')).toEqual({ Script: 7.5 });
    expect(selectCanonicalRunId(late, 'run-new')).toBe('run-new');
    // Unknown authoritative id falls back to latest-inserted, never crashes.
    expect(selectCanonicalRunId(late, 'run-missing')).toBe('run-old');
    expect(selectCanonicalRunId([], 'run-new')).toBeNull();
  });
});

describe('PRES-020 — route emits honest percent/units/receipts', () => {
  const TASK_ID = `pres020-task-${Date.now()}`;

  beforeAll(() => {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO tasks (id, title, status, department, workspace_id, created_at, updated_at)
       VALUES (?, ?, 'in_progress', 'dept-presentations', NULL, ?, ?)`,
    ).run(TASK_ID, 'PRES-020 proof run', now, now);
    const put = db.prepare(
      `INSERT INTO task_activities (id, task_id, activity_type, message, metadata)
       VALUES (?, ?, ?, ?, ?)`,
    );
    // One completion WITHOUT a QC receipt (P4-COPY only) + a QC-passed
    // completion for P-SP-STRUCTURE via the producer scorecard contract.
    put.run(`a1-${TASK_ID}`, TASK_ID, 'phase_completed', 'copy done', JSON.stringify({ phase_id: 'P4-COPY' }));
    put.run(
      `a2-${TASK_ID}`,
      TASK_ID,
      'completed',
      'structure qc pass',
      JSON.stringify({ phase_id: 'P-SP-STRUCTURE', qc_gate: 'P-SP-STRUCTURE', qc_passed: true }),
    );
  });

  it('1-of-5 with receipts reads partial percent, units 1/5, one receipt', async () => {
    const { GET } = await import('../../src/app/api/presentations/[taskId]/phases/route');
    const req = new NextRequest(`http://localhost/api/presentations/${TASK_ID}/phases`);
    const res = await GET(req, { params: { taskId: TASK_ID } });
    expect(res.status).toBe(200);
    const json = await res.json();
    const script = json.phases.find((p: { label: string }) => p.label === 'Script');
    // P-SP-STRUCTURE carries a QC receipt; P4-COPY's bare completion does not.
    expect(script.status).toBe('in_progress');
    expect(script.units_completed).toBe(1);
    expect(script.units_total).toBe(5);
    expect(script.percent).toBe(20);
    expect(script.receipts).toEqual([{ phase_id: 'P-SP-STRUCTURE', verified: true }]);
    // started_at stays an honest null; wall-clock lives in elapsed_s.
    expect(script.started_at).toBeNull();
  });
});
