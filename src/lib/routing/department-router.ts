/**
 * Department Router
 *
 * Routes tasks to the most appropriate agent based on:
 *   1. Explicit department tag on the task
 *   2. Keyword scoring against department definitions
 *   3. Agent role matching within the winning department
 *   4. Load balancing — prefer agents with fewer active tasks
 *
 * Gap 1 (COM intelligence): ComDispatcher picks the best agent via a
 *   multi-factor score (keyword affinity + urgency + department weight)
 *   rather than returning the first master agent it finds.
 *
 * Gap 2 (Load balancing): AgentLoadScore queries active task counts so
 *   we prefer less-loaded agents when scores are equal.
 *
 * Gap 3 (Configurable departments): Departments are loaded via
 *   loadDepartments() which reads from DEPARTMENTS_CONFIG_PATH or
 *   falls back to DEFAULT_DEPARTMENTS. Nothing is hardcoded here.
 */

import { queryAll } from '@/lib/db';
import type { Agent, Task, TaskPriority } from '@/lib/types';
import { loadDepartments, type DepartmentConfig } from './departments.config';

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
 */
function fetchAgentsWithLoad(workspaceId?: string): AgentWithLoad[] {
  const params: unknown[] = [];

  let sql = `
    SELECT
      a.*,
      COUNT(t.id) AS active_tasks
    FROM agents a
    LEFT JOIN tasks t
      ON t.assigned_agent_id = a.id
      AND t.status = 'in_progress'
    WHERE a.status != 'offline'
  `;

  if (workspaceId) {
    sql += ' AND a.workspace_id = ?';
    params.push(workspaceId);
  }

  sql += ' GROUP BY a.id ORDER BY a.is_master DESC, a.name ASC';

  return queryAll<AgentWithLoad>(sql, params);
}

/**
 * Compute a load penalty score (0–1, lower is better) from the active_tasks count.
 * We cap at 10 to avoid extreme penalties.
 */
function loadPenalty(activeTasks: number): number {
  return Math.min(activeTasks, 10) / 10;
}

// ---------------------------------------------------------------------------
// Keyword scoring
// ---------------------------------------------------------------------------

/**
 * Score how well a text (title + description) matches a department's keywords.
 * Returns a raw count of keyword hits. Partial matches count (indexOf).
 */
function keywordScore(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  return keywords.reduce((count, kw) => {
    return lower.includes(kw.toLowerCase()) ? count + 1 : count;
  }, 0);
}

/**
 * Urgency multiplier based on task priority.
 * Critical / high tasks get a boost so COM routes them faster.
 */
function urgencyMultiplier(priority: TaskPriority): number {
  switch (priority) {
    case 'critical': return 2.0;
    case 'high':     return 1.5;
    case 'medium':   return 1.0;
    case 'low':      return 0.7;
    default:         return 1.0;
  }
}

// ---------------------------------------------------------------------------
// Department matching
// ---------------------------------------------------------------------------

interface DepartmentScore {
  department: DepartmentConfig;
  score: number;
}

/**
 * Find the best-matching department for a task.
 * Combines keyword hits × priority weight × department priority weight.
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
      score: keywordScore(text, dept.keywords) * urgency * (dept.priority / 10),
    }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Agent matching within a department
// ---------------------------------------------------------------------------

/**
 * Pick the best available agent for a department.
 * Prefers agents whose role matches the department's agentRoles list,
 * then breaks ties by load (fewer active_tasks wins).
 */
function pickBestAgent(
  agents: AgentWithLoad[],
  department: DepartmentConfig,
): AgentWithLoad | undefined {
  const available = agents.filter((a) => a.status !== 'offline');

  // Score each agent: role match (1 or 0) minus load penalty
  type AgentScore = { agent: AgentWithLoad; score: number };
  const scored: AgentScore[] = available.map((agent) => {
    const roleMatch = department.agentRoles.some(
      (r) => agent.role.toLowerCase().includes(r.toLowerCase()),
    )
      ? 1
      : 0;
    const score = roleMatch - loadPenalty(agent.active_tasks);
    return { agent, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.agent;
}

// ---------------------------------------------------------------------------
// COM Dispatcher (Gap 1 core)
// ---------------------------------------------------------------------------

/**
 * ComDispatcher — smart routing logic for the COM (Chief of Mission) agent.
 *
 * When a task has no department or no exact agent match, COM acts as a
 * real dispatcher: it scores all departments, picks the best one, then
 * selects the least-loaded matching agent within that department.
 *
 * If no department-specific agent is found, it falls back to the
 * least-loaded master agent (not just "the first one found").
 */
export function comDispatch(
  task: Pick<Task, 'title' | 'description' | 'priority' | 'workspace_id'> & { department?: string },
  agents: AgentWithLoad[],
  departments: DepartmentConfig[],
): RoutingResult | null {
  const title = task.title || '';
  const description = task.description || '';
  const priority = (task.priority as TaskPriority) || 'medium';

  // Step 1: Try explicit department tag
  if (task.department) {
    const dept = departments.find((d) => d.id === task.department || d.name === task.department);
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

  // Step 2: Keyword-based department scoring
  const ranked = rankDepartments(title, description, priority, departments);

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

  // Step 3: Fallback to least-loaded master agent (CEO / COM)
  const masters = agents
    .filter((a) => a.is_master && a.status !== 'offline')
    .sort((a, b) => a.active_tasks - b.active_tasks);

  if (masters[0]) {
    return {
      agentId: masters[0].id,
      agentName: masters[0].name,
      department: 'CEO / COM',
      score: 0,
      reason: `No department match — routed to CEO / COM master agent (load: ${masters[0].active_tasks} tasks)`,
    };
  }

  return null; // No agents available
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Route a task to the best available agent.
 *
 * @param task - Partial task with at minimum title, priority, and workspace_id
 * @returns RoutingResult or null if no agent is available
 */
export function routeTask(
  task: Pick<Task, 'title' | 'description' | 'priority' | 'workspace_id'> & { department?: string },
): RoutingResult | null {
  const departments = loadDepartments();
  const agents = fetchAgentsWithLoad(task.workspace_id ?? undefined);

  if (agents.length === 0) {
    console.warn('[DepartmentRouter] No available agents found');
    return null;
  }

  const result = comDispatch(task, agents, departments);

  if (result) {
    console.log(`[DepartmentRouter] Routed "${task.title}" → ${result.agentName} (${result.department}): ${result.reason}`);
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
