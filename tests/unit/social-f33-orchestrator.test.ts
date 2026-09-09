/**
 * social-f33-orchestrator.test.ts — F33 acceptance (CC half).
 *
 * "Ollama request counts never exceed 3 or 10 for the chosen plan, including
 * orchestration/QC calls. Ultra can use more slots with an eligible provider
 * but launches only useful work. Worker death, 429 and quota exhaustion
 * recover without duplicate side effects."
 *
 * Coverage against src/lib/jobs/social-orchestrator.ts + provider-budget.ts:
 *   1. Wave ordering — dependent chains yield one wave per tier; a dependent
 *      step is never claimable before its dependency settles.
 *   2. Lease fencing — a stale worker cannot commit after reassignment
 *      (fencing token mismatch refuses; tokens advance).
 *   3. Budget enforcement — over-cap reservation refused; settle retains
 *      spend; release frees headroom (ProviderBudget).
 *   4. Provider semaphores — Ollama Pro=3 / Max=10 (QC calls count too);
 *      unknown quota → conservative default 2; plan overrides win.
 *   5. Application ceiling — Ultra caps at 50 useful workers; Standard at 1.
 *   6. 429/Retry-After + circuit breaker — failing provider parked/tripped
 *      while eligible alternatives proceed.
 *
 * Run:
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *     --test tests/unit/social-f33-orchestrator.test.ts
 */
import './_isolated-db'; // MUST be first DB import: provider_leases tests need the real migration chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, queryOne, run, closeDb } from '../../src/lib/db';
import {
  createSocialOrchestrator,
  providerLimit,
  applicationCeiling,
  ULTRA_APP_CEILING,
  UNKNOWN_PROVIDER_QUOTA_DEFAULT,
  type SocialPlan,
} from '../../src/lib/jobs/social-orchestrator';
import { ProviderBudget } from '../../src/lib/jobs/provider-budget';

getDb(); // run the full migration chain (incl. 137) against the isolated temp DB

test.after(async () => {
  try { closeDb(); } catch { /* ignore */ }
});

function fakeClock(start = 10_000) {
  let t = start;
  return {
    now: () => t,
    advance: (s: number) => { t += s; },
  };
}


function chainPlan(n: number, provider = 'openrouter', cost = 0): SocialPlan {
  const steps = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const sid = `worker-${String(i).padStart(2, '0')}`;
    steps.push({ step_id: sid, depends_on: prev ? [prev] : [], role: 'worker', provider, estimated_cost: cost });
    prev = sid;
  }
  return { cycle_id: 'c1', steps };
}

// ── 1. Wave ordering ────────────────────────────────────────────────────────
test('[F33.1] dependent chains stay ordered; dependent never claims before dep settles', () => {
  const clock = fakeClock();
  const orch = createSocialOrchestrator('ultra', chainPlan(4), clock.now);
  assert.deepEqual(orch.waves(), [['worker-00'], ['worker-01'], ['worker-02'], ['worker-03']],
    'a chain yields one wave per tier, in order');

  const first = orch.claim('w')!;
  assert.ok(first, 'first step claims');
  assert.equal(orch.claim('w2', 'worker-01'), null,
    'dependent step blocked while its dependency is running');
  assert.ok(orch.settle('worker-00', 'w', first.fencingToken), 'dependency settles');
  assert.ok(orch.claim('w2', 'worker-01'), 'dependent becomes claimable only after settle');
});

