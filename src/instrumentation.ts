/**
 * Next.js instrumentation hook (enabled via `experimental.instrumentationHook`
 * in next.config.mjs). Runs once when the server process boots.
 *
 * Responsibilities:
 *   - Initialize the DB on boot (runs migrations + the first-boot auto-seed,
 *     including the starter SOP library — B6). This guarantees the SOP table is
 *     populated before the first request, so the Triad Rule never silently
 *     blocks the board on a fresh client box.
 *   - Register the in-process cron jobs (model-refresh, usage-refresh,
 *     memory-index, and the B2/B8 safety-net reconcilers). next.config.mjs
 *     references this file for exactly that purpose; it was missing, so cron
 *     jobs previously only registered if something hit /api/cron/register.
 *
 * Node-only: better-sqlite3 and node-cron must not load in the edge runtime.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { getDb } = await import('@/lib/db');
    getDb(); // runs migrations + auto-seed (workspaces + starter SOPs)
    console.log('[instrumentation] DB initialized (migrations + auto-seed ran)');
  } catch (err) {
    console.error('[instrumentation] DB init failed:', err);
  }

  try {
    const { registerCronJobs } = await import('@/lib/jobs/scheduler');
    const jobs = registerCronJobs();
    console.log('[instrumentation] Cron jobs registered:', jobs.map((j) => j.name).join(', '));
  } catch (err) {
    console.error('[instrumentation] Cron registration failed:', err);
  }
}
