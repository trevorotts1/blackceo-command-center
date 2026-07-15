/**
 * Fixture + fixed config for the U58 agent-navigation E2E — the click-through
 * proof the QC fix-loop demanded for BINARY acceptance (5): "ActiveAgentsStrip
 * and department-agents rows navigate to the correct agent detail page
 * (Playwright click-through)."
 *
 * Mirrors create-task.fixture.ts's pattern exactly: stands up a REAL Next dev
 * server against a throwaway DB + workspace, with the interview shell-lock
 * pre-satisfied, so the click-through is proven against the REAL UI + REAL
 * routing — not a mock.
 *
 * SAFETY: every path resolves INSIDE the repo checkout (test-results/…) —
 * never ~/.openclaw, never the operator's canonical files, never a client box.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.cwd();

export const E2E_OUT_DIR = path.join(REPO_ROOT, 'test-results', 'agent-navigation');
export const WORKSPACE_DIR = path.join(E2E_OUT_DIR, 'workspace');
export const BUILD_STATE_PATH = path.join(WORKSPACE_DIR, '.workforce-build-state.json');
export const DB_PATH = path.join(E2E_OUT_DIR, 'mission-control.e2e.db');

export const COOKIE_SECRET = 'agent-navigation-e2e-secret-not-for-production';

/** Dedicated port so this suite never collides with the smoke (4000),
 *  interview-lock (4123), create-task (4124), or my-ai-ceo-responsive (4125)
 *  servers. Override with AGENT_NAV_PORT if 4126 is taken. */
export const PORT = Number(process.env.AGENT_NAV_PORT || 4126);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export function serverEnv(): Record<string, string> {
  return {
    OPENCLAW_WORKSPACE_ROOT: WORKSPACE_DIR,
    MC_INTERVIEW_COOKIE_SECRET: COOKIE_SECRET,
    DATABASE_PATH: DB_PATH,
    PORT: String(PORT),
    OPENCLAW_ROOT: '/nonexistent/openclaw-root-for-tests',
  };
}

export function ensureWorkspace(): void {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

export function writeCompleteBuildState(): void {
  ensureWorkspace();
  const state = { interviewComplete: true, interviewCompletedAt: new Date().toISOString() };
  fs.writeFileSync(BUILD_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

/** Fresh DB + workspace for a clean run (idempotent — safe every local run;
 *  CI always starts from a clean checkout anyway). */
export function resetFixture(): void {
  fs.rmSync(E2E_OUT_DIR, { recursive: true, force: true });
  ensureWorkspace();
  writeCompleteBuildState();
}
