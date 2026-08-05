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
import crypto from 'crypto';

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
/** The latch cookie the middleware checks as fallback (U010). */
export const LATCH_COOKIE_NAME = 'mc_interview_gate_latch';

/**
 * U010: forge a token the same way signInterviewToken signs — HMAC-SHA256 over
 * base64url(payload). This mirrors the gate-cookie signing path using Node
 * crypto (Buffer + createHmac) so we can produce authentic-looking complete and
 * forged tokens without importing the WebCrypto-based gate-cookie module.
 */
function signForgePayload(complete: boolean, ttlSeconds: number): string {
  const payload = JSON.stringify({
    complete,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  const b64 = Buffer.from(payload, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const sig = crypto
    .createHmac('sha256', COOKIE_SECRET)
    .update(b64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${b64}.${sig}`;
}

/**
 * Produce a validly-signed "complete" cookie value with a 30-day TTL.
 * Used by tests that want to prime the browser with a valid, pre-signed cookie
 * without going through the sanctioned setter (so they can exercise the
 * middleware's verification path directly).
 */
export function forgeCompleteCookie(): string {
  return signForgePayload(true, 60 * 60 * 24 * 30);
}

/**
 * Produce a validly-signed but EXPIRED "complete" cookie value.
 * The TTL is negative so `exp` is in the past — but `complete:true` is still
 * signed correctly, so the middleware's monotonic-unlock rule (accept an expired
 * complete token) admits it.
 */
export function forgeExpiredCompleteCookie(): string {
  return signForgePayload(true, -3600);
}

/**
 * Produce a FORGED cookie value — it claims `complete:true` but has the wrong
 * HMAC (signed with 'wrong-secret' instead of COOKIE_SECRET). The middleware
 * must reject it and 302 to /interview.
 */
export function forgeForgedCookie(): string {
  const payload = JSON.stringify({
    complete: true,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30,
  });
  const b64 = Buffer.from(payload, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const sig = crypto
    .createHmac('sha256', 'wrong-secret')
    .update(b64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${b64}.${sig}`;
}

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
 *
 * ZERO_HUMAN_COMPANY_DIR pins the departments.json resolution (migrations.ts
 * resolveDepartmentsConfigPath priority 1) at the FIXTURE company dir so the
 * standard-ready case's /preview read + boot auto-seed see the fixture's
 * chosen-departments artifact — never the operator's live company build.
 */
export function serverEnv(): Record<string, string> {
  return {
    OPENCLAW_WORKSPACE_ROOT: WORKSPACE_DIR,
    MC_INTERVIEW_COOKIE_SECRET: COOKIE_SECRET,
    DATABASE_PATH: DB_PATH,
    ZERO_HUMAN_COMPANY_DIR: COMPANY_DIR,
    PORT: String(PORT),
  };
}

/** Create the fixture workspace dir (idempotent). */
export function ensureWorkspace(): void {
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
}

/* ────────────────── Standard-first fixture additions (PHASE 6b) ─────────────
 * AI Workforce standard-first redesign (master plan section 4.2): a box can now
 * be standard-prebuilt — the canonical floor materialized from the role library,
 * the chosen artifact written, the board seeded — WHILE the interview is still
 * incomplete. The shell lock must treat that third state exactly like incomplete:
 * everything stays 302 → /interview except the exemptions (plus the new
 * read-only /preview surface). The helpers below seed exactly that state. */

/** Throwaway company dir — the fixture's ZERO_HUMAN_COMPANY_DIR (the
 *  `company_dir` of the join contract: chosen artifact lives here). */
export const COMPANY_DIR = path.join(E2E_OUT_DIR, 'company');
/** The chosen-departments artifact the prebuild driver writes. */
export const DEPARTMENTS_JSON_PATH = path.join(COMPANY_DIR, 'departments.json');

/** A SMALL distinct department set for the standard-ready case (three entries,
 *  never 29 — the test must never depend on a hardcoded floor count). Deliberate
 *  sentinel names so a render assertion can prove the preview page read THIS
 *  fixture artifact and not some demo/template departments.json. */
export const STANDARD_READY_DEPTS = [
  { id: 'alpha-preview-dept', name: 'Alpha Preview Dept', emoji: '🧪' },
  { id: 'beta-preview-dept', name: 'Beta Preview Dept', emoji: '🧬' },
  { id: 'gamma-preview-dept', name: 'Gamma Preview Dept', emoji: '🧭' },
];

/** Create the fixture company dir (idempotent). */
export function ensureCompanyDir(): void {
  fs.mkdirSync(COMPANY_DIR, { recursive: true });
}

/** Seed the chosen-departments artifact the standard prebuild writes into
 *  company_dir/departments.json (the canonical array-of-objects shape). */
export function writeDepartmentsJson(): void {
  ensureCompanyDir();
  fs.writeFileSync(
    DEPARTMENTS_JSON_PATH,
    `${JSON.stringify(STANDARD_READY_DEPTS, null, 2)}\n`,
    'utf-8',
  );
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

/**
 * Seed the STANDARD-PREBUILT state block (master plan PHASE 1 shape): the
 * prebuild driver's terminal record — status "done" + standardReadyAt + the
 * prebuilt department ids — alongside `buildType: "standard-first"`. The caller
 * passes the SAME `complete` bit writeBuildState uses so the two terminal
 * fields (interviewComplete / buildCompletedAt) stay consistent in one file.
 *
 * DOCTRINE GUARDED BY THE SPEC: this block MUST NOT unlock the shell. The lock
 * reads interviewComplete/buildCompletedAt only; a present-but-not-complete
 * standardPrebuild block is the exact "standardReady=true + interviewComplete=
 * false" state the PHASE 6b E2E asserts stays LOCKED.
 */
export function writeStandardPrebuildState(complete: boolean): void {
  ensureWorkspace();
  const state: Record<string, unknown> = complete
    ? { interviewComplete: true, interviewCompletedAt: new Date().toISOString() }
    : { interviewComplete: false };
  state.buildType = 'standard-first';
  state.standardPrebuild = {
    status: 'done',
    standardReadyAt: new Date().toISOString(),
    floorVersion: 'naming-map-v2.7.0-e2e-fixture',
    prebuiltDepartments: STANDARD_READY_DEPTS.map((d) => d.id),
    agentRegistration: 'deferred',
    source: 'tests/integration/interview-lock.fixture.ts',
  };
  fs.writeFileSync(BUILD_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}
