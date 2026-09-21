/**
 * route-scorer.ts — which of the agent's OWN models should serve this card, and
 * why, in numbers an owner can read.
 *
 * WHAT THIS ADDS TO THE POOLS
 * ---------------------------
 * v7.6.39 made a saturated pool OVERFLOW: `reserveExecution` walks the agent's
 * own ordered model chain and debits the first pool with room, so the box
 * already answers "is there a slot". It answers that on SLOTS ALONE. Three
 * things it cannot see:
 *
 *   • MONEY. A pool with a free slot and forty cents left is not a usable pool.
 *   • TIME. A card due in ten minutes cannot go to a provider this box has
 *     measured at thirty.
 *   • WHY. The overflow writes an activity row; the CARD still said nothing
 *     about which subscription it was waiting on, or what it would cost to go
 *     elsewhere.
 *
 * This module scores the SAME chain on those dimensions and writes one sentence
 * onto the card, plus the `askWorthy` fact the ask-at-capacity gate consumes.
 *
 * IT DOES NOT REORDER THE CHAIN, AND MUST NOT.
 * The debit is a PREDICTION of what the OpenClaw runtime will do: the gateway
 * takes no per-run model (chat.send rejects one), so the run lands wherever the
 * runtime's own failover puts it — and the runtime walks `model.fallbacks` in
 * CONFIG order. Re-ordering the chain here would make the box debit a pool the
 * runtime was never going to use, which is worse than the naive pick: a wrong
 * prediction is a corrupted count, and the count is the whole point of a pool.
 * So the scorer reports, and the config order rules.
 *
 * SOVEREIGNTY. The chain comes from `resolveRuntimeModelChainFromConfig` — the
 * SAME reader the reservation uses, so the two can never disagree about what
 * the agent declares. Nothing adds a model the client did not put in their own
 * config, and nothing writes that config back.
 *
 * NOTHING IS GUESSED. Every dimension returns `null` when the box cannot know
 * it, and a null NEVER refuses a candidate:
 *   • balance null (provider publishes none, or no key)  → affordability unknown
 *   • no completed run for a provider yet                → latency unknown
 *   • no deadline on the card                            → deadline not a factor
 * A scorer that read "unknown" as "no" would refuse the only provider a client
 * can always reach. See resource-ledger.ts for why a null balance is never zero.
 */

import { queryAll, queryOne, run } from '@/lib/db';
import { canonicalProvider, providerLabel, providerOf } from '@/lib/capacity/provider-pools';
import { readResourceLedger, type ProviderLedgerEntry } from '@/lib/capacity/resource-ledger';
import { resolveRuntimeModelChainFromConfig } from '@/lib/runtime-model';
import type { Agent } from '@/lib/types';

/** Balance at or below which a provider is treated as effectively out of money. */
export const BALANCE_FLOOR = Math.max(
  0,
  Number.parseFloat(process.env.PROVIDER_BALANCE_FLOOR || '1') || 1,
);

/** How many completed runs back the latency history looks. */
export const LATENCY_SAMPLE_LIMIT = Math.max(
  3,
  Number.parseInt(process.env.PROVIDER_LATENCY_SAMPLE || '25', 10) || 25,
);

/**
 * Quality tier per task kind, highest first. A tier is a preference ORDER over
 * providers for that kind of work, not a claim about any model's absolute
 * quality — it decides ties, never whether a candidate is allowed.
 *
 * Override per box with `ROUTE_QUALITY_<KIND>="openrouter,ollama"`.
 */
export const DEFAULT_QUALITY_ORDER: Readonly<Record<string, readonly string[]>> = Object.freeze({
  code: ['openrouter', 'deepseek', 'ollama'],
  research: ['openrouter', 'ollama', 'deepseek'],
  content: ['ollama', 'openrouter', 'agnes'],
  ops: ['ollama', 'deepseek', 'openrouter'],
});

export type TaskKind = keyof typeof DEFAULT_QUALITY_ORDER;