// ── 2. Lease fencing ────────────────────────────────────────────────────────
test('[F33.2] stale worker cannot commit after reassignment (fencing tokens advance)', () => {
  const clock = fakeClock();
  const orch = createSocialOrchestrator('ultra', chainPlan(2), clock.now);
  const lease = orch.claim('worker-a')!;
  assert.ok(lease);

  clock.advance(200); // lease TTL (120s) lapses — worker died
  assert.equal(orch.recoverExpired(), 1, 'dead worker lease reclaimed');
  assert.equal(orch.settle('worker-00', 'worker-a', lease.fencingToken), false,
    'stale worker settle refused on fencing token');

  const fresh = orch.claim('worker-b', 'worker-00')!;
  assert.ok(fresh);
  assert.ok(fresh.fencingToken > lease.fencingToken, 'fencing token advances on reassignment');
  assert.equal(orch.settle('worker-00', 'worker-b', fresh.fencingToken), true, 'fresh holder commits');
  assert.equal(orch.settle('worker-00', 'worker-b', fresh.fencingToken), false, 'double settle refused');
});

// ── 3. Budget enforcement ───────────────────────────────────────────────────
test('[F33.3] budget: over-cap reservation refused, settle binds cumulatively, release frees headroom', () => {
  const budget = new ProviderBudget(1.0);
  assert.ok(budget.reserve('big', 0.75, 1), 'big fits under the cap');
  assert.equal(budget.reserve('huge', 0.5, 1), false, 'over-cap reservation refused');
  assert.ok(budget.reserve('small', 0.2, 1), 'a fitting step still reserves');
  assert.ok(budget.wouldExceed(0.1), 'headroom exhausted');
  assert.equal(budget.settle('big'), true, 'settle converts reserve to spend');
  assert.ok(Math.abs(budget.reservedAmount - 0.2) < 1e-9);
  assert.equal(budget.settledAmount, 0.75);
  // D-F33-03: settled 0.75 binds the cap — reserved(0.2)+settled(0.75)+0.1 > 1.0.
  assert.ok(budget.wouldExceed(0.1), 'settled spend still binds the cap after settle');
  assert.ok(budget.release('small'), 'release frees headroom');
  assert.ok(Math.abs(budget.reservedAmount) < 1e-9);
  assert.equal(budget.spent, 0.75, 'settled spend retained');
  // settled 0.75 + 0.9 > 1.0: refused — only the remaining 0.25 fits.
  assert.equal(budget.reserve('huge', 0.9, 2), false, 'settled spend blocks a 0.9 reservation');
  assert.ok(budget.reserve('fits', 0.25, 2), 'exactly the remaining 0.25 still fits');

  // End-to-end through the orchestrator's fail path (release on failure).
  const clock = fakeClock();
  const plan: SocialPlan = {
    cycle_id: 'c', cycle_budget_cap: 1.0,
    steps: [
      { step_id: 'big', depends_on: [], role: 'worker', provider: 'p', estimated_cost: 0.9 },
      { step_id: 'small', depends_on: [], role: 'worker', provider: 'p', estimated_cost: 0.2 },
    ],
  };
  const orch = createSocialOrchestrator('ultra', plan, clock.now);
  const lease = orch.claim('w', 'big')!;
  assert.ok(lease);
  assert.equal(orch.claim('w2', 'small'), null, 'budget exhausted inside the orchestrator');
  assert.equal(orch.fail('big', 'w', lease.fencingToken), true, 'failure releases the reservation');
  assert.ok(orch.claim('w3', 'small'), 'released budget admits the next step');
});

