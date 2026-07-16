/**
 * U94 (X.2.3) — Requester-stamping completeness, "interview flows" door.
 *
 * The interview surface itself never writes to the `tasks` table (files are
 * the canonical source of truth for interview state — see src/lib/interview/
 * seam.ts); the ONE task-creation surface this repo owns that is reachable
 * as a direct consequence of a client's onboarding interview is the
 * department starter task (`createDepartmentInDbDirect`'s "Welcome to
 * <department>" card, POST /api/departments in CREATE mode with
 * allow_unwired:true — the JS-only fallback this repo ships; the primary
 * path shells out to add-department.sh, which lives in Skill 32, outside
 * this repo's ownership boundary).
 *
 * This drives the REAL POST handler against an isolated temp DB:
 *
 *   A. a resolvable interviewSessionId (owner_id + channel captured on the
 *      interview_sessions mirror row, exactly what
 *      src/lib/jobs/interview-nudge-sweep.ts already reuses for its own
 *      owner re-engagement send) -> the starter task lands with BOTH
 *      requester fields non-null, sourced from that session.
 *   B. no interviewSessionId at all -> starter task requester fields NULL
 *      (a plain operator "add department" — producer/operator path,
 *      correctly excluded from the trust-coverage denominator).
 *   C. an interviewSessionId that does not resolve to any session row ->
 *      same as B (fails safe, never blocks department creation).
 *
 * process.env.HOME is pinned to a nonexistent path around each call so the
 * route's host-script lookup (findAddDepartmentScript(), which reads
 * ${HOME}/.openclaw/skills/32-command-center-setup/scripts/add-department.sh
 * at CALL time) deterministically misses regardless of what is actually
 * installed on the machine running this suite, forcing the allow_unwired
 * JS-only path this unit is testing every run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// ── Isolated DB (set BEFORE @/lib/db / the route module are imported) ───────
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dept-requester-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

const RUN_ID = Math.random().toString(36).slice(2, 10);
const REAL_HOME = process.env.HOME;
const NONEXISTENT_HOME = path.join(os.tmpdir(), `bc-dept-requester-nohome-${RUN_ID}`);

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];

type RouteModule = typeof import('../../src/app/api/departments/route');
let POST: RouteModule['POST'];

type StoreModule = typeof import('../../src/lib/interview/store');
let upsertSession: StoreModule['upsertSession'];

/** Call POST /api/departments with HOME pinned to a path that never resolves
 *  the host add-department.sh script, forcing the allow_unwired JS path. */
async function callCreateDept(payload: Record<string, unknown>): Promise<Response> {
  process.env.HOME = NONEXISTENT_HOME;
  try {
    const req = new NextRequest('http://localhost/api/departments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ create: true, allow_unwired: true, ...payload }),
    });
    return (await POST(req)) as unknown as Response;
  } finally {
    process.env.HOME = REAL_HOME;
  }
}

function starterTaskRow(workspaceId: string): {
  requester_channel: string | null;
  requester_chat_id: string | null;
} | undefined {
  return queryOne<{ requester_channel: string | null; requester_chat_id: string | null }>(
    `SELECT requester_channel, requester_chat_id FROM tasks WHERE workspace_id = ? LIMIT 1`,
    [workspaceId],
  );
}

test.before(async () => {
  const db = (await import('../../src/lib/db')) as DbModule;
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  db.getDb(); // runs the full migration chain (incl. interview_sessions, migration 087) against the temp DB

  const now = new Date().toISOString();
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at)
     VALUES ('default', 'Default', 'default', '{}', ?, ?)`,
    [now, now],
  );

  const route = (await import('../../src/app/api/departments/route')) as RouteModule;
  POST = route.POST;
  const store = (await import('../../src/lib/interview/store')) as StoreModule;
  upsertSession = store.upsertSession;
});

test.after(() => {
  process.env.HOME = REAL_HOME;
  try {
    if (typeof closeDb === 'function') closeDb();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(path.dirname(TMP_DB), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ── A. resolvable interview session → starter task carries BOTH requester fields ──
test('department created with a resolvable interviewSessionId stamps the starter task with the session owner', async () => {
  const sessionId = `sess-dept-a-${RUN_ID}`;
  upsertSession({ id: sessionId, ownerId: '777888999', channel: 'telegram' });

  const slug = `growth-a-${RUN_ID}`;
  const res = await callCreateDept({ name: `Growth A ${RUN_ID}`, slug, interviewSessionId: sessionId });
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { department: { workspace_id: string } };

  const row = starterTaskRow(body.department.workspace_id);
  assert.ok(row, 'starter task must exist');
  assert.equal(row!.requester_chat_id, '777888999', 'starter task must inherit the interview session owner_id');
  assert.equal(row!.requester_channel, 'telegram', 'starter task must inherit the interview session channel');
});

// ── B. no interviewSessionId → starter task requester fields NULL ───────────
test('department created with NO interviewSessionId leaves the starter task requester fields NULL', async () => {
  const slug = `growth-b-${RUN_ID}`;
  const res = await callCreateDept({ name: `Growth B ${RUN_ID}`, slug });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { department: { workspace_id: string } };

  const row = starterTaskRow(body.department.workspace_id);
  assert.ok(row, 'starter task must exist');
  assert.equal(row!.requester_chat_id, null, 'no session => requester_chat_id NULL (operator/producer path)');
  assert.equal(row!.requester_channel, null, 'no session => requester_channel NULL');
});

// ── C. an interviewSessionId that does not resolve → same as B, never blocks ──
test('department created with an UNRESOLVABLE interviewSessionId still succeeds, starter task requester fields NULL', async () => {
  const slug = `growth-c-${RUN_ID}`;
  const res = await callCreateDept({
    name: `Growth C ${RUN_ID}`,
    slug,
    interviewSessionId: `sess-does-not-exist-${RUN_ID}`,
  });
  const bodyText = await res.clone().text();
  assert.equal(res.status, 201, `expected 201, got ${res.status}. Body: ${bodyText}`);
  const body = (await res.json()) as { department: { workspace_id: string } };

  const row = starterTaskRow(body.department.workspace_id);
  assert.ok(row, 'starter task must exist');
  assert.equal(row!.requester_chat_id, null, 'an unresolvable session id must fail safe to NULL, never block creation');
  assert.equal(row!.requester_channel, null);
});
