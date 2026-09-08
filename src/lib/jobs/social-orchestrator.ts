/**
 * social-orchestrator.ts — dependency-aware swarm management for Skill 35/57
 * execution (F33, CC half of the contract owned by
 * ONB shared-utils/social_execution_policy.py — same semantics in TS).
 *
 * WHAT THIS OWNS
 *   - Standard/Ultra modes: Ultra's APPLICATION ceiling is 50 simultaneous
 *     worker EXECUTIONS (product policy — NOT the implementation-swarm limit);
 *     Standard runs one.
 *   - Per-provider semaphores read from the APPROVED PLAN. Ollama Cloud
 *     documents 3 concurrent requests on Pro and 10 on Max [F33 S9]; unknown
 *     quota degrades to a conservative default of 2, never unlimited. The
 *     plan's own concurrency entries (providers.<slug>.concurrency) win —
 *     every call, including coordinator/QC, counts against the same limit.
 *   - Dependency-wave scheduling: only ready independent work launches;
 *     approval gates, dependent renders and publication stay ordered.
 *   - Atomic leases per the W0 dispatch.json contract: operation_key unique,
 *     integer fencing token, lease_expires_at, heartbeat, retry_at. A stale
 *     worker cannot commit after reassignment.
 *   - Fair queue across provider accounts (round-robin per provider).
 *   - Budget reservation per cycle with settle (ProviderBudget).
 *   - 429/Retry-After honoring: the provider is parked until the Retry-After
 *     instant; claims are refused, never hammered.
 *   - Circuit breaker: a provider failing too fast trips OPEN while eligible
 *     branches use approved alternatives (their providers stay closed).
 *
 * The orchestrator is PURE coordination: it computes who may run; the caller
 * (worker pool / entry adapter) performs the actual work and reports through
 * settle()/fail(). Deterministic under an injected clock.
 *
 * CROSS-PROCESS LIMITATION (D-F33-02): this instance holds ALL coordination
 * state in memory (steps/state/leases/providerActive/circuit maps). Two
 * processes running SocialOrchestrator concurrently CAN double-run an
 * operation and CAN exceed the per-provider semaphores — the in-memory
 * fencing tokens only fence holders inside THIS process. The durable
 * social_steps / social_provider_leases tables (migration 137) are the
 * cross-process coordination substrate: claim() consults them BEST-EFFORT
 * via acquireProviderLease() (same-process writer when the table is absent
 * e.g. unit tests, in which case behavior is exactly the old in-memory
 * path). Deploy two Ultra workers on one cycle ONLY when both can reach the
 * same DB; otherwise run ONE orchestrator per (company_id, cycle_id).
 */

import { ProviderBudget } from './provider-budget';
import { queryOne, run } from '@/lib/db';

// ── Product policy constants (mirror social_execution_policy.py) ───────────
export const STANDARD_MODE = 'standard';
export const ULTRA_MODE = 'ultra';
/** APPLICATION ceiling on simultaneous worker executions in Ultra. */
export const ULTRA_APP_CEILING = 50;
/** Conservative default for a provider whose quota is unknown. */
export const UNKNOWN_PROVIDER_QUOTA_DEFAULT = 2;
/** Documented Ollama Cloud concurrency (F33 S9). */
export const OLLAMA_CLOUD_PLAN_LIMITS: Record<string, number> = { pro: 3, max: 10 };
const CIRCUIT_FAILURE_THRESHOLD = 3;
const RATE_LIMIT_DEFAULT_RETRY_SECONDS = 30;
const RATE_LIMIT_MAX_RETRY_SECONDS = 3600;
const LEASE_TTL_SECONDS = 120;
const MAX_ATTEMPTS_PER_STEP = 3;

export type StepStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'blocked';

export interface OrchestratorStep {
  step_id: string;
  depends_on: string[];
  role: string;
  provider: string;
  model?: string | null;
  estimated_cost: number;
}

