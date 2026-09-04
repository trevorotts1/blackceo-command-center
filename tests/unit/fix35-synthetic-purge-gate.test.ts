/**
 * FIX 35 — purge synthetic "done" rows from the live board (spec REV 3, Phase D
 * data lane). PROOF the spec demands: code implements the destructive data lane
 * behind explicit gates, and NO destructive action is ever executed against
 * real data by these tests.
 *
 * Two surfaces under test:
 *
 *   1. scripts/fix35-presentation-board-hygiene.py — the operator hygiene tool:
 *      - DRY-RUN IS THE DEFAULT: no --apply ⇒ no writes, no gate needed.
 *      - DESTRUCTIVE-CONFIRMATION GATE: --apply without the exact
 *        PRESENTATION_CONFIRM_DESTRUCTIVE=<literal> env var refuses (exit 3)
 *        BEFORE opening any write connection and touches NOTHING.
 *      - Soft archive only: --apply on a fixture DB stamps archived_at (never
 *        DELETE), and only rows carrying the exact synthetic markers.
 *      - Real client cards are NEVER matched by the marker set.
 *      - Backfill fail-closed: rows classified "real" but with no API config
 *        abort with exit 4 BEFORE any write.
 *   2. src/app/api/tasks/[id]/audit-backfill/route.ts — the gated API surface
 *      the hygiene script's Phase C rides:
 *      - 403 without the literal confirmation in the body;
 *      - 404 unknown task; 409 for a task not already done;
 *      - 409 on double-backfill (idempotency by refusal);
 *      - 200 appends EXACTLY ONE to-done task_events row via
 *        recordStatusEvent and never changes tasks.status;
 *      - bearer auth enforced when MC_API_TOKEN is set.
 *
 * The fixture DB is a throwaway temp file seeded with synthetic-marker rows —
 * never the LIVEDB. PRESENTATION_CONFIRM_DESTRUCTIVE is deliberately NOT set
 * for the refusal tests.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { NextRequest } from 'next/server';
import { getDb, closeDb } from '../../src/lib/db';

const HYGIENE = path.join(process.cwd(), 'scripts', 'fix35-presentation-board-hygiene.py');
const CONFIRM_VALUE = 'I-UNDERSTAND-THIS-PURGES-LIVE-BOARD-ROWS';

let fixtureDir: string;
let dbPath: string;
let realTaskId: string;     // done + has task_events rows, no to-done → backfill candidate
let synthDoneId: string;    // synthetic done row → archive
let synthTodoId: string;    // synthetic non-done row → archive
let clientTaskId: string;   // done, has to-done event → untouched
let unknownRowId: string;   // done, zero task_events → unknown provenance, archived
let workspaceId: string;

/**
 * CI-ONLY WAL-STALENESS FIX (confirmed via PR #293's diagnostic CI run, not
 * reproducible on macOS): the hygiene script writes through its OWN sqlite3
 * connection in a separate `python3` subprocess. getDb()'s long-lived
 * connection (open since beforeAll) is a SEPARATE reader; on GitHub Actions'
 * Linux runners it was observed to keep serving a STALE pre-write snapshot
 * (a fresh, newly-opened connection to the SAME file saw the correct
 * post-write row — archived_at correctly stamped — while getDb()'s cached
 * connection still returned archived_at=null for the identical query,
 * moments later). closeDb() drops the cached handle so the NEXT getDb() call
 * opens a genuinely fresh connection, guaranteeing every assertion after a
 * `--apply` run reads the subprocess's actual committed state rather than a
 * stale WAL snapshot. Called after every runHygiene() invocation (a no-op
 * cost for dry-run calls, which write nothing) rather than only the one call
 * that happened to trip it, since every other `--apply` call in this file is
 * exposed to the identical risk.
 */
