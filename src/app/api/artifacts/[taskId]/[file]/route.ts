/**
 * /api/artifacts/[taskId]/[file]
 *
 * §3 Artifact serving endpoint.
 *
 * Serves files from <PROJECTS_PATH>/artifacts/<taskId>/<file> with correct
 * Content-Type headers.
 *
 * Security:
 *   - Path-traversal proof: the resolved absolute path MUST start with the
 *     canonical artifacts base directory.  Any request that resolves outside
 *     that prefix returns 403.
 *   - [file] is treated as a filename only (no subdirectory separators
 *     allowed — a slash in the file parameter is rejected).
 *   - taskId must be alphanumeric + hyphens only (UUID shape).
 *
 * Supported MIME types: all common image formats + PDF + text + binary blob.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// ---------------------------------------------------------------------------
// MIME type map
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  // Images
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  bmp:  'image/bmp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  tif:  'image/tiff',
  svg:  'image/svg+xml',
  ico:  'image/x-icon',
  // Documents
  pdf:  'application/pdf',
  txt:  'text/plain',
  md:   'text/markdown',
  html: 'text/html',
  htm:  'text/html',
  json: 'application/json',
  csv:  'text/csv',
  // Video / audio
  mp4:  'video/mp4',
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
  // Fallback
  bin:  'application/octet-stream',
};

function mimeFor(filename: string): string {
  const ext = path.extname(filename).replace(/^\./, '').toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Base directory helper (mirrors task-lifecycle.ts artifactDir)
// ---------------------------------------------------------------------------

function artifactsBase(): string {
  const projectsPath = (process.env.PROJECTS_PATH || '~/Documents/Shared/projects')
    .replace(/^~/, process.env.HOME || '');
  return path.join(projectsPath, 'artifacts');
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * Validate taskId: must be a UUID (hex + hyphens, 36 chars) or a valid
 * alphanumeric-with-hyphens id up to 64 chars.
 */
function isValidTaskId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Validate filename: no directory separators, no null bytes, reasonable length.
 */
function isValidFilename(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  return true;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ taskId: string; file: string }> },
): Promise<NextResponse> {
  const { taskId, file: filename } = await params;

  // ── Input validation ──────────────────────────────────────────────────────
  if (!isValidTaskId(taskId)) {
    return NextResponse.json({ error: 'Invalid taskId' }, { status: 400 });
  }
  if (!isValidFilename(filename)) {
    return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
  }

  // ── Path construction + traversal check ───────────────────────────────────
  const base = artifactsBase();
  const taskDir = path.join(base, taskId);
  const resolved = path.resolve(taskDir, filename);

  // Traversal proof: resolved path must start with the canonical base
  if (!resolved.startsWith(path.resolve(base) + path.sep) &&
      !resolved.startsWith(path.resolve(taskDir) + path.sep) &&
      resolved !== path.resolve(taskDir, filename)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Strict prefix check
  const canonicalBase = path.resolve(base);
  if (!resolved.startsWith(canonicalBase + path.sep)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // ── File existence check ──────────────────────────────────────────────────
  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // ── Serve file ────────────────────────────────────────────────────────────
  try {
    const buf = fs.readFileSync(resolved);
    const mime = mimeFor(filename);
    const isImage = mime.startsWith('image/');

    return new NextResponse(buf, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(buf.length),
        'Content-Disposition': isImage ? 'inline' : `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=3600',
      },
    });
  } catch (err) {
    console.error(`[artifacts] Failed to read ${resolved}:`, err);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
