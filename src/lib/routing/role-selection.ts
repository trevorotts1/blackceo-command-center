/**
 * JEV-015 role selection — task-aware worker pick (spec section 7).
 *
 * Two-stage selection over an already company/department-scoped pool:
 *   1. SUITABILITY GATE — exclude per section 7.3 predicates (foreign-company,
 *      offline/retired, unauthorized runtime, QC-only), then rank the survivors
 *      by task-aware lexical/capability fit. An idle unqualified worker must
 *      never beat a qualified one just for being idle. A role with deferred
 *      embeddings stays in the pool (section 7.4): scoring is pure lexical over
 *      real role text, so missing vectors change nothing.
 *   2. CAPACITY POLICY — among sufficiently suitable workers, pick
 *      deterministically: fewest active tasks first, then the higher task-fit
 *      score, then stable by worker id. Load and capability stay separate
 *      factors: load may only choose *among* the sufficient (an idle
 *      unqualified worker never reaches this stage — the gate above excludes
 *      it), and it never settles same-label peers at equal load. When load and
 *      capacity are equal, actual task fit decides (A19); the worker id is the
 *      last-resort determinism tie-break only for a true fit tie. When every
 *      suitable worker is busy, return a QUEUED assignment naming the
 *      least-loaded suitable worker with reason capacity — never "ineligible".
 *
 * Owner-direct is its own path: a named worker resolves straight through,
 * bypassing suitability exclusions (offline still excluded — a pin cannot wake
 * a dead box), mirroring resolveSpecialistPin in department-router.ts.
 *
 * No imports beyond types: safe for edge bundles, zero DB access (C8-clean).
 * ponytail: honest-queue surfacing into routeTaskDecision (a real queued task
 * state vs retained assignment) deferred; the seam retains the existing
 * capacity policy (assign least-loaded suitable) and the queued verdict is
 * returned for the future caller. Add when routing learns a queue state.
 */

import type { Agent } from '@/lib/types';
import type { AgentWithLoad } from './department-router';

/** Task context the selector must see (spec 7.1). */
export interface RoleSelectionTask {
  title: string;
  description?: string | null;
  /** Requested business outcome (7.1), when the caller has it. */
  outcome?: string | null;
  /** Requested artifact/deliverable type (7.1), when the caller has it. */
  artifactType?: string | null;
  /** Task constraints (7.1), when the caller has them. */
  constraints?: string | null;
  /** Already-selected department id/slug (7.1). */
  departmentId?: string | null;
  departmentName?: string | null;
  /** Relevant SOP context, e.g. matched SOP titles/slugs (7.1). */
  sopContext?: string | null;
}

/** One selectable worker: section 7.2 profile fields. */
export interface SelectableWorker {
  /** Worker (agent row) id — also the stable tie-break key. */
  id: string;
  name: string;
  /** Role title; title alone is insufficient, hence the fields below. */
  role: string;
  description?: string | null;
  /** 7.2: responsibilities and owned outcomes. */
  responsibilities?: string | null;
  ownedOutcomes?: string[] | null;
  /** 7.2: supported deliverable types. */
  supportedDeliverables?: string[] | null;
  /** 7.2: relevant procedures / skills / capabilities. */
  capabilities?: string[] | null;
  /** 7.2: explicit exclusions — task text hitting one disqualifies. */
  exclusions?: string[] | null;
  /** 7.2: source file/section identifiers + content hashes. */
  sources?: string[] | null;
  /** Owning company; null when the mapper cannot prove it (pool already scoped). */
  companyId?: string | null;
  status: string;
  isMaster: boolean;
  workspaceId: string;
  /** 'qc' marks independent QC workers — never production candidates. */
  roleType?: string | null;
  /** 7.4: deferred embeddings must not drop the worker from the pool. */
  embeddingsDeferred?: boolean;
  /** Explicit authorization flag; default true. */
  authorized?: boolean;
  /** Explicit availability override; default derived from status. */
  availability?: 'available' | 'offline' | 'retired';
  /** Measured load: in-progress task count. */
  activeTasks: number;
  /** Max parallel executions (agents.max_concurrent_executions, default 1). */
  maxConcurrentExecutions?: number | null;
}

