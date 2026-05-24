import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { parseAndValidateSteps, type SOP } from '@/lib/sops';

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
export async function DELETE(
  _request: NextRequest,
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
    const now = new Date().toISOString();
    run('UPDATE sops SET deleted_at = ?, updated_at = ? WHERE id = ?', [now, now, existing.id]);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[DELETE /api/sops/[id]] Failed:', error);
    return NextResponse.json({ error: 'Failed to delete SOP' }, { status: 500 });
  }
}
