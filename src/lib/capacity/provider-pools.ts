/**
 * provider-pools.ts — concurrency is a property of the PROVIDER PLAN, not of the agent.
 *
 * v7.6.27 gave each agent its own ceiling (`agents.max_concurrent_executions`,
 * default 1). That is the wrong unit. What actually limits throughput on a box
 * is the plan the client pays for: Ollama Cloud Pro allows 3 concurrent
 * requests, Ollama Cloud Max allows 10 (the operator ceiling is 8), DeepSeek
 * Direct documents 2,500, and OpenRouter is effectively unbounded. An agent is
 * not the thing that runs out — the subscription is. Encoding the limit per
 * agent meant a plan upgrade had to be re-entered on every agent row before the
 * box could use what was just bought, and a box running four agents on one
 * Ollama subscription could exceed that subscription without any single agent
 * exceeding its own ceiling.
 *
 * So the limit lives here, keyed by the PROVIDER PREFIX of the runtime model id
 * (`ollama/deepseek-v4.1-flash:cloud` → `ollama`). Every client box has exactly
 * one of each subscription, so one pool per provider per box is the whole model.
 * Upgrading a plan is ONE setting — an environment variable or one key in
 * `company-config.json` — and every agent on the box immediately takes more work.
 *
 * Nothing here is per-client: the table is defaults for the products themselves,
 * and a box that pays for more says so in its own config.
 */

import { getDb } from '@/lib/db';
import { loadCompanyConfig } from '@/lib/company-config';
// The one value shared with execution-attempts. It lives in the schema module
// so neither of those two files has to import the other.
import { ACTIVE_EXECUTION_STATES_SQL } from '@/lib/execution-schema';
import type Database from 'better-sqlite3';

/**
 * Default concurrent executions per provider pool, per box.
 *
 * These are deliberately CONSERVATIVE against each product's published ceiling:
 * the Command Center is not the only thing on the box that may be talking to a
 * provider, and being refused by the provider is worse than queueing here.
 *   ollama      3 — Ollama Cloud Pro. A Max box raises it to 8 in its own config.
 *   openrouter 20 — effectively unlimited upstream; 20 is a sanity bound, not a plan.
 *   deepseek   50 — DeepSeek Direct documents 2,500; 50 is what one box will ever want.
 *   9router     8 — the local router fans out to whatever it proxies.
 *   google      8
 *   agnes       4
 *   xiaomi      4
 *   moonshot    4
 *   default     2 — an unrecognised or bare (un-prefixed) model id.
 */
export const DEFAULT_PROVIDER_CONCURRENCY: Readonly<Record<string, number>> = Object.freeze({
  ollama: 3,
  openrouter: 20,
  deepseek: 50,
  agnes: 4,
  '9router': 8,
  google: 8,
  xiaomi: 4,
  moonshot: 4,
  default: 2,
});

/** The pool a model id with no provider prefix, or an unreadable one, belongs to. */
export const DEFAULT_POOL = 'default';

/**
 * Spellings of the same product that appear in real model ids on this fleet.
 * The registry writes `ollama-cloud/…` while the runtime config writes
 * `ollama/…` for the SAME subscription — counting those as two pools would let
 * one box run double its plan.
 */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'ollama-cloud': 'ollama',
  ollama_cloud: 'ollama',
  ollamacloud: 'ollama',
  'openrouter.ai': 'openrouter',
  'open-router': 'openrouter',
  'deepseek-direct': 'deepseek',
  'nine-router': '9router',
  '9-router': '9router',
});

