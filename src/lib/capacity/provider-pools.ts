/**
 * provider-pools.ts — concurrency is a property of the PROVIDER PLAN, not of the agent.
 *
 * v7.6.27 gave each agent its own ceiling (`agents.max_concurrent_executions`,
 * default 1). That is the wrong unit. What actually limits throughput on a box
 * is the plan the client pays for: Ollama Cloud Pro allows 3 concurrent
 * requests, Max allows 10 (the operator ceiling is 8), DeepSeek Direct
 * documents 2,500, and OpenRouter is effectively unbounded. An agent is not the
 * thing that runs out — the subscription is. Encoding the limit per agent meant
 * a plan upgrade had to be re-entered on every agent row before the box could
 * use what was just bought, and a box running four agents on one Ollama
 * subscription could exceed that subscription without any single agent
 * exceeding its own ceiling.
 *
 * So the limit lives here, keyed by the PROVIDER PREFIX of the runtime model id
 * (`ollama/deepseek-v4.1-flash:cloud` → `ollama`). Every client box has exactly
 * one of each subscription, so one pool per provider per box is the whole model.
 *
 * THREE WAYS THE LIMIT MOVES, cheapest first:
 *   • a PLAN TIER — `PROVIDER_PLAN_OLLAMA=max` — the friendly spelling of an
 *     upgrade, so nobody has to remember that Max means 8;
 *   • a raw number — `PROVIDER_CONCURRENCY_OLLAMA=8` — which always wins over
 *     the tier, for a plan the tier table does not know about;
 *   • SELF-CALIBRATION — the pool shrinks itself when the provider says 429 and
 *     grows back on its own once the provider has been quiet. A published
 *     ceiling is not always the ceiling you get, and a table in this file cannot
 *     know what a given account is actually being allowed today.
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
 *   ollama      3 — Ollama Cloud Pro. A Max box says `PROVIDER_PLAN_OLLAMA=max`.
 *   openrouter 100 — effectively unlimited upstream.
 *   deepseek   500 — DeepSeek Direct documents 2,500.
 *   agnes       50 — every Agnes client runs agnes-3.0-flash.
 *   9router      8 — the local router fans out to whatever it proxies.
 *   google       8
 *   xiaomi       4
 *   moonshot     4
 *   default      2 — an unrecognised or bare (un-prefixed) model id.
 */
export const DEFAULT_PROVIDER_CONCURRENCY: Readonly<Record<string, number>> = Object.freeze({
  ollama: 3,
  openrouter: 100,
  deepseek: 500,
  agnes: 50,
  '9router': 8,
  google: 8,
  xiaomi: 4,
  moonshot: 4,
  default: 2,
});

/**
 * Plan names, so an upgrade is spelled the way it was bought rather than as a
 * number somebody has to look up.
 *
 * Ollama Cloud Max documents 10 concurrent; `max` maps to the OPERATOR CEILING
 * of 8, deliberately under it, because the Command Center is not the only thing
 * on a box that may be talking to the subscription and being refused by the
 * provider is worse than queueing here. A box that really wants all 10 says
 * `PROVIDER_CONCURRENCY_OLLAMA=10` and owns that decision.
 */
export const PROVIDER_PLAN_TIERS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  ollama: Object.freeze({ pro: 3, max: 8 }),
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