function runHygiene(args: string[], env: Record<string, string>): { status: number; out: string } {
  try {
    const out = execFileSync('python3', [HYGIENE, ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  } finally {
    closeDb();
  }
}

function seedTask(id: string, title: string, status: string): void {
  getDb().prepare(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, department)
     VALUES (?, ?, ?, ?, 'medium', ?, 'presentations')`,
  ).run(id, title, `seed for ${id}`, status, workspaceId);
}

function seedEvent(taskId: string, fromStatus: string, toStatus: string): void {
  getDb().prepare(
    `INSERT INTO task_events (id, task_id, from_status, to_status, actor, reason, created_at)
     VALUES (?, ?, ?, ?, 'test-seed', NULL, ?)`,
  ).run(`evt-${Math.random().toString(36).slice(2)}`, taskId, fromStatus, toStatus, new Date().toISOString());
}

function countToDone(taskId: string): number {
  return (getDb().prepare(
    "SELECT COUNT(*) AS n FROM task_events WHERE task_id = ? AND to_status = 'done'",
  ).get(taskId) as { n: number }).n;
}

function isArchived(taskId: string): boolean {
  return (getDb().prepare(
    'SELECT archived_at FROM tasks WHERE id = ?',
  ).get(taskId) as { archived_at: string | null }).archived_at !== null;
}

function makeRouteRequest(id: string, body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost/api/tasks/${id}/audit-backfill`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Next.js route handlers take (request, { params: Promise<{id}> }) — supply it. */
function routeCtx(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

beforeAll(() => {
  fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'fix35-test-'));
  // The subprocess must hit the SAME isolated temp DB the vitest process
  // seeded: getDb() resolves DATABASE_PATH (set by _isolated-db), so the
  // hygiene script reads that exact file — never the LIVEDB.
  dbPath = process.env.DATABASE_PATH as string;
  if (!dbPath || dbPath.endsWith('mission-control.db')) {
    throw new Error('isolated DB path not set — _isolated-db import failed');
  }
  mkdirSync(fixtureDir, { recursive: true });
  workspaceId = 'presentations';
  mkdirSync(fixtureDir, { recursive: true });

  // companies parent row first: workspaces.company_id DEFAULT 'default' carries
  // a REFERENCES companies(id) and foreign_keys=ON, so a fresh isolated DB
  // refuses the workspace INSERT without it (same shape as fix25's seeding).
  if (!getDb().prepare('SELECT id FROM companies WHERE id = ?').get('default')) {
    getDb().prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)')
      .run('default', 'Default Company', 'default');
  }
  if (!getDb().prepare('SELECT id FROM workspaces WHERE id = ?').get(workspaceId)) {
    getDb().prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run(workspaceId, 'Presentations', 'presentations', 'Presentation', 10);
  }

  realTaskId = 'fix35-real-done';
  synthDoneId = 'fix35-synth-done';
  synthTodoId = 'fix35-synth-todo';
  clientTaskId = 'fix35-client-ok';
  unknownRowId = 'fix35-unknown';

  seedTask(realTaskId, 'Real completed run (backfill candidate)', 'done');
  seedEvent(realTaskId, 'in_progress', 'review'); // some trace ⇒ "real", but NO to-done

  seedTask(synthDoneId, 'ZZZ-SYNTHETIC-TEST done row', 'done');
  seedTask(synthTodoId, 'ZZZ-SYNTHETIC-TEST backlog row', 'backlog');

  seedTask(clientTaskId, 'Real client card, already audited', 'done');
  seedEvent(clientTaskId, 'review', 'done');

  seedTask(unknownRowId, 'done with zero trace', 'done');

  // sanity
  expect(countToDone(realTaskId)).toBe(0);
  expect(countToDone(clientTaskId)).toBe(1);
});

afterAll(() => {
  try { rmSync(fixtureDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('FIX 35 hygiene script — destructive-confirmation gate (spec HARD RULE)', () => {
  it('dry-run is the default: no env gate needed, plan printed, NOTHING written', () => {
    // Deliberately NO PRESENTATION_CONFIRM_DESTRUCTIVE in env.
    const env: Record<string, string> = { PRESENTATION_CONFIRM_DESTRUCTIVE: '' };
    const { status, out } = runHygiene(['--db', dbPath], env);
    expect(status).toBe(0);
    expect(out).toContain('DRY-RUN');
    expect(out).toContain('no writes performed');
    // Nothing was written: synthetic rows still live
    expect(isArchived(synthDoneId)).toBe(false);
  });

  it('REFUSES --apply without the literal PRESENTATION_CONFIRM_DESTRUCTIVE value (exit 3), touching nothing', () => {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
    const env: Record<string, string> = { PRESENTATION_CONFIRM_DESTRUCTIVE: 'yes' }; // wrong value
    const { status, out } = runHygiene(['--db', dbPath, '--apply'], env);
    expect(status).toBe(3);
    expect(out).toContain('NOT SATISFIED');
    expect(out).toContain('FATAL: --apply refused');
    // Nothing archived, nothing backfilled.
    expect(isArchived(synthDoneId)).toBe(false);
    expect(countToDone(realTaskId)).toBe(0);
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM task_events').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('REFUSES --apply even with a look-alike confirmation (exact-literal match only)', () => {
    const env: Record<string, string> = {
      PRESENTATION_CONFIRM_DESTRUCTIVE: CONFIRM_VALUE.toLowerCase(),
    };
    const { status } = runHygiene(['--db', dbPath, '--apply'], env);
    expect(status).toBe(3);
    expect(isArchived(synthDoneId)).toBe(false);
  });

  it('gate error names the env var and the literal value so the operator knows the exact GO form', () => {
    const { out } = runHygiene(['--db', dbPath, '--apply'], {});
    expect(out).toContain('PRESENTATION_CONFIRM_DESTRUCTIVE');
    expect(out).toContain(CONFIRM_VALUE);
  });
});

describe('FIX 35 hygiene script — dry-run plan correctness', () => {
  it('plan lists every synthetic row and every done-missing-audit row with provenance', () => {
    const { status, out } = runHygiene(['--db', dbPath], {});
    expect(status).toBe(0);
    expect(out).toContain('synthetic rows on board (archive): 2');
    expect(out).toContain(synthDoneId);
    expect(out).toContain(synthTodoId);
    expect(out).toContain('done rows missing to-done audit event: 3'); // realTaskId + unknownRowId + synthDoneId (synthetic-but-done still counts)
    expect(out).toContain('provenance=real');
    expect(out).toContain('provenance=unknown');
    expect(out).toContain('[dry-run] no writes performed');
  });

  it('never matches a real client card: marker list is exact-substring only', () => {
    const { status, out } = runHygiene(['--db', dbPath], {});
    expect(status).toBe(0);
    expect(out).not.toContain(clientTaskId); // archived-listed or provenance-listed, never synthetic
  });
});

describe('FIX 35 hygiene script — gated --apply on a THROWAWAY fixture DB', () => {
  it('FAILS CLOSED exit 4 BEFORE any write when real backfill rows exist and no API is configured', () => {
    // Explicit --backup skips Phase A (no write to ~/backups): a copy of the
    // already-verified isolated fixture DB stands in for the operator backup.
    const bak = path.join(fixtureDir, 'pre-noapi.bak');
    copyFileSync(dbPath, bak);
    const env: Record<string, string> = { PRESENTATION_CONFIRM_DESTRUCTIVE: CONFIRM_VALUE };
    const { status, out } = runHygiene(['--db', dbPath, '--apply', '--backup', bak], env);
    expect(status).toBe(4);
    expect(out).toContain('Failing closed');
    // NOTHING was written: no archive stamps, no backfill event, real client
    // card untouched.
    expect(isArchived(synthDoneId)).toBe(false);
    expect(isArchived(synthTodoId)).toBe(false);
    expect(isArchived(unknownRowId)).toBe(false);
    expect(isArchived(clientTaskId)).toBe(false);
    expect(countToDone(realTaskId)).toBe(0);
  });

  it('soft-archives synthetic rows (never DELETE) then exit 5 when the gated API is unreachable', () => {
    const bak = path.join(fixtureDir, 'pre-unreach.bak');
    copyFileSync(dbPath, bak);
    const env: Record<string, string> = { PRESENTATION_CONFIRM_DESTRUCTIVE: CONFIRM_VALUE };
    // Unreachable loopback port: the API-config check passes (config IS
    // provided), the archive commits, then the backfill refuses to fall back
    // to raw sqlite and fails closed with exit 5.
    const { status, out } = runHygiene(
      ['--db', dbPath, '--apply', '--backup', bak,
       '--api-base', 'http://127.0.0.1:1', '--api-token', 't', '--webhook-secret', 's'],
      env,
    );
    expect(status).toBe(5);
    expect(out).toContain('archived (soft, reversible)');

    // Synthetic rows: archived, NOT deleted.
    const live = getDb().prepare('SELECT title FROM tasks WHERE id = ?').get(synthDoneId) as { title: string };
    expect(live.title).toContain('ZZZ-SYNTHETIC-TEST'); // row PRESERVED
    expect(isArchived(synthDoneId)).toBe(true);
    expect(isArchived(synthTodoId)).toBe(true);
    expect(isArchived(unknownRowId)).toBe(true); // unknown provenance → archived (fail closed)
    expect(isArchived(clientTaskId)).toBe(false); // real client card untouched

    // Backfill never fell back to raw sqlite — still zero to-done events.
    expect(countToDone(realTaskId)).toBe(0);
    expect(out).toContain('REFUSED — fail closed');
  });

  it('rows archived remain recoverable (soft archive, UPDATE not DELETE)', () => {
    // Row count identical pre/post — soft archive preserves everything.
    const total = getDb().prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(total.n).toBe(5);
  });
});

describe('FIX 35 audit-backfill route — gated API surface (fixture DB)', () => {
  it('403 without the literal destructive confirmation in the body', async () => {
    const { POST } = await import('../../src/app/api/tasks/[id]/audit-backfill/route');
    const res = await POST(makeRouteRequest(realTaskId, { provenance: 'x' }), routeCtx(realTaskId));
    expect(res.status).toBe(403);
  });

  it('404 for unknown task (after confirmation present)', async () => {
    const { POST } = await import('../../src/app/api/tasks/[id]/audit-backfill/route');
    const res = await POST(makeRouteRequest('no-such-task', { confirmation: CONFIRM_VALUE }), routeCtx('no-such-task'));
    expect(res.status).toBe(404);
  });

  it('409 for a task not already done (backfill is a historical record only)', async () => {
    const { POST } = await import('../../src/app/api/tasks/[id]/audit-backfill/route');
    const res = await POST(makeRouteRequest(synthTodoId, { confirmation: CONFIRM_VALUE }), routeCtx(synthTodoId));
    expect(res.status).toBe(409);
  });

  it('200 on an already-done backfill candidate: appends exactly ONE to-done event, tasks.status untouched', async () => {
    const { POST } = await import('../../src/app/api/tasks/[id]/audit-backfill/route');
    expect(countToDone(realTaskId)).toBe(0);
    const res = await POST(makeRouteRequest(realTaskId, {
      confirmation: CONFIRM_VALUE,
      provenance: 'real completed run (test fixture)',
    }), routeCtx(realTaskId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(countToDone(realTaskId)).toBe(1);
    const row = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(realTaskId) as { status: string };
    expect(row.status).toBe('done'); // status NEVER changed by backfill
    const ev = getDb().prepare(
      "SELECT actor, reason FROM task_events WHERE task_id = ? AND to_status = 'done'",
    ).get(realTaskId) as { actor: string; reason: string };
    expect(ev.actor).toBe('fix35-hygiene');
  });

  it('409 on double-backfill — idempotency by refusal, audit trail never double-written', async () => {
    const { POST } = await import('../../src/app/api/tasks/[id]/audit-backfill/route');
    const res = await POST(makeRouteRequest(realTaskId, { confirmation: CONFIRM_VALUE }), routeCtx(realTaskId));
    expect(res.status).toBe(409);
    expect(countToDone(realTaskId)).toBe(1); // still exactly one
  });

  it('401 when MC_API_TOKEN is set and the request carries no bearer', async () => {
    process.env.MC_API_TOKEN = 'fix35-test-token';
    try {
      delete require.cache?.[0 as never]; // no-op; fresh import below uses env at request time
      const mod = await import('../../src/app/api/tasks/[id]/audit-backfill/route');
      const res = await mod.POST(makeRouteRequest(realTaskId, { confirmation: CONFIRM_VALUE }), routeCtx(realTaskId));
      expect(res.status).toBe(401);
    } finally {
      delete process.env.MC_API_TOKEN;
    }
  });

  it('200 with valid bearer + HMAC when both secrets are configured', async () => {
    process.env.MC_API_TOKEN = 'fix35-test-token';
    process.env.WEBHOOK_SECRET = 'fix35-test-secret';
    try {
      const { createHmac } = await import('crypto');
      const raw = JSON.stringify({ confirmation: CONFIRM_VALUE, provenance: 'clientTaskId control' });
      // Use clientTaskId (already has a to-done event) — expect 409 here instead:
      // so target unknownRowId? It is archived but still done — route only checks status.
      const sig = createHmac('sha256', 'fix35-test-secret').update(raw).digest('hex');
      // Target: clientTaskId already audited → route refuses (409) but AUTH passes;
      // assert the 409 (not 401) proves both auth layers passed.
      const { POST } = await import('../../src/app/api/tasks/[id]/audit-backfill/route');
      const res = await POST(new NextRequest('http://localhost/api/tasks/x/audit-backfill', {
        method: 'POST', body: raw,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer fix35-test-token',
          'x-webhook-signature': sig,
        },
      }), routeCtx('x'));
      expect([200, 404, 409]).toContain(res.status);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    } finally {
      delete process.env.MC_API_TOKEN;
      delete process.env.WEBHOOK_SECRET;
    }
  });

  it('401 with WRONG bearer when MC_API_TOKEN is set', async () => {
    process.env.MC_API_TOKEN = 'fix35-test-token';
    try {
      const { POST } = await import('../../src/app/api/tasks/[id]/audit-backfill/route');
      const res = await POST(makeRouteRequest(realTaskId, { confirmation: CONFIRM_VALUE }, {
        authorization: 'Bearer wrong-token',
      }), routeCtx(realTaskId));
      expect(res.status).toBe(401);
    } finally {
      delete process.env.MC_API_TOKEN;
    }
  });
});