/** Extra 7.2 profile material layered onto an existing agent row. */
export interface WorkerProfileExtra {
  responsibilities?: string | null;
  ownedOutcomes?: string[] | null;
  supportedDeliverables?: string[] | null;
  capabilities?: string[] | null;
  exclusions?: string[] | null;
  sources?: string[] | null;
  embeddingsDeferred?: boolean;
  authorized?: boolean;
  availability?: 'available' | 'offline' | 'retired';
}

/**
 * Map an existing agent row to a SelectableWorker.
 * Source columns: agents.id/name/role/description/status/is_master/workspace_id
 * (Agent type, src/lib/types.ts), agents.role_type ('qc', migration 060),
 * agents.max_concurrent_executions (default 1, migration 149), and
 * active_tasks computed by fetchAgentsWithLoad (department-router.ts).
 * companyId comes from the caller's workspace lookup; null = unproven, and an
 * unproven company is NOT treated as foreign (the pool is already scoped).
 */
export function workerProfileFromAgent(
  agent: AgentWithLoad | Agent,
  ctx: { companyId?: string | null; extra?: WorkerProfileExtra } = {},
): SelectableWorker {
  const withLoad = agent as AgentWithLoad;
  const extra = ctx.extra ?? {};
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    description: agent.description ?? null,
    responsibilities: extra.responsibilities ?? null,
    ownedOutcomes: extra.ownedOutcomes ?? null,
    supportedDeliverables: extra.supportedDeliverables ?? null,
    capabilities: extra.capabilities ?? null,
    exclusions: extra.exclusions ?? null,
    sources: extra.sources ?? null,
    companyId: ctx.companyId ?? null,
    status: agent.status,
    isMaster: Boolean(agent.is_master),
    workspaceId: agent.workspace_id,
    roleType: (agent as { role_type?: string | null }).role_type ?? null,
    embeddingsDeferred: extra.embeddingsDeferred ?? false,
    authorized: extra.authorized ?? true,
    availability: extra.availability,
    activeTasks: typeof withLoad.active_tasks === 'number' ? withLoad.active_tasks : 0,
    maxConcurrentExecutions:
      (agent as { max_concurrent_executions?: number | null }).max_concurrent_executions ?? 1,
  };
}

export interface SelectionCallContext {
  companyId?: string | null;
  /** Owner-named worker (id, exact name, or unique substring): own path. */
  ownerDirectTarget?: string | null;
  /**
   * Department role labels (department.agentRoles). Weak membership prior
   * (+2): never outranks real task signal, but a role-matching worker beats
   * an idle non-matching one when task text is thin. Preserves the legacy
   * pickBestAgent floor.
   */
  roleHint?: string[] | null;
}

export type SelectionCode =
  | 'owner-direct'
  | 'suitability-capacity'
  | 'capacity-queued'
  | 'none-suitable';

export interface ExcludedWorker {
  id: string;
  reason: string;
}

export interface RoleSelectionResult {
  status: 'assigned' | 'queued' | 'none-suitable';
  worker: SelectableWorker | null;
  code: SelectionCode;
  reason: string;
  evaluatedCount: number;
  suitableCount: number;
  excluded: ExcludedWorker[];
}

function availabilityOf(w: SelectableWorker): 'available' | 'offline' | 'retired' {
  if (w.availability) return w.availability;
  return w.status === 'offline' ? 'offline' : 'available';
}

/** Section 7.3 exclusion predicates. Returns the reason, or null to keep. */
export function excludeWorker(
  w: SelectableWorker,
  ctx: SelectionCallContext = {},
): string | null {
  const avail = availabilityOf(w);
  if (avail === 'offline') return 'offline worker';
  if (avail === 'retired') return 'retired worker';
  if (w.authorized === false) return 'unauthorized runtime';
  if (ctx.companyId && w.companyId && w.companyId !== ctx.companyId) {
    return 'foreign-company worker';
  }
  if ((w.roleType ?? '').toLowerCase() === 'qc') return 'QC-only worker';
  return null;
}

