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
    name: 'cc-canary',
    // Internal canary instance — operator-owned fixture for duck pipeline CI.
    // Port 4100 (never 4000, never touches client boxes).
    // DATABASE_PATH pinned to absolute path so it survives cwd changes.
    script: '/opt/homebrew/bin/npx',
    args: 'next start -p 4100 -H 127.0.0.1',
    cwd: '/Users/blackceomacmini/canary/command-center',
    env: {
      NODE_ENV: 'production',
      PORT: 4100,
      DATABASE_PATH: '/Users/blackceomacmini/canary/command-center/canary.db',
      COMPANY_NAME: 'BlackCEO Demo',
      MISSION_CONTROL_URL: 'http://localhost:4100'
    },
    instances: 1,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    watch: false,
    max_memory_restart: '512M'
  }]
};
