/**
 * Department Router — Intelligent name-agnostic task routing
 *
 * Routes tasks to the most appropriate agent based on:
 *   1. Explicit department tag on the task
 *   2. The decision engine (JEV) decides first; semantic similarity (embedding
 *      cosine) steps in only when JEV is unavailable (Option A, JEV-502):
 *      - Embeds task text against each dept's (name + purpose + keywords)
 *      - Uses the CLIENT'S OWN embedding provider (Gemini/OpenAI key, or
 *        keyless local Ollama)
 *      - LLM tiebreak when top-2 scores are within TIEBREAK_MARGIN
 *   3. Order jev, then semantic, then keyword (pickDepartment /
 *      DEPARTMENT_PICKER_ORDER, measured — JEV-502). JEV unsure = General Task.
 *   4. Agent role matching within the winning department
 *   5. Load balancing — prefer agents with fewer active tasks
 *
 * Gap 1 (COM intelligence): ComDispatcher picks the best agent via a
 *   multi-factor score (semantic affinity + urgency + department weight)
 *   rather than returning the first master agent it finds.
 *
 * Gap 2 (Load balancing): AgentLoadScore queries active task counts so
 *   we prefer less-loaded agents when scores are equal.
 *
 * Gap 3 (Intelligent name-agnostic routing): loadDepartments() returns the
 *   client's REAL workspace roster — custom dept names are fully routable.
 *   Semantic embeddings classify by MEANING against those real names.
 */

import { queryAll, queryOne } from '@/lib/db';
import type { Agent, Task, TaskPriority } from '@/lib/types';
import { loadDepartments, type DepartmentConfig } from './departments.config';
import { canonicalDeptSlug } from './canonical-slug';
import { isCatchAllWorkspace } from './catch-all-policy';
// JGT105 — direct sibling-file import (not the decision-engine barrel) to
// keep this module's import graph a straight line, never a cycle.
import { jevDecide, jevMode, jevEngineState, type JevDecision } from '@/lib/decision-engine/live';
import type { DecisionDepartment } from '@/lib/decision-engine/contract';
// B14 — applied-route receipts (SPEC S5 safe content). Import-only, side-effect
// free, and never consulted by any routing branch: the receipt can only be
// attached to a result the router already chose.
import {
  buildDecisionReceipt,
  type HqDecisionReceipt,
  type HqDecisionReceiptPhase,
  type HqDecisionReasonToken,
} from '@/lib/hq/decision-receipt';
import { resolveSpecialistSessionKey } from './executor-runtime';
import {
  selectRoleWorker,
  workerProfileFromAgent,
  type RoleSelectionTask,
} from './role-selection';
import {
  fetchEmbeddingsFor,
  cosineSimilarity,
  isEmbeddingAvailable,
  localEmbedText,
  resolveEmbeddingProvider,
  withEmbeddingFallback,
  type EmbeddingProvider,
  type EmbeddingVector,
} from '@/lib/sop-embeddings';
import {
  authorizedTiebreak,
  resolveTiebreakModel,
  resolveTiebreakPermission,
  type TiebreakFn,
  type TiebreakPermission,
} from './tiebreak-adapter';
import { decideSopVote, rankDepartmentsBySops, sopProfileKeywords, type SopVoteRanking } from './sop-vote';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * If the top-2 semantic scores are within this margin, trigger an LLM
 * tiebreak rather than picking blindly.
 */
const TIEBREAK_MARGIN = 0.04;

/**
 * Minimum routing confidence for semantic classification.
 *
 * When the best semantic similarity falls BELOW this floor (i.e. the task
 * text doesn't clearly match any department), comDispatch() routes to the
 * General Task catch-all instead of force-fitting to the wrong department.
 *
 * Tuneable via env: MIN_ROUTING_CONFIDENCE=0.45 (lower → fewer GT fallbacks,
 * more force-fits; higher → more GT fallbacks, fewer force-fits).
 * Document every General Task fallback in the logs (similarity + floor) so
 * this value can be calibrated from real data.
 *
 * Default: 0.55. Rationale: cosine similarity below 0.55 on
 * text-embedding-ada-002 / gemini-embedding-001 is typically noise-level
 * for domain-specific department text.
 *
 * Local Ollama runs on a different similarity scale per model, so its floor is
 * per model family (ollamaRoutingFloor): the lowest floor that keeps the
 * labeled fixture (scripts/eval-department-routing.ts) at >=90%
 * acceptable-or-General.
 *   - embeddinggemma (the local default, embeddinggemma-2:740m, with its
 *     query/document prefixes): 0.69 (0.68 → 89.3%, 0.69 → 91.7%; 0.56 → 62.1%).
 *   - any other local model: 0.56, as measured on nomic-embed-text in JEV-502
 *     (0.55 → 88.8%, 0.56 → 91.1%).
 * The env value, when valid, wins for every provider.
 */
const MIN_ROUTING_CONFIDENCE_ENV: number | null = (() => {
  const env = process.env.MIN_ROUTING_CONFIDENCE;
  if (env) {
    const parsed = parseFloat(env);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
    console.warn(
      `[DepartmentRouter] Invalid MIN_ROUTING_CONFIDENCE="${env}" — must be 0–1. Using the provider default.`,
    );
  }
  return null;
})();

/** Semantic routing floor for a local Ollama model (see the measurements above). */
export function ollamaRoutingFloor(model: string): number {
  return model.toLowerCase().includes('embeddinggemma') ? 0.69 : 0.56;
}

function minRoutingConfidence(p: EmbeddingProvider = resolveEmbeddingProvider()): number {
  return MIN_ROUTING_CONFIDENCE_ENV ?? (p.name === 'ollama' ? ollamaRoutingFloor(p.model) : 0.55);
}

/**
 * JEV-502 measured gates for the fallback pickers (same fixture):
 *  - a decision-engine route below 0.9 is a weak lexical guess (all of its
 *    >=0.9 picks score 1.0 — a full domain match); gated it measures 87.6%
 *    acceptable-or-General vs 65.1% ungated.
 *  - a keyword pick needs a weighted score of 2 (two keyword hits or one
 *    department-name token); one stray substring hit is not evidence.
 *    Gated 92.9% vs 55.0% ungated.
 */
const JEV_MIN_CONFIDENCE = 0.9;
const KEYWORD_MIN_SCORE = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingResult {
  agentId: string;
  agentName: string;
  department: string;
  score: number;
  reason: string;
  /** Classification evidence, independent of task urgency and load ranking. */
  method?: 'owner_pin' | 'explicit' | 'semantic' | 'keyword' | 'general' | 'escalation';
  confidence?: number;
  workspaceId?: string;
  companyId?: string;
  /**
   * B14 — safe applied-decision receipt for THIS route (SPEC S5 safe content),
   * or null when receipts are switched off (`HQ_DECISION_RECEIPTS=0`). Purely
   * additive: no routing branch reads it, and every routing field above is
   * produced exactly as before.
   */
  receipt?: HqDecisionReceipt | null;
}

export type RoutingDecision =
  | { status: 'assigned'; routing: RoutingResult & { workspaceId: string; companyId: string } }
  | {
      status: 'waiting' | 'ambiguous' | 'no_capable_worker';
      reason: string; owner: 'SYSTEM'; retryable: boolean;
      /** B14 — safe applied-decision receipt for the WITHOUT-ASSIGNMENT outcome that was observed. */
      receipt?: HqDecisionReceipt | null;
    };

export interface AgentWithLoad extends Agent {
  role_type?: string | null;
  /** Number of tasks currently in_progress for this agent */
  active_tasks: number;
}

// ---------------------------------------------------------------------------
// Load balancing helpers
// ---------------------------------------------------------------------------

/** Eligible live workers are fetched only from the selected company's active workspaces. */
function fetchAgentsWithLoad(companyId: string): AgentWithLoad[] {
  return queryAll<AgentWithLoad>(`
    SELECT a.*, MAX(
      (SELECT COUNT(*) FROM tasks t WHERE t.assigned_agent_id = a.id AND t.status = 'in_progress' AND t.archived_at IS NULL),
      (SELECT COUNT(*) FROM task_executions x WHERE x.agent_id = a.id AND x.state IN ('reserved','sending','accepted','running','unknown'))
    ) AS active_tasks
    FROM agents a JOIN workspaces w ON w.id = a.workspace_id
    WHERE a.status != 'offline' AND w.company_id = ? AND w.archived_at IS NULL
    GROUP BY a.id ORDER BY a.is_master DESC, a.name ASC`, [companyId]);
}

