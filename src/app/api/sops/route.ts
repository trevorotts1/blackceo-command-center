import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '@/lib/db';
import { parseAndValidateSteps, type SOP } from '@/lib/sops';
import { storeEmbeddingForSOP } from '@/lib/sop-embeddings';
import { expandDeptSlugAliases } from '@/lib/routing/canonical-slug';
import { TEST_RESIDUE_SOP_DEPARTMENTS } from '@/lib/test-residue';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/sops
 *
 * Query params:
 *   ?department=<slug>   — filter to SOPs bound to this department (alias-aware,
 *                          see C10 note below)
 *   ?keywords=<comma>    — at least one keyword must appear in task_keywords
 *   ?include_deleted=1   — include soft-deleted rows (off by default)
 *
 * C8 — test/fixture-residue gate: rows keyed to an exact TEST_RESIDUE_SOP_
 * DEPARTMENTS value are EXCLUDED unconditionally (even with include_deleted=1)
 * so a client-facing caller can never see them, regardless of whether the C8
 * cleanup migration has run on this box yet. This is belt-and-suspenders with
 * that migration, not a replacement for it.
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

    // C8 — never surface test-harness residue on a client-facing surface.
    const residuePlaceholders = TEST_RESIDUE_SOP_DEPARTMENTS.map(() => '?').join(',');
    sql += ` AND department NOT IN (${residuePlaceholders})`;
    params.push(...TEST_RESIDUE_SOP_DEPARTMENTS);

    // C10 — alias-aware department filter, IN SQL.
    //
    // A row may still be keyed to a LEGACY alias slug (webdev, billing,
    // support, ...) if C2's re-key migration hasn't reached this box's DB yet,
    // while the caller (a workspace page, dispatch-time SOP lookup, etc.) always
    // queries by the CANONICAL slug — and vice versa if a caller passes an
    // alias. A bare `department = ?` silently drops those rows and the library
    // reads as EMPTY for that department even though rows exist.
    //
    // Fix: canonicalize the caller's input, expand it to the full set of raw
    // spellings that mean the same department (expandDeptSlugAliases — the
    // inverse of canonicalDeptSlug), and match with `IN (...)`. Because C2 /
    // migration 091 re-keys at write time, that alias set is knowable up front.
    //
    // Kept in SQL on purpose: filtering in JS after the fact would SELECT the
    // WHOLE sops table (~2.5k rows on a live box) and materialize every row into
    // a JS object on EVERY ?department= request, just to throw almost all of them
    // away. LOWER(TRIM(...)) mirrors canonicalDeptSlug's own normalization so the
    // SQL predicate is exactly equivalent to the canonicalize-both-sides compare.
    if (department) {
      const aliases = expandDeptSlugAliases(department);
      if (aliases.length === 0) {
        // Caller passed a blank/whitespace-only department — match nothing rather
        // than silently returning the entire library.
        return NextResponse.json([]);
      }
      const deptPlaceholders = aliases.map(() => '?').join(',');
      sql += ` AND LOWER(TRIM(COALESCE(department, ''))) IN (${deptPlaceholders})`;
      params.push(...aliases);
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
 * After a successful INSERT, asynchronously computes + stores an embedding (no-op if key absent).
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

    // Compute + store embedding fire-and-forget. storeEmbeddingForSOP swallows
    // errors so a missing key or transient API failure never breaks the create path.
    if (sop) {
      storeEmbeddingForSOP(sop).catch(() => {/* already logged inside */});
    }

    return NextResponse.json(sop, { status: 201 });
  } catch (error) {
    console.error('[POST /api/sops] Failed:', error);
    return NextResponse.json({ error: 'Failed to create SOP' }, { status: 500 });
  }
}
