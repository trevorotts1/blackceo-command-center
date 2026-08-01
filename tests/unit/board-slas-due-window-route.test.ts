/**
 * board-slas-due-window-route.test.ts — MR-44 (fix2) regression lock.
 *
 * The original MR-44 fix registered `dueDateWindowDays` in the board-SLA table
 * (env BOARD_DUE_DATE_WINDOW_DAYS + per-department config/board-slas.json
 * override) and added the prop to MissionQueue, but NOTHING ever read that
 * config and passed it to the board — the knob was dead. fix2 adds the
 * server-side bridge GET /api/settings/board-slas?department=<slug> (read by
 * the client useDueDateWindowDays hook). This suite locks that bridge's
 * resolution contract:
 *
 *   (a) a department with a board-slas.json override resolves ITS window
 *   (b) a department absent from the config resolves the fleet default (7)
 *   (c) no department (cross-department board) resolves the fleet default (7)
 *   (d) an explicit BOARD_DUE_DATE_WINDOW_DAYS env var wins for every department
 *
 * STRATEGY — point BOARD_SLAS_CONFIG_PATH at a throwaway file (BEFORE any
 * module that reads it is imported) and drive the REAL route handler with a
 * real NextRequest. No DB is touched: with BOARD_SLAS_CONFIG_PATH set,
 * loadBoardSlaConfig() reads that file directly and never calls
 * ensureRuntimeConfigFile().
 *
 *   node --import tsx --test tests/unit/board-slas-due-window-route.test.ts
 */

// No global env override at module load — scenario (d) sets it explicitly later.
delete process.env.BOARD_DUE_DATE_WINDOW_DAYS;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

// Point BOARD_SLAS_CONFIG_PATH at a throwaway file with ONE department whose
// "Tasks Due" window is tightened to 3 days, BEFORE the route (and thus
// board-slas.ts) is imported.
const slaConfigPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-due-window-route-')), 'board-slas.json');
fs.writeFileSync(slaConfigPath, JSON.stringify({ 'finance-accounting': { dueDateWindowDays: 3 } }), 'utf-8');
process.env.BOARD_SLAS_CONFIG_PATH = slaConfigPath;

import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../src/app/api/settings/board-slas/route';
import { invalidateBoardSlaConfigCache } from '../../src/lib/board-slas';

invalidateBoardSlaConfigCache();

async function fetchWindow(department?: string): Promise<number> {
  const url = department
    ? `http://localhost/api/settings/board-slas?department=${encodeURIComponent(department)}`
    : 'http://localhost/api/settings/board-slas';
  const res = await GET(new NextRequest(url));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { dueDateWindowDays: number };
  return body.dueDateWindowDays;
}

test.after(() => {
  delete process.env.BOARD_DUE_DATE_WINDOW_DAYS;
  try {
    fs.rmSync(path.dirname(slaConfigPath), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test('MR-44 (a): a department with a board-slas.json override resolves ITS due-date window', async () => {
  assert.equal(await fetchWindow('finance-accounting'), 3);
});

test('MR-44 (b): a department absent from the config resolves the fleet default (7)', async () => {
  assert.equal(await fetchWindow('client-success'), 7);
});

test('MR-44 (c): no department (cross-department /tasks/all board) resolves the fleet default (7)', async () => {
  assert.equal(await fetchWindow(), 7);
});

test('MR-44 (d): an explicit BOARD_DUE_DATE_WINDOW_DAYS env var wins for every department', async () => {
  process.env.BOARD_DUE_DATE_WINDOW_DAYS = '14';
  try {
    // env is read at call-time (numEnvExplicit), so no cache invalidation needed
    assert.equal(await fetchWindow('finance-accounting'), 14, 'env must beat the department override');
    assert.equal(await fetchWindow('client-success'), 14, 'env must beat the fleet default');
    assert.equal(await fetchWindow(), 14, 'env must apply to the global row too');
  } finally {
    delete process.env.BOARD_DUE_DATE_WINDOW_DAYS;
  }
});