// ── 4. Provider semaphores (incl. coordinator/QC calls) ────────────────────
test('[F33.4] Ollama Pro=3 / Max=10 incl. QC calls; unknown → 2; plan overrides win', () => {
  assert.equal(providerLimit('ollama-cloud', { steps: [], ollama_plan: 'pro' }), 3);
  assert.equal(providerLimit('ollama-cloud', { steps: [], ollama_plan: 'max' }), 10);
  assert.equal(providerLimit('ollama-cloud', { steps: [] }), UNKNOWN_PROVIDER_QUOTA_DEFAULT);
  assert.equal(providerLimit('custom', { steps: [], providers: { custom: { concurrency: 7 } } }), 7);

  for (const [planName, limit] of [['pro', 3], ['max', 10]] as const) {
    // Writer AND qc steps share the same provider — orchestration/QC calls
    // count against the same documented limit.
    const steps = [
      ...Array.from({ length: 30 }, (_, i) => ({ step_id: `w-${i}`, depends_on: [], role: 'writer', provider: 'ollama-cloud', estimated_cost: 0 })),
      ...Array.from({ length: 5 }, (_, i) => ({ step_id: `qc-${i}`, depends_on: [], role: 'qc', provider: 'ollama-cloud', estimated_cost: 0 })),
    ];
    const clock = fakeClock();
    const orch = createSocialOrchestrator('ultra', { cycle_id: 'c', ollama_plan: planName, steps }, clock.now);
    let active = 0;
    let maxOverlap = 0;
    while (true) {
      const lease = orch.claim('w');
      if (!lease) break;
      active++;
      maxOverlap = Math.max(maxOverlap, active);
      if (active >= ULTRA_APP_CEILING) break; // never even brush the app ceiling
    }
    assert.ok(maxOverlap <= limit, `Ollama ${planName} never exceeds ${limit} concurrent calls (saw ${maxOverlap})`);
  }
});

// ── D-F33-02: durable provider-lease fencing across processes ───────────────
test('[F33.7] cross-process lease fencing: a second worker holding the live durable lease refuses the in-memory-holder claim', () => {
  // Wall-clock time: the durable path keys lease_expiry off real ISO
  // timestamps, and acquireProviderLease skips the table under fake clocks.
  const t0 = Date.now() / 1000;
  const clock = { now: () => Date.now() / 1000, advance: (_s: number) => { /* wall clock */ } };
  void t0;
  const plan: SocialPlan = {
    cycle_id: 'lease-cycle', company_id: 'lease-co',
    steps: [{ step_id: 's1', depends_on: [], role: 'worker', provider: 'openrouter', estimated_cost: 0 }],
  };
  const orchA = createSocialOrchestrator('ultra', plan, clock.now);
  const leaseA = orchA.claim('worker-a', 's1');
  assert.ok(leaseA, 'first process claims');
  const keyRow = queryOne<{ lease_key: string; worker_id: string }>(
    `SELECT lease_key, worker_id FROM social_provider_leases WHERE company_id = 'lease-co' AND provider = 'openrouter' AND step_id = 's1'`,
  );
  assert.ok(keyRow, 'claim wrote a durable provider-lease row');
  assert.equal(keyRow!.worker_id, 'worker-a');

  // A second orchestrator instance (second process) on the same cycle sees
  // the live durable lease and must NOT claim the same provider work.
  const orchB = createSocialOrchestrator('ultra', plan, clock.now);
  assert.equal(orchB.claim('worker-b', 's1'), null,
    'second process refused while the durable lease is live');

  // After the holder settles (durable row released), the other process may
  // proceed (no double-run while live). Wall-clock expiry (120s) is not
  // advanced here — release-on-settle is the deterministic handoff.
  assert.ok(orchA.settle('s1', 'worker-a', leaseA.fencingToken), 'holder settles and releases the durable row');
  assert.equal(orchB.claim('worker-b', 's1'), null, 'completed durable step never reruns after coordinator restart');
});

// ── D-F33-02: in-memory fallback when the durable table is unavailable ──────
test('[F33.8] explicit deterministic test clock can exercise memory-only fixture', () => {
  run(`ALTER TABLE social_provider_leases RENAME TO social_provider_leases_hidden`);
  try {
    const clock = fakeClock();
    const orch = createSocialOrchestrator('ultra', chainPlan(1), clock.now);
    assert.ok(orch.claim('w'), 'claim proceeds on the in-memory path with no table');
  } finally {
    run(`ALTER TABLE social_provider_leases_hidden RENAME TO social_provider_leases`);
  }
});

