/**
 * PM2 ecosystem config — BlackCEO Command Center
 *
 * B.4 (PRD Addendum B): DATABASE_PATH must be set to the canonical absolute
 * path so a pm2 restart from any working directory always opens the same DB.
 * B.1 check-4 enforces this at health-check time; this template makes fresh
 * installs born compliant.
 *
 * PORT-PIN CONTRACT (v4.42.0+):
 *   This config reads CC_PORT (never process.env.PORT) so an ambient OpenClaw
 *   gateway PORT or a Hostinger-injected random PORT cannot bleed into the CC
 *   start command.  scripts/cc-start.sh performs the env-bleed strip +
 *   orphan-port kill before exec-ing `next start`, so EVERY start path is
 *   hardened by a single canonical launcher.
 *
 * BUILD-ID FRESHNESS (BUILD-06):
 *   This config never calls `next start` directly — it always launches via
 *   scripts/cc-start.sh, which runs a BUILD-ID freshness guard BEFORE exec-ing
 *   `next start`: it FAIL-LOUD exits when `.next/BUILD_ID` is missing or stale
 *   (any src/ or config file newer than the compiled build). That non-zero exit
 *   is caught by the circuit-breaker below (errored state + watchdog alert)
 *   instead of pm2 quietly serving a stale build (the dead-Kanban class). Every
 *   start path therefore inherits the guard through this single launcher.
 *
 * CIRCUIT-BREAKER:
 *   min_uptime ensures PM2 actually trips max_restarts on a fast-failing
 *   process instead of resetting the counter on every brief launch.
 *   exp_backoff_restart_delay backs off the loop instead of hammering.
 *   Together they prevent the 126K-restart loops seen on the worst-hit boxes.
 *
 * INSTALLER INSTRUCTIONS:
 *   Replace __INSTALL_DIR__ with the absolute path where the repo is checked
 *   out (e.g. /home/<user>/projects/command-center or
 *   /data/projects/command-center on a Hostinger VPS).
 *   The installer scripts (scripts/install/mac-mini-bootstrap.sh and
 *   vps-docker-bootstrap.sh) do this substitution automatically.
 */

const path = require('path');
const INSTALL_DIR = process.env.CC_INSTALL_DIR || process.cwd();
const DB_PATH = process.env.DATABASE_PATH || path.join(INSTALL_DIR, '../data/mission-control.db');
// Use CC_PORT ONLY — never read process.env.PORT to prevent env-bleed from
// OpenClaw gateway or Hostinger container-injected PORT. qc-cc.sh enforces this.
const CC_PORT = process.env.CC_PORT || '4000';

