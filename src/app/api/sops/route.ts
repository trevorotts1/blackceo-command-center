import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { parseAndValidateSteps, type SOP } from '@/lib/sops';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/sops
 *
 * Query params:
 *   ?department=<slug>   — filter to SOPs bound to this department
 *   ?keywords=<comma>    — at least one keyword must appear in task_keywords
 *   ?include_deleted=1   — include soft-deleted rows (off by default)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const department = searchParams.get('department');
    const keywords = searchParams.get('keywords');
    const includeDeleted = searchParams.get('include_deleted') === '1';

    let sql = `SELECT * FROM sops WHERE 1=1`;
    const params: unknown[] = [];

    if (!includeDeleted) {
      sql += ` AND deleted_at IS NULL`;
    }
    if (department) {
      sql += ` AND department = ?`;
      params.push(department);
    }
    if (keywords) {
      const list = keywords.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
      if (list.length > 0) {
        const ors = list.map(() => `LOWER(COALESCE(task_keywords, '')) LIKE ?`).join(' OR ');
        sql += ` AND (${ors})`;
        for (const k of list) params.push(`%${k}%`);
      }
    }

    sql += ` ORDER BY department, name`;
    const sops = queryAll<SOP>(sql, params);

    return NextResponse.json(sops);
  } catch (error) {
    console.error('[GET /api/sops] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch SOPs' }, { status: 500 });
  }
}

/**
 * POST /api/sops
 *
 * Body: { name, slug, description?, department?, task_keywords?, steps[], success_criteria?, persona_hints?[] }
 * Always creates with version=1.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      return NextResponse.json(
        { error: 'slug is required and must be lowercase letters, digits, hyphens' },
        { status: 400 }
      );
    }

    let steps;
    try {
      steps = parseAndValidateSteps(body.steps);
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 400 });
    }

    const existing = queryOne<SOP>('SELECT id FROM sops WHERE slug = ?', [slug]);
    if (existing) {
      return NextResponse.json({ error: `SOP with slug "${slug}" already exists` }, { status: 409 });
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    let personaHints: string | null = null;
    if (body.persona_hints !== undefined && body.persona_hints !== null) {
      if (!Array.isArray(body.persona_hints) || !body.persona_hints.every((p: unknown) => typeof p === 'string')) {
        return NextResponse.json({ error: 'persona_hints must be a string array' }, { status: 400 });
      }
      personaHints = JSON.stringify(body.persona_hints);
    }

    run(
      `INSERT INTO sops (id, name, slug, description, version, department, task_keywords, steps, success_criteria, persona_hints, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        slug,
        body.description ?? null,
        body.department ?? null,
        body.task_keywords ?? null,
        JSON.stringify(steps),
        body.success_criteria ?? null,
        personaHints,
        now,
        now,
      ]
    );

    const sop = queryOne<SOP>('SELECT * FROM sops WHERE id = ?', [id]);
    return NextResponse.json(sop, { status: 201 });
  } catch (error) {
    console.error('[POST /api/sops] Failed:', error);
    return NextResponse.json({ error: 'Failed to create SOP' }, { status: 500 });
  }
}
