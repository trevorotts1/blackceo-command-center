/**
 * GET /api/interview/answers/export — the durable ANSWERS DOCUMENT, on demand.
 *
 * Returns the canonical interview transcript — the single Markdown document
 * that contains every QUESTION asked and every ANSWER the owner gave (with
 * Logged timestamps and provenance notes), exactly as Skill-23 wrote it to
 * <workspace>/company-discovery/workforce-interview-answers.md.
 *
 *   GET /api/interview/answers/export             → text/markdown (inline)
 *   GET /api/interview/answers/export?download=1  → Content-Disposition
 *        attachment; filename=workforce-interview-answers[-<company>].md
 *
 * DOCTRINE (do not violate):
 *   • FILES ARE THE SOURCE OF TRUTH. This route is a byte-faithful READ-ONLY
 *     projection of the canonical answers file, resolved through the P0-1
 *     seam (readAnswers → answersFilePath, honoring the build-state recorded
 *     path and both canonical/flat layouts). It performs NO writes, execs NO
 *     script, and never touches build-state — the WG-10c no-web-only-store
 *     rule stays intact because nothing is stored web-side at all.
 *   • It never fabricates: when no transcript exists yet, it 404s with a calm
 *     JSON body instead of emitting an empty/synthetic document.
 *
 * Because every answer is APPENDED to this file at the moment it is given
 * (web card → /api/interview/answer; Telegram → build-workforce.log_answer),
 * the export is complete at ANY point — mid-interview, after a pause, or
 * after completion — so the record of what the owner said is always
 * retrievable, not just at the end.
 */

import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import { readAnswers, readBuildState } from '@/lib/interview/seam';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Safe, header-friendly filename slug from the recorded company slug/name. */
function filenameSlug(state: ReturnType<typeof readBuildState>): string {
  const raw =
    (typeof state?.companySlug === 'string' && state.companySlug) ||
    (typeof state?.companyName === 'string' && state.companyName) ||
    '';
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug ? `workforce-interview-answers-${slug}.md` : 'workforce-interview-answers.md';
}

export async function GET(req: NextRequest) {
  try {
    const state = readBuildState();
    const info = readAnswers(state);

    if (!info.exists) {
      return NextResponse.json(
        {
          error: 'no_answers_yet',
          message:
            'No interview answers have been recorded yet — the document is created with the first answer.',
        },
        { status: 404 },
      );
    }

    // Byte-faithful read of the canonical file (no re-rendering, no reshaping).
    let body: string;
    try {
      body = fs.readFileSync(info.path, 'utf-8');
    } catch (err) {
      return NextResponse.json(
        {
          error: 'read_failed',
          message: 'The interview answers document exists but could not be read.',
          detail: err instanceof Error ? err.message : 'unknown error',
        },
        { status: 500 },
      );
    }

    const download = req.nextUrl.searchParams.get('download') === '1';
    const headers = new Headers({
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      // Structural facts callers can use without parsing the body.
      'x-interview-answer-count': String(info.qBlockCount),
    });
    if (download) {
      headers.set(
        'content-disposition',
        `attachment; filename="${filenameSlug(state)}"`,
      );
    }
    return new NextResponse(body, { status: 200, headers });
  } catch {
    // Fail-soft (read-only route): report a calm error, never a stack.
    return NextResponse.json(
      { error: 'export_failed', message: 'Could not export the interview answers document.' },
      { status: 500 },
    );
  }
}