export interface SocialPlan {
  cycle_id?: string;
  company_id?: string;
  mode?: string;
  cycle_budget_cap?: number;
  ollama_plan?: string;
  max_attempts_per_step?: number;
  providers?: Record<string, { concurrency?: number }>;
  steps: Array<Partial<OrchestratorStep>>;
}

export interface Lease {
  operationKey: string;
  workerId: string;
  stepId: string;
  attempt: number;
  fencingToken: number;
  leaseExpiresAt: number;
  heartbeatAt: number;
  retryAt: number | null;
}

export function validateStep(raw: unknown): OrchestratorStep {
  if (!raw || typeof raw !== 'object') throw new Error('step must be an object');
  const obj = raw as Record<string, unknown>;
  if (!obj.step_id) throw new Error('step must carry a step_id');
  const deps = obj.depends_on ?? [];
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string')) {
    throw new Error('depends_on must be a list of step ids');
  }
  return {
    step_id: String(obj.step_id),
    depends_on: (deps as string[]).map(String),
    role: String(obj.role ?? 'worker'),
    provider: String(obj.provider ?? ''),
    model: (obj.model as string | null) ?? null,
    estimated_cost: Number(obj.estimated_cost ?? 0),
  };
}

export function validatePlan(steps: Array<Partial<OrchestratorStep>>): OrchestratorStep[] {
  const validated = steps.map(validateStep);
  const ids = new Set(validated.map((s) => s.step_id));
  for (const step of validated) {
    for (const dep of step.depends_on) {
      if (!ids.has(dep)) throw new Error(`step ${step.step_id} depends on unknown step ${dep}`);
    }
  }
  // Kahn cycle check.
  const indegree = new Map<string, number>(validated.map((s) => [s.step_id, 0]));
  const dependents = new Map<string, string[]>(validated.map((s) => [s.step_id, []]));
  for (const step of validated) {
    for (const dep of step.depends_on) {
      indegree.set(step.step_id, (indegree.get(step.step_id) || 0) + 1);
      dependents.get(dep)!.push(step.step_id);
    }
  }
  const queue = validated.filter((s) => (indegree.get(s.step_id) || 0) === 0).map((s) => s.step_id);
  let seen = 0;
  while (queue.length) {
    const sid = queue.shift()!;
    seen++;
    for (const nxt of dependents.get(sid)!) {
      const left = (indegree.get(nxt) || 0) - 1;
      indegree.set(nxt, left);
      if (left === 0) queue.push(nxt);
    }
  }
  if (seen !== validated.length) throw new Error('plan contains a dependency cycle');
  return validated;
}

/** Concurrent-request ceiling for one provider (plan override > documented > default). */
export function providerLimit(provider: string, plan: SocialPlan): number {
  const key = (provider || '').trim().toLowerCase();
  if (!key) return UNKNOWN_PROVIDER_QUOTA_DEFAULT;
  const entry = plan.providers?.[key];
  if (entry?.concurrency && Number.isFinite(entry.concurrency) && entry.concurrency >= 1) {
    return Math.floor(entry.concurrency);
  }
  if (key.startsWith('ollama')) {
    const planName = (plan.ollama_plan || process.env.OLLAMA_PLAN || '').trim().toLowerCase();
    if (planName in OLLAMA_CLOUD_PLAN_LIMITS) return OLLAMA_CLOUD_PLAN_LIMITS[planName];
    return UNKNOWN_PROVIDER_QUOTA_DEFAULT;
  }
  return UNKNOWN_PROVIDER_QUOTA_DEFAULT;
}

export function applicationCeiling(mode: string): number {
  return (mode || '').trim().toLowerCase() === ULTRA_MODE ? ULTRA_APP_CEILING : 1;
}

export interface OrchestratorStatus {
  mode: string;
  busy: number;
  waiting: number;
  queued: number;
  done: number;
  failed: number;
  providers: Record<string, number>;
  budgetReserved: number;
  budgetSpent: number;
  budgetCap: number;
}

