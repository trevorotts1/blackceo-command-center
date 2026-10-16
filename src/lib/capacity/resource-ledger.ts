/**
 * resource-ledger.ts — the LIVE resource picture per provider, on THIS box.
 *
 * WHY THIS EXISTS
 * ---------------
 * Capacity pools (provider-pools.ts) answer "is there a slot free right now".
 * That is half the question a routing decision needs. The other half is money
 * and price: a provider with a free slot and $0.40 left cannot finish a job
 * that costs $4.00, and a provider that bills nothing (a subscription) is not
 * comparable to one that bills per token. This module is the one place that
 * knows both halves, so the scorer and the board read ONE shape instead of
 * three.
 *
 * WHAT A BALANCE IS — AND IS NOT
 * ------------------------------
 * `balance` is a number ONLY when the provider documents an endpoint that
 * returns one and that endpoint answered. Every other case is `null`:
 *   • the provider documents no balance endpoint  → null, probe never attempted
 *   • no API key resolves on this box             → null, `lastProbeError`
 *   • the call failed / timed out / parsed empty  → null, `lastProbeError`
 * A guessed, inferred or "probably plenty" balance is never written. A null
 * balance means UNDETERMINED, and the scorer must treat it as such — never as
 * zero and never as infinite.
 *
 * ENDPOINTS — EVERY ONE READ FROM THE VENDOR'S OWN DOCS, 2026-09-21
 * -----------------------------------------------------------------
 * OpenRouter   GET https://openrouter.ai/api/v1/key
 *              docs https://openrouter.ai/docs/api-reference/limits
 *              "To check the rate limit or credits left on an API key, make a
 *              GET request" — auth `Authorization: Bearer <OPENROUTER_API_KEY>`;
 *              body `{ data: { limit, limit_remaining, usage, ... } }`.
 *              `limit_remaining` is null on an UNCAPPED key: that is not zero
 *              and not a failure, it is "no cap declared" → balance null with
 *              no error recorded.
 *              NOTE: the sibling endpoint GET /api/v1/credits
 *              (https://openrouter.ai/docs/api-reference/get-credits) returns
 *              { data: { total_credits, total_usage } } but requires a
 *              MANAGEMENT key and 403s on an ordinary API key, so it is NOT
 *              the probe — a client box holds an ordinary key.
 *
 * DeepSeek     GET https://api.deepseek.com/user/balance
 *              docs https://api-docs.deepseek.com/api/get-user-balance
 *              body `{ is_available, balance_infos: [{ currency, total_balance,
 *              granted_balance, topped_up_balance }] }` — the amounts are
 *              STRINGS. Auth `Authorization: Bearer ${DEEPSEEK_API_KEY}`, base
 *              url https://api.deepseek.com (https://api-docs.deepseek.com/).
 *
 * Ollama Cloud NO BALANCE ENDPOINT EXISTS.
 *              docs https://docs.ollama.com/api/usage document per-REQUEST
 *              metrics only (prompt_eval_count / eval_count); account quota is
 *              an open feature request (ollama/ollama issues #15663 and
 *              #16448). So: balance null, probe never attempted, no error.
 *              Ollama Cloud is a SUBSCRIPTION, so its per-token price is 0 and
 *              a null balance here is correct rather than missing.
 *
 * Agnes        NO BALANCE ENDPOINT DOCUMENTED.
 *              The gateway is OpenAI-compatible at base
 *              https://apihub.agnes-ai.com/v1 with `Authorization: Bearer`
 *              (https://agnes-ai.com/doc/quick-start); account balance is a
 *              dashboard surface (Billing → Balance), not an API. balance null,
 *              probe never attempted.
 *
 * PRICES ARE NOT INVENTED EITHER
 * ------------------------------
 * `model_registry` (migration 031) already stores `input_cost_per_million` /
 * `output_cost_per_million` per model, populated by the provider connectors
 * from each vendor's own catalog. This module READS that table rather than
 * shipping a second price list that would immediately drift. The only thing on
 * top is an env override for providers whose price the catalog cannot know —
 * a subscription (Ollama Cloud) bills nothing per token, and a provider with no
 * connector (DeepSeek Direct, Agnes) has no catalog row at all.
 *
 * SERVER-ONLY (SQLite + fetch + key stores). Never import from a client
 * component.
 */

