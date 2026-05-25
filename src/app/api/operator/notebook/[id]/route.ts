/**
 * /api/operator/notebook/[id]
 *
 *   GET    - fetch a single notebook plus its sources
 *   PATCH  - update title / description / backend / remote_id
 *   DELETE - remove the notebook (cascade removes sources)
 *
 * Track B5 (PRD Section 4.6).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  deleteNotebook,
  getNotebook,
  isNotebookBackend,
  updateNotebook,
  type UpdateNotebookInput,
} from '@/lib/notebooks/store';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const id = ctx.params?.id;
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  try {
    const notebook = getNotebook(id);
    if (!notebook) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(notebook);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'fetch_failed',
        detail: err instanceof Error ? err.message : 'unknown',
      },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest, ctx: { params: { id: string } }) {
  const id = ctx.params?.id;
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const input = body as Record<string, unknown>;
  const update: UpdateNotebookInput = {};

  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.trim().length === 0) {
      return NextResponse.json({ error: 'invalid_title' }, { status: 400 });
    }
    update.title = input.title.trim();
  }
  if (input.description !== undefined) {
    update.description =
      typeof input.description === 'string' ? input.description : null;
  }
  if (input.backend !== undefined) {
    if (!isNotebookBackend(input.backend)) {
      return NextResponse.json({ error: 'invalid_backend' }, { status: 400 });
    }
    update.backend = input.backend;
  }
  if (input.remote_id !== undefined) {
    update.remote_id =
      typeof input.remote_id === 'string' ? input.remote_id : null;
  }

  try {
    const next = updateNotebook(id, update);
    if (!next) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(next);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'update_failed',
        detail: err instanceof Error ? err.message : 'unknown',
      },
      { status: 500 }
    );
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: { id: string } }) {
  const id = ctx.params?.id;
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  try {
    const removed = deleteNotebook(id);
    if (!removed) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'delete_failed',
        detail: err instanceof Error ? err.message : 'unknown',
      },
      { status: 500 }
    );
  }
}
