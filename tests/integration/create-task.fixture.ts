/**
 * Fixture + fixed config for the P2-03 create-task E2E — the regression lock
 * named in the spec: "add a Playwright test that creates a task through the
 * real UI and asserts it appears in Backlog."
 *
 * Stands up a REAL Next dev server (mirrors interview-lock.fixture.ts) against
 * a throwaway DB + workspace so:
 *   1. The interview shell-lock (P0-5/WG-9) is pre-satisfied (interviewComplete
 *      seeded true) — otherwise every page GET 302s to /interview and the board
 *      never renders (see tests/integration/interview-lock.spec.ts).
 *   2. The DB is isolated — never mission-control.db, never a client box.
 *
 * SAFETY: every path resolves INSIDE the repo checkout (test-results/…) —
 * never ~/.openclaw, never the operator's canonical files.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.cwd();

export const E2E_OUT_DIR = path.join(REPO_ROOT, 'test-results', 'create-task');
export const WORKSPACE_DIR = path.join(E2E_OUT_DIR, 'workspace');
export const BUILD_STATE_PATH = path.join(WORKSPACE_DIR, '.workforce-build-state.json');
export const DB_PATH = path.join(E2E_OUT_DIR, 'mission-control.e2e.db');

export const COOKIE_SECRET = 'create-task-e2e-secret-not-for-production';

/** Dedicated port so this suite never collides with the smoke (4000) or
 *  interview-lock (4123) servers. Override with CREATE_TASK_PORT if taken. */
export const PORT = Number(process.env.CREATE_TASK_PORT || 4124);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export function serverEnv(): Record<string, string> {
  return {
    OPENCLAW_WORKSPACE_ROOT: WORKSPACE_DIR,
    MC_INTERVIEW_COOKIE_SECRET: COOKIE_SECRET,
    DATABASE_PATH: DB_PATH,
    PORT: String(PORT),
    // Keep the dev server from trying to reach a real gateway or seed real
    // department content — this suite only needs the board + task-create API.
    OPENCLAW_ROOT: '/nonexistent/openclaw-root-for-tests',
  };
}

export function ensureWorkspace(): void {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

/** Seed the build-state the Node cookie-setter (refreshInterviewGate) reads —
 *  mirrors interview-lock.fixture.ts's writeBuildState(true). */
export function writeCompleteBuildState(): void {
  ensureWorkspace();
  const state = { interviewComplete: true, interviewCompletedAt: new Date().toISOString() };
  fs.writeFileSync(BUILD_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/** Fresh DB + workspace for a clean run (idempotent — safe to call every
 *  local run; CI always starts from a clean checkout anyway). */
export function resetFixture(): void {
  fs.rmSync(E2E_OUT_DIR, { recursive: true, force: true });
  ensureWorkspace();
  writeCompleteBuildState();
}
