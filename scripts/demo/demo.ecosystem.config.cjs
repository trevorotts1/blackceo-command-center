/**
 * Command Center Demo Pack — PM2 ecosystem.
 *
 *   DEMO_DATA_ROOT=<...> pm2 start scripts/demo/demo.ecosystem.config.cjs \
 *       --only "blackceo-cc-demo-interview,blackceo-cc-demo-dashboard"
 *
 * Two isolated Command Center instances from ONE repo copy, plus an optional
 * (stopped-by-default) live-activity generator. Everything is assembled here from
 * DEMO_DATA_ROOT + DEMO_REPO so paths stay machine-relative and no secret is
 * hard-coded. The static, safety-critical env (dead gateway, no keys, DEMO_MODE)
 * comes from demo.env.interview / demo.env.dashboard; the dynamic values (paths,
 * HOME, rotated cookie secret) are computed below.
 *
 * ISOLATION (by construction):
 *   • own DATABASE_PATH, own OPENCLAW_WORKSPACE_ROOT, own OPENCLAW_COMPANY_ROOT
 *   • OPENCLAW_SKILL23_SCRIPTS → the demo stubs (closes the update-interview-state.sh
 *     live-workspace hazard)
 *   • HOME → an isolated empty demo home so getDb()'s first-boot auto-seed can
 *     never read the operator's real ZHC build (~/clawd/zero-human-company/...)
 *   • OPENCLAW_GATEWAY_URL → a dead port (from the env files)
 *   • NO provider keys anywhere
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEMO_REPO = process.env.DEMO_REPO || path.resolve(__dirname, '..', '..');
const DEMO_DATA_ROOT = process.env.DEMO_DATA_ROOT || path.join(os.homedir(), '.command-center-demo');
const DEMO_HOME = path.join(DEMO_DATA_ROOT, 'home');
const STUBS = path.join(DEMO_REPO, 'scripts', 'demo', 'skill23-stubs');

/** Parse a KEY=VALUE .env file (ignores comments / blanks). */
function parseEnv(file) {
  const out = {};
  let text = '';
  try { text = fs.readFileSync(file, 'utf-8'); } catch { return out; }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Read the rotated cookie secret for a profile; fall back to a per-load random. */
function cookieSecret(profile) {
  const f = path.join(DEMO_DATA_ROOT, profile, 'cookie-secret');
  try {
    const v = fs.readFileSync(f, 'utf-8').trim();
    if (v) return v;
  } catch { /* not written yet */ }
  return require('crypto').randomBytes(24).toString('hex');
}

function instanceEnv(profile, envFile) {
  const base = parseEnv(path.join(DEMO_REPO, 'scripts', 'demo', envFile));
  const dir = path.join(DEMO_DATA_ROOT, profile);
  return Object.assign({}, base, {
    HOME: DEMO_HOME,
    DATABASE_PATH: path.join(dir, 'mission-control.db'),
    OPENCLAW_WORKSPACE_ROOT: path.join(dir, 'workspace'),
    OPENCLAW_COMPANY_ROOT: path.join(dir, 'company-root'),
    OPENCLAW_SKILL23_SCRIPTS: STUBS,
    ZERO_HUMAN_COMPANY_DIR: path.join(dir, 'company-root', 'harbor-oak'),
    MASTER_FILES_DIR: path.join(dir, 'company-root'),
    MC_INTERVIEW_COOKIE_SECRET: cookieSecret(profile),
  });
}

const common = {
  cwd: DEMO_REPO,
  exec_mode: 'fork',
  autorestart: true,
  min_uptime: 20000,
  max_restarts: 8,
  exp_backoff_restart_delay: 2000,
  max_memory_restart: '512M',
};

module.exports = {
  apps: [
    Object.assign({
      name: 'blackceo-cc-demo-interview',
      script: 'bash',
      args: 'scripts/cc-start.sh --port 4600',
      env: instanceEnv('interview', 'demo.env.interview'),
    }, common),
    Object.assign({
      name: 'blackceo-cc-demo-dashboard',
      script: 'bash',
      args: 'scripts/cc-start.sh --port 4601',
      env: instanceEnv('dashboard', 'demo.env.dashboard'),
    }, common),
    // Optional live-activity generator for the dashboard act. NOT started by
    // reset-demo.sh (start it manually with:  pm2 start <this> --only blackceo-cc-demo-simulator).
    Object.assign({
      name: 'blackceo-cc-demo-simulator',
      script: 'node',
      args: `scripts/demo/demo-motion.js --db ${path.join(DEMO_DATA_ROOT, 'dashboard', 'mission-control.db')} --interval 15000`,
      env: { HOME: DEMO_HOME },
    }, common),
  ],
};
