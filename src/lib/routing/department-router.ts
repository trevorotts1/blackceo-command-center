/**
 * Department Router — Intelligent name-agnostic task routing
 *
 * Routes tasks to the most appropriate agent based on:
 *   1. Explicit department tag on the task
 *   2. SEMANTIC similarity (embedding cosine) — primary classification path
 *      - Embeds task text against each dept's (name + purpose + keywords)
 *      - Uses the CLIENT'S OWN OPENAI_API_KEY (never a shared key)
 *      - LLM tiebreak when top-2 scores are within TIEBREAK_MARGIN
 *   3. Keyword scoring — fallback when no embedding key is configured
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

import { queryAll } from '@/lib/db';
import type { Agent, Task, TaskPriority } from '@/lib/types';
import { loadDepartments, type DepartmentConfig } from './departments.config';
import { canonicalDeptSlug } from './canonical-slug';
import {
  fetchEmbeddings,
  cosineSimilarity,
  getEmbeddingApiKey,
  type EmbeddingVector,
} from '@/lib/sop-embeddings';

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
 */
const MIN_ROUTING_CONFIDENCE: number = (() => {
  const env = process.env.MIN_ROUTING_CONFIDENCE;
  if (env) {
    const parsed = parseFloat(env);
    if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) return parsed;
    console.warn(
      `[DepartmentRouter] Invalid MIN_ROUTING_CONFIDENCE="${env}" — must be 0–1. Using default 0.55.`,
    );
  }
  return 0.55;
})();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoutingResult {
  agentId: string;
  agentName: string;
  department: string;
  score: number;
  reason: string;
}

export interface AgentWithLoad extends Agent {
  /** Number of tasks currently in_progress for this agent */
  active_tasks: number;
}

// ---------------------------------------------------------------------------
// Load balancing helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all non-offline agents enriched with their active task count.
 * The count is used as a load-balancing tiebreaker.
 *
 * IMPORTANT — name-agnostic routing invariant:
 *   When `workspaceId` is supplied it is used ONLY as a soft pre-filter and
 *   ONLY when that workspace actually has agents. If the requested workspace
 *   has zero agents (e.g. the synthetic `'default'` bucket, or the CEO
 *   workspace before any dept agents are seeded), we fall back to the FULL
 *   agent roster across all workspaces so `comDispatch()` can still run its
 *   keyword/semantic department resolution over the whole universe instead of
 *   bailing to null. The passed workspace is a hint, never a hard gate that
 *   blanks out routing.
 */
function fetchAgentsWithLoad(workspaceId?: string): AgentWithLoad[] {
  const baseSql = `
    SELECT
      a.*,
      COUNT(t.id) AS active_tasks
    FROM agents a
    LEFT JOIN tasks t
      ON t.assigned_agent_id = a.id
      AND t.status = 'in_progress'
    WHERE a.status != 'offline'
  `;
  const groupOrder = " GROUP BY a.id ORDER BY a.is_master DESC, a.name ASC";

  if (workspaceId) {
    const scoped = queryAll<AgentWithLoad>(
      baseSql + ' AND a.workspace_id = ?' + groupOrder,
      [workspaceId],
    );
    // Only honour the scoped pre-filter when it actually has agents. A
    // zero-agent workspace must NOT short-circuit routing — fall through to
    // the full roster so the engine routes across all departments.
    if (scoped.length > 0) return scoped;
  }

  return queryAll<AgentWithLoad>(baseSql + groupOrder, []);
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

/**
 * Rank departments by semantic (cosine) similarity to the task text.
 *
 * Returns null when embeddings are unavailable (no key / API error) so
 * callers can fall back to keyword scoring.
 */
async function semanticRankDepartments(
  taskText: string,
  departments: DepartmentConfig[],
): Promise<SemanticScore[] | null> {
  if (!getEmbeddingApiKey()) return null;
  if (departments.length === 0) return null;

  const deptTexts = departments.map(deptEmbedText);
  const allTexts = [taskText, ...deptTexts];

  const results = await fetchEmbeddings(allTexts);
  if (!results || results.length < 2) return null;

  const taskVec: EmbeddingVector = results[0].embedding;

  return departments
    .map((dept, i) => ({
      department: dept,
      similarity: cosineSimilarity(taskVec, results[i + 1].embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * LLM tiebreak: when the top-2 semantic scores are within TIEBREAK_MARGIN,
 * ask the orchestrator model to pick the correct department.
 *
 * Uses the client's own OPENAI_API_KEY. Falls back silently on any error
 * (returns the embedding-ranked top result).
 */
async function llmTiebreak(
  taskText: string,
  candidates: SemanticScore[],
): Promise<DepartmentConfig> {
  const top = candidates[0].department;

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return top;

    const deptList = candidates
      .slice(0, 5)
      .map((c, i) => `${i + 1}. ${c.department.name} — ${c.department.purpose}`)
      .join('\n');

    const systemPrompt =
      'You are a task routing assistant. Given a task and a list of departments, ' +
      'reply with ONLY the exact department name (no other text) that best handles the task.';

    const userPrompt =
      `Task: "${taskText}"\n\nDepartments:\n${deptList}\n\n` +
      'Which single department should handle this task? Reply with only the department name.';

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.TIEBREAK_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 50,
        temperature: 0,
      }),
    });

    if (!resp.ok) return top;

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };

    const picked = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!picked) return top;

    const match = candidates.find(
      (c) =>
        c.department.name.toLowerCase() === picked.toLowerCase() ||
        picked.toLowerCase().includes(c.department.name.toLowerCase()),
    );

    return match?.department ?? top;
  } catch (err) {
    console.debug('[DepartmentRouter] LLM tiebreak failed:', (err as Error).message);
    return top;
  }
}

