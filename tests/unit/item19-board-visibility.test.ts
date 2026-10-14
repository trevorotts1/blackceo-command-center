/**
 * Item 19 (FIX-PLAN) — board visibility for the presentation engine's
 * P-U branch, its ABANDONED terminal, its parks, and its resume.
 *
 * The defects this suite pins shut:
 *   1. The P-U branch (sales page / checkout / VSL) was unmapped in the
 *      stepper: its phase ids landed in `unmapped`, which nothing renders,
 *      so an elected branch built invisibly (forever-amber). Now: elected
 *      branches get steps with real states; declined branches get NO
 *      steps and no main label waits on their phases.
 *   2. Engine terminal ABANDONED had no board surface: the producer posts
 *      terminal runs as `review`, so abandoned runs sat in review-limbo.
 *      Now the run's state.json vocabulary reaches the card payload, the
 *      phases payload, and the task-row projection (the filter's source).
 *   3. A parked run showed nothing (or raw codes). Now the card payload
 *      carries Item 10's plain-words park record — and the raw blocked
 *      reason NEVER crosses into it.
 *   4. No resume existed on the board. Now POST
 *      /api/presentations/[taskId]/resume drives the engine's own
 *      launcher resume path and reports the engine's resulting state:
 *      success and refusal both render truthfully.
 */

import './_isolated-db';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '../../src/lib/db';
import { resolveActiveCompanyId } from '../../src/lib/company';
import {
  computePhaseProgress,
  phaseElapsedSeconds,
  UPSELL_PHASE_TO_LABEL,
} from '../../src/lib/presentation-phases';
import {
  readEngineRunState,
  parkViewFromEngineState,
  engineStateIsParked,
  resolveElectionsFromIntake,
  getTaskEngineView,
} from '../../src/lib/presentation-engine-state';
import { registerPresentationRun } from '../../src/lib/presentation-run-bindings';
import { projectTaskRow, type TaskRowRaw } from '../../src/lib/board/task-row-projection';

