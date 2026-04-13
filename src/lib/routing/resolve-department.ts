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
  /** Head title (e.g. "Head of Marketing") */
  headTitle: string;
  /** Grade (A-F) */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Grade score (0-100) */
  gradeScore: number;
  /** AI insight text */
  insight: string;
  /** Description from workspace record */
  description?: string;
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
 */
function normalizeWorkspace(ws: Record<string, unknown>): DepartmentResolution {
  const name = (ws.name as string) || 'Unknown Department';
  const slug = (ws.slug as string) || (ws.id as string) || '';
  const description = ws.description as string | undefined;

  return {
    id: ws.id as string,
    slug,
    name,
    emoji: (ws.icon as string) || (ws.emoji as string) || '🏢',
    headTitle: `Head of ${name}`,
    grade: 'B',
    gradeScore: 75,
    insight: description || `${name} department is active and operational.`,
    description,
  };
}
