/**
 * PRES-010 — registered run bindings close the first-directory fallback.
 *
 * THE DEFECT (route.ts pre-PRES-010): after the registered-path walk-up and
 * the PROJECTS_PATH probe failed, GET /api/presentations/[taskId]/deliverables
 * scanned every configured run root (PRESENTATION_RUNS_DIRS) and returned the
 * FIRST directory carrying a working/ marker — with NO task/run/company test.
 * Two runs seeded with identical artifact basenames and different GHL links
 * meant task A without any direct run hint surfaced run B's ledger.
 *
 * THE FIX under test:
 *   1. Seeded runs A/B with identical basenames — task A (no direct hint) must
 *      NOT select B. Without a binding the route answers honestly unbound.
 *   2. A foreign symlink whose target sits outside every approved root is
 *      rejected (realpath containment).
 *   3. The correctly mapped run returns the correct URL.
 *   4. Relocation with an updated mapping recovers.
 *   5. Missing ledger shows the honest pending state (ghl_ledger_present false,
 *      no invented links).
 *
 * Drives the REAL GET handler + the REAL registerPresentationRun / POST
 * /api/presentations/runs on an isolated DB. No network. Rollback:
 * PRESENTATION_RUN_BINDINGS=0 restores the pre-PRES-010 first-directory
 * fallback semantics verbatim (documented).
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { getDb } from '../../src/lib/db';
import {
  registerPresentationRun,
  resolveRunDirForTask,
  joinGhlLedger,
} from '../../src/lib/presentation-run-bindings';

let fixtureDir: string;
let rootA: string;
let rootB: string;
let runA: string;
let runB: string;
let taskA: string;
let taskB: string;

function seedWorkspaceTask(tid: string, title: string) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get('presentations')) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run('presentations', 'Presentations', 'presentations', 'Presentation', 10);
  }
  db.prepare("INSERT INTO tasks (id,title,status,priority,workspace_id,department) VALUES (?,?,'backlog','medium','presentations','presentations')")
    .run(tid, title);
}

function seedDeliverable(id: string, tid: string, fp: string) {
  getDb().prepare(
    "INSERT INTO task_deliverables (id,task_id,deliverable_type,title,path,mime_type,file_size_bytes,sha256,created_at) VALUES (?,?,?,?,?,null,null,null,datetime('now'))",
  ).run(id, tid, 'artifact', path.basename(fp), fp);
}

/** A run dir carrying ONLY the media_library ledger marker + one artifact with
 * the IDENTICAL basename in both runs, and DIFFERENT GHL links per run. */
function makeRun(root: string, taskLabel: string, ghlUrl: string, forTask?: string): string {
  const runDir = path.join(root, taskLabel);
  fs.mkdirSync(path.join(runDir, 'working', 'checkpoints'), { recursive: true });
  const fp = path.join(runDir, 'DECK-FINAL.pptx');
  fs.writeFileSync(fp, 'x'.repeat(2_000_000));
  fs.writeFileSync(
    path.join(runDir, 'working', 'checkpoints', 'media_library.json'),
    JSON.stringify({ uploaded: [{ local_path: fp, ghl_url: ghlUrl }] }),
  );
  return runDir;
}

/** The producer registers the built deck as a deliverable row on its card —
 * that row is what the route's GHL join keys on. */
function registerDeckDeliverable(taskId: string, runDir: string, label: string) {
  seedDeliverable(`dlv-${label}`, taskId, path.join(runDir, 'DECK-FINAL.pptx'));
}

async function callDeliverables(tid: string) {
  const { GET } = await import('../../src/app/api/presentations/[taskId]/deliverables/route');
  const res = await GET(
    new NextRequest(`http://localhost/api/presentations/${tid}/deliverables`),
    { params: { taskId: tid } } as unknown as { params: Promise<{ taskId: string }> },
  );
  return res;
}

async function postRegister(body: Record<string, unknown>) {
  const { POST } = await import('../../src/app/api/presentations/runs/route');
  const req = new NextRequest('http://localhost/api/presentations/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(req);
}

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pres010-'));
  process.env.HOME = fixtureDir;
  delete process.env.PRESENTATION_RUNS_DIRS;
  process.env.PROJECTS_PATH = path.join(fixtureDir, 'projects');
  fs.mkdirSync(path.join(fixtureDir, 'projects', 'artifacts'), { recursive: true });
  // Two approved roots, each seeding one run with IDENTICAL artifact basenames
  // but DIFFERENT GHL links (the exact QC seed).
  rootA = path.join(fixtureDir, 'roots-a');
  rootB = path.join(fixtureDir, 'roots-b');
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  process.env.PRESENTATION_RUNS_DIRS = `${rootA}:${rootB}`;
  taskA = 'pres010-task-a';
  taskB = 'pres010-task-b';
  seedWorkspaceTask(taskA, 'Run A deck');
  seedWorkspaceTask(taskB, 'Run B deck');
  runA = makeRun(rootA, 'run-a', 'https://ghl.example.com/run-a/deck');
  runB = makeRun(rootB, 'run-b', 'https://ghl.example.com/run-b/deck');
});