/**
 * Compute a load penalty score (0–1, lower is better) from the active_tasks count.
 * We cap at 10 to avoid extreme penalties.
 */
function loadPenalty(activeTasks: number): number {
  return Math.min(activeTasks, 10) / 10;
}

// ---------------------------------------------------------------------------
// Keyword scoring (fallback path)
// ---------------------------------------------------------------------------

/**
 * Stopword tokens that must NOT count as a department-name match — they are
 * too generic and appear in many department names or in ordinary task text.
 *
 * Three categories:
 *   1. Generic dept-name suffixes ("Production", "Management", "Team", "/")
 *      — a bare "production" in the task text must not pull a task into
 *      "Video Production".
 *   2. Words that recur across MULTIPLE canonical departments ("development"
 *      is in both Web Development AND App Development → ambiguous tie).
 *   3. Extremely common English words that double as a dept-name token but
 *      appear constantly in unrelated task text ("client" is the name token
 *      of "Client Coaches" yet shows up in "update the client records",
 *      "send the client brief", etc. — without this guard a weight-2 bonus
 *      would steal Sales/CRM tasks on thin keyword inputs).
 */
const NAME_TOKEN_STOPWORDS = new Set([
  // Category 1 — generic dept-name suffixes / connectors
  'production',
  'management',
  'team',
  'department',
  'dept',
  'and',
  'or',
  'the',
  'of',
  'general',
  'task',
  'engine',
  'lab',
  'studio',
  'specialist',
  // Category 2 — shared across multiple canonical departments
  'development',
  // Category 3 — too common in ordinary task text to be a reliable signal
  'client',
  'coaches',
  'creator',
  'support',
  'service',
]);

/**
 * Score how well a text (title + description) matches a department.
 *
 * Two signals are combined:
 *   1. Keyword hits — each configured keyword found in the text counts 1.
 *   2. Department-NAME-token hits — when a meaningful token of the dept's own
 *      display name (e.g. "sales", "video", "presentations") appears in the
 *      text, that is the single strongest possible department signal, so it
 *      counts 2 (stronger than a generic shared keyword). This resolves
 *      keyword-overlap ambiguity: "cold SALES outreach email sequence" must
 *      route to Sales even though it incidentally contains Marketing keywords
 *      ("email", "outreach"). Stopword tokens are excluded so generic words
 *      like "Production"/"Management" never pull a task in.
 *
 * Returns a raw weighted hit count. Partial substring matches count (includes).
 */
function keywordScore(text: string, keywords: string[], deptName?: string): number {
  const lower = text.toLowerCase();

  const kwHits = keywords.reduce((count, kw) => {
    return lower.includes(kw.toLowerCase()) ? count + 1 : count;
  }, 0);

  let nameBonus = 0;
  if (deptName) {
    const nameTokens = deptName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((tok) => tok.length >= 3 && !NAME_TOKEN_STOPWORDS.has(tok));
    // Tokenize the task text on word boundaries and match whole words only, so
    // a dept-name token like "some" does NOT match "something" (substring) —
    // that false positive would wrongly pull unrelated tasks into a dept.
    const textWords = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
    for (const tok of nameTokens) {
      if (textWords.has(tok)) nameBonus += 2;
    }
  }

  return kwHits + nameBonus;
}

/**
 * Urgency multiplier based on task priority.
 * Critical / high tasks get a boost so COM routes them faster.
 */
function urgencyMultiplier(priority: TaskPriority): number {
  switch (priority) {
    case 'critical':
      return 2.0;
    case 'high':
      return 1.5;
    case 'medium':
      return 1.0;
    case 'low':
      return 0.7;
    default:
      return 1.0;
  }
}

// ---------------------------------------------------------------------------
// Department matching (keyword fallback)
// ---------------------------------------------------------------------------

interface DepartmentScore {
  department: DepartmentConfig;
  score: number;
}

/**
 * Find the best-matching department for a task using keyword scoring.
 * Combines keyword hits × priority weight × department priority weight.
 * Used when no embedding key is configured.
 */