/** One candidate, scored. Every field that the box cannot know is null. */
export interface ScoredCandidate {
  /** The model id exactly as the agent's own config spells it. */
  modelId: string;
  /** Canonical pool key for that model id. */
  provider: string;
  /** True when the pool has a free slot and is not cooling. Null when the pools do not know it. */
  canStartNow: boolean | null;
  /** Free slots right now, or null when unknown. */
  slotsFree: number | null;
  /** False ONLY when a KNOWN balance sits at or below the floor. Null when the balance is unknown. */
  affordable: boolean | null;
  /** Remaining balance, or null when the provider publishes none / no key resolved. */
  balance: number | null;
  /** Median measured wall time for this provider, in ms, or null with no history. */
  medianLatencyMs: number | null;
  /** False ONLY when a MEASURED latency says the deadline cannot be met. Null when unknown or no deadline. */
  meetsDeadline: boolean | null;
  /** Position in the quality order for this task kind; lower is better. Unlisted providers sort last. */
  qualityRank: number;
  /** Cheapest known input price per million tokens, or null. */
  pricePerMTokIn: number | null;
  /** The instant this provider's pool reopens, when it is shut. */
  coolingUntil: string | null;
}

export interface RouteDecision {
  /** The agent's own preferred model — `model.primary`. Null when the agent has no config entry. */
  preferred: ScoredCandidate | null;
  /** The best-fitting candidate among the agent's own declared models. */
  recommended: ScoredCandidate | null;
  /** Every candidate, in the CONFIG order the runtime will walk them. */
  candidates: ScoredCandidate[];
  /**
   * The chain entry the reservation is expected to overflow onto — the first
   * one after the preferred that is not blocked. Null when the preferred is
   * fine, or when nothing further is usable.
   */
  overflowTo: ScoredCandidate | null;
  /** True when no model this agent declares can serve the card right now. */
  allBlocked: boolean;
  /**
   * True when the agent's own preferred model cannot serve this card now.
   * A FACT, not a policy: this module states it and the ask-at-capacity gate
   * decides, with its own thresholds and budget, whether it is worth an owner's
   * attention. Keeping the two apart is what stops a scoring tweak silently
   * changing how often a client is messaged.
   */
  askWorthy: boolean;
  /** One sentence, with the live numbers, for `tasks.routing_reason`. */
  reason: string;
}

/**
 * Median wall time per provider, measured from this box's OWN completed runs.
 *
 * `updated_at - created_at` on a succeeded execution is the whole trip: reserve
 * to completion. It is the number a deadline actually cares about, and unlike a
 * token count (which nothing on this box records) it is already there to read.
 * A provider with no completed run has NO median, not a default — an invented
 * latency would refuse or admit a provider on a number nobody measured.
 */
