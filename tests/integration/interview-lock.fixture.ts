/**
 * Fixture + fixed config for the interview-mode shell-lock E2E (WG-6 / WG-10c).
 *
 * The command-center half of the lock proof stands up a REAL Next server (dev)
 * and drives the actual Edge middleware (src/middleware.ts) + the sanctioned
 * Node cookie-setter (refreshInterviewGate) end-to-end. Determinism comes from
 * seeding interview state into a THROWAWAY fixture workspace under
 * test-results/ — never the operator's canonical files and never ~/.openclaw.
 *
 * SAFETY (WG-6): every path here resolves INSIDE the repo checkout
 * (test-results/interview-lock/…). The spawned server's OPENCLAW_WORKSPACE_ROOT
 * is pointed at that fixture so the app seam (readBuildState → buildStatePath →
 * resolveWorkspaceDir) reads the fixture build-state, not the live workspace.
 * Nothing here shells to a Skill-23 script, so no receipt/output path can reach
 * ~/.openclaw either — the lock path is pure file-read + WebCrypto HMAC.
 *
 * Shared by playwright.interview-lock.config.ts (webServer env + globalSetup)
 * and interview-lock.spec.ts (flip the fixture build-state between phases).
 */

import fs from 'fs';
import path from 'path';

/** Playwright is always invoked from the repo root (config lives there). */
const REPO_ROOT = process.cwd();

/** Throwaway artifacts live under test-results so a run never touches the
 *  canonical operator files or ~/.openclaw (WG-6). */
export const E2E_OUT_DIR = path.join(REPO_ROOT, 'test-results', 'interview-lock');
export const WORKSPACE_DIR = path.join(E2E_OUT_DIR, 'workspace');
/** The canonical build-state file, but INSIDE the fixture workspace. */
export const BUILD_STATE_PATH = path.join(WORKSPACE_DIR, '.workforce-build-state.json');
/** Isolated DB so the server never writes over a real mission-control.db. */
export const DB_PATH = path.join(E2E_OUT_DIR, 'mission-control.e2e.db');

/** Fixed secret so the Node setter (signInterviewToken) and the Edge verifier
 *  (verifyInterviewToken) agree inside the spawned server. Test-only. */
export const COOKIE_SECRET = 'interview-lock-e2e-secret-not-for-production';

/** The Edge-readable gate cookie the middleware verifies (mirrors
 *  INTERVIEW_COOKIE_NAME in src/lib/interview/gate-cookie.ts). */
export const INTERVIEW_COOKIE_NAME = 'mc_interview_complete';

/** Dedicated port + base URL so this suite never collides with the port-4000
 *  smoke server. Override with INTERVIEW_LOCK_PORT if 4123 is taken in CI. */
export const PORT = Number(process.env.INTERVIEW_LOCK_PORT || 4123);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Env handed to the webServer child. Points BOTH state-resolution surfaces at the
 * fixture and pins the cookie secret. NODE_ENV is left unset on purpose: `next
 * dev` runs in development, so refreshInterviewGate mints a NON-`secure` cookie
 * that is delivered over plain http://127.0.0.1 (a `secure` cookie would be
 * dropped and the unlock could never be observed).
 */
export function serverEnv(): Record<string, string> {
  return {
    OPENCLAW_WORKSPACE_ROOT: WORKSPACE_DIR,
    MC_INTERVIEW_COOKIE_SECRET: COOKIE_SECRET,
    DATABASE_PATH: DB_PATH,
    PORT: String(PORT),
  };
}

/** Create the fixture workspace dir (idempotent). */
export function ensureWorkspace(): void {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

/**
 * Seed the canonical-shaped build-state INTO THE FIXTURE (not the operator's
 * files). This is the sanctioned completion signal the Node setter derives from:
 *   complete=false → interview incomplete  → shell lock HOLDS (302 → /interview)
 *   complete=true  → interviewComplete set  → refreshInterviewGate mints a
 *                    "complete" cookie and the dashboard UNLOCKS.
 * We flip only the two doctrine terminal fields the setter reads
 * (buildCompletedAt / interviewComplete); we never forge the signed cookie.
 */
export function writeBuildState(complete: boolean): void {
  ensureWorkspace();
  const state = complete
    ? { interviewComplete: true, interviewCompletedAt: new Date().toISOString() }
    : { interviewComplete: false };
  fs.writeFileSync(BUILD_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}
