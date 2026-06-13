/**
 * PLANTED FIXTURE — must FAIL the port-pin-and-env-bleed-guard CI check.
 *
 * This file replicates the EXACT vulnerable pattern that caused the CC
 * crash-loop on 13+ client boxes (Cassandra 71,551 restarts / Monique
 * 126,935 restarts / Sheila 2,191 restarts):
 *
 *   1. process.env.PORT read in args  — OpenClaw gateway PORT bleeds in
 *   2. PORT: key in the env block     — Hostinger injected PORT bleeds in
 *   3. No min_uptime                  — PM2 restart counter never trips
 *   4. No exp_backoff_restart_delay   — rapid crash-loop hammers at full speed
 *   5. next start invoked directly    — orphan-port killer is bypassed
 *
 * The qc-cc.sh section 11 guard MUST detect all of these and exit 1.
 * The CI job self-test MUST confirm exit 1 on this file.
 * If the guard exits 0 on this file, the CI self-test aborts with an error.
 */

module.exports = {
  apps: [{
    name: 'command-center',
    script: 'npx',
    // VULNERABLE: reads process.env.PORT — gateway PORT bleeds in
    args: `next start -p ${process.env.PORT || 4000} -H 0.0.0.0`,
    env: {
      NODE_ENV: 'production',
      // VULNERABLE: PORT key in env block — Hostinger injected PORT bleeds in
      PORT: process.env.PORT || 4000,
      DATABASE_PATH: '/data/projects/command-center/mission-control.db'
    },
    instances: 1,
    autorestart: true,
    max_restarts: 5,
    restart_delay: 3000
    // VULNERABLE: missing min_uptime — restart counter never trips
    // VULNERABLE: missing exp_backoff_restart_delay — loops at full speed
    // VULNERABLE: missing kill_timeout
  }]
};