afterAll(() => {
  delete process.env.PRESENTATION_RUN_BINDINGS;
  delete process.env.PRESENTATION_RUNS_DIRS;
  try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('PRES-010 run bindings — the seeded A/B acceptance', () => {
  it('task A with NO direct run hint never selects run B — unbound is honest', async () => {
    // TRUE no-hint shape: no deliverable rows carrying a path and no binding
    // registered — the legacy route would have returned whichever run dir
    // sorted first across the configured roots. The bound route must answer
    // unbound and never report a foreign ghl_ledger_present.
    getDb().prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(taskA);
    const res = await callDeliverables(taskA);
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.ghl_ledger_present).toBe(false);
    for (const r of b.rows) expect(r.ghl_url).toBeNull();
    expect(b.run_resolution.kind).toBe('unbound');
    expect(b.run_resolution.reason).toBe('no-binding');
    expect(b.run_resolution.remediation).toContain('register');
  });

  it('correct mapping returns the correct URL (A reads A, B reads B)', async () => {
    registerDeckDeliverable(taskA, runA, 'run-a');
    registerDeckDeliverable(taskB, runB, 'run-b');
    const regA = await postRegister({ task_id: taskA, run_root: runA, run_id: 'pj-a' });
    expect(regA.status).toBe(201);
    const regB = await postRegister({ task_id: taskB, run_root: runB, run_id: 'pj-b' });
    expect(regB.status).toBe(201);

    const bA = await (await callDeliverables(taskA)).json();
    expect(bA.ghl_ledger_present).toBe(true);
    expect(bA.run_resolution.kind).toBe('bound');
    const row = bA.rows.find((r: { key: string; ghl_url: string | null }) => r.key === 'deck_pptx');
    expect(row?.ghl_url).toBe('https://ghl.example.com/run-a/deck');

    const bB = await (await callDeliverables(taskB)).json();
    expect(bB.ghl_ledger_present).toBe(true);
    const rowB = bB.rows.find((r: { key: string; ghl_url: string | null }) => r.key === 'deck_pptx');
    expect(rowB?.ghl_url).toBe('https://ghl.example.com/run-b/deck');
  });

  it('registration of a root outside every approved run root is refused', async () => {
    const outside = path.join(fixtureDir, 'outside', 'run');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'working'), 'x');
    const res = await postRegister({ task_id: taskA, run_root: outside });
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.code).toBe('outside_approved_roots');
  });

  it('foreign symlink rejected: a bound root resolving OUTSIDE every approved root is unavailable', () => {
    const victim = path.join(fixtureDir, 'victim');
    fs.mkdirSync(path.join(victim, 'working'), { recursive: true });
    const link = path.join(rootA, 'symlinked-run');
    try { fs.unlinkSync(link); } catch { /* not there */ }
    fs.symlinkSync(victim, link);
    // Registration refuses the foreign target outright.
    const reg = registerPresentationRun({ taskId: taskA, runRoot: link });
    expect(reg.ok).toBe(false);
    expect(reg.code === 'outside_approved_roots' || reg.code === 'run_root_missing').toBe(true);
    // Defense-in-depth at the READ side: a binding row that was seeded (as by a
    // legacy producer) pointing at the foreign symlink must NOT resolve bound.
    getDb().prepare('DELETE FROM presentation_run_bindings WHERE task_id = ?').run(taskB);
    getDb().prepare(
      "INSERT INTO presentation_run_bindings (id, task_id, company_id, presentation_id, run_id, run_root, registered_by, registered_at, updated_at) VALUES ('prb-fake-1', ?, null, null, 'pj-fake', ?, 'test', datetime('now'), datetime('now'))",
    ).run(taskB, link);
    const resolution = resolveRunDirForTask(taskB);
    if (resolution.kind !== 'bound') {
      expect(['unavailable', 'unbound']).toContain(resolution.kind);
    } else {
      // On macOS the /tmp ancestor symlink can canonicalize the victim INTO an
      // approved root only if the victim itself sits inside one — it does not,
      // so reaching here would be a real containment failure.
      throw new Error('foreign symlink resolved as bound — containment failed');
    }
    getDb().prepare("DELETE FROM presentation_run_bindings WHERE id = 'prb-fake-1'").run();
  });

  it('double registration of the identical tuple is idempotent', async () => {
    const reg1 = await postRegister({ task_id: taskA, run_root: runA, run_id: 'pj-a' });
    expect([200, 201]).toContain(reg1.status);
    const reg2 = await postRegister({ task_id: taskA, run_root: runA, run_id: 'pj-a' });
    expect(reg2.status).toBe(200);
    const j = await reg2.json();
    expect(j.idempotent).toBe(true);
  });

  it('relocation with an updated mapping recovers', async () => {
    // Move run A's content to a new location inside the same approved root and
    // re-register. The binding-first read must follow the NEW mapping.
    fs.rmSync(runA, { recursive: true, force: true });
    // The producer re-registers its deliverables at the new location; the old
    // row (pointing at the removed dir) is gone from the card.
    getDb().prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(taskA);
    const runA2 = makeRun(rootA, 'run-a-moved', 'https://ghl.example.com/run-a-moved/deck');
    registerDeckDeliverable(taskA, runA2, 'run-a-moved');
    const reg = await postRegister({ task_id: taskA, run_root: runA2, run_id: 'pj-a' });
    expect(reg.status).toBe(201);
    const b = await (await callDeliverables(taskA)).json();
    expect(b.ghl_ledger_present).toBe(true);
    const row = b.rows.find((r: { key: string; ghl_url: string | null }) => r.key === 'deck_pptx');
    expect(row?.ghl_url).toBe('https://ghl.example.com/run-a-moved/deck');
  });

  it('missing ledger on a BOUND run shows the honest pending state', async () => {
    const taskBare = 'pres010-task-bare';
    seedWorkspaceTask(taskBare, 'Bare run deck');
    const bare = path.join(rootA, 'bare-run');
    fs.mkdirSync(path.join(bare, 'working'), { recursive: true });
    const reg = await postRegister({ task_id: taskBare, run_root: bare, run_id: 'pj-bare' });
    expect(reg.status).toBe(201);
    const b = await (await callDeliverables(taskBare)).json();
    expect(b.ghl_ledger_present).toBe(false);
    for (const r of b.rows) expect(r.ghl_url).toBeNull();
    expect(b.run_resolution.kind).toBe('bound');
  });

  it('stale root (run dir removed) is unavailable with a recovery instruction', async () => {
    const taskDoomed = 'pres010-task-doomed';
    seedWorkspaceTask(taskDoomed, 'Doomed run deck');
    const doomed = path.join(rootA, 'doomed-run');
    fs.mkdirSync(path.join(doomed, 'working'), { recursive: true });
    const reg = await postRegister({ task_id: taskDoomed, run_root: doomed, run_id: 'pj-doomed' });
    expect(reg.status).toBe(201);
    fs.rmSync(doomed, { recursive: true, force: true });
    const b = await (await callDeliverables(taskDoomed)).json();
    expect(b.ghl_ledger_present).toBe(false);
    expect(b.run_resolution.kind).toBe('unavailable');
    expect(b.run_resolution.reason).toBe('stale-root');
    expect(b.run_resolution.remediation).toContain('Re-register');
  });

  it('ledger record whose local_path resolves OUTSIDE the bound run dir contributes no links', () => {
    // The identity join: run B's ledger carries a local_path that lives under
    // run B; joining it against run A's bound dir must produce nothing.
    const foreignRecs = [{ local_path: path.join(runB, 'DECK-FINAL.pptx'), ghl_url: 'https://ghl.example.com/run-b/deck' }];
    const joined = joinGhlLedger(runA, foreignRecs);
    expect(joined.size).toBe(0);
  });
});

