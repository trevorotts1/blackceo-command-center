import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/departments/[id]/config
 *
 * Returns the per-department routing configuration for the given department
 * id/slug: the operator-configured keywords and priority from dispatch_rules
 * (migration 054), plus the derived defaults when no override exists.
 *
 * This is the read side of the per-department config surface that makes custom
 * departments routable: the operator can assign keywords and priority to any
 * department, and the routing engine (loadDepartments/workspaceToDept) reads
 * them via dispatch_rules at load time.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Missing department id' },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    const deptId = id.trim();
    const canon = canonicalDeptSlug(deptId) || deptId;

    // Resolve the workspace row so we know whether this is a standard or custom dept
    const ws = db
      .prepare('SELECT id, slug, name, description FROM workspaces WHERE id = ? OR slug = ?')
      .get(deptId, deptId) as { id: string; slug: string; name: string; description: string | null } | undefined;

    if (!ws) {
      return NextResponse.json(
        { success: false, message: `Department "${deptId}" not found` },
        { status: 404 },
      );
    }

    // Check dispatch_rules for an operator-configured override
    const rule = db
      .prepare(
        `SELECT task_keywords, priority FROM dispatch_rules
         WHERE department_slug = ? OR department_slug = ?
         ORDER BY priority DESC LIMIT 1`,
      )
      .get(canon, deptId) as { task_keywords: string | null; priority: number | null } | undefined;

    const keywords = rule?.task_keywords
      ? rule.task_keywords
          .split(/[,\n]+/)
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      : null;
    const priority = rule?.priority ?? null;
    const hasOverride = rule !== undefined;

    return NextResponse.json({
      success: true,
      department: {
        id: ws.id,
        slug: ws.slug,
        name: ws.name,
        description: ws.description ?? null,
      },
      config: {
        keywords,
        priority,
        hasOverride,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, message: `Failed to read department config: ${msg}` },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/departments/[id]/config
 *
 * Updates the per-department routing configuration: operator-configured
 * keywords and priority stored in dispatch_rules. Creates the rule row if
 * none exists for this department. Passing empty keywords clears the override
 * (the routing engine will fall back to derived keywords at load time).
 *
 * Body: { keywords?: string[] | null, priority?: number | null }
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || typeof id !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Missing department id' },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, message: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const b = body as Record<string, unknown>;
  const keywordsRaw = b.keywords;
  const priorityRaw = b.priority;

  // Validate keywords: null / undefined = clear; array of strings = set
  if (
    keywordsRaw !== undefined &&
    keywordsRaw !== null &&
    (!Array.isArray(keywordsRaw) || keywordsRaw.some((k) => typeof k !== 'string'))
  ) {
    return NextResponse.json(
      { success: false, message: '"keywords" must be an array of strings or null' },
      { status: 400 },
    );
  }

  // Validate priority: null / undefined = clear; 1-10 = set
  if (
    priorityRaw !== undefined &&
    priorityRaw !== null &&
    (typeof priorityRaw !== 'number' || priorityRaw < 1 || priorityRaw > 10)
  ) {
    return NextResponse.json(
      { success: false, message: '"priority" must be a number 1-10 or null' },
      { status: 400 },
    );
  }

  try {
    const db = getDb();
    const deptId = id.trim();
    const canon = canonicalDeptSlug(deptId) || deptId;

    // Verify the workspace exists
    const ws = db
      .prepare('SELECT id, slug FROM workspaces WHERE id = ? OR slug = ?')
      .get(deptId, deptId) as { id: string; slug: string } | undefined;

    if (!ws) {
      return NextResponse.json(
        { success: false, message: `Department "${deptId}" not found` },
        { status: 404 },
      );
    }

    // Upsert dispatch_rules: one row per department_slug (canonical).
    const existingRule = db
      .prepare(
        `SELECT id FROM dispatch_rules
         WHERE department_slug = ? OR department_slug = ?
         LIMIT 1`,
      )
      .get(canon, deptId) as { id: string } | undefined;

    const keywordStr =
      Array.isArray(keywordsRaw)
        ? keywordsRaw
            .map((k) => String(k).trim())
            .filter((k) => k.length > 0)
            .join(', ')
        : null;

    const priority =
      typeof priorityRaw === 'number'
        ? Math.round(priorityRaw)
        : null;

    // Both null → delete the rule row (clear override; let workspaceToDept derive)
    if (keywordStr === null && priority === null) {
      if (existingRule) {
        db.prepare('DELETE FROM dispatch_rules WHERE id = ?').run(existingRule.id);
        return NextResponse.json({
          success: true,
          config: { keywords: null, priority: null, hasOverride: false },
          message: 'Override cleared. Routing engine will derive keywords from department description.',
        });
      }
      return NextResponse.json({
        success: true,
        config: { keywords: null, priority: null, hasOverride: false },
        message: 'No override found; nothing changed.',
      });
    }

    // Build the fields to set; preserve existing values for NULL fields
    // (PATCH semantics: missing fields are left unchanged)
    if (existingRule) {
      // Update existing row — only set fields that were explicitly provided
      if (keywordStr !== null) {
        db.prepare(
          `UPDATE dispatch_rules SET task_keywords = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(keywordStr, existingRule.id);
      }
      if (priority !== null) {
        db.prepare(
          `UPDATE dispatch_rules SET priority = ?, updated_at = datetime('now') WHERE id = ?`,
        ).run(priority, existingRule.id);
      }
    } else {
      // Insert new row
      db.prepare(`
        INSERT INTO dispatch_rules (id, department_slug, task_keywords, priority)
        VALUES (lower(hex(randomblob(8))), ?, ?, ?)
      `).run(canon, keywordStr ?? '', priority ?? 5);
    }

    // Re-read to return the canonical post-upsert state
    const updatedRule = db
      .prepare(
        `SELECT task_keywords, priority FROM dispatch_rules
         WHERE department_slug = ? OR department_slug = ?
         LIMIT 1`,
      )
      .get(canon, deptId) as { task_keywords: string | null; priority: number | null } | undefined;

    const finalKeywords = updatedRule?.task_keywords
      ? updatedRule.task_keywords
          .split(/[,\n]+/)
          .map((k) => k.trim())
          .filter((k) => k.length > 0)
      : null;

    return NextResponse.json({
      success: true,
      config: {
        keywords: finalKeywords,
        priority: updatedRule?.priority ?? null,
        hasOverride: true,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, message: `Failed to update department config: ${msg}` },
      { status: 500 },
    );
  }
}
