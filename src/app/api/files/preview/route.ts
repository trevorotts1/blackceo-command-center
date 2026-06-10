/**
 * File Preview API
 *
 * Serves local files for in-browser preview.
 * Supports:
 *   - HTML/HTM files (existing behaviour)
 *   - Image files: PNG, JPG, GIF, WEBP, BMP, AVIF, TIFF — served with correct
 *     Content-Type so the browser can render them inline (duck-fix).
 *
 * Security: path must resolve under WORKSPACE_BASE_PATH or PROJECTS_PATH.
 * Path-traversal is blocked via path.normalize + startsWith check.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync, statSync, realpathSync } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** MIME map for preview-supported extensions. */
const PREVIEW_MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm':  'text/html',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.bmp':  'image/bmp',
  '.avif': 'image/avif',
  '.tiff': 'image/tiff',
  '.tif':  'image/tiff',
  '.svg':  'image/svg+xml',
};

export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get('path');

  if (!filePath) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }

  // Expand tilde and normalize
  const expandedPath = filePath.replace(/^~/, process.env.HOME || '');
  const normalizedPath = path.normalize(expandedPath);

  const ext = path.extname(normalizedPath).toLowerCase();
  const mimeType = PREVIEW_MIME[ext];

  if (!mimeType) {
    return NextResponse.json(
      { error: `Unsupported file type for preview: ${ext}. Supported: ${Object.keys(PREVIEW_MIME).join(', ')}` },
      { status: 400 }
    );
  }

  // Security: resolve canonical path and verify it stays inside an allowed base.
  const allowedBases = [
    process.env.WORKSPACE_BASE_PATH?.replace(/^~/, process.env.HOME || ''),
    process.env.PROJECTS_PATH?.replace(/^~/, process.env.HOME || ''),
  ].filter(Boolean) as string[];

  // Default fallback so preview works even when env vars are unset (~/projects).
  if (allowedBases.length === 0) {
    allowedBases.push(path.join(process.env.HOME || '', 'projects'));
  }

  if (!existsSync(normalizedPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  let resolvedPath: string;
  try {
    resolvedPath = realpathSync(normalizedPath);
  } catch {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const isAllowed = allowedBases.some((base) => {
    try {
      const resolvedBase = realpathSync(path.normalize(base));
      return resolvedPath.startsWith(resolvedBase + path.sep) || resolvedPath === resolvedBase;
    } catch {
      return resolvedPath.startsWith(path.normalize(base) + path.sep);
    }
  });

  if (!isAllowed) {
    console.warn(`[FILE PREVIEW] Blocked path outside allowed bases: ${resolvedPath}`);
    return NextResponse.json({ error: 'Path not allowed' }, { status: 403 });
  }

  try {
    const stats = statSync(resolvedPath);
    if (!stats.isFile()) {
      return NextResponse.json({ error: 'Path is a directory' }, { status: 400 });
    }

    const isText = mimeType.startsWith('text/') || mimeType === 'image/svg+xml';

    if (isText) {
      const content = readFileSync(resolvedPath, 'utf-8');
      return new NextResponse(content, {
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(stats.size),
          'Content-Disposition': 'inline',
        },
      });
    }

    // Binary (images): read as Buffer and pass as Uint8Array (compatible with BodyInit).
    const binaryContent = readFileSync(resolvedPath);
    return new NextResponse(new Uint8Array(binaryContent), {
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(stats.size),
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    console.error('[FILE PREVIEW] Error reading file:', error);
    return NextResponse.json({ error: 'Failed to read file' }, { status: 500 });
  }
}