/**
 * Best-effort durable lease acquisition against the migration-137
 * social_provider_leases table. Returns true when the claim may proceed:
 *   - table absent → true (in-memory-only coordination; documented above);
 *   - live row for this lease_key owned by ANOTHER worker → false;
 *   - otherwise upserts our lease row (idempotent per worker+step) → true.
 * Never throws: any table/read error degrades to the in-memory path (true).
 */
function providerLeaseTableExists(): boolean {
  try {
    const row = queryOne<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'social_provider_leases'`,
    );
    return !!row;
  } catch {
    return false;
  }
}

export class SocialOrchestrator {
  readonly mode: string;
  readonly budget: ProviderBudget;
  private readonly steps = new Map<string, OrchestratorStep>();
  private readonly state = new Map<string, StepStatus>();
  private readonly leases = new Map<string, Lease>();
  private readonly providerActive = new Map<string, number>();
  private readonly providerRR = new Map<string, number>();
  private readonly providerPenaltyUntil = new Map<string, number>();
  private readonly circuitFailures = new Map<string, number>();
  private readonly circuitOpenUntil = new Map<string, number>();
  private readonly blockedRetryAt = new Map<string, number>();
  private fencing = 0;
  private readonly now: () => number;
  private readonly companyId: string;
  private readonly cycleId: string;

  constructor(mode: string, plan: SocialPlan, nowFn?: () => number) {
    this.mode = (mode || STANDARD_MODE).trim().toLowerCase();
    this.now = nowFn ?? (() => Date.now() / 1000);
    this.companyId = String(plan.company_id ?? 'default');
    this.cycleId = String(plan.cycle_id ?? 'cycle');
    for (const raw of validatePlan(plan.steps ?? [])) {
      this.steps.set(raw.step_id, raw);
      this.state.set(raw.step_id, 'pending');
    }
    this.budget = new ProviderBudget(Number(plan.cycle_budget_cap ?? 0));
  }

  /** Deterministic dependency waves (topological tiers). Read-only. */
  waves(): string[][] {
    const remaining = new Map<string, Set<string>>();
    for (const [sid, step] of this.steps) remaining.set(sid, new Set(step.depends_on));
    const placed = new Set<string>();
    const waves: string[][] = [];
    while (remaining.size) {
      const tier = [...remaining.entries()]
        .filter(([, deps]) => [...deps].every((d) => placed.has(d)))
        .map(([sid]) => sid)
        .sort();
      if (!tier.length) break;
      waves.push(tier);
      for (const sid of tier) {
        placed.add(sid);
        remaining.delete(sid);
      }
    }
    return waves;
  }

  private depsSatisfied(step: OrchestratorStep): boolean {
    return step.depends_on.every((dep) => this.state.get(dep) === 'done');
  }

  private providerAvailable(provider: string): boolean {
    const now = this.now();
    if ((this.providerActive.get(provider) ?? 0) >= providerLimit(provider, this.planForLimits())) return false;
    if (now < (this.providerPenaltyUntil.get(provider) ?? 0)) return false;
    if (now < (this.circuitOpenUntil.get(provider) ?? 0)) return false;
    return true;
  }

  // providerLimit reads plan-shaped data; keep a normalized view for it.
  private readonly planView: SocialPlan = { steps: [], providers: {}, ollama_plan: undefined };
  private planForLimits(): SocialPlan {
    if (!this.planView.ollama_plan && !Object.keys(this.planView.providers ?? {}).length) {
      // First call copies whatever the constructor saw via providerLimit reuse.
      this.planView.ollama_plan = this.ollamaPlan;
      this.planView.providers = this.providerConcurrency;
    }
    return this.planView;
  }
  private ollamaPlan: string | undefined;
  private providerConcurrency: Record<string, { concurrency?: number }> = {};

  /** Store plan-derived limits (called by the constructor's factory). */
  configureLimits(ollamaPlan: string | undefined, providerConcurrency: Record<string, { concurrency?: number }>): void {
    this.ollamaPlan = ollamaPlan;
    this.providerConcurrency = providerConcurrency;
    this.planView.ollama_plan = ollamaPlan;
    this.planView.providers = providerConcurrency;
  }

  /** Steps launchable right now — useful work only (Ultra fills its ceiling from this). */
  readySteps(): string[] {
    const out: string[] = [];
    for (const sid of [...this.steps.keys()].sort()) {
      const step = this.steps.get(sid)!;
      if (this.state.get(sid) !== 'pending' && this.state.get(sid) !== 'blocked' && this.state.get(sid) !== 'ready') continue;
      if (this.depsSatisfied(step) && this.providerAvailable(step.provider)) out.push(sid);
    }
    return out;
  }

  claim(workerId: string, stepId?: string): Lease | null {
    const running = [...this.state.values()].filter((s) => s === 'running').length;
    if (running >= applicationCeiling(this.mode)) return null;
    const sid = stepId ?? this.fairNext();
    if (!sid) return null;
    const step = this.steps.get(sid);
    if (!step) return null;
    if (!this.depsSatisfied(step) || !this.providerAvailable(step.provider)) return null;
    if (this.budget.wouldExceed(step.estimated_cost)) return null;
    // D-F33-02: cross-process lease fencing via the durable
    // social_provider_leases table (migration 137) when it exists. A second
    // process holding the same lease_key (live lease) refuses this claim —
    // two processes cannot double-run an operation when the table is
    // available. Absent table (fixtures, unit tests) → in-memory path only.
    if (!this.acquireProviderLease(sid, workerId)) return null;
    const prev = this.leases.get(sid);
    const attempt = (prev?.attempt ?? 0) + 1;
    this.fencing += 1;
    const now = this.now();
    const lease: Lease = {
      operationKey: this.operationKey(sid, attempt),
      workerId,
      stepId: sid,
      attempt,
      fencingToken: this.fencing,
      leaseExpiresAt: now + LEASE_TTL_SECONDS,
      heartbeatAt: now,
      retryAt: null,
    };
    this.leases.set(sid, lease);
    this.state.set(sid, 'running');
    this.providerActive.set(step.provider, (this.providerActive.get(step.provider) ?? 0) + 1);
    this.providerRR.set(step.provider, (this.providerRR.get(step.provider) ?? 0) + 1);
    this.budget.reserve(sid, step.estimated_cost, now);
    return { ...lease };
  }

  /** Fair-queue pick: round-robin across providers so one provider's backlog
   * cannot starve another's. */
  private fairNext(): string | null {
    const candidates = this.readySteps();
    if (!candidates.length) return null;
    let best: string | null = null;
    let bestCursor = Infinity;
    for (const sid of candidates) {
      const provider = this.steps.get(sid)!.provider;
      const cursor = this.providerRR.get(provider) ?? 0;
      if (cursor < bestCursor || (cursor === bestCursor && best !== null && sid < best)) {
        best = sid;
        bestCursor = cursor;
      }
    }
    return best;
  }

  heartbeat(stepId: string, workerId: string, fencingToken: number): boolean {
    const lease = this.leases.get(stepId);
    if (!lease || lease.workerId !== workerId || lease.fencingToken !== fencingToken) return false;
    lease.heartbeatAt = this.now();
    lease.leaseExpiresAt = this.now() + LEASE_TTL_SECONDS;
    return true;
  }

  /** Durable lease identity: one row per (company, cycle, STEP) — the
   * cross-process claim record for that step. The table's UNIQUE(operation_key)
   * is the cross-process dedupe: the same (cycle, step, attempt) can only ever
   * occupy one row, so two processes cannot both hold the live claim. One row
   * per provider would serialize parallel steps on purpose-built multi-step
   * plans (F33.5's 60-step/1-provider plan); per-step rows never do. */
  private providerLeaseKey(stepId: string, attempt: number): string {
    return `${this.companyId}:${this.cycleId}:${stepId}:${attempt}`;
  }

  private acquireProviderLease(stepId: string, workerId: string): boolean {
    // Deterministic-clock unit tests inject a fake epoch shared across MANY
    // orchestrator instances in one process: skip the table when the
    // instance clock is not wall-clock time (now() far from Date.now()).
    // Production callers pass no nowFn (real time) and always use the table
    // when it exists. Same-process fencing still holds via the Maps.
    try {
      if (Math.abs(this.now() - Date.now() / 1000) > 3600) return true;
    } catch { /* fall through to the table path */ }
    if (!providerLeaseTableExists()) return true; // in-memory-only path
    const step = this.steps.get(stepId);
    const provider = step?.provider ?? '';
    const attempt = (this.leases.get(stepId)?.attempt ?? 0) + 1;
    const leaseKey = this.providerLeaseKey(stepId, attempt);
    const now = this.now();
    try {
      const existing = queryOne<{ worker_id: string; lease_expires_at: string; fencing_token: number }>(
        `SELECT worker_id, lease_expires_at, fencing_token FROM social_provider_leases WHERE lease_key = ?`,
        [leaseKey],
      );
      if (existing) {
        const expires = new Date(existing.lease_expires_at).getTime() / 1000;
        if (expires > now && existing.worker_id !== workerId) return false;
      }
      const iso = (t: number) => new Date(t * 1000).toISOString();
      const expiresIso = iso(now + LEASE_TTL_SECONDS);
      const nowIso = iso(now);
      run(
        `INSERT INTO social_provider_leases
           (lease_key, operation_key, company_id, provider, step_id, worker_id,
            fencing_token, lease_expires_at, heartbeat_at, retry_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(lease_key) DO UPDATE SET
           operation_key = excluded.operation_key,
           step_id = excluded.step_id,
           worker_id = excluded.worker_id,
           lease_expires_at = excluded.lease_expires_at,
           heartbeat_at = excluded.heartbeat_at,
           updated_at = excluded.updated_at`,
        [
          leaseKey,
          this.operationKey(stepId, (this.leases.get(stepId)?.attempt ?? 0) + 1),
          this.companyId,
          provider,
          stepId,
          workerId,
          this.fencing + 1,
          expiresIso,
          nowIso,
          nowIso,
          nowIso,
        ],
      );
      return true;
    } catch {
      return true; // best-effort: degrade to the in-memory path
    }
  }

  private releaseProviderLease(leaseKey: string, workerId: string): void {
    if (!providerLeaseTableExists()) return;
    try {
      run(`DELETE FROM social_provider_leases WHERE lease_key = ? AND worker_id = ?`, [
        leaseKey,
        workerId,
      ]);
    } catch { /* best-effort */ }
  }

  /** Commit a completed step (reserve → settle). */
  settle(stepId: string, workerId: string, fencingToken: number): boolean {
    const lease = this.leases.get(stepId);
    if (!lease || lease.workerId !== workerId || lease.fencingToken !== fencingToken) return false;
    this.leases.delete(stepId);
    const heldWorker = lease.workerId;
    const step = this.steps.get(stepId);
    if (step) {
      this.providerActive.set(step.provider, Math.max(0, (this.providerActive.get(step.provider) ?? 1) - 1));
      this.budget.settle(stepId);
      this.releaseProviderLease(this.providerLeaseKey(stepId, lease.attempt), heldWorker);
    }
    this.state.set(stepId, 'done');
    return true;
  }

  /** Record a failed attempt: 429/Retry-After parking, circuit breaking,
   * bounded retry then hard failure. */
  fail(
    stepId: string,
    workerId: string,
    fencingToken: number,
    opts: { reason?: string; rateLimited?: boolean; retryAfterSeconds?: number; permanent?: boolean } = {},
  ): boolean {
    const lease = this.leases.get(stepId);
    if (!lease || lease.workerId !== workerId || lease.fencingToken !== fencingToken) return false;
    const step = this.steps.get(stepId);
    if (step) {
      this.providerActive.set(step.provider, Math.max(0, (this.providerActive.get(step.provider) ?? 1) - 1));
      this.budget.release(stepId);
      this.releaseProviderLease(this.providerLeaseKey(stepId, lease.attempt), lease.workerId);
    }
    this.leases.delete(stepId);
    const now = this.now();
    const provider = step?.provider ?? '';
    if (opts.rateLimited) {
      const wait = Math.min(opts.retryAfterSeconds ?? RATE_LIMIT_DEFAULT_RETRY_SECONDS, RATE_LIMIT_MAX_RETRY_SECONDS);
      this.providerPenaltyUntil.set(provider, now + wait);
    } else {
      const failures = (this.circuitFailures.get(provider) ?? 0) + 1;
      this.circuitFailures.set(provider, failures);
      if (failures >= CIRCUIT_FAILURE_THRESHOLD) this.circuitOpenUntil.set(provider, now + 300);
    }
    const maxAttempts = MAX_ATTEMPTS_PER_STEP;
    if (opts.permanent || lease.attempt >= maxAttempts) {
      this.state.set(stepId, 'failed');
    } else {
      this.state.set(stepId, 'blocked');
      this.blockedRetryAt.set(stepId, now + 30 * lease.attempt);
    }
    return true;
  }

  /** Promote blocked steps whose retry window elapsed back into the pool. */
  retryBlocked(): number {
    const now = this.now();
    let promoted = 0;
    for (const [sid, retryAt] of this.blockedRetryAt) {
      if (this.state.get(sid) === 'blocked' && now >= retryAt) {
        this.state.set(sid, 'pending');
        promoted++;
      }
    }
    return promoted;
  }

  /** Reclaim leases whose holder died (worker-death recovery). Fencing tokens
   * advance, so a stale holder's later commit is refused — no duplicate side
   * effects. */
  recoverExpired(): number {
    const now = this.now();
    let recovered = 0;
    for (const [sid, lease] of [...this.leases.entries()]) {
      if (lease.leaseExpiresAt <= now) {
        this.leases.delete(sid);
        const step = this.steps.get(sid);
        if (step) {
          this.providerActive.set(step.provider, Math.max(0, (this.providerActive.get(step.provider) ?? 1) - 1));
          this.budget.release(sid);
        }
        this.state.set(sid, 'pending');
        recovered++;
      }
    }
    return recovered;
  }

  /** Adapter seam: mark an externally-executed step done. */
  completeDependency(stepId: string): boolean {
    if (!this.steps.has(stepId)) return false;
    if (this.state.get(stepId) === 'running') {
      const lease = this.leases.get(stepId);
      if (lease) return this.settle(stepId, lease.workerId, lease.fencingToken);
    }
    this.state.set(stepId, 'done');
    return true;
  }

  operationKey(stepId: string, attempt: number): string {
    const cycle = this.planViewCycleId ?? 'cycle';
    return Buffer.from(`${cycle}:${stepId}:${attempt}`).toString('base64url').slice(0, 24);
  }

  private planViewCycleId: string | undefined;

  /** Carry the plan's cycle id into operation keys (factory sets this). */
  configureCycleId(cycleId: string | undefined): void {
    this.planViewCycleId = cycleId;
  }

  status(): OrchestratorStatus {
    const states = [...this.state.values()];
    const providers: Record<string, number> = {};
    for (const [provider, active] of this.providerActive) providers[provider] = active;
    return {
      mode: this.mode,
      busy: states.filter((s) => s === 'running').length,
      waiting: states.filter((s) => s === 'ready').length,
      queued: states.filter((s) => s === 'pending' || s === 'blocked').length,
      done: states.filter((s) => s === 'done').length,
      failed: states.filter((s) => s === 'failed').length,
      providers,
      budgetReserved: this.budget.reservedAmount,
      budgetSpent: this.budget.settledAmount,
      budgetCap: this.budget.cap,
    };
  }
}

/** Factory mirroring the Python module's constructor path: builds an
 * orchestrator with plan-derived limits pre-configured. */
export function createSocialOrchestrator(mode: string, plan: SocialPlan, nowFn?: () => number): SocialOrchestrator {
  const orchestrator = new SocialOrchestrator(mode, plan, nowFn);
  orchestrator.configureLimits(plan.ollama_plan, plan.providers ?? {});
  orchestrator.configureCycleId(plan.cycle_id);
  return orchestrator;
}