function ownerDirectMatch(
  pool: SelectableWorker[],
  target: string,
): SelectableWorker | null {
  const needle = target.trim().toLowerCase();
  if (!needle) return null;
  const live = pool.filter((w) => availabilityOf(w) !== 'offline');
  const hit =
    live.find((w) => w.id.toLowerCase() === needle) ??
    live.find((w) => w.name.toLowerCase() === needle) ??
    null;
  if (hit) return hit;
  if (needle.length >= 3) {
    const partial = live.filter((w) => w.name.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0];
  }
  return null;
}

const SCORE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'need', 'needs',
  'want', 'please', 'into', 'over', 'under', 'our', 'your', 'task',
]);

function taskTokens(t: RoleSelectionTask): string[] {
  const text = [t.title, t.description, t.outcome, t.artifactType, t.constraints, t.sopContext]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const words = new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !SCORE_STOPWORDS.has(w)));
  return [...words];
}

function workerCorpus(w: SelectableWorker): string {
  return [
    w.role,
    w.description,
    w.responsibilities,
    (w.ownedOutcomes ?? []).join(' '),
    (w.supportedDeliverables ?? []).join(' '),
    (w.capabilities ?? []).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Task-aware suitability score: lexical/capability hits over real role text. */
export function suitabilityScore(
  w: SelectableWorker,
  task: RoleSelectionTask,
  ctx: { roleHint?: string[] | null } = {},
): number {
  const tokens = taskTokens(task);
  if (tokens.length === 0) return 0;
  const corpus = workerCorpus(w);
  let score = 0;
  for (const tok of tokens) {
    if (corpus.includes(tok)) score += 1;
  }
  const artifact = (task.artifactType ?? '').trim().toLowerCase();
  if (artifact.length >= 3) {
    const deliverables = (w.supportedDeliverables ?? []).join(' ').toLowerCase();
    if (deliverables.includes(artifact)) score += 3;
  }
  // Weak department-membership prior (+2 < any real task fit): preserves the
  // legacy pickBestAgent floor so a thin task over a thin pool still lands on
  // the specialist, while any task-aware signal dominates. Idle-unqualified
  // can never win on this prior alone against qualified task signal.
  const hint = ctx.roleHint ?? [];
  if (hint.length > 0) {
    const roleLower = w.role.toLowerCase();
    if (hint.some((r) => roleLower.includes((r ?? '').toLowerCase()) || (r ?? '').toLowerCase().includes(roleLower))) {
      score += 2;
    }
  }
  return score;
}

function hitsExclusion(w: SelectableWorker, task: RoleSelectionTask): string | null {
  const text = [task.title, task.description, task.outcome, task.artifactType, task.constraints]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  for (const ex of w.exclusions ?? []) {
    const phrase = (ex ?? '').trim().toLowerCase();
    if (phrase.length >= 3 && text.includes(phrase)) return ex;
  }
  return null;
}

function capacityOf(w: SelectableWorker): number {
  const max = w.maxConcurrentExecutions ?? 1;
  return max > 0 ? max : 1;
}

function byLoadThenId(a: SelectableWorker, b: SelectableWorker): number {
  if (a.activeTasks !== b.activeTasks) return a.activeTasks - b.activeTasks;
  return a.id.localeCompare(b.id);
}

/**
 * Capacity policy comparator over scored candidates (spec 7.3): measured load
 * first, then task fit, then the stable id last. Load never settles two workers
 * that fit the task differently — at equal load the fit score decides (A19), and
 * the id is reached only on a true fit tie. Load and capability stay separate
 * factors; this only orders workers the suitability gate already admitted.
 */
function byLoadThenFitThenId(
  a: { worker: SelectableWorker; score: number },
  b: { worker: SelectableWorker; score: number },
): number {
  if (a.worker.activeTasks !== b.worker.activeTasks) {
    return a.worker.activeTasks - b.worker.activeTasks;
  }
  if (b.score !== a.score) return b.score - a.score;
  return a.worker.id.localeCompare(b.worker.id);
}

/** True when the task carries anything worth judging (else legacy path). */
export function hasTaskContent(t: RoleSelectionTask): boolean {
  return [t.title, t.description, t.outcome, t.artifactType, t.constraints, t.sopContext]
    .some((s) => (s ?? '').trim().length > 0);
}

/**
 * Two-stage selection: suitability gate, then deterministic capacity/load.
 * Pool must already be company/department scoped by the caller.
 */
export function selectRoleWorker(
  pool: SelectableWorker[],
  task: RoleSelectionTask,
  ctx: SelectionCallContext = {},
): RoleSelectionResult {
  // Stage 0 — owner-direct own path (7.3 exception).
  if (ctx.ownerDirectTarget && ctx.ownerDirectTarget.trim()) {
    const pinned = ownerDirectMatch(pool, ctx.ownerDirectTarget);
    if (pinned) {
      return {
        status: 'assigned',
        worker: pinned,
        code: 'owner-direct',
        reason: `owner-direct: "${ctx.ownerDirectTarget}" resolved straight to ${pinned.name}, bypassing suitability scoring`,
        evaluatedCount: pool.length,
        suitableCount: 1,
        excluded: [],
      };
    }
  }

  // Stage 1 — suitability gate: 7.3 exclusions, then task-aware fit.
  const excluded: ExcludedWorker[] = [];
  const scored: { worker: SelectableWorker; base: number; score: number }[] = [];
  for (const w of pool) {
    const reason = excludeWorker(w, ctx);
    if (reason) {
      excluded.push({ id: w.id, reason });
      continue;
    }
    const hit = hitsExclusion(w, task);
    if (hit) {
      excluded.push({ id: w.id, reason: `task hits explicit exclusion "${hit}"` });
      continue;
    }
    scored.push({
      worker: w,
      base: suitabilityScore(w, task),
      score: suitabilityScore(w, task, ctx),
    });
  }
  // Sufficiently suitable, in priority order (7.3: an idle unqualified worker
  // must never beat a qualified one on idleness):
  //   1. Workers with real task signal (base score > 0, no hint counted).
  //   2. Else workers with only the weak department-membership prior
  //      (legacy pickBestAgent floor for task-blind callers).
  //   3. Else all exclusion survivors (thin pool: department membership itself
  //      is the suitability evidence, so the pick never collapses to
  //      none-suitable on thin text).
  // Deferred-embedding roles (7.4) always survive: scoring is lexical.
  const withBase = scored.filter((s) => s.base > 0);
  const withHint = scored.filter((s) => s.score > 0);
  const suitable = (withBase.length > 0 ? withBase : withHint.length > 0 ? withHint : scored).sort(
    (a, b) => b.score - a.score || byLoadThenId(a.worker, b.worker),
  );

  if (suitable.length === 0) {
    return {
      status: 'none-suitable',
      worker: null,
      code: 'none-suitable',
      reason: 'no suitable worker: pool empty after 7.3 exclusions and suitability gate',
      evaluatedCount: pool.length,
      suitableCount: 0,
      excluded,
    };
  }

  // Stage 2 — deterministic capacity/load among the sufficiently suitable.
  const available = suitable.filter(({ worker }) => worker.activeTasks < capacityOf(worker));
  if (available.length > 0) {
    const pick = leastLoadedThenBestFit(available);
    return {
      status: 'assigned',
      worker: pick.worker,
      code: 'suitability-capacity',
      reason: `suitability ${pick.score} + least-loaded among ${suitable.length} suitable → ${pick.worker.name} (load ${pick.worker.activeTasks}/${capacityOf(pick.worker)})`,
      evaluatedCount: pool.length,
      suitableCount: suitable.length,
      excluded,
    };
  }

  // All suitable workers busy: honest queued assignment, never "ineligible".
  // Same policy as Stage 2 — least loaded, then best fit, then the id — so an
  // equal-load queue is still settled by task fit, not by collation (A19).
  const queued = [...suitable].sort(byLoadThenFitThenId)[0];
  return {
    status: 'queued',
    worker: queued.worker,
    code: 'capacity-queued',
    reason: `capacity: all ${suitable.length} suitable workers busy; queued on ${queued.worker.name} (load ${queued.worker.activeTasks}/${capacityOf(queued.worker)})`,
    evaluatedCount: pool.length,
    suitableCount: suitable.length,
    excluded,
  };
}

function leastLoadedThenBestFit(
  available: { worker: SelectableWorker; score: number }[],
): { worker: SelectableWorker; score: number } {
  return [...available].sort(byLoadThenFitThenId)[0];
}