function rankDepartments(
  title: string,
  description: string,
  priority: TaskPriority,
  departments: DepartmentConfig[],
): DepartmentScore[] {
  const text = `${title} ${description}`;
  const urgency = urgencyMultiplier(priority);

  return departments
    .map((dept) => ({
      department: dept,
      score: keywordScore(text, dept.keywords, dept.name) * urgency * (dept.priority / 10),
    }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Semantic routing (embedding-based) — primary classification path
// ---------------------------------------------------------------------------

/**
 * Build the canonical text to embed for a department.
 * Combines name + purpose + first N keywords for a dense signal.
 */
function deptEmbedText(dept: DepartmentConfig): string {
  const kwSample = dept.keywords.slice(0, 12).join(', ');
  return `${dept.name}. ${dept.purpose}${kwSample ? '. Keywords: ' + kwSample : ''}`;
}

interface SemanticScore {
  department: DepartmentConfig;
  similarity: number;
}

// ---------------------------------------------------------------------------
// Department-embedding cache (P4-03 step 6)
//
// PRE-FIX: semanticRankDepartments() embedded the task text AND every
// department's deptEmbedText() on EVERY comDispatch() call — N+1 client-key
// embedding calls per task dispatch, zero caching of the semi-static
// department vectors (department name/purpose/keywords rarely change between
// dispatches). This module-level cache computes each department's vector
// ONCE per department-config version and reuses it until the department's
// embed text actually changes, so semanticRankDepartments() embeds only the
// live task text per call: N+1 -> 1.
//
// Cache key = department.id; invalidation = a content hash of the SAME text
// deptEmbedText() produces (name + purpose + first-12-keywords) — no
// separate version field needed. An operator editing a department's name,
// purpose, or keywords changes the hash and the next dispatch re-embeds ONLY
// that department, never the whole roster.
//
// Process-local (not persisted) — cheap to rebuild on restart, and per the
// standing guard (P4-03 step 8) never shipped as a cross-client asset:
// department configs are per-client, not a shared library.
// ---------------------------------------------------------------------------
interface DeptVectorCacheEntry {
  hash: string;
  vector: EmbeddingVector;
}

const _deptVectorCache = new Map<string, DeptVectorCacheEntry>();

/**
 * Content fingerprint for department-vector cache invalidation.
 *
 * This is deliberately a small, dependency-free string hash (cyrb53) — NOT a
 * cryptographic digest. Its ONLY job is to detect when a department's
 * deptEmbedText() (name + purpose + first-12-keywords) changes so the cache
 * re-embeds exactly that one department. Same text -> same hash; any edit ->
 * a different hash. That is the entire contract the embed-cache relies on.
 *
 * WHY NOT node:crypto: department-router.ts is pulled into Next.js's EDGE
 * instrumentation bundle via instrumentation -> scheduler.ts ->
 * ceo-delegation-sweep.ts -> department-router.ts. Importing
 * `createHash` from 'node:crypto' makes `next build` fail with
 * UnhandledSchemeError ("Reading from node:crypto is not handled") because the
 * edge runtime has no node: builtins. A lazy require would still be traced into
 * the edge bundle; Web Crypto's subtle.digest is async and would force this
 * synchronous cache path to become async. A pure-JS hash keeps the P4-03
 * embed-cache feature byte-for-byte identical in behaviour while compiling
 * cleanly for edge, node, and browser runtimes alike.
 *
 * cyrb53 is a well-distributed 53-bit hash — collision risk across a client's
 * handful of department texts is negligible, which is all cache invalidation
 * needs (a collision would at worst reuse a stale vector for one dept).
 */
function _deptTextHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hashNum = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return hashNum.toString(16);
}

/** Test-only: reset the cache between test cases so assertions don't leak
 * state across departments-config fixtures in the same test process. */
export function _resetDeptVectorCacheForTests(): void {
  _deptVectorCache.clear();
}

/** Test-only: current cache size, for asserting cache population/eviction. */
export function _deptVectorCacheSizeForTests(): number {
  return _deptVectorCache.size;
}

/**
 * Resolve every department's semantic vector, embedding ONLY the
 * departments whose cache entry is missing or stale (content-hash mismatch).
 * Returns null when the embed call for the uncached delta fails, so the
 * caller falls back to keyword scoring exactly as before.
 */
async function getCachedDepartmentVectors(
  departments: DepartmentConfig[],
  p: EmbeddingProvider,
): Promise<Map<string, EmbeddingVector> | null> {
  const resolved = new Map<string, EmbeddingVector>();
  const toEmbed: { dept: DepartmentConfig; text: string; hash: string }[] = [];

  // Keyed on provider + model + text: a vector from one embedding space (or
  // prefix scheme) is never reused under another.
  // The cache entry itself is per provider too (Trevor 2026-10-07): a Gemini
  // fallback never evicts, reads or mixes with a local vector.
  for (const dept of departments) {
    const text = deptEmbedText(dept);
    const hash = _deptTextHash(`${p.name}\u0000${p.model}\u0000${text}`);
    const cacheKey = `${p.name}\u0000${p.model}\u0000${dept.id}`;
    const cached = _deptVectorCache.get(cacheKey);
    if (cached && cached.hash === hash) {
      resolved.set(dept.id, cached.vector);
    } else {
      toEmbed.push({ dept, text, hash });
    }
  }

  if (toEmbed.length > 0) {
    const results = await fetchEmbeddingsFor(p, toEmbed.map((t) => localEmbedText(t.text, 'document', p)));
    if (!results || results.length !== toEmbed.length) return null;
    toEmbed.forEach((t, i) => {
      const vector = results[i].embedding;
      _deptVectorCache.set(`${p.name}\u0000${p.model}\u0000${t.dept.id}`, { hash: t.hash, vector });
      resolved.set(t.dept.id, vector);
    });
  }

  return resolved;
}

/**
 * Rank departments by semantic (cosine) similarity to the task text.
 *
 * Returns null when embeddings are unavailable (no key / API error) so
 * callers can fall back to keyword scoring.
 *
 * Embed-call accounting (P4-03): 1 call for the live task text, PLUS one call
 * per uncached/stale department (0 on a fully warm cache) — never N+1 for a
 * roster whose department configs have not changed since the last dispatch.
 */
async function semanticRankDepartments(
  taskText: string,
  departments: DepartmentConfig[],
): Promise<{ ranked: SemanticScore[]; provider: EmbeddingProvider } | null> {
  // JEV-502: isEmbeddingAvailable() also covers keyless local Ollama
  // (SOP_EMBEDDING_PROVIDER=ollama); getEmbeddingApiKey() skipped it.
  if (!isEmbeddingAvailable()) return null;
  if (departments.length === 0) return null;

  try {
    // Local Ollama down -> the box's own Gemini key (withEmbeddingFallback); both sides
    // (department vectors and task) are embedded with the SAME provider.
    const done = await withEmbeddingFallback(async (p) => {
      const deptVectors = await getCachedDepartmentVectors(departments, p);
      if (!deptVectors) throw new Error('department vectors unavailable');
      const taskResults = await fetchEmbeddingsFor(p, [localEmbedText(taskText, 'query', p)]);
      if (!taskResults || taskResults.length < 1) throw new Error('task embedding unavailable');
      return { deptVectors, taskVec: taskResults[0].embedding };
    });
    if (!done) return null;
    const { deptVectors, taskVec } = done.value;
    const ranked = departments
      .map((dept) => {
        const deptVec = deptVectors.get(dept.id);
        return { department: dept, similarity: deptVec ? cosineSimilarity(taskVec, deptVec) : 0 };
      })
      .sort((a, b) => b.similarity - a.similarity);
    return { ranked, provider: done.provider };
  } catch (err) {
    // A down/slow provider (Ollama not running, 429, network) is "no semantic
    // answer" — the next picker decides; it must never throw out of routing.
    console.warn(`[DepartmentRouter] Semantic ranking unavailable: ${(err as Error).message}`);
    return null;
  }
}

/**
 * JEV-014 — tie-break seam (spec section 6.5).
 *
 * The old autonomous branch (env-read key + direct provider call + own
 * timeout) is ELIMINATED: this function now delegates to the single
 * authorized tie-break adapter, which runs at most one call under an explicit
 * config {model from TIEBREAK_MODEL or approved client config, deadline
 * inherited from the routing root budget, permission context}. With no
 * permitted model or no permission, the adapter resolves evidence-only with
 * zero network calls and the embedding-ranked top result stays.
 *
 * Exposed for tests via __tiebreakTestSeams: callers and tests inject a
 * TiebreakFn (call-count spy). Optional tiebreakConfig carries the explicit
 * {model override, deadlineMs left on the root budget, company scope,
 * permission override}; production plumbs company scope only.
 */
export interface TiebreakSeamConfig {
  tiebreak?: TiebreakFn;
  model?: string | null;
  deadlineMs?: number;
  companyId?: string;
  permissionOverride?: boolean;
}

export const __tiebreakTestSeams = {
  permissionFor(input: {
    companyId?: string;
    model: string | null;
    override?: boolean;
  }): TiebreakPermission {
    return resolveTiebreakPermission(input);
  },
};

async function llmTiebreak(
  taskText: string,
  candidates: SemanticScore[],
  seam: TiebreakSeamConfig = {},
): Promise<DepartmentConfig> {
  const top = candidates[0].department;

  const model = seam.model !== undefined ? seam.model : resolveTiebreakModel();
  const permission = __tiebreakTestSeams.permissionFor({
    companyId: seam.companyId,
    model,
    override: seam.permissionOverride,
  });
  const runTiebreak: TiebreakFn = seam.tiebreak ?? authorizedTiebreak;

  const result = await runTiebreak({
    taskText,
    candidates: candidates.slice(0, 5).map((c) => ({
      id: c.department.id,
      name: c.department.name,
      purpose: c.department.purpose,
    })),
    companyId: seam.companyId,
    model,
    deadlineMs: seam.deadlineMs,
    permission,
  });

  if (!result.decided || !result.departmentId) {
    return top;
  }
  return candidates.find((c) => c.department.id === result.departmentId)?.department ?? top;
}

// ---------------------------------------------------------------------------
// JEV-502 — department picking, in the MEASURED order
// ---------------------------------------------------------------------------

export type DepartmentPickerName = 'semantic' | 'jev' | 'keyword';
/** Pickers that run AFTER the first available one was unsure (routing-accuracy chain). */
export type DepartmentTailName = 'sop' | 'model';

/**
 * "Option A" (Trevor, 2026-10-07): JEV (the decision engine) goes FIRST. The
 * FIRST AVAILABLE picker decides: its confident pick wins, and when it is
 * unsure the task goes to General Task (never on to a weaker picker — every
 * "ask the next picker when unsure" chain measured worse). So JEV below
 * JEV_MIN_CONFIDENCE, or JEV saying it cannot place the task (fallback=true,
 * no department, a department outside the catalog), is UNSURE: General Task,
 * and semantic is NOT asked. Only a picker that is unavailable passes to the
 * next one: JEV off/absent/old/shadow/timeout/error -> semantic -> keyword;
 * semantic with no embedding provider or an outage -> keyword.
 *
 * Measured by scripts/eval-department-routing.ts on its 169-case labeled
 * fixture, standard floor seeded as on a box (acceptable dept or General Task
 * / strict acceptable dept / wrong department):
 *   v7.6.89 order (decision engine first, then semantic) 61.5% / 52.7% / 65
 *   decision engine alone (lexical)                      65.1% / 51.5% / 59
 *   semantic alone, local nomic-embed-text, floor 0.56   91.1% / 34.9% / 15   ← first
 * Re-measured 2026-10-07 with the local default embeddinggemma-2:740m (prefixed;
 * the decision engine's routes have moved since, so the jev rows differ too):
 *   semantic alone, embeddinggemma, floor 0.69           91.7% / 28.4% / 14
 *   decision engine alone, gated                         96.4% / 34.3% / 6
 *   JEV first is chosen on these numbers: +4.7 points acceptable-or-General
 *   and 8 fewer wrong departments than semantic first (6 vs 14), strict
 *   34.3% vs 28.4%.
 *   no embeddings: decision engine, then keyword (gated) 87.0% / 32.5% / 22
 *   no embeddings, decision engine off: keyword (gated)  92.9% / 33.7% / 12
 * Gemini/OpenAI boxes were not measured (no key used); they keep floor 0.55.
 */
export const DEPARTMENT_PICKER_ORDER: readonly DepartmentPickerName[] = ['jev', 'semantic', 'keyword'];

/**
 * Routing-accuracy chain (Trevor 2026-10-07, supersedes "JEV unsure -> General
 * Task" of Option A): when the first available picker is UNSURE (or none is
 * available) the task is no longer parked on General Task. It goes to the
 * nearest-SOP vote, then the model pick (a small model chooses between the top
 * 3 candidate departments and General Task), and only then, as a last resort,
 * to General Task. JEV stays FIRST.
 */
export const DEPARTMENT_FALLBACK_TAIL: readonly DepartmentTailName[] = ['sop', 'model'];

/** What belongs in General Task, offered to the model pick as an explicit choice. */
export const GENERAL_TASK_ID = 'general-task';
export const GENERAL_TASK_DESCRIPTION =
  'One-off, personal, office-admin, hiring or HR, or cross-department tasks that fit no single department, ' +
  'and requests too vague or unrecognizable to place. Choose this when no listed department clearly owns the work.';
/** Candidate departments shown to the model pick (General Task is offered in addition). */
export const MODEL_PICK_CANDIDATES = 3;
/** Budget for the model pick; the adapter caps it again and never exceeds its own ceiling. */
export const MODEL_PICK_TIMEOUT_MS = 6_000;

export interface DepartmentPick {
  /** null → General Task catch-all. */
  department: DepartmentConfig | null;
  method: DepartmentPickerName | DepartmentTailName | 'general';
  confidence: number;
  note: string;
  /** General Task only: 'decision' = positively chosen (model pick), 'last-resort' = nothing was sure. */
  generalBy?: 'decision' | 'last-resort';
  /** When the deciding picker was unsure: the department it leaned to (evaluation only). */
  candidate?: DepartmentConfig;
}

/** A confident pick, an unsure lean (→ General Task), or null = unavailable (next picker). */
type Verdict = { pick: DepartmentPick; confident: boolean } | null;

// ---------------------------------------------------------------------------
// B14 — decision-engine observation (input to the safe receipt)
//
// `pickDepartment` records what the decision-engine picker ACTUALLY did while
// it runs, by reading the SAME `jevDecide`/`jevMode` values `pickJev` already
// consumes. This is observation only: `pickJev`'s return value is unchanged,
// so the department and owner decision are identical with or without receipts.
// ---------------------------------------------------------------------------

interface EngineObservation {
  mode: string;
  phase: HqDecisionReceiptPhase;
  /** Engine route fields, recorded only when the engine's route was the applied one. */
  routeAction: string | null;
  departmentSlug: string | null;
  confidence: number | null;
  fallback: boolean | null;
  /** Why the engine did not decide this boundary; null when it did. */
  reasonToken: HqDecisionReasonToken | null;
}

/** Engine state → the reason token that states it explicitly. */
function engineStateToken(mode: string): HqDecisionReasonToken {
  if (mode === 'shadow') return 'engine_shadow';
  if (mode === 'off') return 'engine_off';
  if (mode === 'legacy') return 'engine_legacy';
  const state = jevEngineState().core;
  if (state === 'missing') return 'engine_core_missing';
  if (state === 'failed') return 'engine_core_failed';
  if (state === 'unprobed') return 'engine_core_unprobed';
  return 'engine_no_decision';
}

/**
 * What one `jevDecide` outcome means for the applied route.
 *
 * `applied` is the router's own verdict on whether it will USE this engine
 * route (computed by `pickJev` from the same conditions it always used). An
 * engine recommendation the router did not apply must never be recorded as
 * the applied route — that is exactly the "core recommendation misrepresented
 * as assignment" failure SPEC S5 forbids.
 */
function observeJevDecision(jev: JevDecision | null, mode: string, applied: boolean): EngineObservation {
  if (mode === 'shadow') {
    // SPEC S5: "Shadow is explicitly non-applied". The observed engine route is
    // still RECORDED (that is the point of a shadow receipt) and the phase says
    // plainly that it was not applied.
    return {
      mode,
      phase: 'shadow',
      routeAction: jev?.route.action ?? null,
      departmentSlug: jev?.route.department ?? null,
      confidence: jev?.route.confidence ?? null,
      fallback: jev?.route.fallback ?? null,
      reasonToken: 'engine_shadow',
    };
  }
  if (!jev) {
    return {
      mode,
      phase: 'unavailable',
      routeAction: null,
      departmentSlug: null,
      confidence: null,
      fallback: null,
      reasonToken: engineStateToken(mode),
    };
  }
  if (!applied) {
    // The engine answered; this boundary did NOT apply its route (it declined
    // to route, named a department outside the routed catalog, or landed under
    // the router's confidence gate). The engine's fields are therefore not this
    // receipt's route fields — they are stated as not supplied, and the reason
    // channel says the engine did not decide here.
    const declined = jev.route.action !== 'route' || jev.route.fallback || !jev.route.department;
    return {
      mode,
      phase: 'applied',
      routeAction: null,
      departmentSlug: null,
      confidence: null,
      fallback: null,
      reasonToken: declined ? 'engine_no_decision' : 'engine_unsure',
    };
  }
  // The engine's route IS the applied route.
  return {
    mode,
    phase: 'applied',
    routeAction: jev.route.action,
    departmentSlug: jev.route.department,
    confidence: jev.route.confidence,
    fallback: jev.route.fallback,
    reasonToken: null,
  };
}

/** Catalog JEV ranks against: the company's departments minus the structural default. */
function jevCatalog(departments: DepartmentConfig[]): DecisionDepartment[] {
  // Each department's profile also carries the distinguishing words of its own SOP titles and task_keywords.
  const profiles = sopProfileKeywords();
  return departments
    .filter((d) => canonicalDeptSlug(d.slug || d.id) !== 'default')
    .map((d) => ({ slug: d.slug || d.id, name: d.name, description: d.purpose, keywords: [...d.keywords, ...(profiles.get(canonicalDeptSlug(d.slug || d.id)) ?? [])] }));
}

async function pickSemantic(
  taskText: string,
  departments: DepartmentConfig[],
  tiebreakSeam: TiebreakSeamConfig,
): Promise<Verdict> {
  const sem = await semanticRankDepartments(taskText, departments);
  if (!sem || sem.ranked.length === 0) return null;
  const ranked = sem.ranked;
  const top = ranked[0].similarity;
  // The floor belongs to the provider that produced the scores (0.55 on Gemini, 0.69 on local embeddinggemma).
  const floor = minRoutingConfidence(sem.provider);
  if (top < floor) {
    const note = `Low routing confidence (sim ${top.toFixed(3)} < floor ${floor}) for "${ranked[0].department.name}"`;
    return { confident: false, pick: { department: ranked[0].department, method: 'semantic', confidence: top, note } };
  }
  let best = ranked[0].department;
  if (ranked.length >= 2 && top - ranked[1].similarity < TIEBREAK_MARGIN) {
    best = await llmTiebreak(taskText, ranked, tiebreakSeam);
  }
  const similarity = ranked.find((s) => s.department === best)?.similarity ?? 0;
  return { confident: true, pick: { department: best, method: 'semantic', confidence: similarity, note: `Semantic routing matched "${best.name}" (similarity: ${similarity.toFixed(3)})` } };
}

async function pickJev(
  taskText: string,
  departments: DepartmentConfig[],
  /** Per-call B14 out-channel: what the engine actually did. */
  reportObservation: (observation: EngineObservation) => void,
): Promise<Verdict> {
  const jev = await jevDecide(taskText, jevCatalog(departments));
  const mode = jevMode();
  // B14 — report what the engine actually did, for the receipt only. The
  // decision statements below are unchanged, and `observeJevDecision` is a
  // pure read of the same value `pickJev` already consumed. The report goes
  // through a per-call callback (never module state) so two concurrent
  // dispatches in one process can never read each other's observation.
  // null = JEV unavailable (off/absent/old/shadow/timeout/error): next picker.
  if (!jev) {
    reportObservation(observeJevDecision(jev, mode, false));
    return null;
  }
  // Option A: the engine ANSWERED but cannot place the task (declined,
  // fallback=true, no department, or a department outside the catalog). That
  // is "unsure", not "unavailable": General Task, semantic is not asked.
  const target = jev.route.department ? canonicalDeptSlug(jev.route.department) : null;
  const dept = jev.route.action === 'route' && !jev.route.fallback && target
    ? departments.find((d) => canonicalDeptSlug(d.slug || d.id) === target)
    : undefined;
  if (!dept) {
    reportObservation(observeJevDecision(jev, mode, false));
    return { confident: false, pick: { department: null, method: 'jev', confidence: jev.route.confidence ?? 0, note: 'Decision engine could not place the task' } };
  }
  const confidence = jev.route.confidence;
  // "Applied" is exactly what this boundary will apply: a usable engine route
  // that also clears the router's own confidence gate. Below the gate the task
  // goes to General Task, so the engine route is NOT the applied route.
  reportObservation(observeJevDecision(jev, mode, confidence >= JEV_MIN_CONFIDENCE));
  return { confident: confidence >= JEV_MIN_CONFIDENCE, pick: { department: dept, method: 'jev', confidence, note: `Decision engine matched "${dept.name}" (confidence: ${confidence.toFixed(2)})` } };
}

function pickKeyword(title: string, description: string, priority: TaskPriority, departments: DepartmentConfig[]): Verdict {
  const top = rankDepartments(title, description, priority, departments)[0];
  if (!top) return { confident: false, pick: { department: null, method: 'keyword', confidence: 0, note: 'Zero keyword hits' } };
  const raw = keywordScore(`${title} ${description}`, top.department.keywords, top.department.name);
  return {
    confident: raw >= KEYWORD_MIN_SCORE,
    pick: { department: top.department, method: 'keyword', confidence: Math.min(1, raw / 3), note: `Keyword scoring matched department "${top.department.name}" (score: ${top.score.toFixed(2)})` },
  };
}

/** Top candidate departments for the model pick: SOP vote first, then semantic, then keyword, no duplicates. */
async function modelCandidates(
  taskText: string,
  title: string,
  description: string,
  priority: TaskPriority,
  departments: DepartmentConfig[],
  sop: SopVoteRanking | null,
): Promise<DepartmentConfig[]> {
  const out: DepartmentConfig[] = [];
  const add = (d: DepartmentConfig) => {
    const c = canonicalDeptSlug(d.slug || d.id);
    if (c === GENERAL_TASK_ID || c === 'master-orchestrator' || c === 'default') return;
    if (!out.includes(d) && out.length < MODEL_PICK_CANDIDATES) out.push(d);
  };
  for (const r of sop?.ranked ?? []) add(r.department);
  if (out.length < MODEL_PICK_CANDIDATES) {
    for (const r of (await semanticRankDepartments(taskText, departments))?.ranked ?? []) add(r.department);
  }
  if (out.length < MODEL_PICK_CANDIDATES) {
    for (const r of rankDepartments(title, description, priority, departments)) {
      if (keywordScore(`${title} ${description}`, r.department.keywords, r.department.name) > 0) add(r.department);
    }
  }
  return out;
}

/**
 * Model pick: a small model is shown the task, up to 3 candidate departments
 * and General Task (with what belongs there) and returns exactly one of them.
 * Runs through the single authorized tie-break adapter (same model and
 * permission config as llmTiebreak: no provider or key is chosen here), bounded
 * by MODEL_PICK_TIMEOUT_MS. No permitted model, a timeout, an error or an
 * unreadable reply is "no answer" (null): the caller falls to General Task.
 */
async function pickByModel(
  taskText: string,
  candidates: DepartmentConfig[],
  seam: TiebreakSeamConfig,
): Promise<DepartmentPick | null> {
  if (candidates.length === 0) return null;
  try {
    const model = seam.model !== undefined ? seam.model : resolveTiebreakModel();
    const permission = __tiebreakTestSeams.permissionFor({ companyId: seam.companyId, model, override: seam.permissionOverride });
    const runTiebreak: TiebreakFn = seam.tiebreak ?? authorizedTiebreak;
    const result = await runTiebreak({
      taskText,
      candidates: [
        ...candidates.map((d) => ({ id: d.id, name: d.name, purpose: d.purpose })),
        { id: GENERAL_TASK_ID, name: 'General Task', purpose: GENERAL_TASK_DESCRIPTION },
      ],
      companyId: seam.companyId,
      model,
      deadlineMs: Math.min(seam.deadlineMs ?? MODEL_PICK_TIMEOUT_MS, MODEL_PICK_TIMEOUT_MS),
      permission,
    });
    if (!result.decided || !result.departmentId) return null;
    if (result.departmentId === GENERAL_TASK_ID) {
      return { department: null, method: 'general', generalBy: 'decision', confidence: 1, note: `Model pick chose General Task: the task fits no listed department (${result.provenance})` };
    }
    const dept = candidates.find((d) => d.id === result.departmentId);
    return dept ? { department: dept, method: 'model', confidence: 1, note: `Model pick chose "${dept.name}" (${result.provenance})` } : null;
  } catch (err) {
    console.warn(`[DepartmentRouter] Model pick unavailable: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Pick the department for a task with no department/agent hint. Never throws
 * for a picker outage and never drops a task. The first available picker
 * decides; when it is unsure (or none is available) the tail runs: nearest-SOP
 * vote, then model pick, then General Task as the LAST resort.
 */
export async function pickDepartment(
  task: { title?: string | null; description?: string | null; priority?: TaskPriority | null },
  departments: DepartmentConfig[],
  opts: { order?: readonly DepartmentPickerName[]; tail?: readonly DepartmentTailName[]; tiebreakSeam?: TiebreakSeamConfig } = {},
): Promise<DepartmentPick> {
  return (await pickDepartmentInternal(task, departments, opts)).pick;
}

/**
 * B14 — `pickDepartment` plus what its decision-engine picker observed. The
 * observation travels as a per-call value (no module state), so concurrent
 * dispatches cannot read each other's.
 */
async function pickDepartmentInternal(
  task: { title?: string | null; description?: string | null; priority?: TaskPriority | null },
  departments: DepartmentConfig[],
  opts: { order?: readonly DepartmentPickerName[]; tail?: readonly DepartmentTailName[]; tiebreakSeam?: TiebreakSeamConfig } = {},
): Promise<{ pick: DepartmentPick; observation: EngineObservation | null }> {
  const title = task.title || '';
  const description = task.description || '';
  const priority = (task.priority as TaskPriority) || 'medium';
  let observation: EngineObservation | null = null;
  let unsure: DepartmentPick | null = null;
  for (const picker of opts.order ?? DEPARTMENT_PICKER_ORDER) {
    const verdict =
      picker === 'semantic' ? await pickSemantic([title, description].filter(Boolean).join(' — '), departments, opts.tiebreakSeam ?? {})
      : picker === 'jev' ? await pickJev([title, description].filter(Boolean).join('\n'), departments, (o) => { observation = o; })
      : pickKeyword(title, description, priority, departments);
    if (!verdict) continue;
    if (verdict.confident) return { pick: verdict.pick, observation };
    unsure = {
      department: null, method: 'general', generalBy: 'last-resort', confidence: verdict.pick.confidence,
      note: `${verdict.pick.note} — ${picker} picker unsure`, candidate: verdict.pick.department ?? undefined,
    };
    break;
  }
  const lastResort: DepartmentPick = unsure ?? { department: null, method: 'general', generalBy: 'last-resort', confidence: 0, note: 'No department picker available' };

  // Tail: nearest-SOP vote -> model pick -> General Task (last resort).
  const tail = opts.tail ?? DEPARTMENT_FALLBACK_TAIL;
  if (tail.length === 0 || departments.length === 0) return { pick: lastResort, observation };
  const text = [title, description].filter(Boolean).join(' — ');
  let sop: SopVoteRanking | null = null;
  if (tail.includes('sop')) {
    sop = await rankDepartmentsBySops(text, departments);
    const win = decideSopVote(sop);
    if (win) {
      return {
        pick: {
          department: win.department, method: 'sop', confidence: win.share,
          note: `Nearest-SOP vote chose "${win.department.name}" (${Math.round(win.share * 100)}% of the weight of the ${sop!.ranked.length > 1 ? 'nearest SOPs' : 'nearest SOPs, all one department'}; ${lastResort.note})`,
        },
        observation,
      };
    }
  }
  if (tail.includes('model')) {
    const cands = await modelCandidates(text, title, description, priority, departments, sop);
    const picked = await pickByModel(text, cands, opts.tiebreakSeam ?? {});
    if (picked) return { pick: picked, observation };
  }
  return { pick: lastResort, observation };
}

// ---------------------------------------------------------------------------
// Agent matching within a department
// ---------------------------------------------------------------------------

/**
 * Pick the best available agent for a department.
 * Prefers agents whose role matches the department's agentRoles list,
 * then breaks ties by workspace_id match and load (fewer active_tasks wins).
 */
export interface PickTaskContext {
  title?: string | null;
  description?: string | null;
  outcome?: string | null;
  artifactType?: string | null;
  constraints?: string | null;
  sopContext?: string | null;
}

/**
 * JEV-015 seam: delegates to src/lib/routing/role-selection.ts.
 * Two-stage pick (suitability gate, then deterministic capacity/load) over the
 * department-scoped pool. Masters stay excluded here (legacy floor); the module
 * owns offline/QC-only/unauthorized/foreign exclusions, task-aware fit, stable
 * id tie-breaks, and busy-qualified queueing. Queued still returns the worker
 * (existing capacity policy retains the assignment); none-suitable → undefined.
 */
function pickBestAgent(
  agents: AgentWithLoad[],
  department: DepartmentConfig,
  task?: PickTaskContext | null,
): AgentWithLoad | undefined {
  const inDept = agents.filter((a) => !a.is_master && a.workspace_id === department.id);
  if (inDept.length === 0) return undefined;
  const pool = inDept.map((a) => workerProfileFromAgent(a));
  const taskCtx: RoleSelectionTask = {
    title: task?.title ?? '',
    description: task?.description ?? null,
    outcome: task?.outcome ?? null,
    artifactType: task?.artifactType ?? null,
    constraints: task?.constraints ?? null,
    departmentId: department.id,
    departmentName: department.name,
    sopContext: task?.sopContext ?? null,
  };
  const result = selectRoleWorker(pool, taskCtx, { roleHint: department.agentRoles });
  if (!result.worker) return undefined;
  return inDept.find((a) => a.id === result.worker!.id);
}

// ---------------------------------------------------------------------------
// W3.2 — Owner-direct specialist pin (spec §3 owner-direct exception)
// ---------------------------------------------------------------------------

/**
 * Resolve an owner-named specialist directly to a RoutingResult, BYPASSING
 * `pickBestAgent` and all department classification.
 *
 * Spec §3: "The ONLY time the CEO does NOT route to a department: the owner
 * specifically requests a specific AI/agent do it." When the owner names a
 * specialist, the CEO routes STRAIGHT to that agent — no role-fit scoring, no
 * least-loaded tiebreak, no semantic/keyword department resolution.
 *
 * Matching is name-agnostic and tolerant (the owner types a human name, not a
 * UUID): exact agent id → exact agent name → exact persona → unique substring
 * of the agent name. Offline agents are excluded (a pin can't wake a dead box).
 *
 * AMBIGUITY IS A HOLD, NEVER A PICK (spec 1.1 ss 4.4 "Have Jordan do it." —
 * "ambiguity must not select a random Jordan"; ss 5.5.1 "An unavailable pinned
 * executor creates a specific hold, not silent delegation"). Two same-company
 * workers the owner's name matches equally (two "Jordan", or "Jordan Blake" +
 * "Jordan Reyes") used to fall through the `find()` chain and the substring
 * guard to the first row in the list — a silent random pick the owner never
 * authorized. They now return `ambiguous` with the candidate list, and the
 * caller holds the card for an explicit owner decision.
 *
 * Returns null when NO agent matches, so the caller can fall back to normal
 * department routing rather than dropping the task.
 */
type SpecialistPinResolution =
  | { kind: 'pinned'; result: RoutingResult }
  | { kind: 'ambiguous'; reason: string };

/** Owner-facing candidate list: `Name @ Workspace (id)` — enough to disambiguate. */
function describePinCandidates(candidates: AgentWithLoad[], departments: DepartmentConfig[]): string {
  return candidates
    .map((a) => {
      const canon = canonicalDeptSlug(a.workspace_id);
      const dept = departments.find((d) => d.id === a.workspace_id || canonicalDeptSlug(d.id) === canon);
      return `${a.name} @ ${dept?.name ?? a.workspace_id} (${a.id})`;
    })
    .join('; ');
}

function resolveSpecialistPin(
  agents: AgentWithLoad[],
  targetAgent: string,
  departments: DepartmentConfig[],
  sourceReference: string | null = null,
): SpecialistPinResolution | null {
  const needle = targetAgent.trim().toLowerCase();
  if (!needle) return null;

  const available = agents.filter((a) => a.status !== 'offline' && !a.is_master);

  const ambiguity = (candidates: AgentWithLoad[]): SpecialistPinResolution => ({
    kind: 'ambiguous',
    reason:
      `Owner-named worker "${targetAgent}" is ambiguous — ${candidates.length} same-company matches ` +
      `(${describePinCandidates(candidates, departments)}). Held for an explicit owner assignment; never a random pick.`,
  });

  // Exact agent id is unique by primary key — always an unambiguous pin.
  const byId = available.find((a) => a.id.toLowerCase() === needle);
  if (byId) return pinResultFor(byId, targetAgent, departments, sourceReference);

  // Resolution precedence for a typed NAME: exact name → exact persona → unique substring.
  for (const match of [
    (a: AgentWithLoad) => a.name.toLowerCase() === needle,
    (a: AgentWithLoad) => (a.persona ?? '').toLowerCase() === needle,
  ]) {
    const exact = available.filter(match);
    if (exact.length > 1) return ambiguity(exact);
    if (exact.length === 1) return pinResultFor(exact[0], targetAgent, departments, sourceReference);
  }

  if (needle.length >= 3) {
    const partial = available.filter((a) => a.name.toLowerCase().includes(needle));
    // Only accept a substring match when it is unambiguous; several agents
    // share the fragment → the owner must say which one.
    if (partial.length > 1) return ambiguity(partial);
    if (partial.length === 1) return pinResultFor(partial[0], targetAgent, departments, sourceReference);
  }

  return null;
}

/** Build the owner_direct RoutingResult for a resolved agent. */
function pinResultFor(
  pinned: AgentWithLoad,
  targetAgent: string,
  departments: DepartmentConfig[],
  sourceReference: string | null = null,
): SpecialistPinResolution {
  // Resolve the agent's department label for the owner-facing report.
  const pinnedWsCanon = canonicalDeptSlug(pinned.workspace_id);
  const dept = departments.find(
    (d) => d.id === pinned!.workspace_id || canonicalDeptSlug(d.id) === pinnedWsCanon,
  );
  const departmentName = dept?.name ?? pinned.role ?? 'Owner-Direct';

  const routing: RoutingResult = {
    agentId: pinned.id,
    agentName: pinned.name,
    department: departmentName,
    score: 1, method: 'owner_pin', confidence: 1, workspaceId: pinned.workspace_id,
    reason:
      `Owner-direct specialist pin: owner named "${targetAgent}" → routed straight to ` +
      `${pinned.name} (${departmentName}), bypassing department classification and pickBestAgent.`,
  };
  // B14 — owner pin is an explicit caller resolution; the department comes from
  // the pinned worker, never from a classifier. No engine was consulted.
  return { kind: 'pinned', result: withEngineReceipt('owner_pin', null, routing, { sourceReference }) };
}

// ---------------------------------------------------------------------------
// COM Dispatcher — intelligent name-agnostic routing
// ---------------------------------------------------------------------------

/**
 * ComDispatcher — intelligent name-agnostic routing for the CEO / COM agent.
 *
 * Routing pipeline:
 *   1. Explicit department tag on the task (exact name or slug match)
 *   2. pickDepartment(): the first available of semantic → decision engine →
 *      keyword decides; an unsure picker means General Task (JEV-502).
 *   3. Same-company General worker, then CEO / COM executable fallback.
 *
 * An owned, recognized CEO workspace can execute the existing task when no
 * department worker is available. The fallback marker accompanies assignment
 * through dispatch; it never grants access to another company.
 *
 * Async because semantic embedding requires an API call.
 */
export async function comDispatch(
  task: Pick<Task, 'title' | 'priority'> & {
    description?: string | null;
    workspace_id?: string | null;
    department?: string;
    /**
     * W3.2 — owner-direct specialist pin. When the OWNER names a specific
     * AI/agent, this carries that name (or id/persona) and the dispatcher routes
     * straight to it, bypassing department classification + pickBestAgent.
     */
    target_agent?: string | null;
    /**
     * B14 — durable task/correlation id, used only as the receipt's source
     * reference (qc.md Q05: a receipt resolves by task/correlation, never by
     * text similarity). Omitted → the receipt says so explicitly.
     */
    source_reference?: string | null;
  },
  agents: AgentWithLoad[],
  departments: DepartmentConfig[],
  tiebreakSeam: TiebreakSeamConfig = {},
  /**
   * B14 — optional out-holder for what the decision-engine picker observed.
   * Callers that can receive a `null` route (the catch-all having no eligible
   * worker) need this to state the observation honestly instead of claiming
   * the engine was never consulted.
   */
  observationOut?: { observation: EngineObservation | null },
): Promise<RoutingResult | null> {
  const title = task.title || '';
  const description = task.description || '';
  const priority = (task.priority as TaskPriority) || 'medium';

  // ── Step 0: Owner-direct specialist pin (W3.2 / spec §3) ──────────────────
  // The ONE exception to CEO → department → specialist: when the owner names a
  // specific AI, route straight to it. This precedes every classification step
  // and bypasses pickBestAgent entirely. If the named specialist can't be
  // resolved we fall through to normal routing rather than dropping the task.
  if (task.target_agent) {
    const pin = resolveSpecialistPin(agents, String(task.target_agent), departments, task.source_reference ?? null);
    if (pin?.kind === 'pinned') {
      console.log(`[DepartmentRouter] ${pin.result.reason}`);
      return pin.result;
    }
    if (pin?.kind === 'ambiguous') {
      // An owner name matching more than one same-company worker is a HOLD,
      // never a silent random pick (spec 4.4 "Have Jordan do it."). It
      // surfaces as `ambiguous` so routeTaskDecision records the specific
      // hold reason and the card waits for an explicit owner assignment.
      console.warn(`[DepartmentRouter] ${pin.reason}`);
      return null;
    }
    return null; // An unresolved owner pin requires an explicit correction.
  }

  // ── Step 1: Explicit department tag ───────────────────────────────────────
  // Match by exact name (client's actual dept name) OR canonical slug
  if (task.department) {
    const taskDeptCanon = canonicalDeptSlug(task.department);
    const matches = departments.filter(
      (d) =>
        d.name.toLowerCase() === task.department!.toLowerCase() ||
        canonicalDeptSlug(d.slug || d.id) === taskDeptCanon,
    );
    if (matches.length > 1) return null;
    const dept = matches[0];
    if (dept) {
      const slug = canonicalDeptSlug(dept.slug || dept.id);
      if (['general', 'general-task'].includes(slug) || ['general', 'general task'].includes(dept.name.trim().toLowerCase())) {
        return catchAllAssignment(agents, departments, 'Explicit General Task request', task.source_reference ?? null);
      }
      const agent = pickBestAgent(agents, dept, task);
      if (agent) {
        return withEngineReceipt('explicit', null, {
          agentId: agent.id,
          agentName: agent.name,
          department: dept.name,
          method: 'explicit', confidence: 1, workspaceId: agent.workspace_id,
          score: dept.priority * urgencyMultiplier(priority) - loadPenalty(agent.active_tasks),
          reason: `Explicit department tag "${dept.name}" matched → role-fit agent selected (load: ${agent.active_tasks} tasks)`,
        }, { sourceReference: task.source_reference ?? null });
      }
    }
    return catchAllAssignment(agents, departments, `Department "${task.department}" is unavailable or has no eligible worker`, task.source_reference ?? null);
  }

  // ── Step 2: department pick (JEV-502 measured order) ─────────────────────
  // DEPARTMENT_PICKER_ORDER: the first AVAILABLE picker decides; if it is
  // unsure (or none is available) → DEPARTMENT_FALLBACK_TAIL (nearest-SOP vote,
  // then model pick) → General Task catch-all as the last resort.
  const { pick, observation: enginePick } = await pickDepartmentInternal(task, departments, { tiebreakSeam });
  if (observationOut) observationOut.observation = enginePick;
  if (!pick.department) {
    console.log(`[DepartmentRouter] ${pick.note} — routing to General Task catch-all`);
    const why = pick.generalBy === 'decision' ? 'Model pick chose General Task: the task fits no listed department' : 'No eligible department match';
    return catchAllAssignment(agents, departments, why, task.source_reference ?? null, enginePick);
  }
  if (pick.method === 'jev') {
    // The decision engine's pick dispatches as an explicit tag; NEVER prefix
    // the reason: isCatchAllRoutingReason is a startsWith('[catch-all]') check.
    const routing = await comDispatch({ ...task, department: pick.department.slug || pick.department.id }, agents, departments);
    if (!routing) return routing;
    // B14 — the applied route was the ENGINE's; the nested explicit dispatch is
    // only how it is carried out. Re-record that honestly (resolvedBy 'jev')
    // instead of presenting the engine route as a bare explicit tag.
    const withReceiptResult = withEngineReceipt('jev', enginePick, routing, { sourceReference: task.source_reference ?? null });
    return { ...withReceiptResult, reason: `${routing.reason} (department chosen by decision engine)` };
  }
  const bestDept = pick.department;
  const agent = pickBestAgent(agents, bestDept, task);
  if (agent) {
    const base = pick.method === 'keyword' ? keywordScore(`${title} ${description}`, bestDept.keywords, bestDept.name) : pick.confidence;
    return withEngineReceipt(pick.method, enginePick, {
      agentId: agent.id,
      agentName: agent.name,
      department: bestDept.name,
      method: pick.method === 'sop' || pick.method === 'model' ? 'semantic' : pick.method, confidence: pick.confidence, workspaceId: agent.workspace_id,
      score: base * urgencyMultiplier(priority) * (bestDept.priority / 10),
      reason: `${pick.note} → least-loaded role-fit agent selected (load: ${agent.active_tasks} tasks)`,
    }, { sourceReference: task.source_reference ?? null });
  }
  return catchAllAssignment(agents, departments, `Matched department "${bestDept.name}" has no eligible worker`, task.source_reference ?? null, enginePick);
}

/** Per-call receipt inputs. `confidence === null` states that none was supplied. */
interface ReceiptOptions {
  token?: HqDecisionReasonToken;
  sourceReference?: string | null;
  /**
   * Confidence actually supplied by the deciding path. Omit to use the
   * routing result's own confidence; pass null when this outcome carries no
   * confidence at all (the catch-all's `confidence: 0` is a routing sentinel,
   * NOT a supplied confidence, and must never be recorded as one).
   */
  confidence?: number | null;
}

/**
 * Attach the B14 safe receipt to an already-decided RoutingResult. This is the
 * only thing receipts may do here: every routing field is produced by the
 * branch that chose it, and the receipt can never change one. Returns the
 * result untouched when receipts are switched off.
 *
 * `observed` is the engine observation for this dispatch, or null when the
 * engine picker was not reached (stated explicitly as `engine_not_consulted`).
 */
function withEngineReceipt(
  resolvedBy: string,
  observed: EngineObservation | null,
  routing: RoutingResult,
  options: ReceiptOptions = {},
): RoutingResult {
  const observation: EngineObservation = observed ?? {
    mode: 'not_consulted',
    phase: 'applied',
    routeAction: null,
    departmentSlug: null,
    confidence: null,
    fallback: null,
    reasonToken: 'engine_not_consulted',
  };
  const engineDecided = observation.phase === 'applied' && observation.reasonToken === null;
  // The engine answers in the CATALOG spelling it was given (often the raw
  // workspace slug); the receipt records the canonical slug, matching what the
  // non-engine paths record, so the two are comparable.
  const departmentSlug = engineDecided
    ? canonicalDeptSlug(observation.departmentSlug) || null
    : canonicalDeptSlug(routing.department) || null;
  const receipt = buildDecisionReceipt({
    stage: 'department_routing',
    phase: observation.phase,
    mode: observation.mode,
    resolvedBy,
    routeAction: engineDecided ? observation.routeAction : null,
    departmentSlug,
    confidence: engineDecided
      ? observation.confidence
      : options.confidence !== undefined
        ? options.confidence
        : routing.confidence ?? null,
    fallback: engineDecided ? observation.fallback : null,
    // Q05: a receipt resolves by task/correlation, never by text similarity —
    // this is the caller-supplied durable task/correlation id when there is one.
    sourceReference: options.sourceReference ?? null,
    tokens: [
      ...(observation.reasonToken ? [observation.reasonToken] : []),
      ...(options.token ? [options.token] : []),
      ...(departmentSlug === null ? (['department_slug_unmapped'] as const) : []),
      // SPEC S7 route actions are the core's own vocabulary; this boundary
      // applies a department route, so an absent engine route action is stated
      // rather than invented.
      ...(engineDecided ? [] : (['route_action_not_supplied'] as const)),
    ],
  });
  return receipt === null ? routing : { ...routing, receipt };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Candidates are already company-scoped; recognized workspaces constrain fallback roles. */
function catchAllAssignment(
  agents: AgentWithLoad[],
  departments: DepartmentConfig[],
  reason: string,
  sourceReference: string | null = null,
  /** B14 — the engine observation from the pick that led here, when there was one. */
  observed: EngineObservation | null = null,
): RoutingResult | null {
  const eligible = agents.filter(agent => {
    const workspace = departments.find(d => d.id === agent.workspace_id);
    // Independent QC workers must never produce the work they will review.
    if (agent.role_type === 'qc' || agent.status === 'offline' || !workspace || !isCatchAllWorkspace({slug:workspace.slug || workspace.id,name:workspace.name})) return false;
    const general = ['general', 'general-task'].includes(canonicalDeptSlug(workspace.slug || workspace.id))
      || ['general', 'general task'].includes(workspace.name.trim().toLowerCase());
    return agent.is_master || general;
 });
  // A routable DB row can outlive its runtime. Prefer installed executors;
  // retain an owned assignment when all runtimes are unavailable so recovery retries.
  const ready = eligible.filter(agent => resolveSpecialistSessionKey(agent, 'routing-readiness', agent.workspace_id, 'CatchAllRouting', Boolean(agent.is_master)) !== null);
  const candidates = ready.length ? ready : eligible;
  const generals = candidates.filter(a => !a.is_master).sort((a,b) => a.active_tasks-b.active_tasks || a.id.localeCompare(b.id));
  const masters = candidates.filter(a => a.is_master).sort((a,b) => a.active_tasks-b.active_tasks || a.id.localeCompare(b.id));
  const agent = generals.find(a => a.active_tasks === 0) || masters.find(a => a.active_tasks === 0) || generals[0] || masters[0];
  if (!agent) return null;
  const workspace = departments.find(d => d.id === agent.workspace_id)!;
  // B14 — record the catch-all lane EXPLICITLY in the safe receipt (token
  // `catch_all`), including the engine observation when this path was reached
  // after a picker ran. The routing fields above are untouched.
  return withEngineReceipt(agent.is_master ? 'escalation' : 'general', observed, {
    agentId:agent.id,agentName:agent.name,department:workspace.name,workspaceId:agent.workspace_id,
    score:0,confidence:0,method:agent.is_master ? 'escalation' : 'general',
    reason:`[catch-all] ${reason}. Assigned to ${agent.is_master ? 'CEO / orchestrator' : 'General worker'} for execution${agent.active_tasks ? ' when worker capacity is available' : ''}.`}, { token: 'catch_all', sourceReference, confidence: null });
}

/**
 * Route a task to the best available agent.
 *
 * Async because the semantic embedding path makes an API call.
 *
 * @param task - Partial task with at minimum title, priority, and workspace_id
 * @returns RoutingResult or null if no agent is available
 */
export type RoutingTask = Pick<Task, 'title' | 'priority'> & {
    description?: string | null;
  workspace_id?: string | null;
  company_id?: string | null;
  department?: string;
  target_agent?: string | null;
  /** B14 — durable task/correlation id for the receipt's source reference. */
  source_reference?: string | null;
  /** Internal only: an already verified catch-all assignment needs a fresh worker choice. */
  catch_all?: boolean;
};

/** Resolve company before any model call; an empty or ambiguous scope never expands globally. */
export async function routeTaskDecision(task: RoutingTask): Promise<RoutingDecision> {
  // B14 — every decision outcome (assigned AND each without-assignment HOLD)
  // carries a safe receipt when receipts are enabled. `resolvedBy`/reason
  // tokens describe the outcome that was observed; no routing branch reads
  // them back.
  const wait = (
    reason: string,
    status: 'waiting' | 'ambiguous' | 'no_capable_worker' = 'waiting',
    resolvedBy: string = status,
    tokens: HqDecisionReasonToken[] = [],
    sourceReference: string | null = null,
  ): RoutingDecision => {
    // B14 — the engine may have been consulted before this hold (via the
    // dispatcher). Its outcome is stated when it ran; only a genuinely
    // unconsulted engine says `engine_not_consulted`.
    const observed = dispatchObservation.observation;
    const receipt = buildDecisionReceipt({
      stage: 'department_routing',
      phase: observed?.phase ?? 'applied',
      mode: observed?.mode ?? 'not_consulted',
      resolvedBy,
      departmentSlug: null,
      sourceReference,
      tokens: [
        ...(observed?.reasonToken ? [observed.reasonToken] : []),
        ...(observed ? [] : (['engine_not_consulted'] as const)),
        ...tokens,
      ],
    });
    return { status, reason, owner: 'SYSTEM', retryable: false, ...(receipt ? { receipt } : {}) };
  };
  /** B14 — what the dispatcher's engine picker observed for THIS decision. */
  const dispatchObservation: { observation: EngineObservation | null } = { observation: null };
  const workspace = task.workspace_id
    ? queryOne<{ company_id: string; archived_at: string | null }>('SELECT company_id, archived_at FROM workspaces WHERE id = ?', [task.workspace_id])
    : undefined;
  if (task.workspace_id && (!workspace || workspace.archived_at)) return wait('Task workspace is missing or archived');
  if (workspace && task.company_id && workspace.company_id !== task.company_id) return wait('Task company and workspace disagree', 'ambiguous');
  let companyId = task.company_id || workspace?.company_id;
  if (!companyId) {
    const companies = queryAll<{ company_id: string }>('SELECT DISTINCT company_id FROM workspaces WHERE archived_at IS NULL');
    if (companies.length !== 1) return wait('A unique task company is required', 'ambiguous');
    companyId = companies[0].company_id;
  }
  if (!companyId) return wait('Task company is missing', 'ambiguous');
  const departments = loadDepartments(companyId);
  const agents = fetchAgentsWithLoad(companyId);
  if (task.department) {
    const canon = canonicalDeptSlug(task.department);
    const matches = departments.filter(d => d.name.toLowerCase() === task.department!.toLowerCase() || canonicalDeptSlug(d.slug || d.id) === canon);
    if (matches.length > 1) return wait('Explicit department is missing or ambiguous within the task company', 'ambiguous');
  }
  let routing: RoutingResult | null;
  if (task.catch_all && !task.target_agent) {
    routing = catchAllAssignment(agents, departments, 'Reassessing queued catch-all executor', task.source_reference ?? null);
  } else {
    // No hint → comDispatch Step 2 runs DEPARTMENT_PICKER_ORDER (incl. JEV).
    // companyId binds the model pick's permission context (no model or credential is chosen here).
    routing = await comDispatch(task, agents, departments, { companyId }, dispatchObservation);
  }
  if (!routing) {
    // An owner pin that matches more than one same-company worker is a
    // HOLD (spec 4.4 "Have Jordan do it.": ambiguity must not select a random
    // Jordan), not an ordinary "no worker" outcome — the reason must reach the
    // owner, so it is reported as `ambiguous` rather than `no_capable_worker`.
    if (task.target_agent) {
      const pin = resolveSpecialistPin(agents, String(task.target_agent), departments);
      if (pin?.kind === 'ambiguous') {
        return wait(pin.reason, 'ambiguous', 'owner_pin', [], task.source_reference ?? null);
      }
      // B14 — the explicit owner pin could not be resolved: stated, not implied.
      return wait(
        'No eligible worker for the requested department or specialist',
        'no_capable_worker',
        'owner_pin',
        ['owner_pin_unresolved'],
        task.source_reference ?? null,
      );
    }
    return wait(
      'No eligible worker for the requested department or specialist',
      'no_capable_worker',
      'no_capable_worker',
      [],
      task.source_reference ?? null,
    );
  }
  const agent = agents.find(a => a.id === routing.agentId);
  const workspaceConfig = departments.find(d => d.id === agent?.workspace_id);
  if (!agent || (agent.is_master && (routing.method !== 'escalation' || !workspaceConfig ||
      !isCatchAllWorkspace({slug:workspaceConfig.slug || workspaceConfig.id, name:workspaceConfig.name})))) {
    return wait('Task requires an operator routing decision', 'waiting', 'waiting', [], task.source_reference ?? null);
  }
  return { status: 'assigned', routing: { ...routing, workspaceId: agent.workspace_id, companyId } };
}

/** Compatibility adapter: callers receive only executable, company-scoped assignments. */
export async function routeTask(task: RoutingTask): Promise<RoutingResult | null> {
  const decision = await routeTaskDecision(task);
  return decision.status === 'assigned' ? decision.routing : null;
}

/**
 * Convenience export: get the loaded department list.
 * Useful for debugging / API endpoints that expose department info.
 */
export function getDepartments(): DepartmentConfig[] {
  return loadDepartments();
}
