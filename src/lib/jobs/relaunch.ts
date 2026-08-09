/**
 * relaunch.ts — PORT-FIX-3 self-heal relaunch bridge.
 *
 * Deliberately isolated from the Next/webpack bundle graph: this module is
 * imported ONLY by src/lib/jobs/port-integrity.ts (itself a scheduler job,
 * never a Next-routed page), and it dynamically requires node:child_process at
 * RUNTIME. Because webpack only bundles modules reachable from pages/routes and
 * this file never appears in that graph statically, the production build stays
 * clean — no UnhandledSchemeError.
 *
 * It shells out to scripts/relaunch-cc-on-4000.cjs (a plain-CommonJS Node
 * script that runs `pm2 start ecosystem.config.cjs` with CC_PORT=4000), the
 * canonical launch path that strips ambient PORT and pins 4000.
 */
import { CANONICAL_CC_PORT } from '@/lib/jobs/port-integrity';

export async function relaunchOnCanonicalPort(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { execFile } = require('node:child_process') as typeof import('node:child_process');
  const script = new URL('../../../scripts/relaunch-cc-on-4000.cjs', import.meta.url).pathname;
  return await new Promise<boolean>((resolve) => {
    execFile(
      process.execPath,
      [script],
      {
        cwd: process.cwd(),
        env: { ...process.env, CC_PORT: String(CANONICAL_CC_PORT) },
        timeout: 20000,
      },
      (err) => resolve(!err),
    );
  });
}