/** `ollama` → `OLLAMA`; `9router` → `9ROUTER`. */
function envSuffix(provider: string): string {
  return provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** A plan name → its concurrency, or null when the provider has no tier table
 * or the name is not one of its plans. A misspelled plan is said out loud once
 * rather than silently resolving to the default. */
function tierLimit(provider: string, plan: unknown): number | null {
  const name = String(plan ?? '').trim().toLowerCase();
  if (!name) return null;
  const tiers = PROVIDER_PLAN_TIERS[provider];
  if (!tiers) {
    console.warn(`[provider-pools] "${provider}" has no plan tiers; use PROVIDER_CONCURRENCY_${envSuffix(provider)}=<n>`);
    return null;
  }
  const limit = tiers[name];
  if (!limit) {
    console.warn(`[provider-pools] unknown ${provider} plan "${name}"; known plans: ${Object.keys(tiers).join(', ')}`);
    return null;
  }
  return limit;
}

/** Per-box overrides out of `company-config.json`. Never throws: the config
 * loader touches the filesystem, and a capacity read happens on the dispatch
 * path where a missing config file must not be fatal. */
function companyOverrides(): { concurrency: Record<string, number>; plans: Record<string, unknown> } {
  const concurrency: Record<string, number> = {};
  const plans: Record<string, unknown> = {};
  try {
    const config = loadCompanyConfig();
    for (const [key, value] of Object.entries(config.provider_concurrency ?? {})) {
      const n = positiveInt(value);
      if (n !== null) concurrency[canonicalProvider(key)] = n;
    }
    for (const [key, value] of Object.entries(config.provider_plans ?? {})) plans[canonicalProvider(key)] = value;
  } catch {
    /* no config on this box, or it is unreadable — defaults stand. */
  }
  return { concurrency, plans };
}

/**
 * The CONFIGURED limit for this pool — what the plan allows, before any
 * self-calibration. Precedence, highest first: a raw number in the environment,
 * a plan tier in the environment, a raw number in `company-config.json`, a plan
 * tier in `company-config.json`, the default table, and finally the `default`
 * pool's own limit for a provider nobody has named.
 */
export function poolLimit(provider: string): number {
  const pool = canonicalProvider(provider);
  const suffix = envSuffix(pool);
  const fromEnv = positiveInt(process.env[`PROVIDER_CONCURRENCY_${suffix}`]);
  if (fromEnv !== null) return fromEnv;
  const fromEnvPlan = tierLimit(pool, process.env[`PROVIDER_PLAN_${suffix}`]);
  if (fromEnvPlan !== null) return fromEnvPlan;
  const overrides = companyOverrides();
  if (overrides.concurrency[pool]) return overrides.concurrency[pool];
  const fromConfigPlan = tierLimit(pool, overrides.plans[pool]);
  if (fromConfigPlan !== null) return fromConfigPlan;
  const fromTable = DEFAULT_PROVIDER_CONCURRENCY[pool];
  if (fromTable) return fromTable;
  return positiveInt(process.env[`PROVIDER_CONCURRENCY_${envSuffix(DEFAULT_POOL)}`]) ?? DEFAULT_PROVIDER_CONCURRENCY[DEFAULT_POOL];
}

// ── Self-calibration ─────────────────────────────────────────────────────────

/** How long a pool stays shut after the provider answered 429 (ms). */
export const PROVIDER_COOLDOWN_MS = positiveInt(process.env.PROVIDER_COOLDOWN_MS) ?? 30_000;
/** How quiet a provider must be before the pool grows back by one (ms). */
export const PROVIDER_RECOVERY_MS = positiveInt(process.env.PROVIDER_RECOVERY_MS) ?? 15 * 60_000;

/**
 * True when a failure text is the provider saying "slow down".
 * A 429 is a capacity fact about the POOL, not a fault of the card that hit it,
 * which is why it buys a cooldown instead of a dispatch attempt.
 */
export function isRateLimitError(text: unknown): boolean {
  const s = typeof text === 'string' ? text : (text as Error | undefined)?.message ?? String(text ?? '');
  return /429|rate.?limit|too many requests/i.test(s);
}

interface PoolStateRow {
  provider: string;
  effective_limit: number | null;
  last_429_at: string | null;
  cooling_until: string | null;
}

function poolState(provider: string, db: Database.Database): PoolStateRow | undefined {
  try {
    return db.prepare('SELECT * FROM provider_pool_state WHERE provider=?').get(provider) as PoolStateRow | undefined;
  } catch {
    return undefined; // pre-migration box: no state table, so no calibration.
  }
}

/**
 * The limit actually in force: the configured limit, lowered by whatever the
 * provider has taught us. Clamped to the configured value so LOWERING a plan
 * takes effect at once rather than waiting for a 429, and floored at 1 so a
 * pool can never calibrate itself shut.
 */
export function effectiveLimit(provider: string, db: Database.Database = getDb()): number {
  const pool = canonicalProvider(provider);
  const configured = poolLimit(pool);
  const learned = poolState(pool, db)?.effective_limit;
  if (typeof learned !== 'number' || !Number.isFinite(learned) || learned <= 0) return configured;
  return Math.max(1, Math.min(configured, Math.floor(learned)));
}

/**
 * The provider refused for rate: shut the pool for PROVIDER_COOLDOWN_MS AND
 * lower the effective limit by one. The cooldown handles the next few seconds;
 * the lowered limit is what stops us walking back into the same wall in ten
 * minutes' time. Never throws.
 */
export function noteProviderRateLimit(
  provider: string | null | undefined,
  db: Database.Database = getDb(),
  nowMs = Date.now(),
): { until: string; effective_limit: number } | null {
  const pool = canonicalProvider(provider);
  const now = new Date(nowMs).toISOString();
  const until = new Date(nowMs + PROVIDER_COOLDOWN_MS).toISOString();
  try {
    const current = effectiveLimit(pool, db);
    const lowered = Math.max(1, current - 1);
    db.prepare(
      `INSERT INTO provider_pool_state(provider,effective_limit,last_429_at,cooling_until,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(provider) DO UPDATE SET
         effective_limit=excluded.effective_limit,
         last_429_at=excluded.last_429_at,
         cooling_until=MAX(COALESCE(provider_pool_state.cooling_until,''),excluded.cooling_until),
         updated_at=excluded.updated_at`,
    ).run(pool, lowered, now, until, now);
    return { until, effective_limit: lowered };
  } catch {
    return null; // pre-migration box: no state table, so no cooldown.
  }
}

/** The instant this pool reopens, or null when it is open now. Never throws. */
export function providerCoolingUntil(
  provider: string | null | undefined,
  db: Database.Database = getDb(),
  now = new Date().toISOString(),
): string | null {
  const until = poolState(canonicalProvider(provider), db)?.cooling_until ?? null;
  return until && until > now ? until : null;
}

/**
 * Grow every calibrated-down pool back by one, for providers that have been
 * quiet for PROVIDER_RECOVERY_MS. Returns how many pools were raised.
 *
 * ONE step per call on purpose: the shrink is evidence (a real 429) and the
 * growth is a guess, so the guess walks back slowly and re-shrinks instantly
 * if it was wrong. A row that has climbed back to its configured limit is
 * deleted rather than left behind, so a pool with nothing to say holds no row.
 *
 * Rides the existing execution-reconcile tick — no new job, no new lease. The
 * quiet window is enforced by `last_429_at`, not by the cron cadence, so a
 * faster tick only notices sooner, it never grows faster.
 */
export function growProviderPools(db: Database.Database = getDb(), nowMs = Date.now()): number {
  let raised = 0;
  try {
    const quietBefore = new Date(nowMs - PROVIDER_RECOVERY_MS).toISOString();
    const rows = db
      .prepare('SELECT * FROM provider_pool_state WHERE effective_limit IS NOT NULL AND (last_429_at IS NULL OR last_429_at < ?)')
      .all(quietBefore) as PoolStateRow[];
    const now = new Date(nowMs).toISOString();
    for (const row of rows) {
      const configured = poolLimit(row.provider);
      const current = Math.max(1, Math.min(configured, row.effective_limit ?? configured));
      if (current >= configured) {
        db.prepare('DELETE FROM provider_pool_state WHERE provider=? AND (cooling_until IS NULL OR cooling_until < ?)').run(row.provider, now);
        continue;
      }
      db.prepare('UPDATE provider_pool_state SET effective_limit=?,updated_at=? WHERE provider=?').run(current + 1, now, row.provider);
      raised += 1;
    }
  } catch {
    /* pre-migration box: nothing to grow. */
  }
  return raised;
}

// ── Choosing a pool (primary, then the agent's own fallbacks) ────────────────

export interface PoolProbe {
  /** Pool key. */
  provider: string;
  /** The model id from the agent's own list that put us in this pool. */
  model: string | null;
  running: number;
  /** The limit in force — already calibrated. */
  limit: number;
  cooling_until: string | null;
  room: boolean;
}

/** Live occupancy of ONE pool. Reads through the caller's `db`, so when that
 * caller is inside BEGIN IMMEDIATE this count is serialized with its insert. */
export function probePool(
  provider: string,
  db: Database.Database,
  excludeTaskId?: string,
  model: string | null = null,
): PoolProbe {
  const pool = canonicalProvider(provider);
  const limit = effectiveLimit(pool, db);
  const cooling = providerCoolingUntil(pool, db);
  let running = 0;
  try {
    running = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM task_executions
          WHERE provider = ? AND state IN ${ACTIVE_EXECUTION_STATES_SQL}${excludeTaskId ? ' AND task_id <> ?' : ''}`,
      )
      .get(...(excludeTaskId ? [pool, excludeTaskId] : [pool])) as { n: number }).n;
  } catch {
    /* pre-migration box: no provider column, so nothing is attributed yet. */
  }
  return { provider: pool, model, running, limit, cooling_until: cooling, room: !cooling && running < limit };
}

/**
 * Probe the agent's OWN model list — primary first, then its configured
 * fallbacks — WITHOUT choosing among them.
 *
 * THE ACCOUNTING STAYS ON THE PRIMARY. An earlier draft of this module let a
 * full primary pool "overflow": it debited the first fallback pool with room and
 * dispatched anyway, on the theory that the runtime would land the run there
 * because the primary was saturated. That theory does not survive contact with
 * the runtime. The OpenClaw runtime advances its fallback chain ONLY on
 * `candidate_failed` or `skip_candidate` (read from the installed dist), i.e.
 * only after an attempt actually fails — it has no knowledge of this box's
 * pools and cannot pre-empt on capacity. So the run always ATTEMPTS the primary
 * first, and it falls back only if that attempt is refused.
 *
 * That makes the overflow debit a lie in exactly the case the pool exists to
 * catch. Our limit is a number in this repo, not the provider's; when it is
 * conservative, the primary accepts the run, the primary now carries one more
 * concurrent request than we configured, and our books credit that load to a
 * fallback that is doing nothing. The pool would under-count the one
 * subscription it is meant to protect — and the error is anti-conservative,
 * not safe.
 *
 * So the fallbacks are read for VISIBILITY only: a refusal names which of them
 * have room, which is what the owner needs in order to act (re-point the
 * agent's primary, or raise the plan). Nothing is ever added to the list, and
 * no pool but the primary is ever debited.
 */
export function probeChain(
  chain: readonly string[],
  db: Database.Database,
  excludeTaskId?: string,
): { primary: PoolProbe; fallbacks: PoolProbe[] } {
  const models = chain.length ? chain : [''];
  const probes = models.map((model) => probePool(providerOf(model), db, excludeTaskId, model || null));
  return { primary: probes[0], fallbacks: probes.slice(1) };
}

/**
 * What the operator sees on a queued card: why the primary is refusing, and
 * where there IS room among the models this agent already declares.
 *
 * "Ollama Cloud 3/3 full; Agnes AI 1/50 and OpenRouter 0/100 have room" — the
 * second half is the actionable part, and it is deliberately NOT a promise that
 * the run will go there.
 */
export function poolPressureSummary(primary: PoolProbe, fallbacks: readonly PoolProbe[]): string {
  const head = `${providerLabel(primary.provider)} ${primary.running}/${primary.limit}${primary.cooling_until ? ' (cooling)' : ' full'}`;
  const open = fallbacks.filter((p) => p.room);
  if (!open.length) {
    return fallbacks.length
      ? `${head}; no fallback has room (${fallbacks.map((p) => `${providerLabel(p.provider)} ${p.running}/${p.limit}`).join(', ')})`
      : `${head}; this agent declares no fallback`;
  }
  return `${head}; ${open.map((p) => `${providerLabel(p.provider)} ${p.running}/${p.limit}`).join(' and ')} have room`;
}

// ── Observability ────────────────────────────────────────────────────────────

export interface PoolStatus {
  running: number;
  /** What the plan allows. */
  configured_limit: number;
  /** What is in force after self-calibration — lower than configured after a 429. */
  limit: number;
  cooling_until: string | null;
  last_429_at: string | null;
}

/**
 * Live pool occupancy for `/api/health` — ONE GROUP BY over the active
 * executions plus one read of the state table, so polling it is cheap.
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
  let states: PoolStateRow[] = [];
  try {
    states = db.prepare('SELECT * FROM provider_pool_state').all() as PoolStateRow[];
  } catch {
    /* pre-migration box: no state table. */
  }

  const now = new Date().toISOString();
  const running = new Map<string, number>();
  for (const row of counts) running.set(canonicalProvider(row.provider), row.n);
  const stateByPool = new Map<string, PoolStateRow>();
  for (const row of states) stateByPool.set(canonicalProvider(row.provider), row);

  const overrides = companyOverrides();
  const pools = new Set<string>([
    ...Object.keys(DEFAULT_PROVIDER_CONCURRENCY),
    ...Object.keys(overrides.concurrency),
    ...Object.keys(overrides.plans),
    ...running.keys(),
    ...stateByPool.keys(),
  ]);
  const out: Record<string, PoolStatus> = {};
  for (const pool of Array.from(pools).sort()) {
    const configured = poolLimit(pool);
    const state = stateByPool.get(pool);
    const learned = state?.effective_limit;
    const cooling = state?.cooling_until && state.cooling_until > now ? state.cooling_until : null;
    out[pool] = {
      running: running.get(pool) ?? 0,
      configured_limit: configured,
      limit:
        typeof learned === 'number' && Number.isFinite(learned) && learned > 0
          ? Math.max(1, Math.min(configured, Math.floor(learned)))
          : configured,
      cooling_until: cooling,
      last_429_at: state?.last_429_at ?? null,
    };
  }
  return out;
}
