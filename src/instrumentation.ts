/**
 * Next.js instrumentation hook (enabled via `experimental.instrumentationHook`
 * in next.config.mjs). Runs once when the server process boots.
 *
 * IMPORTANT (Next.js 14.2 + src/ dir): with a `src/` directory present, Next.js
 * loads THIS file (`src/instrumentation.ts`) and IGNORES any root-level
 * `instrumentation.ts`. See
 * https://nextjs.org/docs/14/app/building-your-application/optimizing/instrumentation
 * ("If you're using the `src` folder, then place the file inside `src`"). All
 * boot-time wiring therefore lives here — the previous root-level file was dead
 * code and has been removed (QC remediation, PR #35).
 *
 * Responsibilities (in boot order):
 *   1. Initialize the DB (runs migrations + the first-boot auto-seed, including
 *      the starter SOP library — B6). Guarantees the SOP table is populated
 *      before the first request so the Triad Rule never silently blocks the
 *      board on a fresh client box.
 *   2. Hydrate provider API keys from the OpenClaw secret files (v4.1.2) so the
 *      Studio gate and the weekly refresh both see the keys.
 *   3. Seed the Studio `model_registry` if empty (v4.1.6) so a fresh deploy
 *      shows providers immediately instead of "No providers configured".
 *   4. Register the in-process cron jobs (model-refresh, usage-refresh,
 *      memory-index, the B2/B8 safety-net reconcilers, and the nightly
 *      sop-learning auto-writer — v4.3.0).
 *   5. Bridge pairing bootstrap (v4.1.2): fire a single non-blocking connect so
 *      the OpenClaw gateway records this command-center as a PENDING pairing
 *      request immediately after deploy.
 *
 * Node-only: better-sqlite3 and node-cron must not load in the edge runtime.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // 1. DB init — migrations + first-boot auto-seed (workspaces + starter SOPs).
  //
  // DATA-02: do NOT swallow a boot-time DB-init failure. getDb() records the
  // failure into module state (getDbInitFailure()) which GET /api/health now
  // surfaces as a deterministic 503 "migration <N> failed". On failure we log
  // LOUDLY and ABORT the rest of boot (registry seed, cron registration, bridge
  // bootstrap) — running background jobs against a half-migrated DB is exactly
  // what corrupts state. We deliberately do NOT re-throw: throwing out of
  // register() crash-loops the worker and thrashes the watchdog with
  // connection-refused instead of a clean 503. Fail-closed = stay up, serve 503,
  // do no further work.
  const dbmod = await import('@/lib/db');
  try {
    dbmod.getDb(); // runs migrations + auto-seed (workspaces + starter SOPs)
    console.log('[instrumentation] DB initialized (migrations + auto-seed ran)');
  } catch (err) {
    const failure = dbmod.getDbInitFailure();
    const which = failure?.migrationId ? `migration ${failure.migrationId}` : 'db open/schema';
    console.error(
      `[instrumentation] FATAL: DB init failed (${which}) — aborting boot wiring; ` +
        `/api/health will report 503 fail-closed. NOT registering cron/bridge against a broken DB:`,
      err,
    );
    return;
  }

  // 2. v4.1.2: hydrate provider API keys from the OpenClaw secret files BEFORE
  // anything reads them. `process.env` (container/host env) is authoritative
  // and never overwritten; this only fills keys that are absent from the
  // process env by reading host /docker/<proj>/.env, ~/.openclaw/.env,
  // ~/.openclaw/secrets/.env, and openclaw.json env/env.vars. Best-effort —
  // a missing/unreadable source is skipped, never thrown. This makes both the
  // Studio gate (hasApiKey) and the weekly refresh (apiKeyFor) see the keys.
  try {
    const { hydrateProviderEnvFromOpenClaw } = await import('@/lib/studio/provider-discovery');
    const hydrated = hydrateProviderEnvFromOpenClaw();
    if (hydrated.length > 0) {
      console.log('[instrumentation] hydrated provider env from OpenClaw files:', hydrated.join(', '));
    }
  } catch (error) {
    console.error('[instrumentation] provider env hydration failed (non-fatal):', error);
  }

  // 3. v4.1.6: seed the Studio `model_registry` on boot IF it is empty.
  //
  // The table is only ever written by the weekly Sunday-03:00 refresh cron, so
  // a fresh deploy showed "No providers configured" in Studio for up to a week
  // until that tick. The lazy seed in `availableModels()` already covers the
  // first Studio read, but this makes the registry populate the moment the
  // worker boots (with keys just hydrated above) — using the OFFLINE provider
  // catalogs, so it needs no network. Fire-and-forget and never-throw: a seed
  // failure must not block boot. Idempotent + single-flight via the shared
  // `ensureRegistrySeeded` guard, and `seedRegistryIfEmpty` no-ops when the
  // table is already populated. Opt out with DISABLE_REGISTRY_BOOT_SEED=1.
  if (process.env.DISABLE_REGISTRY_BOOT_SEED !== '1' && process.env.DISABLE_REGISTRY_BOOT_SEED !== 'true') {
    void (async () => {
      try {
        const { seedRegistryIfEmpty } = await import('@/lib/studio/generators');
        const covered = seedRegistryIfEmpty();
        console.log(`[instrumentation] Studio registry boot seed — ${covered}/3 media tabs have an active model`);
      } catch (error) {
        console.error('[instrumentation] Studio registry boot seed failed (non-fatal):', error);
      }
    })();
  }

  // 4. Register the in-process cron jobs.
  // Dev mode runs both a webpack worker and the page-runtime worker; we only
  // want one scheduler. Skip when explicitly opted out for tests, builds, or
  // CI smoke runs that do not want background jobs to fire.
  if (process.env.DISABLE_CRON === '1' || process.env.DISABLE_CRON === 'true') {
    console.log('[instrumentation] DISABLE_CRON set, skipping cron registration');
    return;
  }

  try {
    const { registerCronJobs } = await import('@/lib/jobs/scheduler');
    const jobs = registerCronJobs();
    console.log('[instrumentation] Cron jobs registered:', jobs.map((j) => j.name).join(', '));
  } catch (error) {
    console.error('[instrumentation] failed to register cron jobs:', error);
  }

  // 5. Bridge pairing bootstrap (v4.1.2): kick a single, non-blocking connect
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
