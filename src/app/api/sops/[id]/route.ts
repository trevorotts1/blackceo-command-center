import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { parseAndValidateSteps, type SOP } from '@/lib/sops';
import { enqueueAutoReplace, countImpactedTasks } from '@/lib/sop-auto-replace';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// GET /api/sops/[id]
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    // Accept either id or slug for convenience
    const sop = queryOne<SOP>('SELECT * FROM sops WHERE id = ? OR slug = ?', [id, id]);
    if (!sop) {
      return NextResponse.json({ error: 'SOP not found' }, { status: 404 });
    }
    return NextResponse.json(sop);
  } catch (error) {
    console.error('[GET /api/sops/[id]] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch SOP' }, { status: 500 });
  }
}

// PATCH /api/sops/[id] — updates bump version.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const existing = queryOne<SOP>('SELECT * FROM sops WHERE id = ? OR slug = ?', [id, id]);
    if (!existing) {
      return NextResponse.json({ error: 'SOP not found' }, { status: 404 });
    }
    if (existing.deleted_at) {
      return NextResponse.json({ error: 'Cannot update a deleted SOP' }, { status: 410 });
    }

    const updates: string[] = [];
    const values: unknown[] = [];
    const now = new Date().toISOString();

    if (typeof body.name === 'string') {
      updates.push('name = ?');
      values.push(body.name.trim());
    }
    if (typeof body.slug === 'string') {
      const slug = body.slug.trim();
      if (!/^[a-z0-9-]+$/.test(slug)) {
        return NextResponse.json({ error: 'slug must be lowercase letters, digits, hyphens' }, { status: 400 });
      }
      if (slug !== existing.slug) {
        const clash = queryOne<SOP>('SELECT id FROM sops WHERE slug = ? AND id != ?', [slug, existing.id]);
        if (clash) {
          return NextResponse.json({ error: `slug "${slug}" already in use` }, { status: 409 });
        }
      }
      updates.push('slug = ?');
      values.push(slug);
    }
    if (body.description !== undefined) {
      updates.push('description = ?');
      values.push(body.description);
    }
    if (body.department !== undefined) {
      updates.push('department = ?');
      values.push(body.department);
    }
    if (body.task_keywords !== undefined) {
      updates.push('task_keywords = ?');
      values.push(body.task_keywords);
    }
    if (body.steps !== undefined) {
      let steps;
      try {
        steps = parseAndValidateSteps(body.steps);
      } catch (err) {
        return NextResponse.json({ error: (err as Error).message }, { status: 400 });
      }
      updates.push('steps = ?');
      values.push(JSON.stringify(steps));
    }
    if (body.success_criteria !== undefined) {
      updates.push('success_criteria = ?');
      values.push(body.success_criteria);
    }
    if (body.persona_hints !== undefined) {
      if (body.persona_hints === null) {
        updates.push('persona_hints = ?');
        values.push(null);
      } else {
        if (!Array.isArray(body.persona_hints) || !body.persona_hints.every((p: unknown) => typeof p === 'string')) {
          return NextResponse.json({ error: 'persona_hints must be a string array' }, { status: 400 });
        }
        updates.push('persona_hints = ?');
        values.push(JSON.stringify(body.persona_hints));
      }
    }

    if (updates.length === 0) {
      return NextResponse.json({ error: 'No updates provided' }, { status: 400 });
    }

    // Bump version
    updates.push('version = version + 1');
    updates.push('updated_at = ?');
    values.push(now);
    values.push(existing.id);

    run(`UPDATE sops SET ${updates.join(', ')} WHERE id = ?`, values);
    const sop = queryOne<SOP>('SELECT * FROM sops WHERE id = ?', [existing.id]);
    return NextResponse.json(sop);
  } catch (error) {
    console.error('[PATCH /api/sops/[id]] Failed:', error);
    return NextResponse.json({ error: 'Failed to update SOP' }, { status: 500 });
  }
}

