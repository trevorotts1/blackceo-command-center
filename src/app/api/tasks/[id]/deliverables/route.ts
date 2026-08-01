/**
 * Task Deliverables API
 * Endpoints for managing task deliverables (files, URLs, artifacts)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { CreateDeliverableSchema } from '@/lib/validation';
import { existsSync, lstatSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { extname } from 'path';
import type { TaskDeliverable } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/tasks/[id]/deliverables
 * Retrieve all deliverables for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const db = getDb();

    const deliverables = db.prepare(`
      SELECT *
      FROM task_deliverables
      WHERE task_id = ?
      ORDER BY created_at DESC
    `).all(taskId) as TaskDeliverable[];

    return NextResponse.json(deliverables);
  } catch (error) {
    console.error('Error fetching deliverables:', error);
    return NextResponse.json(
      { error: 'Failed to fetch deliverables' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/tasks/[id]/deliverables
 * Add a new deliverable to a task
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const body = await request.json();
    
    // Validate input with Zod
    const validation = CreateDeliverableSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { error: 'Validation failed', details: validation.error.issues },
        { status: 400 }
      );
    }

    const { deliverable_type, title, path, description } = validation.data;

    // Validate file existence for file-backed deliverables (QC-04).
    // Both 'file' and 'artifact' types carry a filesystem path the QC scorer
    // later probes (see qc-scorer FILE_BACKED_DELIVERABLE_TYPES); the old guard
    // only checked 'file', so an artifact registered at a non-existent path was
    // accepted silently and only failed much later inside the QC manifest build.
    let fileExists = true;
    let normalizedPath = path;
    let mime_type: string | null = null;
    let file_size_bytes: number | null = null;
    let sha256: string | null = null;
    if ((deliverable_type === 'file' || deliverable_type === 'artifact') && path) {
      // Expand tilde
      normalizedPath = path.replace(/^~/, process.env.HOME || '');
      fileExists = existsSync(normalizedPath);
      if (!fileExists) {
        console.warn(`[DELIVERABLE] Warning: File does not exist: ${normalizedPath}`);
      }
      // U063: capture mime_type, file_size_bytes, sha256 for regular files.
      // Wrap so a stat failure logs and continues — the POST must still return 201.
      if (fileExists) {
        try {
          const stat = lstatSync(normalizedPath);
          if (stat.isFile()) {
            file_size_bytes = stat.size;
            const ext = extname(normalizedPath).replace(/^\./, '').toLowerCase();
            const mimeMap: Record<string, string> = {
              pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
              pdf: 'application/pdf', md: 'text/markdown', mp3: 'audio/mpeg',
              png: 'image/png', html: 'text/html', htm: 'text/html',
              json: 'application/json', txt: 'text/plain', csv: 'text/csv',
              jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
              svg: 'image/svg+xml', webp: 'image/webp',
            };
            mime_type = mimeMap[ext] || 'application/octet-stream';
            const buf = readFileSync(normalizedPath);
            sha256 = createHash('sha256').update(buf).digest('hex');
          }
        } catch (err) {
          console.warn(`[DELIVERABLE] Could not stat/read file ${normalizedPath}:`, (err as Error).message);
        }
      }
    }

    const db = getDb();
    const id = crypto.randomUUID();

    // Insert deliverable (U063: now writes mime_type, file_size_bytes, sha256
    // for regular files. Back-fills nothing — the 24 existing rows stay NULL.)
    db.prepare(`
      INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description, mime_type, file_size_bytes, sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      taskId,
      deliverable_type,
      title,
      path || null,
      description || null,
      mime_type,
      file_size_bytes,
      sha256,
    );

    // Get the created deliverable
    const deliverable = db.prepare(`
      SELECT *
      FROM task_deliverables
      WHERE id = ?
    `).get(id) as TaskDeliverable;

    // Broadcast to SSE clients
    broadcast({
      type: 'deliverable_added',
      payload: deliverable,
    });

    // Return with warning if the file-backed deliverable doesn't exist (QC-04).
    if ((deliverable_type === 'file' || deliverable_type === 'artifact') && !fileExists) {
      return NextResponse.json(
        {
          ...deliverable,
          warning: `File does not exist at path: ${normalizedPath}. Please create the file.`
        },
        { status: 201 }
      );
    }

    return NextResponse.json(deliverable, { status: 201 });
  } catch (error) {
    console.error('Error creating deliverable:', error);
    return NextResponse.json(
      { error: 'Failed to create deliverable' },
      { status: 500 }
    );
  }
}
