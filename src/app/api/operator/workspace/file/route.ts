/**
 * GET /api/operator/workspace/file?agent=<slug>&path=<relPath>
 *
 * Track B3 (Operator Console Workspace sub-module).
 *
 * Returns the content of a single file under an agent's scratch root.
 * Behavior:
 *   - Text-like kinds (markdown, code, plain text, html, svg) return JSON
 *     with content, kind, ext, bytes, mtime, truncated.
 *   - Binary kinds (image, video, audio, pdf, generic binary) stream the
 *     raw bytes back with a best-effort Content-Type. This lets img, video,
 *     audio, and iframe tags render the file directly.
 *
 * Security: paths are resolved through aggregator.resolveSafe(), which
 * rejects "..", absolute paths, and NUL bytes. The agent slug is checked
 * against the OPERATOR_AGENTS whitelist.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import {
  OPERATOR_AGENTS,
  parseAgentSlug,
  readAgentFile,
  resolveSafe,
} from '@/lib/workspaces/aggregator';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
};

function mimeFor(ext: string): string {
  return MIME[ext.toLowerCase()] || 'application/octet-stream';
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agentParam = url.searchParams.get('agent');
  const relPath = url.searchParams.get('path');

  const agent = parseAgentSlug(agentParam);
  if (!agent) {
    return NextResponse.json(
      { error: 'invalid_agent', valid: OPERATOR_AGENTS },
      { status: 400 }
    );
  }
  if (!relPath) {
    return NextResponse.json({ error: 'missing_path' }, { status: 400 });
  }

  const abs = resolveSafe(agent, relPath);
  if (!abs) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let st;
  try {
    st = statSync(abs);
  } catch {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (!st.isFile()) {
    return NextResponse.json({ error: 'not_a_file' }, { status: 400 });
  }

  const ext = path.extname(abs).toLowerCase();
  const isBinary =
    /^\.(png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v|mkv|mp3|wav|ogg|m4a|aac|flac|pdf)$/i.test(
      ext
    );

  // For binary content, stream raw bytes so img/video/audio/iframe tags can hit
  // this same endpoint with src="/api/operator/workspace/file?...".
  if (isBinary) {
    const range = req.headers.get('range');
    if (range && /^bytes=\d*-\d*/i.test(range)) {
      // Honor HTTP Range requests so video scrub works on big files.
      const match = /^bytes=(\d*)-(\d*)/i.exec(range);
      const startStr = match?.[1];
      const endStr = match?.[2];
      const total = st.size;
      let start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : total - 1;
      if (Number.isNaN(start) || start < 0) start = 0;
      if (Number.isNaN(end) || end >= total) end = total - 1;
      if (start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }
      const chunk = end - start + 1;
      const stream = createReadStream(abs, { start, end });
      return new Response(stream as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Type': mimeFor(ext),
          'Content-Length': String(chunk),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        },
      });
    }
    const stream = createReadStream(abs);
    return new Response(stream as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Type': mimeFor(ext),
        'Content-Length': String(st.size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    });
  }

  // Text-like JSON response.
  const result = await readAgentFile(agent, relPath);
  if (!result.ok) {
    const status = result.reason === 'not_found' ? 404 : result.reason === 'forbidden' ? 403 : 400;
    return NextResponse.json({ error: result.reason }, { status });
  }
  return NextResponse.json({
    agent,
    path: result.relPath,
    kind: result.kind,
    ext: result.ext,
    bytes: result.bytes,
    mtime: result.mtime,
    truncated: result.truncated,
    content: result.content,
  });
}
