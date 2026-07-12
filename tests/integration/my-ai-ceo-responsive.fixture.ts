/**
 * Fixture + fixed config for the P5-01 (c) steps 3-4 + (e) responsive-proof
 * E2E. Mirrors create-task.fixture.ts / interview-lock.fixture.ts: stands up
 * a REAL Next dev server against a throwaway DB + workspace so the chat,
 * board, and TaskModal can be screenshotted at 360/768/1280 against the REAL
 * UI — not skipped when nothing happens to be listening on :4000.
 *
 * SAFETY: every path resolves INSIDE the repo checkout (test-results/…) —
 * never ~/.openclaw, never the operator's canonical files.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.cwd();

export const E2E_OUT_DIR = path.join(REPO_ROOT, 'test-results', 'my-ai-ceo-responsive');
export const WORKSPACE_DIR = path.join(E2E_OUT_DIR, 'workspace');
export const BUILD_STATE_PATH = path.join(WORKSPACE_DIR, '.workforce-build-state.json');
export const DB_PATH = path.join(E2E_OUT_DIR, 'mission-control.e2e.db');

export const COOKIE_SECRET = 'my-ai-ceo-responsive-e2e-secret-not-for-production';

/** Dedicated port so this suite never collides with the smoke (4000),
 *  interview-lock (4123), or create-task (4124) servers. Override with
 *  MY_AI_CEO_RESPONSIVE_PORT if 4125 is taken. */
export const PORT = Number(process.env.MY_AI_CEO_RESPONSIVE_PORT || 4125);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Committed (non-gitignored) home for the actual proof artifacts — the
 *  screenshots and the violation catalog. test-results/ is gitignored
 *  (throwaway per-run output), so the proof this finding requires lives
 *  under tests/ instead and gets checked in. */
export const PROOF_DIR = path.join(REPO_ROOT, 'tests', 'integration', '__screenshots__', 'my-ai-ceo-responsive');

export function serverEnv(): Record<string, string> {
  return {
    OPENCLAW_WORKSPACE_ROOT: WORKSPACE_DIR,
    MC_INTERVIEW_COOKIE_SECRET: COOKIE_SECRET,
    DATABASE_PATH: DB_PATH,
    PORT: String(PORT),
    // Keep the dev server from trying to reach a real gateway or seed real
    // department content — this suite only needs the board, TaskModal, and
    // the My AI CEO chat shell to render.
    OPENCLAW_ROOT: '/nonexistent/openclaw-root-for-tests',
  };
}

export function ensureWorkspace(): void {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(PROOF_DIR, { recursive: true });
}

/** Seed the build-state the Node cookie-setter (refreshInterviewGate) reads —
 *  mirrors interview-lock.fixture.ts's writeBuildState(true). Without this
 *  every page (including /my-ai-ceo and /tasks/all) 302s to /interview and
 *  there is nothing to screenshot. */
export function writeCompleteBuildState(): void {
  ensureWorkspace();
  const state = { interviewComplete: true, interviewCompletedAt: new Date().toISOString() };
  fs.writeFileSync(BUILD_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/** Fresh DB + workspace for a clean run (idempotent — safe to call every
 *  local run; CI always starts from a clean checkout anyway). Leaves PROOF_DIR
 *  alone — that directory holds the committed screenshots/catalog, which this
 *  run is about to overwrite with fresh ones, not delete out from under itself
 *  before the report is written. */
export function resetFixture(): void {
  fs.rmSync(E2E_OUT_DIR, { recursive: true, force: true });
  ensureWorkspace();
  writeCompleteBuildState();
}