export function medianLatencyByProvider(limit = LATENCY_SAMPLE_LIMIT): Record<string, number> {
  const out: Record<string, number> = {};
  let rows: { provider: string | null; ms: number }[] = [];
  try {
    rows = queryAll<{ provider: string | null; ms: number }>(
      `SELECT provider,
              (julianday(updated_at) - julianday(created_at)) * 86400000.0 AS ms
         FROM task_executions
        WHERE state = 'succeeded' AND provider IS NOT NULL AND updated_at > created_at
        ORDER BY created_at DESC
        LIMIT ?`,
      [limit * 8],
    );
  } catch {
    // Pre-150 database: no provider column, so no attribution exists yet.
    return out;
  }
  const buckets = new Map<string, number[]>();
  for (const row of rows) {
    const key = canonicalProvider(row.provider);
    const list = buckets.get(key) ?? [];
    if (list.length < limit && Number.isFinite(row.ms) && row.ms > 0) list.push(row.ms);
    buckets.set(key, list);
  }
  for (const [provider, samples] of buckets) {
    if (samples.length === 0) continue;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out[provider] =
      sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return out;
}

/** The quality order in force for a task kind, env-overridable per box. */
export function qualityOrder(kind: TaskKind): readonly string[] {
  const raw = process.env[`ROUTE_QUALITY_${kind.toUpperCase()}`];
  if (raw && raw.trim()) {
    const parsed = raw
      .split(',')
      .map((s) => canonicalProvider(s))
      .filter(Boolean);
    if (parsed.length) return parsed;
  }
  return DEFAULT_QUALITY_ORDER[kind];
}

/**
 * Classify a card so the quality order has something to sort by. Deliberately
 * crude and keyword-only: this decides TIES between candidates the client
 * already declared, so a wrong guess costs a preference, never a refusal.
 */
export function taskKind(title: string | null | undefined, department: string | null | undefined): TaskKind {
  const text = `${title ?? ''} ${department ?? ''}`.toLowerCase();
  if (/\b(code|bug|api|script|deploy|refactor|engineer)/.test(text)) return 'code';
  if (/\b(research|analy|report|competitor|market|audit)/.test(text)) return 'research';
  if (/\b(ops|schedule|admin|invoice|inbox|calendar)/.test(text)) return 'ops';
  return 'content';
}

function scoreOne(
  modelId: string,
  ledger: Map<string, ProviderLedgerEntry>,
  latency: Record<string, number>,
  order: readonly string[],
  deadlineMs: number | null,
  nowMs: number,
): ScoredCandidate {
  const provider = providerOf(modelId);
  const entry = ledger.get(provider);
  const slotsFree = entry?.slotsFree ?? null;
  const coolingUntil = entry?.coolingUntil ?? null;
  const balance = entry?.balance ?? null;
  const medianLatencyMs = latency[provider] ?? null;

  // A shut pool is a definite no. An unknown pool is not a no.
  const canStartNow = coolingUntil ? false : slotsFree === null ? null : slotsFree > 0;

  // Only a KNOWN balance at or below the floor refuses. Unknown stays unknown:
  // a provider that publishes no balance (a subscription) must not be scored as
  // if it were empty.
  const affordable = balance === null ? null : balance > BALANCE_FLOOR;

  // Only a MEASURED median can say a deadline is unreachable.
  const meetsDeadline =
    deadlineMs === null ? null : medianLatencyMs === null ? null : nowMs + medianLatencyMs <= deadlineMs;

  const rank = order.indexOf(provider);
  return {
    modelId,
    provider,
    canStartNow,
    slotsFree,
    affordable,
    balance,
    medianLatencyMs,
    meetsDeadline,
    qualityRank: rank === -1 ? order.length : rank,
    pricePerMTokIn: entry?.pricePerMTokIn ?? null,
    coolingUntil,
  };
}

/** A candidate is BLOCKED only on a definite no — never on an unknown. */
export function isBlocked(c: ScoredCandidate): boolean {
  return c.canStartNow === false || c.affordable === false || c.meetsDeadline === false;
}

/**
 * Order candidates best-first: unblocked before blocked, then quality rank,
 * then the cheaper known price, then the agent's own declared order. Fully
 * deterministic — the same inputs always produce the same pick, so a reason
 * string can be trusted to explain the decision that was actually made.
 */
function bestFirst(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ab = isBlocked(a.c) ? 1 : 0;
      const bb = isBlocked(b.c) ? 1 : 0;
      if (ab !== bb) return ab - bb;
      if (a.c.qualityRank !== b.c.qualityRank) return a.c.qualityRank - b.c.qualityRank;
      const ap = a.c.pricePerMTokIn;
      const bp = b.c.pricePerMTokIn;
      if (ap !== null && bp !== null && ap !== bp) return ap - bp;
      return a.i - b.i;
    })
    .map((x) => x.c);
}