describe('PRES-010 rollback flag (PRESENTATION_RUN_BINDINGS=0)', () => {
  it('flag=0 restores the pre-PRES-010 first-directory fallback verbatim', async () => {
    // Task A has no binding here (deleted below) and no deliverable-path hint
    // under the binding regime → unbound. With the rollback flag set, the SAME
    // request resolves through the legacy first-directory scan (run-a sorts
    // first in rootA) — the documented pre-PRES-010 semantics, restored.
    getDb().prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(taskA);
    getDb().prepare('DELETE FROM presentation_run_bindings WHERE task_id = ?').run(taskA);
    const unbound = resolveRunDirForTask(taskA);
    expect(unbound.kind).toBe('unbound');

    process.env.PRESENTATION_RUN_BINDINGS = '0';
    try {
      const rolled = resolveRunDirForTask(taskA);
      expect(rolled.kind).toBe('bound');
      if (rolled.kind === 'bound') {
        // Verbatim legacy semantics: the FIRST directory under any configured
        // root that carries a workdir marker wins — no task/run/company test.
        // (Which directory sorts first is filesystem order; the defect shape is
        // that SOME run dir is returned without any binding identity.)
        const underRootA = rolled.runDir.startsWith(rootA + path.sep) || rolled.runDir === rootA;
        const underRootB = rolled.runDir.startsWith(rootB + path.sep) || rolled.runDir === rootB;
        expect(underRootA || underRootB).toBe(true);
        expect(
          fs.existsSync(path.join(rolled.runDir, 'working')) ||
          fs.existsSync(path.join(rolled.runDir, 'media_library.json')) ||
          fs.existsSync(path.join(rolled.runDir, 'working', 'checkpoints', 'media_library.json')),
        ).toBe(true);
      }
    } finally {
      delete process.env.PRESENTATION_RUN_BINDINGS;
    }
  });

  it('route-level rollback resolves a run dir (verbatim legacy semantics)', async () => {
    process.env.PRESENTATION_RUN_BINDINGS = '0';
    try {
      getDb().prepare('DELETE FROM presentation_run_bindings WHERE task_id = ?').run(taskB);
      getDb().prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(taskB);
      const b = await (await callDeliverables(taskB)).json();
      // Rollback restores the LEGACY behavior including its defect shape: a
      // run dir IS selected from the root scan (no binding test) — proving the
      // flag is wired into the route's resolver, not dead code.
      expect(b.run_resolution.kind).toBe('bound');
      expect(b.run_resolution.source).toBe('registry');
    } finally {
      delete process.env.PRESENTATION_RUN_BINDINGS;
    }
  });
});

