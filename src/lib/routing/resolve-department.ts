'use server';

/**
 * Shared Department Resolution — Server Action (PRD 2.10)
 *
 * Both /ceo-board/[dept] and /workspace/[slug] need to resolve a slug or id
 * to a department/workspace, including its REAL performance grade. This is a
 * Server Action (Next 14 'use server' file — same pattern as
 * src/components/interview/gate-actions.ts) so it can query the SQLite DB
 * directly via better-sqlite3, which cannot run in the browser, while still
 * being importable and callable from the 'use client' pages that render it.
 *
 * Resolution strategy:
 *   1. Query workspaces directly by id or slug (same join as
 *      /api/workspaces/[id] — LEFT JOIN agents for head_agent_name).
 *   2. Compute the REAL grade via computeDepartmentGrade (src/lib/grading.ts)
 *      — never the old hardcoded grade:'B'/gradeScore:75. computeDepartmentGrade
 *      needs 2+ of the four graded inputs to have data; when it doesn't,
 *      score/grade are null. The "never 72" doctrine applies here too: null
 *      MUST render as "Insufficient data" in the UI, never a fake letter.
 *   3. Return a normalized DepartmentResolution object.
 *
 * PRD 2.9(e): headTitle is the REAL per-client agent name from head_agent_name
 * (populated via the agents JOIN below). Generic "Head of <Dept>" is only used
 * when no agent is registered as head yet.
 */

import { getDb } from '@/lib/db';
import { computeDepartmentGrade, type Grade } from '@/lib/grading';
import { loadCompanyConfig } from '@/lib/company-config';

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
  /** Real grade (A-F) from computeDepartmentGrade; null = insufficient data — never a fabricated letter */
  grade: Grade | null;
  /** Real grade score (0-100) from computeDepartmentGrade; null = insufficient data — never 0 or 72 */
  gradeScore: number | null;
  /** AI insight text */
  insight: string;
  /** Description from workspace record */
  description?: string;
  /** Real agent name used as department head (null when no head registered) */
  headAgentName?: string | null;
}

interface WorkspaceJoinRow {
  id: string;
  slug: string | null;
  name: string | null;
  icon: string | null;
  description: string | null;
  head_agent_name: string | null;
}

/**
 * Resolve a slug or id to a department, including its real computed grade.
 * Works identically for /ceo-board/[dept] and /workspace/[slug].
 * Returns null when no matching workspace exists, or on any DB error
 * (never throws to the caller — callers treat null as "not found").
 */
export async function resolveDepartment(
  slugOrId: string,
): Promise<DepartmentResolution | null> {
  try {
    const db = getDb();

    const ws = db.prepare(
      `SELECT w.id, w.slug, w.name, w.icon, w.description,
              a.name AS head_agent_name
         FROM workspaces w
         LEFT JOIN agents a ON a.id = w.head_agent_id
        WHERE w.id = ? OR w.slug = ?`
    ).get(slugOrId, slugOrId) as WorkspaceJoinRow | undefined;

    if (!ws) return null;

    const config = loadCompanyConfig();
    const windowDays = config.gradingWindowDays ?? 30;
    const slug = ws.slug || ws.id;
    const name = ws.name || 'Unknown Department';

    // PRD 2.10 single source of truth — real grade from observable DB signals,
    // honest null gating when there isn't enough data yet (never 'B'/75).
    const deptGrade = computeDepartmentGrade(
      db,
      { id: ws.id, slug, name },
      windowDays,
      config.gradingInputWeights,
    );

    // head_agent_name is populated by the agents LEFT JOIN above. When present
    // it is the real per-client agent identity (e.g. "Nova", "Orion") rather
    // than a generic role label.
    const headAgentName = ws.head_agent_name ?? null;
    const headTitle = headAgentName || `Head of ${name}`;

    return {
      id: ws.id,
      slug,
      name,
      emoji: ws.icon || '🏢',
      headTitle,
      headAgentName,
      grade: deptGrade.grade,
      gradeScore: deptGrade.score,
      insight: ws.description || `${name} department is active and operational.`,
      description: ws.description ?? undefined,
    };
  } catch (err) {
    console.error('[resolveDepartment] Error:', (err as Error).message);
    return null;
  }
}