// ── The launcher seam: the resume orchestration stays real; only the
// process spawn is stubbed, per test, through this mock.
const launcherMock = vi.hoisted(() => ({
  launch: vi.fn(),
}));
vi.mock('@/lib/presentation-engine-launcher', async (importOriginal) => {
  const orig =
    await importOriginal<typeof import('../../src/lib/presentation-engine-launcher')>();
  return { ...orig, launchEngineResume: launcherMock.launch };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const RUN = `i19-${Date.now().toString(36)}`;
const ROOTS = fs.mkdtempSync(path.join(os.tmpdir(), `i19-roots-${RUN}-`));
process.env.PRESENTATION_RUNS_DIRS = ROOTS;

const SALES_IDS = Object.entries(UPSELL_PHASE_TO_LABEL)
  .filter(([, l]) => l === 'Sales Page')
  .map(([id]) => id);
const CHECKOUT_IDS = Object.entries(UPSELL_PHASE_TO_LABEL)
  .filter(([, l]) => l === 'Checkout')
  .map(([id]) => id);
const VSL_IDS = Object.entries(UPSELL_PHASE_TO_LABEL)
  .filter(([, l]) => l === 'VSL Page')
  .map(([id]) => id);

function makeRunDir(name: string): string {
  const dir = path.join(ROOTS, name);
  fs.mkdirSync(path.join(dir, 'working', 'copy'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'working', 'checkpoints'), { recursive: true });
  return dir;
}

function writeState(runDir: string, state: Record<string, unknown>): void {
  fs.writeFileSync(path.join(runDir, 'state.json'), JSON.stringify(state, null, 2));
}

function writeIntake(runDir: string, intake: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(runDir, 'working', 'copy', 'intake.json'),
    JSON.stringify(intake, null, 2),
  );
}

function insertTask(
  db: ReturnType<typeof getDb>,
  row: { id: string; title: string; status: string },
): void {
  const now = new Date().toISOString();
  const workspaceId = `i19-workspace-${RUN}`;
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, slug, company_id) VALUES (?, ?, ?, ?)')
    .run(workspaceId, 'Item 19 fixture', workspaceId, resolveActiveCompanyId(db));
  db.prepare(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, department, source, parent_task_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'medium', ?, 'default', 'presentations', 'build_deck', NULL, ?, ?)`,
  ).run(row.id, row.title, 'Deck build.', row.status, workspaceId, now, now);
}

function bindRun(taskId: string, runDir: string): void {
  fs.writeFileSync(
    path.join(runDir, 'working', 'checkpoints', 'process_manifest.json'),
    JSON.stringify({ cc_task_id: taskId, run_id: `run-${taskId}` }),
  );
  const res = registerPresentationRun({
    taskId,
    runRoot: runDir,
    companyId: resolveActiveCompanyId(getDb()),
    runId: `run-${taskId}`,
    registeredBy: 'item19-test',
  });
  expect(res.ok).toBe(true);
}

const doneActivity = (phase_id: string) => ({
  activity_type: 'phase_completed',
  metadata: { phase_id },
});
const startedActivity = (phase_id: string) => ({
  activity_type: 'status_changed',
  metadata: { phase_id },
});

// ── 1. The stepper mapping ──────────────────────────────────────────────────

describe('Item 19 — stepper: elected branches get steps with real states', () => {
  it('the manifest mapping is total: 20 branch ids + 2 shared ids', () => {
    expect(SALES_IDS.length).toBe(6);
    expect(CHECKOUT_IDS.length).toBe(6);
    expect(VSL_IDS.length).toBe(8);
  });

  it('sales/checkout elected: both steps appear, not_started, honest totals', () => {
    const r = computePhaseProgress([], [], {
      electedBranches: { salesCheckout: true, vsl: false },
    });
    expect(r.phases.map((p) => p.label)).toEqual([
      'Intake', 'Script', 'Prompts', 'Images',
      'Sales Page', 'Checkout',
      'Teleprompter', 'QC', 'Delivered',
    ]);
    const sales = r.phases.find((p) => p.label === 'Sales Page')!;
    const checkout = r.phases.find((p) => p.label === 'Checkout')!;
    expect(sales.status).toBe('not_started');
    expect(sales.totalIds).toBe(6);
    expect(checkout.status).toBe('not_started');
    expect(checkout.totalIds).toBe(6);
    // The shared wrap-up ids join their main labels for an elected run.
    expect(r.phases.find((p) => p.label === 'QC')!.totalIds).toBe(3);
    expect(r.phases.find((p) => p.label === 'Delivered')!.totalIds).toBe(4);
  });

  it('VSL elected only: VSL step appears, no sales/checkout steps', () => {
    const r = computePhaseProgress([], [], {
      electedBranches: { salesCheckout: false, vsl: true },
    });
    const labels = r.phases.map((p) => p.label);
    expect(labels).toContain('VSL Page');
    expect(labels).not.toContain('Sales Page');
    expect(labels).not.toContain('Checkout');
    expect(r.phases.find((p) => p.label === 'VSL Page')!.totalIds).toBe(8);
  });

  it('partial branch progress is in_progress with honest units; all done + receipts is done', () => {
    const partial = computePhaseProgress(
      SALES_IDS.slice(0, 3).map(doneActivity),
      [],
      { electedBranches: { salesCheckout: true, vsl: false } },
    );
    const sales = partial.phases.find((p) => p.label === 'Sales Page')!;
    expect(sales.status).toBe('in_progress');
    expect(sales.doneIds).toBe(3);
    expect(sales.totalIds).toBe(6);

    const full = computePhaseProgress(
      SALES_IDS.map(doneActivity),
      [],
      { electedBranches: { salesCheckout: true, vsl: false } },
    );
    expect(full.phases.find((p) => p.label === 'Sales Page')!.status).toBe('done');

    // Receipts gate applies to branch ids exactly like main ids: bare
    // completions without a validating receipt never flip the step done.
    const receipts: Record<string, boolean> = {};
    for (const id of SALES_IDS) receipts[id] = true;
    delete receipts['P-U-GHL-SALES'];
    const gated = computePhaseProgress(SALES_IDS.map(doneActivity), [], {
      electedBranches: { salesCheckout: true, vsl: false },
      completionReceipts: receipts,
    });
    const gatedSales = gated.phases.find((p) => p.label === 'Sales Page')!;
    expect(gatedSales.status).toBe('in_progress');
    expect(gatedSales.doneIds).toBe(5);
  });

  it('a started-but-unfinished branch step is in_progress, never a default success', () => {
    const r = computePhaseProgress([startedActivity('P-U-DESIGN-VSL')], [], {
      electedBranches: { salesCheckout: false, vsl: true },
    });
    const vsl = r.phases.find((p) => p.label === 'VSL Page')!;
    expect(vsl.status).toBe('in_progress');
    expect(vsl.doneIds).toBe(0);
  });
});

describe('Item 19 — stepper: declined branches show no phantom steps', () => {
  it('both declined: exactly the 7 main steps, main totals unchanged', () => {
    const r = computePhaseProgress([], [], {
      electedBranches: { salesCheckout: false, vsl: false },
    });
    expect(r.phases.map((p) => p.label)).toEqual([
      'Intake', 'Script', 'Prompts', 'Images', 'Teleprompter', 'QC', 'Delivered',
    ]);
    expect(r.phases.find((p) => p.label === 'QC')!.totalIds).toBe(2);
    expect(r.phases.find((p) => p.label === 'Delivered')!.totalIds).toBe(3);
  });

  it('both declined: stray P-U activity creates no step and is NOT unmapped', () => {
    const r = computePhaseProgress(
      [doneActivity('P-U-SALES-COPY'), startedActivity('P-U-GHL-VSL')],
      [],
      { electedBranches: { salesCheckout: false, vsl: false } },
    );
    expect(r.phases.length).toBe(7);
    // Mapped-but-not-applicable is not "unknown": the ids stay out of the
    // unmapped bucket, and no label waits on them.
    expect(r.unmapped).toEqual([]);
    expect(r.phases.every((p) => p.status === 'not_started')).toBe(true);
  });

  it('unknown elections and no evidence: exactly 7 steps (no invented branches)', () => {
    const r = computePhaseProgress([doneActivity('P4-COPY')], []);
    expect(r.phases.length).toBe(7);
  });

  it('unknown elections with branch evidence: the evidenced branch appears', () => {
    const r = computePhaseProgress([startedActivity('P-U-VSL-COPY')], []);
    const labels = r.phases.map((p) => p.label);
    expect(labels).toContain('VSL Page');
    expect(labels).not.toContain('Sales Page');
    expect(r.unmapped).toEqual([]);
    // Shared wrap-up joins QC on the same evidence.
    expect(r.phases.find((p) => p.label === 'QC')!.totalIds).toBe(3);
  });

  it('elapsed seconds attribute P-U rows to their branch step only when active', () => {
    const rows = [
      { run_id: 'run-1', phase_id: 'P-U-SALES-COPY', duration_s: 42 },
      { run_id: 'run-1', phase_id: 'P4-COPY', duration_s: 10 },
    ];
    const elected = phaseElapsedSeconds(rows, 'run-1', { salesCheckout: true, vsl: false });
    expect(elected['Sales Page']).toBe(42);
    expect(elected['Script']).toBe(10);
    const declined = phaseElapsedSeconds(rows, 'run-1', { salesCheckout: false, vsl: false });
    expect(declined['Sales Page']).toBeUndefined();
    expect(declined['Script']).toBe(10);
  });
});

// ── 2+3. Engine state: ABANDONED, parks, elections ─────────────────────────

const PARK_STATUS = {
  park_class: 'client_action',
  label: 'Waiting for you',
  waiting_on: 'client',
  needed: 'Connect the GoHighLevel account so the sales page can be installed',
  phase: 'P-U-GHL-SALES',
  since: '2026-10-01T10:00:00.000Z',
  recorded_at: '2026-10-01T10:05:00.000Z',
  auto_resume: false,
  by: 'presentation_job.auto_resume',
};
const RAW_REASON = 'RAW-DIAGNOSTIC ghl token 401 gate GHL-INSTALL-7 stack trace';

describe('Item 19 — engine state reads', () => {
  it('park view carries the plain-words record verbatim, never the raw reason', () => {
    const dir = makeRunDir('parked-status');
    writeState(dir, {
      job_id: 'job-parked',
      terminal: 'BLOCKED',
      blocked: { phase: 'P-U-GHL-SALES', reason: RAW_REASON, at: '2026-10-01T10:00:00.000Z' },
      park_status: PARK_STATUS,
    });
    const state = readEngineRunState(dir)!;
    expect(state.terminal).toBe('BLOCKED');
    expect(engineStateIsParked(state)).toBe(true);
    const view = parkViewFromEngineState(state)!;
    expect(view.source).toBe('park_status');
    expect(view.label).toBe('Waiting for you');
    expect(view.waiting_on).toBe('client');
    expect(view.needed).toBe(PARK_STATUS.needed);
    expect(view.phase).toBe('P-U-GHL-SALES');
    expect(view.since).toBe('2026-10-01T10:00:00.000Z');
    expect(view.auto_resume).toBe(false);
    expect(JSON.stringify(view)).not.toContain('RAW-DIAGNOSTIC');
  });

  it('a lingering park_status record does NOT re-park a resumed run', () => {
    const dir = makeRunDir('resumed-lingering');
    writeState(dir, {
      job_id: 'job-resumed',
      terminal: null,
      blocked: null,
      park_status: PARK_STATUS,
      resume_history: [{ at: '2026-10-02T09:00:00.000Z' }],
    });
    const state = readEngineRunState(dir)!;
    expect(engineStateIsParked(state)).toBe(false);
    expect(parkViewFromEngineState(state)).toBeNull();
  });

  it('pre-Item-10 blocked record: view shows phase + since, no reason text', () => {
    const dir = makeRunDir('parked-legacy');
    writeState(dir, {
      job_id: 'job-legacy',
      terminal: 'BLOCKED',
      blocked: { phase: 'P8-ASSEMBLE', reason: RAW_REASON, at: '2026-09-15T08:30:00.000Z' },
    });
    const view = parkViewFromEngineState(readEngineRunState(dir)!)!;
    expect(view.source).toBe('blocked');
    expect(view.phase).toBe('P8-ASSEMBLE');
    expect(view.since).toBe('2026-09-15T08:30:00.000Z');
    expect(view.needed).toBeNull();
    expect(JSON.stringify(view)).not.toContain('RAW-DIAGNOSTIC');
  });

  it('configuration_pending fallback: plain-words owner + next action', () => {
    const dir = makeRunDir('parked-config');
    writeState(dir, {
      job_id: 'job-config',
      terminal: 'BLOCKED',
      blocked: { phase: 'P0A-INTAKE', reason: RAW_REASON, at: '2026-09-20T12:00:00.000Z' },
      configuration_pending: {
        at: '2026-09-20T12:01:00.000Z',
        phase: 'P0A-INTAKE',
        reason: RAW_REASON,
        owner: 'the client (a one-time resource-plan answer)',
        next_action: 'answer the pending resource-plan question for the named provider',
        by: 'presentation_job.auto_resume',
      },
    });
    const view = parkViewFromEngineState(readEngineRunState(dir)!)!;
    expect(view.source).toBe('configuration_pending');
    expect(view.waiting_on).toBe('client');
    expect(view.needed).toContain('resource-plan question');
    expect(JSON.stringify(view)).not.toContain('RAW-DIAGNOSTIC');
  });

  it('ABANDONED is read as its own terminal, distinct from BLOCKED and DONE', () => {
    const dir = makeRunDir('abandoned');
    writeState(dir, { job_id: 'job-ab', terminal: 'ABANDONED' });
    const state = readEngineRunState(dir)!;
    expect(state.terminal).toBe('ABANDONED');
    expect(engineStateIsParked(state)).toBe(false);
    expect(parkViewFromEngineState(state)).toBeNull();
  });

  it('elections resolve in the engine order: capture, waiver, defaults', () => {
    const a = makeRunDir('elect-a');
    writeIntake(a, {
      pre_presentation_capture: { WANT_SALES_CHECKOUT: 'no', WANT_VSL_PAGE: 'yes' },
    });
    expect(resolveElectionsFromIntake(a)).toEqual({ salesCheckout: false, vsl: true });

    const b = makeRunDir('elect-b');
    writeIntake(b, {
      pre_presentation_capture: {},
      waivers: [{ rule: 'sales_checkout', client_request_quote: 'no upsell please' }],
    });
    // The recorded decline beats the sales default ("yes"); VSL default is "no".
    expect(resolveElectionsFromIntake(b)).toEqual({ salesCheckout: false, vsl: false });

    const c = makeRunDir('elect-c');
    writeIntake(c, { pre_presentation_capture: { WANT_SALES_CHECKOUT: true } });
    expect(resolveElectionsFromIntake(c)).toEqual({ salesCheckout: true, vsl: false });

    const d = makeRunDir('elect-d');
    expect(resolveElectionsFromIntake(d)).toBeNull();
  });
});

// ── 2+3 (routes). Card + stepper payloads carry the engine truth ───────────

describe('Item 19 — routes surface ABANDONED and the park record', () => {
  const ABANDONED_TASK = `i19-abandoned-${RUN}`;
  const PARKED_TASK = `i19-parked-${RUN}`;
  const ELECTED_TASK = `i19-elected-${RUN}`;

  beforeAll(() => {
    const db = getDb();
    insertTask(db, { id: ABANDONED_TASK, title: 'Abandoned deck', status: 'review' });
    const abDir = makeRunDir('run-abandoned');
    writeState(abDir, { job_id: 'job-ab', terminal: 'ABANDONED' });
    bindRun(ABANDONED_TASK, abDir);

    insertTask(db, { id: PARKED_TASK, title: 'Parked deck', status: 'blocked' });
    const parkDir = makeRunDir('run-parked');
    writeState(parkDir, {
      job_id: 'job-parked',
      terminal: 'BLOCKED',
      blocked: { phase: 'P-U-GHL-SALES', reason: RAW_REASON, at: '2026-10-01T10:00:00.000Z' },
      park_status: PARK_STATUS,
    });
    bindRun(PARKED_TASK, parkDir);

    insertTask(db, { id: ELECTED_TASK, title: 'Elected deck', status: 'in_progress' });
    const elDir = makeRunDir('run-elected');
    writeState(elDir, { job_id: 'job-elected', terminal: null });
    writeIntake(elDir, {
      pre_presentation_capture: { WANT_SALES_CHECKOUT: 'yes', WANT_VSL_PAGE: 'no' },
    });
    bindRun(ELECTED_TASK, elDir);
  });

  it('children payload: ABANDONED reaches the card, distinct from its review status', async () => {
    const { GET } = await import('../../src/app/api/presentations/children/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/presentations/children?parent_id=${ABANDONED_TASK}`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      parent: { status: string; engine_terminal: string | null; park_status: unknown };
    };
    expect(body.parent.status).toBe('review');
    expect(body.parent.engine_terminal).toBe('ABANDONED');
    expect(body.parent.park_status).toBeNull();
  });

  it('children payload: the parked card carries the plain-words record', async () => {
    const { GET } = await import('../../src/app/api/presentations/children/route');
    const res = await GET(
      new NextRequest(`http://localhost/api/presentations/children?parent_id=${PARKED_TASK}`),
    );
    const body = (await res.json()) as {
      parent: { engine_terminal: string | null; park_status: { label: string; needed: string; waiting_on: string } | null };
    };
    expect(body.parent.engine_terminal).toBe('BLOCKED');
    expect(body.parent.park_status?.label).toBe('Waiting for you');
    expect(body.parent.park_status?.waiting_on).toBe('client');
    expect(JSON.stringify(body.parent.park_status)).not.toContain('RAW-DIAGNOSTIC');
  });

  it('phases payload: elected run shows branch steps; engine block rides along', async () => {
    const db = getDb();
    const put = db.prepare(
      `INSERT INTO task_activities (id, task_id, activity_type, message, metadata) VALUES (?, ?, ?, ?, ?)`,
    );
    // The producer's scorecard shape: a 'completed' row whose metadata
    // carries the QC receipt for the same phase id.
    put.run(`a1-${RUN}`, ELECTED_TASK, 'completed', 'sales copy done',
      JSON.stringify({ phase_id: 'P-U-SALES-COPY', qc_gate: 'P-U-SALES-COPY', qc_passed: true }));

    const { GET } = await import('../../src/app/api/presentations/[taskId]/phases/route');
    const res = await GET(new NextRequest(`http://localhost/api/presentations/${ELECTED_TASK}/phases`), {
      params: { taskId: ELECTED_TASK },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      phases: Array<{ label: string; status: string; units_completed: number; units_total: number; receipts: unknown[] }>;
      engine: { terminal: string | null };
      unmapped: string[];
    };
    const labels = body.phases.map((p) => p.label);
    expect(labels).toContain('Sales Page');
    expect(labels).toContain('Checkout');
    expect(labels).not.toContain('VSL Page');
    const sales = body.phases.find((p) => p.label === 'Sales Page')!;
    expect(sales.status).toBe('in_progress');
    expect(sales.units_completed).toBe(1);
    expect(sales.units_total).toBe(6);
    expect(sales.receipts).toEqual([{ phase_id: 'P-U-SALES-COPY', verified: true }]);
    expect(body.unmapped).toEqual([]);
  });

  it('row projection: engine_terminal + park_status ride the board payload', () => {
    const row = projectTaskRow({
      id: ABANDONED_TASK,
      status: 'review',
      source: 'build_deck',
      department: 'presentations',
      parent_task_id: null,
    } as unknown as TaskRowRaw);
    expect(row.engine_terminal).toBe('ABANDONED');

    const parkedRow = projectTaskRow({
      id: PARKED_TASK,
      status: 'blocked',
      source: 'build_deck',
      department: 'presentations',
      parent_task_id: null,
    } as unknown as TaskRowRaw);
    expect(parkedRow.engine_terminal).toBe('BLOCKED');
    expect(parkedRow.park_status?.label).toBe('Waiting for you');

    // A non-presentation row pays nothing and claims nothing.
    const plain = projectTaskRow({
      id: 'some-other-task',
      status: 'backlog',
      source: null,
      department: 'general',
      parent_task_id: null,
    } as unknown as TaskRowRaw);
    expect(plain.engine_terminal).toBeNull();
    expect(plain.park_status).toBeNull();
  });

  it('getTaskEngineView: an unbound task is UNDETERMINED, never a guess', () => {
    const view = getTaskEngineView(`i19-no-such-task-${RUN}`);
    expect(view.runDir).toBeNull();
    expect(view.terminal).toBeNull();
    expect(view.park).toBeNull();
  });
});

