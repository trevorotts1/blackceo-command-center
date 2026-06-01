import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { zhcLibraryBaseDirs } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/persona-matrix
 *
 * Reads persona-matrix.md — the master pre-qualified persona pool across all
 * departments. Skill 23 (build-workforce.py) writes it under the per-company
 * `departments/` subfolder (`<root>/zero-human-company/<slug>/departments/
 * persona-matrix.md`); some builds/legacy layouts placed it at the company
 * root or the flat workspace root. zhcLibraryBaseDirs() yields the right
 * bases canonical-first and platform-aware (Mac `~/clawd` vs VPS
 * `/data/.openclaw/workspace`); we probe `departments/persona-matrix.md` and
 * `persona-matrix.md` under each.
 */
export async function GET() {
  const candidatePaths: string[] = [];
  for (const base of zhcLibraryBaseDirs()) {
    candidatePaths.push(join(base, 'departments', 'persona-matrix.md'));
    candidatePaths.push(join(base, 'persona-matrix.md'));
  }

  let filePath: string | null = null;
  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }

  if (!filePath) {
    return NextResponse.json({
      success: true,
      raw: null,
      message: 'No persona-matrix.md found. It will be generated after running Skill 23 (AI Workforce Blueprint).',
    });
  }

  try {
    const raw = await readFile(filePath, 'utf-8');
    return NextResponse.json({
      success: true,
      raw,
      source: filePath,
    });
  } catch {
    return NextResponse.json(
      { success: false, message: 'Failed to read persona-matrix.md' },
      { status: 500 }
    );
  }
}
