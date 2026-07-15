/**
 * Fixture + fixed config for the U43 (C/C-12) home-dashboard induced-failure
 * E2E — BINARY acceptance (a): "screenshot/DOM assertion of the degraded slot
 * during the induced failure and of the producer cards after recovery, on the
 * operator box."
 *
 * Mirrors create-task.fixture.ts's / agent-navigation.fixture.ts's pattern
 * exactly: stands up a REAL Next dev server against a throwaway DB +
 * workspace, with the interview shell-lock pre-satisfied, so the induced
 * `/api/workspaces` failure is proven against the REAL UI + REAL fetch retry
 * loop (`src/app/page.tsx` + `src/lib/dashboard-workspaces.ts`) — not a mock
 * of the decision logic (that pure-logic proof already exists in
 * `tests/unit/p1-03-dashboard-workspaces.test.ts`; this suite proves the
 * DOM/render half on a live server, which no existing suite covers).
 *
 * No producer workspace is seeded (a throwaway DB auto-migrates to EMPTY
 * `workspaces` — the exact "this box has no producer engines" case the P1-03
 * fix comment names explicitly). Recovery is therefore proven by the
 * non-degraded, zero-producer-card layout returning (the CORRECT behavior
 * for such a box per `selectProducerCardSlugs`'s own contract) AND by
 * observing the underlying `GET /api/workspaces` retry actually succeed
 * (200) on the live network — the direct proof that the fetch loop itself
 * recovered, not merely that a screenshot looks unchanged.
 *
 * SAFETY: every path resolves INSIDE the repo checkout (test-results/…) —
 * never ~/.openclaw, never the operator's canonical files, never a client box.
 * The fault injection itself (below, in the spec file) is client-side
 * Playwright route interception — it makes ZERO production-code changes
 * (BINARY acceptance (c): "zero client-box changes performed by this unit").
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = process.cwd();

export const E2E_OUT_DIR = path.join(REPO_ROOT, 'test-results', 'home-dashboard-fault');
export const WORKSPACE_DIR = path.join(E2E_OUT_DIR, 'workspace');
export const BUILD_STATE_PATH = path.join(WORKSPACE_DIR, '.workforce-build-state.json');
export const DB_PATH = path.join(E2E_OUT_DIR, 'mission-control.e2e.db');

export const COOKIE_SECRET = 'home-dashboard-fault-e2e-secret-not-for-production';

/** Dedicated port so this suite never collides with the smoke (4000),
 *  interview-lock (4123), create-task (4124), my-ai-ceo-responsive (4125), or
 *  agent-navigation (4126) servers. Override with HOME_DASHBOARD_FAULT_PORT
 *  if 4127 is taken. */
export const PORT = Number(process.env.HOME_DASHBOARD_FAULT_PORT || 4127);
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
