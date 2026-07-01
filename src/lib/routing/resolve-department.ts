/**
 * Shared Department Resolution
 *
 * Both /ceo-board/[dept] and /workspace/[slug] need to resolve a slug or id
 * to a department/workspace. This module provides a single resolution function
 * so both routes use identical logic.
 *
 * Resolution strategy:
 *   1. Call /api/workspaces/${slugOrId} (direct lookup by slug or id)
 *   2. If that fails, fall back to listing all workspaces and matching by id or slug
 *   3. Return a normalized DepartmentResolution object
 *
 * PRD 2.9(e): headTitle is the REAL per-client agent name from head_agent_name
 * (populated via the agents JOIN in /api/workspaces routes). Generic
 * "Head of <Dept>" is only used when no agent is registered as head yet.
 */

export interface DepartmentResolution {
  /** The workspace/department id from the database */
  id: string;
  /** The slug (may equal id if no slug set) */
  slug: string;
  /** Display name */
  name: string;
  /** Emoji icon */
  emoji: string;
  /**
   * Head display title — the real per-client agent name when one is registered
   * as the department head (head_agent_name from the agents JOIN), or the
   * generic "Head of <Dept>" fallback when no head agent is seeded yet.
   */
  headTitle: string;
  /** Grade (A-F) */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Grade score (0-100) */
  gradeScore: number;
  /** AI insight text */
  insight: string;
  /** Description from workspace record */
  description?: string;
  /** Real agent name used as department head (null when no head registered) */
  headAgentName?: string | null;
}

/**
 * Resolve a slug or id to a department.
 * Works identically for /ceo-board/[dept] and /workspace/[slug].
 */
export async function resolveDepartment(
  slugOrId: string,
): Promise<DepartmentResolution | null> {
  // Strategy 1: Direct API lookup (fastest path)
  try {
    const res = await fetch(`/api/workspaces/${slugOrId}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      return normalizeWorkspace(data);
    }
  } catch {
    // Fall through to strategy 2
  }

  // Strategy 2: List workspaces and match by id or slug
  try {
    const wsRes = await fetch('/api/workspaces', { cache: 'no-store' });
    if (wsRes.ok) {
      const workspaces = await wsRes.json();
      const allWorkspaces = Array.isArray(workspaces) ? workspaces : workspaces.workspaces || [];
      const ws = allWorkspaces.find(
        (w: { id: string; slug?: string }) => w.id === slugOrId || w.slug === slugOrId,
      );
      if (ws) {
        return normalizeWorkspace(ws);
      }
    }
  } catch {
    // No match found
  }

  return null;
}

/**
 * Normalize a workspace API response into a DepartmentResolution.
 * Handles both singular workspace objects and list items.
 *
 * PRD 2.9(e): headTitle uses the real per-client agent name (head_agent_name
 * from the agents LEFT JOIN in all /api/workspaces routes). Falls back to the
 * generic "Head of <Name>" only when no head agent has been registered yet.
 */
function normalizeWorkspace(ws: Record<string, unknown>): DepartmentResolution {
  const name = (ws.name as string) || 'Unknown Department';
  const slug = (ws.slug as string) || (ws.id as string) || '';
  const description = ws.description as string | undefined;

  // head_agent_name is populated by the agents LEFT JOIN in /api/workspaces/[id]
  // and /api/workspaces (list). When present it is the real per-client agent
  // identity (e.g. "Nova", "Orion") rather than a generic role label.
  const headAgentName = (ws.head_agent_name as string | null | undefined) ?? null;
  const headTitle = headAgentName || `Head of ${name}`;

  return {
    id: ws.id as string,
    slug,
    name,
    emoji: (ws.icon as string) || (ws.emoji as string) || '🏢',
    headTitle,
    headAgentName,
    grade: 'B',
    gradeScore: 75,
    insight: description || `${name} department is active and operational.`,
    description,
  };
}