module.exports = {
  apps: [{
    // FLEET-CANONICAL PM2 APP NAME — do not rename without updating every other
    // tool that (re)starts the CC, or a box will end up with two apps fighting
    // over :4000 (a proven multi-hour gateway-outage root cause on a client
    // box). "blackceo-command-center" is the single canonical name the whole
    // fleet standardizes on: the openclaw-onboarding installer Phase 6, every
    // per-box dedup, scripts/deploy.sh, the scripts/install/*-bootstrap.sh
    // ecosystem templates, and scripts/watchdog-cc.sh self-heal (which restarts
    // via `pm2 start ecosystem.config.cjs`, so this name is what it resurrects).
    // `mission-control` is a LEGACY alias that earlier revisions of this repo
    // used; it is reconciled away (pm2 delete) by the installer and the
    // watchdog. The DATABASE_PATH file is still mission-control.db — that is the
    // on-disk DB filename, intentionally unchanged, NOT the pm2 app name.
    name: 'blackceo-command-center',
    // Canonical hardened launcher — performs env-bleed strip + orphan-port kill
    // before exec-ing `next start`. NEVER call `next start` directly from this
    // config (qc-cc.sh port-pin-and-env-bleed-guard will FAIL the build).
    script: 'bash',
    args: `scripts/cc-start.sh --port ${CC_PORT}`,
    cwd: INSTALL_DIR,
    env: {
      NODE_ENV: 'production',
      // CC_PORT: canonical port variable; cc-start.sh reads this, strips PORT,
      // then re-exports PORT=CC_PORT before exec. Never set PORT here directly.
      CC_PORT: CC_PORT,
      // B.4: DATABASE_PATH pinned to the canonical absolute path so a restart
      // from a wrong cwd still serves the real DB. B.1 check-4 verifies this
      // is set; leaving it unset makes every health check report db_path_set=false.
      DATABASE_PATH: DB_PATH,
      // COMPANY_NAME: read by the branding seed as a fallback when
      // company-config.json is absent. Optional — the seed will use Default
      // for truly unconfigured boxes, or read from the config file.
      ...(process.env.COMPANY_NAME ? { COMPANY_NAME: process.env.COMPANY_NAME } : {}),
      // OpenClaw Bridge: pass these through explicitly so they land in the pm2
      // child env (pm2 does not always inherit a shell's exported vars). They
      // still default at the app layer when unset — OPENCLAW_GATEWAY_URL
      // defaults to ws://127.0.0.1:18789. Set the real values in the
      // container/host .env (Hostinger /docker/<project>/.env) or app .env.local
      // and run `pm2 restart blackceo-command-center --update-env`.
      ...(process.env.OPENCLAW_GATEWAY_URL ? { OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL } : {}),
      ...(process.env.OPENCLAW_GATEWAY_TOKEN ? { OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN } : {}),
      ...(process.env.BCC_DEVICE_IDENTITY_DIR ? { BCC_DEVICE_IDENTITY_DIR: process.env.BCC_DEVICE_IDENTITY_DIR } : {}),
      ...(process.env.BCC_INSTALL_TYPE ? { BCC_INSTALL_TYPE: process.env.BCC_INSTALL_TYPE } : {}),
      ...(process.env.OPENCLAW_PLATFORM ? { OPENCLAW_PLATFORM: process.env.OPENCLAW_PLATFORM } : {}),
      // OPENCLAW_CLI_BIN: absolute path override for the `openclaw` binary that
      // src/lib/native-web-search.ts and src/lib/openclaw/client.ts shell out to
      // (SOP research provider discovery/search, device pairing). Without this,
      // execFile('openclaw', ...) resolves the bare command name against
      // whatever PATH the pm2 daemon itself was started with — NOT an
      // interactive login shell's PATH, and NOT necessarily the PATH a
      // `which openclaw` run in a terminal would show. If pm2 was daemonized
      // with a stripped PATH (launchd/systemd/`pm2 resurrect` at boot), the CLI
      // silently fails to resolve, every CLI-backed research tier reports
      // "unusable," and — on a box with no TAVILY_API_KEY — the whole SOP
      // research selector degrades to a graceful-empty result with no signal
      // anywhere except a `[tavily]`/`[native-web-search]` pm2 log line.
      // Resolve the real absolute path (`command -v openclaw`) AS THE USER/
      // CONTEXT THAT ACTUALLY RUNS PM2 — not from any interactive shell, that
      // mismatch is the whole bug — set it in the host/container .env or
      // app .env.local, then run
      // `pm2 restart ecosystem.config.cjs --update-env` FROM THE CC DIRECTORY.
      // A plain `pm2 restart blackceo-command-center` (by app name, without
      // --update-env, or without pointing at this file) will NOT pick up an
      // edited env var — same trap as the other OPENCLAW_* passthroughs above.
      ...(process.env.OPENCLAW_CLI_BIN ? { OPENCLAW_CLI_BIN: process.env.OPENCLAW_CLI_BIN } : {}),
      // WRITE-BACK-401 hardening: pass the task-API write-back credentials into
      // the pm2 child env explicitly. Next.js auto-loads .env.local from cwd, but
      // a cwd-drift restart (or `pm2 restart` without --update-env) could silently
      // drop them, re-opening the "carded-but-trapped" 401 trap — MC_API_TOKEN is
      // the bearer the middleware requires on every external /api write-back, and
      // WEBHOOK_SECRET signs the HMAC ingest/status routes. Conditional spread so
      // an unset value never overrides the .env.local layer (never blanks it).
      ...(process.env.MC_API_TOKEN ? { MC_API_TOKEN: process.env.MC_API_TOKEN } : {}),
      ...(process.env.WEBHOOK_SECRET ? { WEBHOOK_SECRET: process.env.WEBHOOK_SECRET } : {}),
      // QC JUDGE (master plan unit 3.3): the podcast QC judge is resolved by
      // resolveClientJudgeModel (qc-scorer.ts) from the dept QC agent's model OR
      // QC_JUDGE_MODEL, and scored via the CLIENT's OWN OLLAMA_CLOUD_API_KEY.
      // Pass both through explicitly so a cwd-drift `pm2 restart` never drops
      // them (same rationale as MC_API_TOKEN above). Both are client-owned;
      // never operator/shared. Set them in the host/container .env and run
      // `pm2 restart blackceo-command-center --update-env` to apply — this
      // config change alone does NOT touch the running process.
      ...(process.env.QC_JUDGE_MODEL ? { QC_JUDGE_MODEL: process.env.QC_JUDGE_MODEL } : {}),
      ...(process.env.OLLAMA_CLOUD_API_KEY ? { OLLAMA_CLOUD_API_KEY: process.env.OLLAMA_CLOUD_API_KEY } : {})
    },
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    // CIRCUIT-BREAKER: min_uptime is the critical field — without it PM2 resets
    // the restart counter on every brief launch and max_restarts never trips.
    // With min_uptime:30000, a process that dies in <30s counts as a failed
    // restart; after max_restarts=8 failures the app moves to `errored` state,
    // stopping the loop and triggering the watchdog alert.
    min_uptime: 30000,
    max_restarts: 8,
    // Exponential backoff (replaces fixed restart_delay) so rapid loops back off
    // instead of hammering port/disk at full speed.
    exp_backoff_restart_delay: 2000,
    kill_timeout: 10000,
    watch: false,
    max_memory_restart: '512M'
  }]
};
