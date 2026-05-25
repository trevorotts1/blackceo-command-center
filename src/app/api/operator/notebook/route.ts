/**
 * /api/operator/notebook
 *
 *   GET  - list notebooks (each row carries source_count for the library view)
 *   POST - create a new notebook
 *
 * Track B5 (PRD Section 4.6). Backed by Migration 040 (`notebooks` /
 * `notebook_sources`).
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  createNotebook,
  isNotebookBackend,
  listNotebooks,
  type NotebookBackend,
} from '@/lib/notebooks/store';
import { backendStatus, pickBackend } from '@/lib/notebooks/notebooklm-client';

export async function GET() {
  try {
    const items = listNotebooks();
    return NextResponse.json({
      items,
      backends: backendStatus(),
    });
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

export async function POST(req: NextRequest) {
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

  const title =
    typeof input.title === 'string' && input.title.trim().length > 0
      ? input.title.trim()
      : null;
  if (!title) {
    return NextResponse.json({ error: 'missing_title' }, { status: 400 });
  }
  const description =
    typeof input.description === 'string' && input.description.trim().length > 0
      ? input.description.trim()
      : null;

  let backend: NotebookBackend | null = null;
  if (input.backend !== undefined) {
    if (!isNotebookBackend(input.backend)) {
      return NextResponse.json({ error: 'invalid_backend' }, { status: 400 });
    }
    backend = input.backend;
  } else {
    backend = pickBackend() ?? 'notebooklm';
  }

  try {
    const notebook = createNotebook({
      title,
      description,
      backend,
      remote_id: typeof input.remote_id === 'string' ? input.remote_id : null,
    });
    return NextResponse.json(notebook, { status: 201 });
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
