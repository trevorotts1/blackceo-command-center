/**
 * scripts/demo/demo.ecosystem.config.cjs
 * Command Center DEMO PACK — the OPERATIONAL SOURCE OF TRUTH for the two demo
 * instances + the on-demand simulator (SPEC §1).
 *
 * This file is PURE JS (no repo imports) so `pm2 start` and a bare
 * `node -e "require(...)"` both parse it with zero side effects.
 *
 * DOCTRINE:
 *   • Fictional / demo-only values ONLY — NO provider keys of any kind.
 *   • Dead gateway ws://127.0.0.1:1 (never the real 18789).
 *   • App names are the demo allowlist — reset-demo.sh may touch ONLY these and
 *     must NEVER touch the real CC (`cc-prod` on :4000 on this box, or the
 *     fleet-canonical `blackceo-command-center`).
 *   • The web apps launch via scripts/cc-start.sh (env-bleed guard + orphan-port
 *     killer), matching the real ecosystem.config.cjs start contract. cc-start.sh
 *     pins the port from CC_PORT / --port and binds the app; we additionally set
 *     PORT so a manual `next start` from demo.env.* lines up 1:1.
 *   • Bind localhost — cloudflared reaches 127.0.0.1.
 */

const path = require('path');
const fs = require('fs');

// Repo root: this file lives at <REPO>/scripts/demo/ → up two levels.
const REPO = path.resolve(__dirname, '../..');

// Runtime data root (gitignored). Override with DEMO_DATA_ROOT.
const DEMO_DATA_ROOT =
  process.env.DEMO_DATA_ROOT || path.join(REPO, 'scripts/demo/.runtime');

// Committed, side-effect-free Skill-23 stub scripts (closes the §2.7 hazard).
const STUBS = path.join(REPO, 'scripts/demo/skill23-stubs');

const INTERVIEW_DIR = path.join(DEMO_DATA_ROOT, 'interview');
const DASHBOARD_DIR = path.join(DEMO_DATA_ROOT, 'dashboard');

// Rotated cookie secret lives ONLY in the gitignored runtime dir. Fall back to a
// fixed, non-secret demo string when it has not been rotated yet. Never throws.
const COOKIE_SECRET_FILE = path.join(DEMO_DATA_ROOT, 'cookie-secret.txt');
let COOKIE_SECRET = 'demo-cookie-secret-rotate-on-reset';
try {
  if (fs.existsSync(COOKIE_SECRET_FILE)) {
    const v = fs.readFileSync(COOKIE_SECRET_FILE, 'utf8').trim();
    if (v) COOKIE_SECRET = v;
  }
} catch {
  /* keep the fixed demo fallback */
}

// Common env for BOTH web apps. NO provider keys — see demo.env.* for the full
// deliberately-absent list. Values MUST mirror demo.env.interview/.dashboard.
const commonEnv = {
  NODE_ENV: 'production',
  OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:1', // DEAD on purpose — never 18789
  OPENCLAW_SKILL23_SCRIPTS: STUBS,
  MC_INTERVIEW_COOKIE_SECRET: COOKIE_SECRET,
  WEBHOOK_SECRET: 'demo-only-webhook-secret-not-real',
  COMPANY_NAME: 'Harbor & Oak Candle Co.',
  REQUIRE_CF_ACCESS: 'false',
};

// Circuit-breaker fields mirror the real ecosystem.config.cjs so a fast-failing
// demo instance trips instead of hammering the port.
const breaker = {
  instances: 1,
  exec_mode: 'fork',
  min_uptime: 30000,
  max_restarts: 8,
  exp_backoff_restart_delay: 2000,
  kill_timeout: 10000,
  watch: false,
  max_memory_restart: '512M',
};

module.exports = {
  apps: [
    {
      // INTERVIEW instance — DEMO_MODE UNSET → accepts POSTs (interactive).
      name: 'blackceo-cc-demo-interview',
      script: 'bash',
      args: 'scripts/cc-start.sh --port 4600',
      cwd: REPO,
      autorestart: true,
      ...breaker,
      env: {
        ...commonEnv,
        PORT: '4600',
        CC_PORT: '4600',
        DATABASE_PATH: path.join(INTERVIEW_DIR, 'mission-control.db'),
        OPENCLAW_WORKSPACE_ROOT: path.join(INTERVIEW_DIR, 'workspace'),
        // DEMO_MODE intentionally ABSENT.
      },
    },
    {
      // DASHBOARD instance — DEMO_MODE=true → read-only public link.
      name: 'blackceo-cc-demo-dashboard',
      script: 'bash',
      args: 'scripts/cc-start.sh --port 4601',
      cwd: REPO,
      autorestart: true,
      ...breaker,
      env: {
        ...commonEnv,
        PORT: '4601',
        CC_PORT: '4601',
        DATABASE_PATH: path.join(DASHBOARD_DIR, 'mission-control.db'),
        OPENCLAW_WORKSPACE_ROOT: path.join(DASHBOARD_DIR, 'workspace'),
        DEMO_MODE: 'true',
      },
    },
    {
      // SIMULATOR — NOT auto-started. `pm2 start <this file>` starts every app,
      // so reset-demo.sh and the documented boot ALWAYS pass
      // `--only blackceo-cc-demo-interview,blackceo-cc-demo-dashboard` and never
      // include this app. It is launched on demand for the dashboard act via:
      //   pm2 start scripts/demo/demo.ecosystem.config.cjs --only blackceo-cc-demo-simulator
      // and is always stopped+deleted by reset. autorestart:false → never
      // resurrected on exit.
      name: 'blackceo-cc-demo-simulator',
      script: path.join(REPO, 'scripts/demo-simulator.js'),
      interpreter: 'node',
      args: `--db ${path.join(DASHBOARD_DIR, 'mission-control.db')} --interval 15000`,
      cwd: REPO,
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