import { getDb, queryAll, run } from '@/lib/db';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';
import { canonicalProvider, poolLimit, poolUsage } from '@/lib/capacity/provider-pools';
import type { ModelProvider } from '@/lib/model-providers/types';

/** How long a probed balance stays fresh before `/api/capacity` re-probes. */
export const BALANCE_STALE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.PROVIDER_BALANCE_STALE_MS || '300000', 10) || 300_000,
);

/** Per-probe HTTP budget. A balance probe is never allowed to hold a job lease. */
export const BALANCE_PROBE_TIMEOUT_MS = Math.max(
  1_000,
  Number.parseInt(process.env.PROVIDER_BALANCE_TIMEOUT_MS || '10000', 10) || 10_000,
);

/** One provider's live picture. Every "unknown" is null, never a guess. */
export interface ProviderLedgerEntry {
  /** Provider slug, as `model_registry.provider` and the pool key both spell it. */
  provider: string;
  /** Slots not currently in use, or null when pool state is unavailable. */
  slotsFree: number | null;
  /** The plan's concurrency ceiling, or null when unknown. */
  slotsLimit: number | null;
  /** The limit actually in force (an adaptive limit may sit below the plan's). */
  effectiveLimit: number | null;
  /** ISO timestamp this provider is cooling off until, or null when it is not. */
  coolingUntil: string | null;
  /** Remaining money, or null when the provider does not expose one. */
  balance: number | null;
  /** Currency of `balance`, null whenever `balance` is null. */
  balanceCurrency: string | null;
  /** When `balance` was read, or null when it never was. */
  balanceAsOf: string | null;
  /** USD per million input tokens, or null when no price is known. */
  pricePerMTokIn: number | null;
  /** USD per million output tokens, or null when no price is known. */
  pricePerMTokOut: number | null;
  /** Why the last probe produced no number. Null when it succeeded or was never attempted. */
  lastProbeError: string | null;
}

/** The outcome of one balance probe. `balance: null` is a legitimate answer. */
export interface BalanceProbeResult {
  balance: number | null;
  currency: string | null;
  error: string | null;
}

/**
 * A provider we only need for KEY RESOLUTION. `resolveProviderApiKey` walks
 * process.env → .env files → openclaw.json → the OpenClaw auth store for a
 * slug's candidate names; DeepSeek and Agnes have no model connector on this
 * box, so they have no ModelProvider object to hand it. `fetchModels` is part
 * of the connector contract and is never called on this path.
 */
function keyOnlyProvider(slug: string, envCandidates: readonly string[]): ModelProvider {
  return {
    slug,
    displayName: slug,
    envCandidates,
    fetchModels: async () => [],
  };
}

interface BalanceProbeSpec {
  /** Env-var names this provider's key may live under, in priority order. */
  envCandidates: readonly string[];
  /** The documented balance URL. */
  url: string;
  /** Pull the number out of the parsed body. Returns null when the body says "no cap". */
  parse: (body: unknown) => { balance: number | null; currency: string | null };
}

/**
 * Providers with a DOCUMENTED balance endpoint. A provider absent from this
 * table is not "unsupported" — it is a provider that publishes no balance, and
 * the ledger says so with a null instead of a fiction. Adding a row here
 * requires a vendor doc URL in the header comment above.
 */
export const BALANCE_PROBES: Readonly<Record<string, BalanceProbeSpec>> = {
  // https://openrouter.ai/docs/api-reference/limits
  openrouter: {
    envCandidates: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY', 'OR_API_KEY'],
    url: 'https://openrouter.ai/api/v1/key',
    parse: (body) => {
      const data = (body as { data?: Record<string, unknown> } | null)?.data;
      const remaining = data?.limit_remaining;
      // null limit_remaining = the key declares NO spending cap. Not zero,
      // not an error — simply no number to report.
      if (remaining === null || remaining === undefined) return { balance: null, currency: null };
      const n = Number(remaining);
      return Number.isFinite(n) ? { balance: n, currency: 'USD' } : { balance: null, currency: null };
    },
  },
  // https://api-docs.deepseek.com/api/get-user-balance
  deepseek: {
    envCandidates: ['DEEPSEEK_API_KEY', 'DEEPSEEK_DIRECT_API_KEY'],
    url: 'https://api.deepseek.com/user/balance',
    parse: (body) => {
      const infos = (body as { balance_infos?: unknown } | null)?.balance_infos;
      if (!Array.isArray(infos) || infos.length === 0) return { balance: null, currency: null };
      // `currency` is documented as CNY or USD. Prefer USD so the ledger's
      // numbers are comparable across providers; fall back to whatever the
      // account is denominated in, carrying its currency so nothing is
      // silently compared across denominations later.
      const rows = infos.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
      const picked = rows.find((r) => String(r.currency ?? '').toUpperCase() === 'USD') ?? rows[0];
      if (!picked) return { balance: null, currency: null };
      // total_balance is a STRING in the documented response.
      const n = Number(picked.total_balance);
      return Number.isFinite(n)
        ? { balance: n, currency: String(picked.currency ?? '') || null }
        : { balance: null, currency: null };
    },
  },
};

