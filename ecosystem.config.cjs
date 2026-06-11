/**
 * PM2 ecosystem config — BlackCEO Command Center
 *
 * B.4 (PRD Addendum B): DATABASE_PATH must be set to the canonical absolute
 * path so a pm2 restart from any working directory always opens the same DB.
 * B.1 check-4 enforces this at health-check time; this template makes fresh
 * installs born compliant.
 *
 * INSTALLER INSTRUCTIONS:
 *   Replace __INSTALL_DIR__ with the absolute path where the repo is checked
 *   out (e.g. /home/<user>/projects/command-center or
 *   /data/projects/command-center on a Hostinger VPS).
 *   The installer scripts (scripts/install/mac-mini-bootstrap.sh and
 *   vps-docker-bootstrap.sh) do this substitution automatically.
 */

const INSTALL_DIR = process.env.CC_INSTALL_DIR || process.cwd();
const DB_PATH = process.env.DATABASE_PATH || `${INSTALL_DIR}/mission-control.db`;

module.exports = {
  apps: [{
    name: 'mission-control',
    // Mac: /opt/homebrew/bin/npx | VPS/Docker: npx (from PATH, install via npm i -g)
    // If npx not found, replace with full path: which npx
    script: 'npx',
    args: `next start -p ${process.env.PORT || 4000} -H 0.0.0.0`,
    cwd: INSTALL_DIR,
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 4000,
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
      // and run `pm2 restart mission-control --update-env`.
      ...(process.env.OPENCLAW_GATEWAY_URL ? { OPENCLAW_GATEWAY_URL: process.env.OPENCLAW_GATEWAY_URL } : {}),
      ...(process.env.OPENCLAW_GATEWAY_TOKEN ? { OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN } : {}),
      ...(process.env.BCC_DEVICE_IDENTITY_DIR ? { BCC_DEVICE_IDENTITY_DIR: process.env.BCC_DEVICE_IDENTITY_DIR } : {}),
      ...(process.env.BCC_INSTALL_TYPE ? { BCC_INSTALL_TYPE: process.env.BCC_INSTALL_TYPE } : {}),
      ...(process.env.OPENCLAW_PLATFORM ? { OPENCLAW_PLATFORM: process.env.OPENCLAW_PLATFORM } : {})
    },
    // PM2 settings
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    watch: false,
    max_memory_restart: '512M'
  }]
};
