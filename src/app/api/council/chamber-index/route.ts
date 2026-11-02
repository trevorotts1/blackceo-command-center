import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * CTR-191: serve the canonical chamber document with the CC adapter's one
 * additive script. The canonical bundle on disk (public/chamber/index.html)
 * is never edited — this handler injects the tag at serve time only.
 *
 * `/council` is rewritten here AFTER middleware, so every tenant/interview
 * gate still runs first. A direct hit on this adapter path serves the same
 * bytes that are already public at /chamber/index.html; it exposes nothing
 * new.
 */
let injected: string | null = null;

async function canonicalIndex(): Promise<string> {
  if (injected !== null) return injected;
  const file = path.join(process.cwd(), 'public', 'chamber', 'index.html');
  const html = await readFile(file, 'utf8');
  const tag = '<script src="/chamber-cc-intent.js" defer></script>';
  injected = html.includes('</body>') ? html.replace('</body>', `${tag}\n</body>`) : `${html}\n${tag}`;
  return injected;
}

export async function GET() {
  try {
    const html = await canonicalIndex();
    return new NextResponse(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      {
        code: 'COUNCIL_CHAMBER_INDEX_UNAVAILABLE',
        detail: 'The canonical chamber document is not present in this installation.',
        recovery: 'Restore public/chamber/index.html from the canonical bundle, then reload.',
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