// ── D-F33-03: settled spend binds the cap cumulatively ───────────────────────
test('[F33.9] cap 1.0: reserve 0.6, settle → second 0.6 reservation refused (settled spend binds)', () => {
  const budget = new ProviderBudget(1.0);
  assert.ok(budget.reserve('first', 0.6, 1), 'first 0.6 reserves');
  assert.ok(budget.settle('first'), 'first settles');
  assert.equal(budget.reserve('second', 0.6, 2), false,
    'settled 0.6 still counts: a second 0.6 would exceed the 1.0 cap');
  assert.ok(budget.reserve('fits', 0.4, 2), 'exactly the remaining 0.4 still fits');
});

// ── 5. Application ceiling ──────────────────────────────────────────────────
test('[F33.5] Ultra fills its 50-execution ceiling with useful work; Standard runs one', () => {
  assert.equal(applicationCeiling('ultra'), ULTRA_APP_CEILING);
  assert.equal(applicationCeiling('standard'), 1);
  const clock = fakeClock();
  const plan: SocialPlan = {
    cycle_id: 'c1',
    providers: { openrouter: { concurrency: 100 } },
    steps: Array.from({ length: 60 }, (_, i) => ({
      step_id: `worker-${String(i).padStart(2, '0')}`, depends_on: [], role: 'worker',
      provider: 'openrouter', estimated_cost: 0,
    })),
  };
  const ultra = createSocialOrchestrator('ultra', plan, clock.now);
  let claimed = 0;
  while (ultra.claim(`worker-${claimed}`)) claimed++;
  assert.equal(claimed, ULTRA_APP_CEILING, 'Ultra fills the ceiling with ready (useful) work');

  const standard = createSocialOrchestrator('standard', plan, clock.now);
  assert.ok(standard.claim('w1'));
  assert.equal(standard.claim('w2'), null, 'Standard runs exactly ONE execution');
});

// ── 6. 429/Retry-After + circuit breaker ────────────────────────────────────
test('[F33.6] 429 parks the provider; circuit isolates failures; alternatives proceed', () => {
  const clock = fakeClock();
  const plan: SocialPlan = {
    cycle_id: 'c',
    steps: [
      { step_id: 's1', depends_on: [], role: 'worker', provider: 'openrouter', estimated_cost: 0 },
      { step_id: 's2', depends_on: [], role: 'worker', provider: 'deepseek', estimated_cost: 0 },
    ],
  };
  const orch = createSocialOrchestrator('ultra', plan, clock.now);
  const lease = orch.claim('w', 's1')!;
  assert.ok(lease);
  assert.equal(orch.fail('s1', 'w', lease.fencingToken, { rateLimited: true, retryAfterSeconds: 60 }), true);
  assert.equal(orch.claim('w', 's1'), null, '429 parks the provider — claims refused, no hammering');
  assert.ok(orch.claim('w2', 's2'), 'an eligible alternative provider still serves');
  clock.advance(61);
  assert.ok(orch.claim('w3', 's1'), 'after the Retry-After window the provider serves again');

  // Circuit breaker: 3 consecutive non-429 failures trip provider-a OPEN…
  const clock2 = fakeClock();
  const plan2: SocialPlan = {
    cycle_id: 'c',
    steps: [
      { step_id: 'a-0', depends_on: [], role: 'worker', provider: 'provider-a', estimated_cost: 0 },
      { step_id: 'a-1', depends_on: [], role: 'worker', provider: 'provider-a', estimated_cost: 0 },
      { step_id: 'b-0', depends_on: [], role: 'worker', provider: 'provider-b', estimated_cost: 0 },
    ],
  };
  const orch2 = createSocialOrchestrator('ultra', plan2, clock2.now);
  for (let i = 0; i < 3; i++) {
    const l = orch2.claim('w', 'a-0')!;
    assert.ok(l, 'retry becomes eligible after its explicit backoff');
    orch2.fail('a-0', 'w', l.fencingToken);
    if (i < 2) clock2.advance(30 * (i + 1));
  }
  assert.equal(orch2.claim('w', 'a-1'), null, 'open circuit refuses claims for the failing provider');
  assert.ok(orch2.claim('w', 'b-0'), 'circuit isolates the failing provider only');
});