function minutes(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`;
}

/** Why a candidate is blocked, in the numbers that blocked it. */
function blockReason(c: ScoredCandidate): string | null {
  if (c.coolingUntil) return `${providerLabel(c.provider)} cooling until ${c.coolingUntil}`;
  if (c.canStartNow === false) return `${providerLabel(c.provider)} ${c.slotsFree === 0 ? 'pool full' : 'has no free slot'}`;
  if (c.affordable === false) return `${providerLabel(c.provider)} balance ${c.balance} at or below the ${BALANCE_FLOOR} floor`;
  if (c.meetsDeadline === false)
    return `${providerLabel(c.provider)} typically takes ${minutes(c.medianLatencyMs ?? 0)}, past the deadline`;
  return null;
}

/**
 * Build the one-sentence reason written onto the card. It names what was used
 * or what is being waited for, and the number behind it, so an owner reading
 * the board does not have to reconstruct the decision.
 */
export function buildReason(decision: Omit<RouteDecision, 'reason'>): string {
  const { preferred, overflowTo, candidates } = decision;
  if (!preferred) return 'No model declared for this agent in the box config; routing by box default.';

  const blocked = blockReason(preferred);
  if (!blocked) {
    const detail: string[] = [];
    if (preferred.slotsFree !== null) detail.push(`${preferred.slotsFree} slot(s) free`);
    if (preferred.balance !== null) detail.push(`balance ${preferred.balance}`);
    if (preferred.medianLatencyMs !== null) detail.push(`typically ${minutes(preferred.medianLatencyMs)}`);
    return `Running on ${providerLabel(preferred.provider)} (${preferred.modelId})${
      detail.length ? `: ${detail.join(', ')}` : ''
    }.`;
  }

  if (overflowTo) {
    const cost =
      overflowTo.pricePerMTokIn !== null && preferred.pricePerMTokIn !== null
        ? `, ${overflowTo.pricePerMTokIn > preferred.pricePerMTokIn ? 'dearer' : 'no dearer'} per million tokens`
        : '';
    return (
      `${blocked}, so this run goes to the next model this agent declares: ` +
      `${overflowTo.modelId} on ${providerLabel(overflowTo.provider)}` +
      `${overflowTo.slotsFree !== null ? ` (${overflowTo.slotsFree} slot(s) free)` : ''}${cost}.`
    );
  }
  const others = candidates.filter((c) => c.modelId !== preferred.modelId);
  return (
    `Queued: ${blocked}.` +
    (others.length
      ? ` Every other model this agent declares is blocked too (${others.map((c) => blockReason(c) ?? providerLabel(c.provider)).join('; ')}).`
      : ' This agent declares no other model, so it waits for a slot.')
  );
}

export interface ScoreRouteInput {
  agent: Agent;
  workspaceId?: string | null;
  /** Card title, for the task-kind classification that breaks ties. */
  title?: string | null;
  department?: string | null;
  /** ISO deadline (`tasks.due_date`), or null when the card has none. */
  needBy?: string | null;
  /** Injected for tests; defaults to the live ledger. */
  ledger?: ProviderLedgerEntry[];
  /** Injected for tests; defaults to this box's measured history. */
  latency?: Record<string, number>;
  /** Injected for tests; defaults to the agent's own openclaw.json entry. */
  candidateModels?: string[];
  nowMs?: number;
}

/**
 * Score the agent's own declared models against live capacity, money and
 * measured latency. Never throws: a box whose config or ledger cannot be read
 * produces an empty candidate list and a reason saying so, and the dispatcher
 * proceeds exactly as it did before this existed.
 */
export function scoreRoute(input: ScoreRouteInput): RouteDecision {
  const nowMs = input.nowMs ?? Date.now();
  let models = input.candidateModels;
  if (!models) {
    try {
      models = resolveRuntimeModelChainFromConfig(input.agent, input.workspaceId ?? undefined);
    } catch {
      models = [];
    }
  }
  let ledgerRows = input.ledger;
  if (!ledgerRows) {
    try {
      ledgerRows = readResourceLedger();
    } catch {
      ledgerRows = [];
    }
  }
  const ledger = new Map(ledgerRows.map((e) => [e.provider, e]));
  const latency = input.latency ?? medianLatencyByProvider();
  const order = qualityOrder(taskKind(input.title, input.department));
  const deadlineMs = input.needBy ? Date.parse(input.needBy) : NaN;
  const deadline = Number.isFinite(deadlineMs) ? deadlineMs : null;

  const candidates = models.map((m) => scoreOne(m, ledger, latency, order, deadline, nowMs));
  const preferred = candidates[0] ?? null;
  const recommended = candidates.length ? bestFirst(candidates)[0] : null;
  // The overflow target is the next USABLE entry in CONFIG order, because that
  // is the one the reservation will debit and the runtime will fail over to.
  // `recommended` is a separate question — the best FIT — and the two differ
  // whenever config order and quality order disagree. Reporting the second as
  // the first would put a model on the card that nothing is going to run.
  const overflowTo = candidates.slice(1).find((c) => !isBlocked(c)) ?? null;
  const allBlocked = candidates.length > 0 && candidates.every(isBlocked);
  const askWorthy = !!(preferred && isBlocked(preferred));

  const partial = { preferred, recommended, candidates, overflowTo, allBlocked, askWorthy };
  return { ...partial, reason: buildReason(partial) };
}

/**
 * Write the decision onto the card.
 *
 * `routing_reason` is updated ALONE. The `tasks_routing_reconsider` trigger
 * (migration 133) clears it on any update that also touches title, description,
 * assignment or status — so the reason must never ride along with a status
 * write, or the trigger erases the explanation in the same statement that
 * earned it. Best-effort: the explanation is never worth failing a dispatch.
 */
export function recordRoutingReason(taskId: string, reason: string): void {
  try {
    const current = queryOne<{ routing_reason: string | null }>(
      'SELECT routing_reason FROM tasks WHERE id = ?',
      [taskId],
    );
    // A catch-all routing reason is an assignment AUTHORIZATION that migration
    // 133 deliberately preserves across lifecycle changes. Overwriting it with
    // a capacity note would revoke that authorization.
    if (current?.routing_reason?.startsWith('[catch-all]')) return;
    if (current?.routing_reason === reason) return;
    run('UPDATE tasks SET routing_reason = ? WHERE id = ?', [reason, taskId]);
  } catch {
    /* pre-migration tolerant */
  }
}
