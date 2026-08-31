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
 * FIX 27 — registration-time reachability gate (rejects fake paths).
 *
 * A task_deliverables row is the durable claim "the work landed HERE." Before
 * this fix, a file/artifact registered at a nonexistent path was accepted with
 * a 201 + warning — the row lied until the QC scorer probed it much later (or
 * the task reached `done` on evidence that never existed). Registration now
 * fails closed (422) unless the backing resource is reachable at register time:
 *
 *   file | artifact | image → a filesystem path that exists (after ~ expansion)
 *   url                     → a syntactically valid http(s) URL
 *
 * The type→reachability mapping mirrors EVIDENCE_DELIVERABLE_TYPES
 * (src/lib/completion-evidence.ts) so FIX 25's review/done gates can trust
 * that a registered row's path was real at registration. size/sha/mime are
 * captured ONLY on real regular files (U063 behavior kept).
 *
 * ROLLBACK: set DELIVERABLE_PATH_VALIDATION=0 to restore the pre-fix
 * warn-and-201 behavior. Any other value (including unset) keeps the gate ON.
 * Read per-request (pathValidationEnabled()), so tests and a process restart
 * both control it without code changes.
 */
function pathValidationEnabled(): boolean {
  return process.env.DELIVERABLE_PATH_VALIDATION !== '0';
}

/** FIX 27: the deliverable types whose `path` is a filesystem path. */
const FILE_BACKED_TYPES = new Set(['file', 'artifact', 'image']);

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

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

    // FIX 27 — reachability at registration time (see PATH_VALIDATION_ENABLED
    // header above). Gate ON (default): an unreachable path/URL is a 422 and no
    // row is written; mime/size/sha are captured only on real regular files.
    // Gate OFF (DELIVERABLE_PATH_VALIDATION=0): the pre-fix QC-04 behavior runs
    // verbatim — warn and 201 (rollback path).
    // Both 'file' and 'artifact' (and defensively 'image', per
    // qc-scorer/EVIDENCE_DELIVERABLE_TYPES) carry a filesystem path the QC
    // scorer later probes; 'url' carries an http(s) link validated by shape.
    let fileExists = true;
    let normalizedPath = path;
    let mime_type: string | null = null;
    let file_size_bytes: number | null = null;
    let sha256: string | null = null;

    const mimeFor = (target: string): string => {
      const ext = extname(target).replace(/^\./, '').toLowerCase();
      const mimeMap: Record<string, string> = {
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        pdf: 'application/pdf', md: 'text/markdown', mp3: 'audio/mpeg',
        png: 'image/png', html: 'text/html', htm: 'text/html',
        json: 'application/json', txt: 'text/plain', csv: 'text/csv',
        jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        svg: 'image/svg+xml', webp: 'image/webp',
      };
      return mimeMap[ext] || 'application/octet-stream';
    };

    if (pathValidationEnabled() && FILE_BACKED_TYPES.has(deliverable_type)) {
      if (!path) {
        console.warn(`[DELIVERABLE] Rejected (FIX 27): '${deliverable_type}' registered without a path`);
        return NextResponse.json(
          { error: `A '${deliverable_type}' deliverable requires a path — registration cannot verify a resource that was never pointed at.` },
          { status: 422 }
        );
      }
      // Expand tilde
      normalizedPath = path.replace(/^~/, process.env.HOME || '');
      if (!existsSync(normalizedPath)) {
        console.warn(`[DELIVERABLE] Rejected (FIX 27): file does not exist: ${normalizedPath}`);
        return NextResponse.json(
          { error: `File does not exist at path: ${normalizedPath}. Create the artifact before registering it.`, path: normalizedPath },
          { status: 422 }
        );
      }
      fileExists = true;
      // U063: capture mime_type, file_size_bytes, sha256 for regular files.
      // A path that exists but cannot be stat'ed/read stays NULL on those
      // columns — size/sha are captured only on real files (FIX 27).
      try {
        const stat = lstatSync(normalizedPath);
        if (stat.isFile()) {
          file_size_bytes = stat.size;
          mime_type = mimeFor(normalizedPath);
          const buf = readFileSync(normalizedPath);
          sha256 = createHash('sha256').update(buf).digest('hex');
        }
      } catch (err) {
        console.warn(`[DELIVERABLE] Could not stat/read file ${normalizedPath}:`, (err as Error).message);
      }
    } else if (pathValidationEnabled() && deliverable_type === 'url') {
      // A url row is the artifact-free escape hatch (completion-evidence.ts):
      // its reachability rule is shape, not bytes — a valid http(s) URL.
      if (!path || !isValidHttpUrl(path)) {
        console.warn(`[DELIVERABLE] Rejected (FIX 27): invalid url: ${path ?? '(absent)'}`);
        return NextResponse.json(
          { error: `A 'url' deliverable requires a valid http(s) URL in path.`, path: path ?? null },
          { status: 422 }
        );
      }
    } else if ((deliverable_type === 'file' || deliverable_type === 'artifact') && path) {
      // ROLLBACK PATH (DELIVERABLE_PATH_VALIDATION=0): pre-FIX-27 QC-04
      // behavior, kept verbatim — nonexistent file warns and still 201s.
      normalizedPath = path.replace(/^~/, process.env.HOME || '');
      fileExists = existsSync(normalizedPath);
      if (!fileExists) {
        console.warn(`[DELIVERABLE] Warning: File does not exist: ${normalizedPath}`);
      }
      if (fileExists) {
        try {
          const stat = lstatSync(normalizedPath);
          if (stat.isFile()) {
            file_size_bytes = stat.size;
            mime_type = mimeFor(normalizedPath);
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

    // Return with warning if the file-backed deliverable doesn't exist.
    // Only reachable on the rollback path now — with the FIX 27 gate ON, an
    // unreachable file-backed path was already rejected with 422.
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