/**
 * Providers that publish NO balance, with the reason recorded once here so a
 * reader never has to wonder whether the probe is missing or the endpoint is.
 * These are reported with balance null and lastProbeError null — an absent
 * number, not a failure.
 */
export const BALANCE_NOT_EXPOSED: Readonly<Record<string, string>> = {
  // Keyed on the CANONICAL pool name, so `ollama-cloud/…` from the registry and
  // `ollama/…` from the runtime config are the one subscription they really are.
  ollama: 'provider publishes no account-balance endpoint (docs.ollama.com/api/usage is per-request only)',
  agnes: 'provider publishes no account-balance endpoint (balance is a dashboard surface)',
};

/** Injection seam. `fetch` and the key lookup are the only two things a probe
 *  touches outside this module, and a test must be able to replace BOTH: a unit
 *  test that fell through to the real key stores would reach this box's own
 *  credentials and make a live billed call. */
export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  resolveKey?: typeof resolveProviderApiKey;
}

/**
 * Probe one provider's balance. Never throws.
 *
 * Returns `{ balance: null, error: null }` for a provider that publishes no
 * balance, and `{ balance: null, error: '<why>' }` when a documented probe
 * could not produce a number. The two are different facts and the ledger keeps
 * them apart.
 */
export async function probeProviderBalance(
  provider: string,
  deps: ProbeDeps = {},
): Promise<BalanceProbeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveKey = deps.resolveKey ?? resolveProviderApiKey;
  if (provider in BALANCE_NOT_EXPOSED) {
    return { balance: null, currency: null, error: null };
  }
  const spec = BALANCE_PROBES[provider];
  if (!spec) {
    return { balance: null, currency: null, error: null };
  }
  const key = resolveKey(keyOnlyProvider(provider, spec.envCandidates));
  if (!('found' in key) || !key.found) {
    const checked = 'checked' in key ? key.checked.join(', ') : spec.envCandidates.join(', ');
    return { balance: null, currency: null, error: `no api key on this box (checked ${checked})` };
  }
  try {
    const response = await fetchImpl(spec.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key.value}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(BALANCE_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { balance: null, currency: null, error: `HTTP ${response.status} from ${spec.url}` };
    }
    const parsed = spec.parse(await response.json());
    return { balance: parsed.balance, currency: parsed.currency, error: null };
  } catch (err) {
    // The key value is in a header and nowhere else; an error message here can
    // carry a URL and a status, never a secret.
    return { balance: null, currency: null, error: (err as Error).message.slice(0, 200) };
  }
}

/**
 * Per-provider price override, for providers whose per-token price the model
 * catalog cannot know.
 *
 * `PROVIDER_PRICE_OVERRIDE="ollama-cloud=0/0,agnes=0/0"` — USD per million
 * input/output tokens. An entry here WINS over `model_registry`, because it is
 * the operator stating a billing fact the catalog has no way to see (a
 * subscription bills nothing per token; a provider with no connector has no
 * catalog row at all). A malformed entry is skipped, never guessed at.
 */
export function priceOverrides(raw = process.env.PROVIDER_PRICE_OVERRIDE): Record<string, { in: number; out: number }> {
  const out: Record<string, { in: number; out: number }> = {};
  for (const part of (raw || '').split(',')) {
    const [slug, pair] = part.split('=');
    if (!slug?.trim() || !pair) continue;
    const [i, o] = pair.split('/');
    const inNum = Number(i);
    const outNum = Number(o);
    if (!Number.isFinite(inNum) || !Number.isFinite(outNum) || inNum < 0 || outNum < 0) continue;
    out[slug.trim()] = { in: inNum, out: outNum };
  }
  return out;
}