// ── 4. The resume action ────────────────────────────────────────────────────

describe('Item 19 — resume round-trips against stubbed engine state', () => {
  const RESUME_TASK = `i19-resume-${RUN}`;
  const REFUSE_TASK = `i19-refuse-${RUN}`;
  const TERMINAL_TASK = `i19-terminal-${RUN}`;
  let resumeDir = '';
  let refuseDir = '';

  beforeAll(() => {
    const db = getDb();
    insertTask(db, { id: RESUME_TASK, title: 'Resumable deck', status: 'blocked' });
    resumeDir = makeRunDir('run-resume');
    writeState(resumeDir, {
      job_id: 'job-resume',
      terminal: 'BLOCKED',
      blocked: { phase: 'P4-RENDER', reason: RAW_REASON, at: '2026-10-03T09:00:00.000Z' },
      park_status: { ...PARK_STATUS, park_class: 'transient_infra', label: 'Paused by a temporary problem, retrying on its own', waiting_on: 'system', auto_resume: true },
      resume_history: [],
    });
    bindRun(RESUME_TASK, resumeDir);

    insertTask(db, { id: REFUSE_TASK, title: 'Refused deck', status: 'blocked' });
    refuseDir = makeRunDir('run-refuse');
    writeState(refuseDir, {
      job_id: 'job-refuse',
      terminal: 'BLOCKED',
      blocked: { phase: 'P4-RENDER', reason: RAW_REASON, at: '2026-10-03T09:00:00.000Z' },
      resume_history: [],
    });
    bindRun(REFUSE_TASK, refuseDir);

    insertTask(db, { id: TERMINAL_TASK, title: 'Terminal deck', status: 'review' });
    const termDir = makeRunDir('run-terminal');
    writeState(termDir, { job_id: 'job-term', terminal: 'ABANDONED' });
    bindRun(TERMINAL_TASK, termDir);
  });

  async function postResume(taskId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const { POST } = await import('../../src/app/api/presentations/[taskId]/resume/route');
    const res = await POST(new NextRequest(`http://localhost/api/presentations/${taskId}/resume`, { method: 'POST' }), {
      params: { taskId },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  it('success: the launcher consumes the park and the answer is the new engine state', async () => {
    launcherMock.launch.mockReset();
    launcherMock.launch.mockImplementation(async () => {
      // The stubbed engine: --resume clears the park and records the
      // resume in its own history, exactly as the real reset does.
      const state = JSON.parse(fs.readFileSync(path.join(resumeDir, 'state.json'), 'utf8'));
      state.terminal = null;
      state.blocked = null;
      state.resume_history = [...(state.resume_history ?? []), { at: '2026-10-03T10:00:00.000Z', by: 'cc-board-resume' }];
      writeState(resumeDir, state);
      return { exitCode: 0, output: 'launcher: spawned engine pid 4242' };
    });

    const { status, body } = await postResume(RESUME_TASK);
    expect(status).toBe(200);
    expect(body.resumed).toBe(true);
    const engine = body.engine as { terminal: string | null; park_status: unknown };
    expect(engine.terminal).toBeNull();
    expect(engine.park_status).toBeNull();
    expect(launcherMock.launch).toHaveBeenCalledTimes(1);
    // The board task itself was NOT moved by the resume: the engine owns it.
    const row = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(RESUME_TASK) as { status: string };
    expect(row.status).toBe('blocked');
  });

  it('refusal: the launcher refusal is surfaced verbatim and the park remains', async () => {
    launcherMock.launch.mockReset();
    launcherMock.launch.mockResolvedValue({
      exitCode: 6,
      output: 'launcher: engine already running for this run (pid 9911)',
    });

    const { status, body } = await postResume(REFUSE_TASK);
    expect(status).toBe(409);
    expect(body.resumed).toBe(false);
    expect(body.code).toBe('launcher_refused');
    expect(body.error).toContain('engine already running');
    const engine = body.engine as { park_status: { label: string } | null };
    expect(engine.park_status).not.toBeNull();
    // State on disk is untouched by the refused attempt.
    const state = readEngineRunState(refuseDir)!;
    expect(engineStateIsParked(state)).toBe(true);
  });

  it('terminal runs are refused before the launcher is ever invoked', async () => {
    launcherMock.launch.mockReset();
    launcherMock.launch.mockResolvedValue({ exitCode: 0, output: 'should not happen' });
    const { status, body } = await postResume(TERMINAL_TASK);
    expect(status).toBe(409);
    expect(body.code).toBe('engine_terminal');
    expect(body.error).toContain('ABANDONED');
    expect(launcherMock.launch).not.toHaveBeenCalled();
  });

  it('an unbound task refuses honestly (no run to resume)', async () => {
    const db = getDb();
    const id = `i19-unbound-${RUN}`;
    insertTask(db, { id, title: 'Unbound deck', status: 'blocked' });
    launcherMock.launch.mockReset();
    const { status, body } = await postResume(id);
    expect(status).toBe(409);
    expect(body.code).toBe('run_unbound');
    expect(launcherMock.launch).not.toHaveBeenCalled();
  });
});
