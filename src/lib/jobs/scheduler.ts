/**
 * Cron scheduler registration for v4.0.1 P0-6.
 *
 * Registers all in-process recurring jobs via node-cron. Idempotent so it can
 * be invoked from `instrumentation.ts` on every boot and from the
 * `/api/cron/register` route without double-scheduling on Next.js hot reload
 * or repeated calls.
 *
 * Jobs:
 *   - model-refresh:  weekly, Sunday 03:00 (server local time)
 *   - usage-refresh:  every 6 hours
 *   - memory-index:   hourly, on the hour
 *
 * Each job is wrapped so a thrown error never crashes the scheduler. Errors
 * are logged and the next tick will run normally.
 */

import * as cron from 'node-cron';
import { refreshModels } from './refresh-models';
import { ALL_PROVIDERS } from '@/lib/model-providers';
import { runExecutionCompletionReconcile } from './execution-watcher';
import { runCeoDelegationSweep } from './ceo-delegation-sweep';

export interface RegisteredJob {
  name: string;
  cron: string;
  nextRun: string | null;
}

/**
 * Process-wide flag so multiple imports / hot reloads do not double-register.
 * Stored on `globalThis` so Next.js' module reloading does not lose it across
 * server-component refreshes in dev.
 */
const REGISTRY_KEY = '__BC_CRON_REGISTERED__';

interface CronGlobals {
  [REGISTRY_KEY]?: boolean;
}

type ScheduledHandle = {
  name?: string;
  getNextRun?: () => Date | null;
};

function alreadyRegistered(): boolean {
  return Boolean((globalThis as unknown as CronGlobals)[REGISTRY_KEY]);
}

function markRegistered(): void {
  (globalThis as unknown as CronGlobals)[REGISTRY_KEY] = true;
}

/**
 * Wrap a task body so thrown errors are caught and logged. node-cron 4 will
 * surface them via the `execution:failed` event, but we want a single log line
 * regardless of the consumer.
 */
function wrap(name: string, fn: () => Promise<unknown> | unknown): () => Promise<void> {
  return async () => {
    const startedAt = new Date().toISOString();
    try {
      console.log(`[cron] ${name} starting at ${startedAt}`);
      await fn();
      console.log(`[cron] ${name} finished`);
    } catch (error) {
      console.error(`[cron] ${name} failed:`, error);
    }
  };
}

/**
 * Job: weekly model registry refresh. Sundays at 03:00 server local time.
 */
async function runModelRefresh(): Promise<void> {
  await refreshModels(ALL_PROVIDERS);
}

/**
 * Job: usage-quota refresh for connectors that expose `fetchUsage()`. Stub
 * until Track B6 (Usage dashboard) wires in the persistence layer. Walks any
 * connector with a `fetchUsage()` method and logs results.
 */
async function runUsageRefresh(): Promise<void> {
  const providersWithUsage = ALL_PROVIDERS.filter((p) => typeof p.fetchUsage === 'function');
  if (providersWithUsage.length === 0) {
    console.log('[cron] usage-refresh: no providers expose fetchUsage(), skipping');
    return;
  }
  // No persistence target exists yet for usage snapshots. Track B6 owns the
  // table + writer. For now we simply confirm the connector responds so a
  // missing API key surfaces in the logs.
  await Promise.allSettled(
    providersWithUsage.map(async (p) => {
      const slug = p.slug;
      const envKey = slug.toUpperCase().replace(/-/g, '_') + '_API_KEY';
      const apiKey = process.env[envKey];
      if (!apiKey) {
        console.log(`[cron] usage-refresh: ${slug} skipped (no ${envKey})`);
        return;
      }
      try {
        await p.fetchUsage?.(apiKey);
        console.log(`[cron] usage-refresh: ${slug} ok`);
      } catch (error) {
        console.warn(`[cron] usage-refresh: ${slug} failed:`, (error as Error).message);
      }
    })
  );
}

/**
 * Job: memory index rebuild. Stub until Track B2 (memory index) wires in the
 * rebuild routine. Logs a heartbeat so the System Status panel can confirm
 * the scheduler ticked.
 */
async function runMemoryIndexRebuild(): Promise<void> {
  console.log('[cron] memory-index: heartbeat (rebuild routine not yet wired)');
}

const JOBS: Array<{ name: string; expr: string; fn: () => Promise<void> }> = [
  { name: 'model-refresh', expr: '0 3 * * 0', fn: runModelRefresh },
  { name: 'usage-refresh', expr: '0 */6 * * *', fn: runUsageRefresh },
  { name: 'memory-index', expr: '0 * * * *', fn: runMemoryIndexRebuild },

  // --- OPTIONAL SAFETY NETS (B2 / B8) ----------------------------------------
  // These two are NOT the primary mechanism. The primary B2 path is the instant
  // agent-completion webhook (which now broadcasts task_updated immediately),
  // and the primary B4/B8 path is in-process routing in createTaskCore. These
  // crons only catch DROPPED events / pre-existing backlog. To disable, delete
  // the entry here (or set EXECUTION_WATCHER_ENABLED=0 /
  // CEO_DELEGATION_SWEEP_ENABLED=0). Kept low-frequency on purpose.
  //
  // execution-reconcile: every 2 minutes, catch in_progress tasks whose
  // TASK_COMPLETE report never reached the webhook.
  { name: 'execution-reconcile', expr: '*/2 * * * *', fn: runExecutionCompletionReconcile },
  // ceo-delegation: every 5 minutes, push CEO-stranded backlog tasks down to
  // the right department (mostly relevant for tasks created before in-process
  // routing shipped).
  { name: 'ceo-delegation', expr: '*/5 * * * *', fn: async () => { runCeoDelegationSweep(); } },
];

/**
 * Register every job. Safe to call multiple times.
 */
export function registerCronJobs(): RegisteredJob[] {
  if (alreadyRegistered()) {
    return listJobs();
  }

  for (const job of JOBS) {
    if (!cron.validate(job.expr)) {
      console.error(`[cron] invalid expression for ${job.name}: ${job.expr}`);
      continue;
    }
    cron.schedule(job.expr, wrap(job.name, job.fn), { name: job.name });
  }

  markRegistered();
  const registered = listJobs();
  console.log(
    '[cron] Cron jobs registered:',
    registered.map((j) => j.name).join(', ')
  );
  return registered;
}

/**
 * List currently registered jobs with their next-run timestamps. Returns the
 * jobs in the order they were defined regardless of node-cron's internal map
 * ordering.
 */
export function listJobs(): RegisteredJob[] {
  const tasks = cron.getTasks();
  const byName = new Map<string, ScheduledHandle>();
  tasks.forEach((task) => {
    const handle = task as unknown as ScheduledHandle;
    if (handle.name) byName.set(handle.name, handle);
  });

  return JOBS.map((j) => {
    const handle = byName.get(j.name);
    let nextRun: string | null = null;
    try {
      const next = handle?.getNextRun?.() ?? null;
      nextRun = next ? next.toISOString() : null;
    } catch {
      nextRun = null;
    }
    return { name: j.name, cron: j.expr, nextRun };
  });
}