/**
 * The per-provider price actually in force: the env override when the operator
 * declared one, otherwise the CHEAPEST active catalog row for that provider,
 * otherwise null.
 *
 * Cheapest — not average — because the scorer asks "could this provider serve
 * this job within budget", and an average would refuse a provider whose cheap
 * model would have fit.
 *
 * Catalog rows are folded onto CANONICAL pool keys before the minimum is taken:
 * `model_registry` writes `ollama-cloud/…` while the pools count `ollama`, and
 * a price filed under a spelling the ledger never looks up is a price nobody
 * ever sees.
 */
export function catalogPrices(): Record<string, { in: number | null; out: number | null }> {
  const cheapest: Record<string, { in: number | null; out: number | null }> = {};
  try {
    const rows = queryAll<{ provider: string; input_cost_per_million: number; output_cost_per_million: number | null }>(
      `SELECT provider, input_cost_per_million, output_cost_per_million
         FROM model_registry
        WHERE status = 'active' AND input_cost_per_million IS NOT NULL`,
    );
    for (const row of rows) {
      const key = canonicalProvider(row.provider);
      const current = cheapest[key];
      if (!current || current.in === null || row.input_cost_per_million < current.in) {
        cheapest[key] = { in: row.input_cost_per_million, out: row.output_cost_per_million ?? null };
      }
    }
  } catch {
    // Pre-031 database, or a fixture without the catalog. Unknown, not zero.
  }
  return cheapest;
}

export function providerPrice(
  provider: string,
  overrides = priceOverrides(),
  catalog = catalogPrices(),
): { in: number | null; out: number | null } {
  const key = canonicalProvider(provider);
  const override = overrides[key] ?? overrides[provider];
  if (override) return { in: override.in, out: override.out };
  return catalog[key] ?? { in: null, out: null };
}

interface ProviderLedgerRow {
  provider: string;
  balance: number | null;
  balance_currency: string | null;
  balance_as_of: string | null;
  last_probe_error: string | null;
}

/** Read the stored balance rows. Tolerant of a pre-migration database. */
export function storedBalances(): Map<string, ProviderLedgerRow> {
  const map = new Map<string, ProviderLedgerRow>();
  try {
    for (const row of queryAll<ProviderLedgerRow>(
      'SELECT provider, balance, balance_currency, balance_as_of, last_probe_error FROM provider_ledger',
    )) {
      map.set(row.provider, row);
    }
  } catch {
    /* pre-migration box: no stored balances yet, every entry reports null */
  }
  return map;
}

/** True when a stored balance is older than the freshness window (or absent). */
export function isBalanceStale(asOf: string | null | undefined, nowMs = Date.now()): boolean {
  if (!asOf) return true;
  const t = Date.parse(asOf);
  return !Number.isFinite(t) || nowMs - t >= BALANCE_STALE_MS;
}

/** Persist one probe result. Best-effort: a pre-migration box simply keeps null. */
export function writeBalance(provider: string, result: BalanceProbeResult, now = new Date().toISOString()): void {
  try {
    run(
      `INSERT INTO provider_ledger (provider, balance, balance_currency, balance_as_of, last_probe_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         balance = excluded.balance,
         balance_currency = excluded.balance_currency,
         balance_as_of = excluded.balance_as_of,
         last_probe_error = excluded.last_probe_error,
         updated_at = excluded.updated_at`,
      [provider, result.balance, result.currency, result.balance === null ? null : now, result.error, now],
    );
  } catch {
    /* pre-migration tolerant — the ledger degrades to "unknown", never to a guess */
  }
}

/** Pool state for one provider, when the capacity pools are available. */
export interface PoolSnapshot {
  slotsFree: number | null;
  slotsLimit: number | null;
  effectiveLimit: number | null;
  coolingUntil: string | null;
}

const EMPTY_POOL: PoolSnapshot = {
  slotsFree: null,
  slotsLimit: null,
  effectiveLimit: null,
  coolingUntil: null,
};

/**
 * Every provider the ledger should report: the ones with a documented probe,
 * the ones documented as publishing none, and every provider the model catalog
 * on this box actually carries. That last source is what keeps the ledger about
 * THIS client's providers rather than a fixed fleet-wide list.
 */