// DELETE /api/sops/[id] — soft delete. Tasks that reference it keep the FK
// pointer, but the Triad Rule treats deleted SOPs as missing.
//
// Track S: after soft-delete, optionally enqueue an auto-research replacement.
// The auto-research path is opt-in via `auto_research=true` (default), can be
// disabled with `?auto_research=false` query param or `{ auto_research: false }`
// in the JSON body.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const existing = queryOne<SOP>('SELECT * FROM sops WHERE id = ? OR slug = ?', [id, id]);
    if (!existing) {
      return NextResponse.json({ error: 'SOP not found' }, { status: 404 });
    }
    if (existing.deleted_at) {
      return NextResponse.json({ success: true, already_deleted: true });
    }

    // Resolve `auto_research` from query param (preferred) or JSON body.
    const url = new URL(request.url);
    const qpAutoResearch = url.searchParams.get('auto_research');
    let autoResearch = qpAutoResearch === null ? true : qpAutoResearch !== 'false';
    let useFixtures = url.searchParams.get('use_fixtures') === 'true';
    try {
      const body = await request.json();
      if (typeof body?.auto_research === 'boolean') autoResearch = body.auto_research;
      if (typeof body?.use_fixtures === 'boolean') useFixtures = body.use_fixtures;
    } catch {
      // body may be empty — that's fine, defaults apply
    }

    const impactedTasks = countImpactedTasks(existing.id);

    const now = new Date().toISOString();
    run('UPDATE sops SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, existing.id]);

    // Only fire auto-research if there are actually impacted tasks AND the
    // operator opted in. Use fixtures during smoke testing to keep cost $0.
    let replacementProposalId: string | null = null;
    let escalated = false;
    if (autoResearch && impactedTasks > 0) {
      try {
        // Fire-and-await: keep this synchronous so the response carries the
        // proposal id. For long-running research, swap to setImmediate + a
        // queue table — for now Tavily + Gemini round-trip is fast enough.
        const prevTavily = process.env.TAVILY_FIXTURE_JSON_PATH;
        const prevGemini = process.env.GEMINI_FIXTURE_JSON_PATH;
        const prevTelegram = process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED;
        try {
          if (useFixtures) {
            // Fixture paths come from request body if provided; otherwise
            // fall back to repo-default fixtures.
            process.env.TAVILY_FIXTURE_JSON_PATH = process.env.TAVILY_FIXTURE_JSON_PATH || '';
            process.env.GEMINI_FIXTURE_JSON_PATH = process.env.GEMINI_FIXTURE_JSON_PATH || '';
            process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED = '1';
          }
          const result = await enqueueAutoReplace(existing.id, {
            impactedTasks,
            notify: !useFixtures,
          });
          replacementProposalId = result.proposal_id;
          escalated = result.escalated;
        } finally {
          if (useFixtures) {
            process.env.TAVILY_FIXTURE_JSON_PATH = prevTavily;
            process.env.GEMINI_FIXTURE_JSON_PATH = prevGemini;
            process.env.SOP_AUTO_REPLACE_TELEGRAM_DISABLED = prevTelegram;
          }
        }
      } catch (err) {
        console.error('[DELETE /api/sops/[id]] auto-research failed:', err);
        // Don't fail the delete — the soft-delete already succeeded. Just
        // surface the error so the operator knows to manually author.
        return NextResponse.json({
          deleted: true,
          impacted_tasks: impactedTasks,
          replacement_proposal_id: null,
          auto_research_error: (err as Error).message,
        });
      }
    }

    return NextResponse.json({
      deleted: true,
      impacted_tasks: impactedTasks,
      replacement_proposal_id: replacementProposalId,
      escalated,
    });
  } catch (error) {
    console.error('[DELETE /api/sops/[id]] Failed:', error);
    return NextResponse.json({ error: 'Failed to delete SOP' }, { status: 500 });
  }
}
