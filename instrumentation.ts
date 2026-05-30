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

  // Bridge pairing bootstrap (v4.1.2): kick a single, non-blocking connect
  // attempt on boot so the OpenClaw gateway records this command-center's
  // device as a PENDING pairing request immediately after deploy — instead of
  // only when the operator first opens the Bridge. The install/runbook step
  // then runs `openclaw devices approve <requestId>` once and the connection
  // succeeds on the next status poll. Opt out with DISABLE_BRIDGE_BOOTSTRAP=1
  // (e.g. CI, or a box with no gateway).
  if (process.env.DISABLE_BRIDGE_BOOTSTRAP === '1' || process.env.DISABLE_BRIDGE_BOOTSTRAP === 'true') {
    return;
  }
  try {
    const { getOpenClawClient } = await import('@/lib/openclaw/client');
    const client = getOpenClawClient();
    const deviceId = client.getDeviceId();
    console.log(
      `[instrumentation] Bridge device id: ${deviceId ?? 'unavailable'} — gateway ${client.getGatewayUrl()}`,
    );
    // Fire-and-forget: a failure here just means the gateway is down or the
    // device is pending approval. Either way the pending request is now on the
    // gateway and the status route will report the precise remediation.
    client.connect().then(
      () => console.log('[instrumentation] Bridge connected to OpenClaw gateway on boot'),
      (err) =>
        console.log(
          `[instrumentation] Bridge not yet connected (expected until paired): ${err instanceof Error ? err.message : String(err)}`,
        ),
    );
  } catch (error) {
    console.error('[instrumentation] Bridge pairing bootstrap failed:', error);
  }
}