export function ledgerProviders(): string[] {
  const slugs = new Set<string>([...Object.keys(BALANCE_PROBES), ...Object.keys(BALANCE_NOT_EXPOSED)]);
  try {
    for (const row of queryAll<{ provider: string }>(
      "SELECT DISTINCT provider FROM model_registry WHERE status = 'active'",
    )) {
      if (row.provider) slugs.add(canonicalProvider(row.provider));
    }
  } catch {
    /* pre-031 database: the documented providers are the whole list */
  }
  return [...slugs].sort();
}

/**
 * Slot state per provider, read from the capacity pools and NEVER recomputed
 * here. The pools own occupancy; this module only reports what they say, so the
 * two can never disagree about whether a subscription is full. A provider the
 * pools do not know reports nulls rather than an invented ceiling.
 */
export function poolSnapshots(): (provider: string) => PoolSnapshot {
  let usage: ReturnType<typeof poolUsage> = {};
  try {
    usage = poolUsage();
  } catch {
    /* pre-150 box: no provider column, no cooldown table — nothing attributed */
  }
  return (provider: string) => {
    const key = canonicalProvider(provider);
    const status = usage[key];
    if (!status) return EMPTY_POOL;
    return {
      slotsFree: Math.max(0, status.limit - status.running),
      slotsLimit: poolLimit(key),
      effectiveLimit: status.limit,
      coolingUntil: status.cooling_until ?? null,
    };
  };
}

/**
 * Build the ledger: pool state + stored balance + price, per provider.
 *
 * `pools` is injected so a test can pin slot state without a database; the
 * default reads the real pools. The capacity pools own slot accounting and this
 * module never second-guesses them.
 */
export function readResourceLedger(
  pools: (provider: string) => PoolSnapshot = poolSnapshots(),
): ProviderLedgerEntry[] {
  const stored = storedBalances();
  const overrides = priceOverrides();
  const catalog = catalogPrices();
  return ledgerProviders().map((provider) => {
    const pool = pools(provider) ?? EMPTY_POOL;
    const row = stored.get(provider);
    const price = providerPrice(provider, overrides, catalog);
    return {
      provider,
      slotsFree: pool.slotsFree,
      slotsLimit: pool.slotsLimit,
      effectiveLimit: pool.effectiveLimit,
      coolingUntil: pool.coolingUntil,
      balance: row?.balance ?? null,
      balanceCurrency: row?.balance == null ? null : row.balance_currency ?? null,
      balanceAsOf: row?.balance == null ? null : row.balance_as_of ?? null,
      pricePerMTokIn: price.in,
      pricePerMTokOut: price.out,
      lastProbeError: row?.last_probe_error ?? null,
    };
  });
}

/**
 * Probe every provider whose stored balance is stale and persist the results.
 * Returns what it did, so the scheduler wrapper can log a real line instead of
 * a green tick over nothing.
 *
 * `force` re-probes regardless of freshness (the on-demand path).
 */
export async function refreshProviderBalances(
  opts: ProbeDeps & { force?: boolean; now?: number } = {},
): Promise<{ probed: number; skipped: number; withBalance: number; errors: number }> {
  const nowMs = opts.now ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const stored = storedBalances();
  let probed = 0;
  let skipped = 0;
  let withBalance = 0;
  let errors = 0;

  for (const provider of Object.keys(BALANCE_PROBES)) {
    if (!opts.force && !isBalanceStale(stored.get(provider)?.balance_as_of ?? null, nowMs)) {
      skipped += 1;
      continue;
    }
    const result = await probeProviderBalance(provider, {
      fetchImpl: opts.fetchImpl,
      resolveKey: opts.resolveKey,
    });
    probed += 1;
    if (result.balance !== null) withBalance += 1;
    if (result.error) errors += 1;
    writeBalance(provider, result, nowIso);
  }

  // Providers documented as publishing no balance get their row written once
  // so `/api/capacity` can say "not exposed" from the ledger itself rather
  // than from a hardcoded list in a UI.
  for (const provider of Object.keys(BALANCE_NOT_EXPOSED)) {
    if (stored.has(provider)) continue;
    writeBalance(provider, { balance: null, currency: null, error: null }, nowIso);
  }

  return { probed, skipped, withBalance, errors };
}

/** Ensure the table exists for a caller that runs before migrations (tests, probes). */
export function ensureProviderLedgerTable(db = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_ledger (
      provider TEXT PRIMARY KEY,
      balance REAL,
      balance_currency TEXT,
      balance_as_of TEXT,
      last_probe_error TEXT,
      updated_at TEXT NOT NULL
    )
  `);
}