// ---------------------------------------------------------------------------
// Agent matching within a department
// ---------------------------------------------------------------------------

/**
 * Pick the best available agent for a department.
 * Prefers agents whose role matches the department's agentRoles list,
 * then breaks ties by workspace_id match and load (fewer active_tasks wins).
 */
function pickBestAgent(
  agents: AgentWithLoad[],
  department: DepartmentConfig,
): AgentWithLoad | undefined {
  const available = agents.filter((a) => a.status !== 'offline');

  type AgentScore = { agent: AgentWithLoad; score: number };
  const deptCanon = canonicalDeptSlug(department.id);
  const scored: AgentScore[] = available.map((agent) => {
    const roleMatch = department.agentRoles.some((r) =>
      agent.role.toLowerCase().includes(r.toLowerCase()),
    )
      ? 1
      : 0;
    // Direct workspace_id match (client's real id) OR canonical slug match
    const workspaceMatch =
      agent.workspace_id &&
      (agent.workspace_id === department.id ||
        canonicalDeptSlug(agent.workspace_id) === deptCanon)
        ? 0.2
        : 0;
    const score = roleMatch + workspaceMatch - loadPenalty(agent.active_tasks);
    return { agent, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.agent;
}

// ---------------------------------------------------------------------------
// COM Dispatcher — intelligent name-agnostic routing
// ---------------------------------------------------------------------------

/**
 * ComDispatcher — intelligent name-agnostic routing for the CEO / COM agent.
 *
 * Routing pipeline:
 *   1. Explicit department tag on the task (exact name or slug match)
 *   2. SEMANTIC similarity — embeds task text against each dept's
 *      (name + purpose + keywords) using the CLIENT'S OWN OPENAI_API_KEY.
 *      LLM tiebreak when top-2 scores are within TIEBREAK_MARGIN.
 *   3. Keyword scoring — fallback when no embedding key is configured.
 *   4. Least-loaded master agent (CEO / COM) — router-only fallback.
 *
 * The CEO / COM agent is ALWAYS the router/dispatcher — it NEVER executes the
 * task itself. When no department-specific agent is found, the master agent
 * is returned so it can re-dispatch or escalate, not so it can execute.
 *
 * Async because semantic embedding requires an API call.
 */
export async function comDispatch(
  task: Pick<Task, 'title' | 'description' | 'priority'> & {
    workspace_id?: string | null;
    department?: string;
  },
  agents: AgentWithLoad[],
  departments: DepartmentConfig[],
): Promise<RoutingResult | null> {
  const title = task.title || '';
  const description = task.description || '';
  const priority = (task.priority as TaskPriority) || 'medium';
  const taskText = [title, description].filter(Boolean).join(' — ');

  // ── Step 1: Explicit department tag ───────────────────────────────────────
  // Match by exact name (client's actual dept name) OR canonical slug
  if (task.department) {
    const taskDeptCanon = canonicalDeptSlug(task.department);
    const dept = departments.find(
      (d) =>
        d.name.toLowerCase() === task.department!.toLowerCase() ||
        canonicalDeptSlug(d.id) === taskDeptCanon,
    );
    if (dept) {
      const agent = pickBestAgent(agents, dept);
      if (agent) {
        return {
          agentId: agent.id,
          agentName: agent.name,
          department: dept.name,
          score: dept.priority * urgencyMultiplier(priority) - loadPenalty(agent.active_tasks),
          reason: `Explicit department tag "${dept.name}" matched → role-fit agent selected (load: ${agent.active_tasks} tasks)`,
        };
      }
    }
  }

  // ── Step 2: Semantic (embedding) classification ───────────────────────────
  // Primary path when OPENAI_API_KEY / GOOGLE_API_KEY is configured. Works for
  // ANY dept name because it classifies by MEANING against the dept's purpose.
  const semanticRanked = await semanticRankDepartments(taskText, departments);

  if (semanticRanked && semanticRanked.length > 0) {
    // Raw top result before tiebreak — we need its similarity for the floor check.
    const rawTopSimilarity = semanticRanked[0].similarity;

    // ── Confidence floor check ──────────────────────────────────────────────
    // If the best semantic match is below MIN_ROUTING_CONFIDENCE, the task
    // doesn't clearly belong to any specific department. Route to General Task
    // (Step 3.5) instead of force-fitting. Log with the similarity + floor
    // values so the operator can tune MIN_ROUTING_CONFIDENCE from real data.
    if (rawTopSimilarity < MIN_ROUTING_CONFIDENCE) {
      console.log(
        `[DepartmentRouter] Low routing confidence (sim ${rawTopSimilarity.toFixed(3)} < floor ${MIN_ROUTING_CONFIDENCE}) — routing to General Task instead of force-fitting to "${semanticRanked[0].department.name}"`,
      );
      // Fall through to Step 3.5 below (after keyword block) by NOT returning here.
      // We skip the semantic result entirely.
    } else {
      let bestDept: DepartmentConfig;

      // LLM tiebreak when top-2 are ambiguously close (only when above floor)
      if (
        semanticRanked.length >= 2 &&
        rawTopSimilarity - semanticRanked[1].similarity < TIEBREAK_MARGIN
      ) {
        bestDept = await llmTiebreak(taskText, semanticRanked);
        console.log(
          `[DepartmentRouter] Semantic scores within tiebreak margin (${rawTopSimilarity.toFixed(3)} vs ${semanticRanked[1].similarity.toFixed(3)}) — LLM tiebreak selected "${bestDept.name}"`,
        );
      } else {
        bestDept = semanticRanked[0].department;
      }

      const agent = pickBestAgent(agents, bestDept);
      if (agent) {
        const similarity = semanticRanked.find((s) => s.department === bestDept)?.similarity ?? 0;
        return {
          agentId: agent.id,
          agentName: agent.name,
          department: bestDept.name,
          score: similarity * urgencyMultiplier(priority) * (bestDept.priority / 10),
          reason: `Semantic routing matched "${bestDept.name}" (similarity: ${similarity.toFixed(3)}) → least-loaded role-fit agent selected (load: ${agent.active_tasks} tasks)`,
        };
      }
    }
  }

  // ── Step 3: Keyword scoring fallback ─────────────────────────────────────
  // Used when no embedding key is configured (zero configuration required).
  // General Task has empty keywords + priority=1 → always scores 0 → filtered
  // out here by the `score > 0` guard. It is NEVER reached by keyword scoring.
  const ranked = rankDepartments(title, description, priority, departments);

  if (ranked.length > 0) {
    for (const { department, score } of ranked) {
      const agent = pickBestAgent(agents, department);
      if (agent) {
        return {
          agentId: agent.id,
          agentName: agent.name,
          department: department.name,
          score,
          reason: `Keyword scoring matched department "${department.name}" (score: ${score.toFixed(2)}) → least-loaded role-fit agent selected (load: ${agent.active_tasks} tasks)`,
        };
      }
    }
  } else if (!semanticRanked) {
    // Keyword-only mode (no embedding key) AND zero keyword hits → General Task.
    // This is the keyword-mode equivalent of the confidence floor: when no dept
    // matches at all, don't fall through to the CEO master; catch it here.
    console.log(
      `[DepartmentRouter] Keyword-only mode: zero keyword hits — routing to General Task catch-all`,
    );
    // Falls through to Step 3.5 below.
  }

  // ── Step 3.5: General Task catch-all ──────────────────────────────────────
  // Reached when:
  //   a) Semantic similarity < MIN_ROUTING_CONFIDENCE (low-confidence catch), OR
  //   b) Keyword-only mode and zero keyword hits.
  // General Task is priority-1 / empty-keywords so it NEVER wins in steps 2–3
  // on merit. This is the ONLY path that routes to it.
  const generalTaskDept = departments.find(
    (d) =>
      canonicalDeptSlug(d.id) === 'general-task' ||
      d.id === 'general-task' ||
      // Name-agnostic safety net: when departments are loaded from the
      // workspaces table the dept `id` is the workspace's row id (which may be
      // a UUID or a client-specific scheme that doesn't canonicalize to
      // 'general-task'). The display name is the reliable signal, so also match
      // on the canonical 'General Task' name.
      d.name.trim().toLowerCase() === 'general task',
  );
  if (generalTaskDept) {
    const agent = pickBestAgent(agents, generalTaskDept);
    if (agent) {
      const sim = semanticRanked?.[0]?.similarity;
      const reason = sim !== undefined
        ? `Routing confidence below floor (sim ${sim.toFixed(3)} < ${MIN_ROUTING_CONFIDENCE}). Routed to General Task to avoid force-fitting to wrong department.`
        : `No keyword hits in keyword-only mode. Routed to General Task catch-all.`;
      return {
        agentId: agent.id,
        agentName: agent.name,
        department: generalTaskDept.name,
        score: sim ?? 0,
        reason,
      };
    }
  }

  // ── Step 4: CEO / COM router fallback ─────────────────────────────────────
  // Degenerate case: General Task dept has no agent (misconfigured install).
  // The master agent is the ROUTER of last resort — it will re-dispatch, NOT
  // execute the task itself. This preserves the invariant that the CEO never
  // does department work.
  const masters = agents
    .filter((a) => a.is_master && a.status !== 'offline')
    .sort((a, b) => a.active_tasks - b.active_tasks);

  if (masters[0]) {
    return {
      agentId: masters[0].id,
      agentName: masters[0].name,
      department: 'CEO / COM',
      score: 0,
      reason: `No department match found and General Task dept has no agent. Routed to CEO / COM master agent for re-dispatch (load: ${masters[0].active_tasks} tasks). CEO will route, not execute.`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Route a task to the best available agent.
 *
 * Async because the semantic embedding path makes an API call.
 *
 * @param task - Partial task with at minimum title, priority, and workspace_id
 * @returns RoutingResult or null if no agent is available
 */
export async function routeTask(
  task: Pick<Task, 'title' | 'description' | 'priority'> & {
    workspace_id?: string | null;
    department?: string;
  },
): Promise<RoutingResult | null> {
  const departments = loadDepartments();
  // The passed workspace_id is at most a HINT. fetchAgentsWithLoad() only
  // honours it as a pre-filter when that workspace has agents; otherwise it
  // returns the FULL roster so comDispatch can run keyword/semantic resolution
  // across ALL departments. This is the fix for bare-task routing: a scoped
  // workspace with zero agents (e.g. 'default' / unseeded CEO) must fall
  // through to full routing, NOT short-circuit to null.
  const agents = fetchAgentsWithLoad(task.workspace_id ?? undefined);

  if (agents.length === 0) {
    // Genuinely degenerate: the install has NO non-offline agents anywhere.
    console.warn('[DepartmentRouter] No available agents found in any workspace');
    return null;
  }

  const result = await comDispatch(task, agents, departments);

  if (result) {
    console.log(
      `[DepartmentRouter] Routed "${task.title}" → ${result.agentName} (${result.department}): ${result.reason}`,
    );
  } else {
    console.warn(`[DepartmentRouter] Could not find a suitable agent for "${task.title}"`);
  }

  return result;
}

/**
 * Convenience export: get the loaded department list.
 * Useful for debugging / API endpoints that expose department info.
 */
export function getDepartments(): DepartmentConfig[] {
  return loadDepartments();
}