describe('PRES-010 runs-route company scope', () => {
  it('POST refuses a task whose workspace belongs to another company', async () => {
    // Seed a foreign company + workspace + task, then scope the caller to a
    // DIFFERENT active company: the registration must 404 like a missing task.
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('comp-foreign', 'Foreign Co', 'foreign-co')").run();
    db.prepare("INSERT OR IGNORE INTO companies (id, name, slug) VALUES ('comp-active', 'Active Co', 'active-co')").run();
    db.prepare("INSERT OR IGNORE INTO workspaces (id, name, slug, icon, sort_order, company_id) VALUES ('ws-foreign', 'Foreign WS', 'foreign-ws', 'X', 99, 'comp-foreign')").run();
    db.prepare("INSERT OR IGNORE INTO tasks (id,title,status,priority,workspace_id,department) VALUES ('pres010-task-foreign','Foreign deck','backlog','medium','ws-foreign','presentations')").run();
    db.prepare("DELETE FROM presentation_run_bindings WHERE task_id = 'pres010-task-foreign'").run();

    process.env.COMPANY_SLUG = 'active-co';
    try {
      const res = await postRegister({ task_id: 'pres010-task-foreign', run_root: runA });
      expect(res.status).toBe(404);
      // The binding must NOT have been minted.
      const rows = db.prepare("SELECT COUNT(*) AS n FROM presentation_run_bindings WHERE task_id = 'pres010-task-foreign'").get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      delete process.env.COMPANY_SLUG;
    }
  });

  it('POST allows a task in the caller’s own scope (NULL workspace = box’s own)', async () => {
    const db = getDb();
    db.prepare("INSERT OR IGNORE INTO tasks (id,title,status,priority,workspace_id,department) VALUES ('pres010-task-nullws','Own deck','backlog','medium',NULL,'presentations')").run();
    const ownRun = path.join(rootA, 'own-scope-run');
    fs.mkdirSync(path.join(ownRun, 'working'), { recursive: true });
    process.env.COMPANY_SLUG = 'active-co';
    try {
      const res = await postRegister({ task_id: 'pres010-task-nullws', run_root: ownRun });
      expect([200, 201]).toContain(res.status);
    } finally {
      delete process.env.COMPANY_SLUG;
      db.prepare("DELETE FROM presentation_run_bindings WHERE task_id = 'pres010-task-nullws'").run();
    }
  });

  it('GET binding history refuses a foreign-scope task the same way', async () => {
    const { GET } = await import('../../src/app/api/presentations/runs/route');
    process.env.COMPANY_SLUG = 'active-co';
    try {
      const res = await GET(
        new NextRequest('http://localhost/api/presentations/runs?task_id=pres010-task-foreign'),
      );
      expect(res.status).toBe(404);
    } finally {
      delete process.env.COMPANY_SLUG;
    }
  });
});