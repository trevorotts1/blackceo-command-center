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
 * Durable claims, heartbeats, completion and retry counts share SQLite under
 * BEGIN IMMEDIATE. Provider and application reservations count active rows
 * for this company; all coordinators for an account must share this database.
 * Storage errors fail closed. Only node:test fixtures with an explicitly
 * injected distant clock use the deterministic in-memory model.
 * Provider circuit history remains coordinator-local; this scheduling
 * primitive needs a production worker adapter before it constitutes Ultra.
 */

import { ProviderBudget } from './provider-budget';
import { createHash } from 'node:crypto';
import { getDb, queryOne, run } from '@/lib/db';

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
  const estimatedCost=Number(obj.estimated_cost ?? 0);
  if (!Number.isFinite(estimatedCost) || estimatedCost < 0) throw new Error('step estimated_cost must be finite and nonnegative');
  return {
    step_id: String(obj.step_id),
    depends_on: (deps as string[]).map(String),
    role: String(obj.role ?? 'worker'),
    provider: String(obj.provider ?? '').trim().toLowerCase(),
    model: (obj.model as string | null) ?? null,
    estimated_cost: estimatedCost,
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

interface DurableStep {
  status: StepStatus; attempt_count: number; fencing_token: number;
  lease_owner: string | null; lease_expires_at: string | null; retry_at: string | null;
  provider: string; depends_on: string; estimated_cost: number; role: string; model: string | null;
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
  private readonly fixtureMemoryOnly: boolean;
  private readonly attempts = new Map<string, number>();

  constructor(mode: string, plan: SocialPlan, nowFn?: () => number) {
    this.mode = (mode || STANDARD_MODE).trim().toLowerCase();
    this.now = nowFn ?? (() => Date.now() / 1000);
    this.companyId = String(plan.company_id ?? 'default');
    this.cycleId = String(plan.cycle_id ?? 'cycle');
    // Deterministic legacy fixtures may explicitly inject a distant fake clock.
    // Production never infers missing storage as permission to run unfenced.
    this.fixtureMemoryOnly = !!process.env.NODE_TEST_CONTEXT && !!nowFn && Math.abs(this.now() - Date.now() / 1000) > 3600;
    for (const raw of validatePlan(plan.steps ?? [])) {
      this.steps.set(raw.step_id, raw);
      this.state.set(raw.step_id, 'pending');
    }
    const budgetCap=Number(plan.cycle_budget_cap ?? 0);
    if (!Number.isFinite(budgetCap) || budgetCap < 0) throw new Error('cycle_budget_cap must be finite and nonnegative');
    this.budget = new ProviderBudget(budgetCap);
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
    return step.depends_on.every((dep) => this.durableState(dep)?.status === 'done' || (this.fixtureMemoryOnly && this.state.get(dep) === 'done'));
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
    this.refreshDurableStates();
    const out: string[] = [];
    for (const sid of [...this.steps.keys()].sort()) {
      const step = this.steps.get(sid)!;
      if (this.state.get(sid) !== 'pending' && this.state.get(sid) !== 'blocked' && this.state.get(sid) !== 'ready') continue;
      if ((this.blockedRetryAt.get(sid) ?? 0) > this.now()) continue;
      if (this.depsSatisfied(step) && this.providerAvailable(step.provider)) out.push(sid);
    }
    return out;
  }

  claim(workerId: string, stepId?: string): Lease | null {
    this.recoverExpired();
    this.refreshDurableStates();
    const running = [...this.state.values()].filter((s) => s === 'running').length;
    if (running >= applicationCeiling(this.mode)) return null;
    if (stepId === undefined) {
      // A ready snapshot can lose durable capacity to another coordinator.
      // Try each independent candidate once; one saturated provider or costly
      // step must not hide another provider's useful work. Explicit requests
      // never silently switch to a different step.
      const candidates = this.readySteps().sort((a, b) =>
        (this.providerRR.get(this.steps.get(a)!.provider) ?? 0) -
        (this.providerRR.get(this.steps.get(b)!.provider) ?? 0) || a.localeCompare(b));
      for (const candidate of candidates) {
        const lease = this.claim(workerId, candidate);
        if (lease) return lease;
      }
      return null;
    }
    const sid = stepId;
    if (!sid) return null;
    const step = this.steps.get(sid);
    if (!step) return null;
    if (!this.depsSatisfied(step) || !this.providerAvailable(step.provider)) return null;
    if (this.budget.wouldExceed(step.estimated_cost)) return null;
    if (!['pending', 'ready', 'blocked', 'running'].includes(this.state.get(sid) ?? '')) return null;
    if (this.fixtureMemoryOnly && this.state.get(sid) === 'running') return null;
    if ((this.blockedRetryAt.get(sid) ?? 0) > this.now()) return null;
    const persisted = this.acquireProviderLease(sid, workerId);
    if (!persisted) return null;
    const attempt = persisted.attempt;
    this.attempts.set(sid, attempt);
    this.fencing = Math.max(this.fencing + 1, persisted.fencingToken);
    const now = this.now();
    const lease: Lease = {
      operationKey: this.operationKey(sid, attempt),
      workerId,
      stepId: sid,
      attempt,
      fencingToken: persisted.fencingToken,
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

  private durableState(stepId: string): DurableStep | undefined {
    if (this.fixtureMemoryOnly) return undefined;
    return queryOne<DurableStep>(`SELECT * FROM social_steps WHERE company_id=? AND cycle_id=? AND step_id=?`, [this.companyId, this.cycleId, stepId]);
  }

  private refreshDurableStates(): void {
    if (this.fixtureMemoryOnly) return;
    // Read errors propagate to the caller instead of granting an unfenced run.
    for (const sid of this.steps.keys()) {
      const row = this.durableState(sid);
      if (row) {
        this.state.set(sid, row.status === 'running' && Date.parse(row.lease_expires_at ?? '') <= this.now()*1000 ? 'pending' : row.status);
        if (row.retry_at) this.blockedRetryAt.set(sid, Date.parse(row.retry_at)/1000);
      }
    }
  }

  heartbeat(stepId: string, workerId: string, fencingToken: number): boolean {
    const lease = this.leases.get(stepId);
    if (!lease || lease.workerId !== workerId || lease.fencingToken !== fencingToken || lease.leaseExpiresAt <= this.now()) return false;
    if (!this.updateOwnedLease(lease, 'heartbeat')) return false;
    lease.heartbeatAt = this.now();
    lease.leaseExpiresAt = this.now() + LEASE_TTL_SECONDS;
    return true;
  }

  private providerLeaseKey(stepId: string, _attempt: number): string {
    return createHash('sha256').update(JSON.stringify([this.companyId, this.cycleId, stepId])).digest('hex');
  }

  private acquireProviderLease(stepId: string, workerId: string): {attempt:number; fencingToken:number} | null {
    if (this.fixtureMemoryOnly) {
      const attempt = (this.attempts.get(stepId) ?? 0) + 1;
      return attempt <= MAX_ATTEMPTS_PER_STEP ? {attempt, fencingToken:this.fencing+1} : null;
    }
    const step = this.steps.get(stepId)!;
    const db = getDb();
    return db.transaction(() => {
      const now = this.now();
      const iso = (t:number) => new Date(t*1000).toISOString();
      const stamp = iso(now);
      run(`INSERT OR IGNORE INTO social_steps (step_id, company_id, cycle_id, depends_on, role, provider, model, estimated_cost, mode, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [stepId,this.companyId,this.cycleId,JSON.stringify(step.depends_on),step.role,step.provider,step.model??null,step.estimated_cost,this.mode,stamp,stamp]);
      const row = this.durableState(stepId)!;
      if (row.provider !== step.provider || row.depends_on !== JSON.stringify(step.depends_on) || row.estimated_cost !== step.estimated_cost || row.role !== step.role || row.model !== (step.model ?? null)) {
        throw new Error('Persisted social step differs from approved plan; use a new cycle or reconcile the plan before execution');
      }
      if (row.status === 'done' || row.status === 'failed' || (row.retry_at && Date.parse(row.retry_at)/1000 > now)) return null;
      if (row.status === 'running') {
        if (!Number.isFinite(Date.parse(row.lease_expires_at ?? ''))) throw new Error('Invalid persisted social lease expiry');
        if (Date.parse(row.lease_expires_at!)/1000 > now) return null;
      }
      if (row.attempt_count >= MAX_ATTEMPTS_PER_STEP) {
        run(`UPDATE social_steps SET status='failed', error='attempt_limit', updated_at=? WHERE company_id=? AND cycle_id=? AND step_id=?`, [stamp,this.companyId,this.cycleId,stepId]);
        return null;
      }
      if (!this.depsSatisfied(step)) return null;
      const active = queryOne<{total:number; provider_count:number}>(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN provider=? THEN 1 ELSE 0 END),0) AS provider_count FROM social_steps WHERE company_id=? AND status='running' AND lease_expires_at>?`, [step.provider,this.companyId,stamp])!;
      if (active.total >= applicationCeiling(this.mode) || active.provider_count >= providerLimit(step.provider,this.planForLimits())) return null;
      const used = queryOne<{cost:number}>(`SELECT COALESCE(SUM(estimated_cost),0) AS cost FROM social_steps WHERE company_id=? AND cycle_id=? AND (status='done' OR (status='running' AND lease_expires_at>?))`,[this.companyId,this.cycleId,stamp])!.cost;
      if (this.budget.cap > 0 && used+step.estimated_cost > this.budget.cap) return null;
      const attempt=row.attempt_count+1, token=row.fencing_token+1;
      const expires=iso(now+LEASE_TTL_SECONDS);
      run(`UPDATE social_steps SET status='running', attempt_count=?, fencing_token=?, lease_owner=?, lease_expires_at=?, heartbeat_at=?, last_attempt_at=?, retry_at=NULL, updated_at=? WHERE company_id=? AND cycle_id=? AND step_id=?`,[attempt,token,workerId,expires,stamp,stamp,stamp,this.companyId,this.cycleId,stepId]);
      // Required second write. Any storage error rolls back the entire claim.
      run(`INSERT INTO social_provider_leases (lease_key,operation_key,company_id,provider,step_id,worker_id,fencing_token,lease_expires_at,heartbeat_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lease_key) DO UPDATE SET operation_key=excluded.operation_key,worker_id=excluded.worker_id,fencing_token=excluded.fencing_token,lease_expires_at=excluded.lease_expires_at,heartbeat_at=excluded.heartbeat_at,updated_at=excluded.updated_at`,[this.providerLeaseKey(stepId,attempt),this.operationKey(stepId,attempt),this.companyId,step.provider,stepId,workerId,token,expires,stamp,stamp,stamp]);
      return {attempt,fencingToken:token};
    }).immediate();
  }

  private updateOwnedLease(lease: Lease, action: 'heartbeat'|'done'|'blocked'|'failed', retryAt?:number): boolean {
    if (this.fixtureMemoryOnly) return lease.leaseExpiresAt > this.now();
    return getDb().transaction(() => {
      const now=this.now(), stamp=new Date(now*1000).toISOString();
      const row=this.durableState(lease.stepId);
      const key=this.providerLeaseKey(lease.stepId,lease.attempt);
      const provider=queryOne<{worker_id:string;fencing_token:number;lease_expires_at:string}>(`SELECT * FROM social_provider_leases WHERE lease_key=?`,[key]);
      if (!row || row.status!=='running' || row.lease_owner!==lease.workerId || row.fencing_token!==lease.fencingToken || !(Date.parse(row.lease_expires_at??'')/1000>now) || !provider || provider.worker_id!==lease.workerId || provider.fencing_token!==lease.fencingToken || !(Date.parse(provider.lease_expires_at)/1000>now)) return false;
      if (action==='heartbeat') {
        const expires=new Date((now+LEASE_TTL_SECONDS)*1000).toISOString();
        run(`UPDATE social_steps SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE company_id=? AND cycle_id=? AND step_id=?`,[stamp,expires,stamp,this.companyId,this.cycleId,lease.stepId]);
        run(`UPDATE social_provider_leases SET heartbeat_at=?,lease_expires_at=?,updated_at=? WHERE lease_key=?`,[stamp,expires,stamp,key]);
      } else {
        run(`UPDATE social_steps SET status=?,retry_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE company_id=? AND cycle_id=? AND step_id=?`,[action,retryAt ? new Date(retryAt*1000).toISOString():null,stamp,this.companyId,this.cycleId,lease.stepId]);
        run(`DELETE FROM social_provider_leases WHERE lease_key=? AND worker_id=? AND fencing_token=?`,[key,lease.workerId,lease.fencingToken]);
      }
      return true;
    }).immediate();
  }

  /** Commit a completed step (reserve → settle). */
  settle(stepId: string, workerId: string, fencingToken: number): boolean {
    const lease = this.leases.get(stepId);
    if (!lease || lease.workerId !== workerId || lease.fencingToken !== fencingToken) return false;
    if (!this.updateOwnedLease(lease, 'done')) return false;
    this.leases.delete(stepId);
    const step = this.steps.get(stepId);
    if (step) {
      this.providerActive.set(step.provider, Math.max(0, (this.providerActive.get(step.provider) ?? 1) - 1));
      this.budget.settle(stepId);

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
    const terminal = !!opts.permanent || lease.attempt >= MAX_ATTEMPTS_PER_STEP;
    if (!this.updateOwnedLease(lease, terminal ? 'failed' : 'blocked', this.now()+Math.max(30*lease.attempt, opts.rateLimited ? Math.min(opts.retryAfterSeconds??RATE_LIMIT_DEFAULT_RETRY_SECONDS,RATE_LIMIT_MAX_RETRY_SECONDS):0))) return false;
    const step = this.steps.get(stepId);
    if (step) {
      this.providerActive.set(step.provider, Math.max(0, (this.providerActive.get(step.provider) ?? 1) - 1));
      this.budget.release(stepId);

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
    if (!this.fixtureMemoryOnly) {
      const row=this.durableState(stepId);
      if (row?.status==='running') return false;
      const step=this.steps.get(stepId)!;
      const stamp=new Date(this.now()*1000).toISOString();
      const result=run(`INSERT INTO social_steps (step_id,company_id,cycle_id,depends_on,role,provider,model,estimated_cost,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'done',?,?) ON CONFLICT(step_id,company_id,cycle_id) DO UPDATE SET status='done', updated_at=excluded.updated_at WHERE social_steps.status<>'running'`,[stepId,this.companyId,this.cycleId,JSON.stringify(step.depends_on),step.role,step.provider,step.model??null,step.estimated_cost,stamp,stamp]);
      if (!result.changes) return false;
    }
    this.state.set(stepId, 'done');
    return true;
  }

  operationKey(stepId: string, attempt: number): string {
    return createHash('sha256').update(JSON.stringify([this.companyId,this.cycleId,stepId,attempt])).digest('hex');
  }

  status(): OrchestratorStatus {
    this.refreshDurableStates();
    const states = [...this.state.values()];
    const providers: Record<string, number> = {};
    for (const [provider, active] of this.providerActive) providers[provider] = active;
    let reserved=this.budget.reservedAmount, spent=this.budget.settledAmount;
    if (!this.fixtureMemoryOnly) {
      const stamp=new Date(this.now()*1000).toISOString();
      const totals=queryOne<{reserved:number;spent:number}>(`SELECT COALESCE(SUM(CASE WHEN status='running' AND lease_expires_at>? THEN estimated_cost ELSE 0 END),0) AS reserved, COALESCE(SUM(CASE WHEN status='done' THEN estimated_cost ELSE 0 END),0) AS spent FROM social_steps WHERE company_id=? AND cycle_id=?`,[stamp,this.companyId,this.cycleId])!;
      reserved=totals.reserved;spent=totals.spent;
      for(const key of Object.keys(providers)) delete providers[key];
      for(const [sid,step] of this.steps) if(this.state.get(sid)==='running') providers[step.provider]=(providers[step.provider]??0)+1;
    }
    return {
      mode: this.mode,
      busy: states.filter((s) => s === 'running').length,
      waiting: states.filter((s) => s === 'ready').length,
      queued: states.filter((s) => s === 'pending' || s === 'blocked').length,
      done: states.filter((s) => s === 'done').length,
      failed: states.filter((s) => s === 'failed').length,
      providers,
      budgetReserved: reserved,
      budgetSpent: spent,
      budgetCap: this.budget.cap,
    };
  }
}

/** Factory mirroring the Python module's constructor path: builds an
 * orchestrator with plan-derived limits pre-configured. */
export function createSocialOrchestrator(mode: string, plan: SocialPlan, nowFn?: () => number): SocialOrchestrator {
  const orchestrator = new SocialOrchestrator(mode, plan, nowFn);
  orchestrator.configureLimits(plan.ollama_plan, plan.providers ?? {});
  return orchestrator;
}