/** Operator-facing name of a pool, for the hold message on a queued card. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = Object.freeze({
  ollama: 'Ollama Cloud',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek Direct',
  agnes: 'Agnes AI',
  '9router': '9Router',
  google: 'Google',
  xiaomi: 'Xiaomi',
  moonshot: 'Moonshot',
  [DEFAULT_POOL]: 'Unrecognised provider',
});

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Fold a raw provider spelling onto its canonical pool key. */
export function canonicalProvider(raw: string | null | undefined): string {
  const s = (raw ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (!s) return DEFAULT_POOL;
  return PROVIDER_ALIASES[s] ?? s;
}

/**
 * The pool a runtime model id belongs to — the segment before the FIRST slash.
 * `openrouter/deepseek/deepseek-v4-flash` is OpenRouter's capacity, not
 * DeepSeek's: the wrapper is who rate-limits the call. A bare id (no slash)
 * records no provider at all and falls to the default pool.
 */
export function providerOf(modelId: string | null | undefined): string {
  const s = (modelId ?? '').trim();
  if (!s) return DEFAULT_POOL;
  const slash = s.indexOf('/');
  if (slash <= 0) return DEFAULT_POOL;
  return canonicalProvider(s.slice(0, slash));
}

/** `ollama` → `PROVIDER_CONCURRENCY_OLLAMA`; `9router` → `PROVIDER_CONCURRENCY_9ROUTER`. */
function envKeyFor(provider: string): string {
  return `PROVIDER_CONCURRENCY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * Per-box `provider_concurrency` overrides out of `company-config.json`.
 * Never throws: the config loader touches the filesystem, and a capacity read
 * happens on the dispatch path where a missing config file must not be fatal.
 */
function configuredOverrides(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const raw = loadCompanyConfig().provider_concurrency;
    if (!raw || typeof raw !== 'object') return out;
    for (const [key, value] of Object.entries(raw)) {
      const n = positiveInt(value);
      if (n !== null) out[canonicalProvider(key)] = n;
    }
  } catch {
    /* no config on this box, or it is unreadable — defaults stand. */
  }
  return out;
}

/**
 * How many executions this provider's pool may run at once on this box.
 *
 * Precedence, highest first: the `PROVIDER_CONCURRENCY_<PROVIDER>` environment
 * variable, `provider_concurrency` in `company-config.json`, the default table,
 * and finally the `default` pool's own limit for a provider nobody has named.
 * A plan upgrade is exactly one of those two settings.
 */
export function poolLimit(provider: string): number {
  const pool = canonicalProvider(provider);
  const fromEnv = positiveInt(process.env[envKeyFor(pool)]);
  if (fromEnv !== null) return fromEnv;
  const fromConfig = configuredOverrides()[pool];
  if (fromConfig) return fromConfig;
  const fromTable = DEFAULT_PROVIDER_CONCURRENCY[pool];
  if (fromTable) return fromTable;
  return positiveInt(process.env[envKeyFor(DEFAULT_POOL)]) ?? DEFAULT_PROVIDER_CONCURRENCY[DEFAULT_POOL];
}

// ── Rate-limit backoff ───────────────────────────────────────────────────────

/** How long a pool stays shut after the provider answered 429 (ms). */
export const PROVIDER_COOLDOWN_MS = positiveInt(process.env.PROVIDER_COOLDOWN_MS) ?? 30_000;

/**
 * True when a failure text is the provider saying "slow down".
 * A 429 is a capacity fact about the POOL, not a fault of the card that hit it,
 * which is why it buys a cooldown instead of a dispatch attempt.
 */
export function isRateLimitError(text: unknown): boolean {
  const s = typeof text === 'string' ? text : (text as Error | undefined)?.message ?? String(text ?? '');
  return /429|rate.?limit|too many requests/i.test(s);
}

/** Shut this pool until now + PROVIDER_COOLDOWN_MS. Never throws. */
export function noteProviderRateLimit(
  provider: string | null | undefined,
  db: Database.Database = getDb(),
  nowMs = Date.now(),
): string | null {
  const pool = canonicalProvider(provider);
  const until = new Date(nowMs + PROVIDER_COOLDOWN_MS).toISOString();
  try {
    db.prepare(
      `INSERT INTO provider_cooldowns(provider,until,updated_at) VALUES(?,?,?)
       ON CONFLICT(provider) DO UPDATE SET until=excluded.until,updated_at=excluded.updated_at
       WHERE excluded.until > provider_cooldowns.until`,
    ).run(pool, until, new Date(nowMs).toISOString());
    return until;
  } catch {
    return null; // pre-migration box: no cooldown table, so no cooldown.
  }
}

/** The instant this pool reopens, or null when it is open now. Never throws. */
export function providerCoolingUntil(
  provider: string | null | undefined,
  db: Database.Database = getDb(),
  now = new Date().toISOString(),
): string | null {
  try {
    const row = db
      .prepare('SELECT until FROM provider_cooldowns WHERE provider=? AND until > ?')
      .get(canonicalProvider(provider), now) as { until?: string } | undefined;
    return row?.until ?? null;
  } catch {
    return null;
  }
}

// ── Observability ────────────────────────────────────────────────────────────

export interface PoolStatus {
  running: number;
  limit: number;
  cooling_until: string | null;
}

/**
 * Live pool occupancy for `/api/health` — ONE GROUP BY over the active
 * executions plus one read of the cooldown table, so polling it is cheap.
 * Executions written before the provider column existed carry NULL and are
 * counted into no pool: an unknown provider is not evidence of load on any
 * particular one, and those rows drain within a lease.
 */
export function poolUsage(db: Database.Database = getDb()): Record<string, PoolStatus> {
  let counts: { provider: string | null; n: number }[] = [];
  try {
    counts = db
      .prepare(
        `SELECT provider, COUNT(*) AS n FROM task_executions
          WHERE provider IS NOT NULL AND state IN ${ACTIVE_EXECUTION_STATES_SQL}
          GROUP BY provider`,
      )
      .all() as { provider: string | null; n: number }[];
  } catch {
    /* pre-migration box: no provider column, so nothing is attributed yet. */
  }
  let cooldowns: { provider: string; until: string }[] = [];
  try {
    cooldowns = db.prepare('SELECT provider,until FROM provider_cooldowns').all() as {
      provider: string;
      until: string;
    }[];
  } catch {
    /* pre-migration box: no cooldown table. */
  }

  const now = new Date().toISOString();
  const running = new Map<string, number>();
  for (const row of counts) running.set(canonicalProvider(row.provider), row.n);
  const cooling = new Map<string, string>();
  for (const row of cooldowns) if (row.until > now) cooling.set(canonicalProvider(row.provider), row.until);

  const pools = new Set<string>([
    ...Object.keys(DEFAULT_PROVIDER_CONCURRENCY),
    ...Object.keys(configuredOverrides()),
    ...running.keys(),
    ...cooling.keys(),
  ]);
  const out: Record<string, PoolStatus> = {};
  for (const pool of Array.from(pools).sort()) {
    out[pool] = {
      running: running.get(pool) ?? 0,
      limit: poolLimit(pool),
      cooling_until: cooling.get(pool) ?? null,
    };
  }
  return out;
}
