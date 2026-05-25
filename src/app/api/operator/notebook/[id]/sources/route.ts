/**
 * /api/operator/notebook/[id]/sources
 *
 *   GET    - list the notebook's sources
 *   POST   - attach a new source (PDF / text / markdown / URL / audio / video)
 *   DELETE - remove a source by `source_id` query param
 *
 * Track B5 (PRD Section 4.6). At Depth 2 we accept already-uploaded files by
 * `path`, raw text blobs in `path` (when source_type=text|markdown), or
 * external URLs. The actual NotebookLM upload + `remote_id` assignment is
 * handled by the `notebooklm-client` adapter once a backend is wired in.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  addNotebookSource,
  getNotebook,
  isNotebookSourceType,
  listNotebookSources,
  removeNotebookSource,
  type NotebookSourceType,
} from '@/lib/notebooks/store';

export async function GET(_req: NextRequest, ctx: { params: { id: string } }) {
  const id = ctx.params?.id;
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  try {
    const notebook = getNotebook(id);
    if (!notebook) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ items: listNotebookSources(id) });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'list_failed',
        detail: err instanceof Error ? err.message : 'unknown',
      },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest, ctx: { params: { id: string } }) {
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

  const source_type = input.source_type;
  if (!isNotebookSourceType(source_type)) {
    return NextResponse.json({ error: 'invalid_source_type' }, { status: 400 });
  }
  const typed: NotebookSourceType = source_type;

  const title =
    typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : null;
  const path = typeof input.path === 'string' ? input.path : null;
  const url = typeof input.url === 'string' ? input.url : null;
  const remote_id = typeof input.remote_id === 'string' ? input.remote_id : null;
  const byte_size =
    typeof input.byte_size === 'number' && Number.isFinite(input.byte_size)
      ? Math.max(0, Math.floor(input.byte_size))
      : null;

  // Require either a path, a URL, or an inline blob in path - the row is
  // useless without a way to reach the content.
  if (!path && !url) {
    return NextResponse.json({ error: 'missing_content' }, { status: 400 });
  }

  try {
    const notebook = getNotebook(id);
    if (!notebook) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const created = addNotebookSource({
      notebook_id: id,
      source_type: typed,
      title,
      path,
      url,
      remote_id,
      byte_size,
    });
    if (!created) {
      return NextResponse.json({ error: 'create_failed' }, { status: 500 });
    }
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'create_failed',
        detail: err instanceof Error ? err.message : 'unknown',
      },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest, ctx: { params: { id: string } }) {
  const id = ctx.params?.id;
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });

  const url = new URL(req.url);
  const sourceId = url.searchParams.get('source_id');
  if (!sourceId) {
    return NextResponse.json({ error: 'missing_source_id' }, { status: 400 });
  }

  try {
    const removed = removeNotebookSource(id, sourceId);
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
