#!/usr/bin/env node
/**
 * relaunch-cc-on-4000.cjs — PORT-FIX-3 self-heal relaunch.
 *
 * Invoked by src/lib/jobs/port-integrity.ts via `process.execPath` so the
 * Next/webpack production build NEVER sees a `node:child_process` import
 * (UnhandledSchemeError at build time). This file is plain CommonJS run
 * directly by Node — it is free to use child_process.
 *
 * It relaunches the Command Center through the canonical launch path:
 *   pm2 start ecosystem.config.cjs
 * from the app cwd with CC_PORT pinned to 4000. That config reads only
 * CC_PORT, cc-start.sh strips any ambient PORT, and it carries the
 * circuit-breaker — so the relaunch cannot drift again.
 *
 * Exit 0 on success (pm2 exited 0), non-zero otherwise.
 */
'use strict';

const { execFile } = require('node:child_process');

const CANONICAL_CC_PORT = 4000;

function main() {
  execFile(
    'pm2',
    ['start', 'ecosystem.config.cjs'],
    {
      cwd: process.cwd(),
      env: { ...process.env, CC_PORT: String(CANONICAL_CC_PORT) },
      timeout: 20000,
    },
    (err) => {
      if (err) {
        process.stderr.write(`relaunch-cc-on-4000: pm2 start failed: ${err.message}\n`);
        process.exit(1);
      }
      process.exit(0);
    },
  );
}

main();
