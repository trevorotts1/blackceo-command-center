/**
 * Next.js instrumentation entry point.
 *
 * Runs once per server worker on boot. Used here to register the in-process
 * cron scheduler (v4.0.1 P0-6: weekly model refresh, usage refresh, memory
 * index rebuild). Only the Node.js runtime should attempt this; the edge
 * runtime cannot load node-cron.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Dev mode runs both a webpack worker and the page-runtime worker; we only
  // want one scheduler. Skip when explicitly opted out for tests, builds, or
  // CI smoke runs that do not want background jobs to fire.
  if (process.env.DISABLE_CRON === '1' || process.env.DISABLE_CRON === 'true') {
    console.log('[instrumentation] DISABLE_CRON set, skipping cron registration');
    return;
  }

  try {
    const { registerCronJobs } = await import('@/lib/jobs/scheduler');
    registerCronJobs();
  } catch (error) {
    console.error('[instrumentation] failed to register cron jobs:', error);
  }
}
