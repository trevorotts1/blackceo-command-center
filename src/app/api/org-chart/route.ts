import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { zhcLibraryBaseDirs } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/org-chart
 *
 * Reads ORG-CHART.md from the client's Zero-Human-Company library.
 * Skill 23 (build-workforce.py) writes it to the per-company root since
 * v9.6.0 (`<root>/zero-human-company/<slug>/ORG-CHART.md`); pre-v9.6.0 builds
 * wrote a top-level `<root>/ORG-CHART.md`. zhcLibraryBaseDirs() yields both,
 * canonical-first, and is platform-aware (Mac `~/clawd` vs VPS
 * `/data/.openclaw/workspace`), so a built workforce resolves on either box.
 *
 * Returns the raw markdown content for display in the Command Center.
 */
export async function GET() {
  const candidatePaths = zhcLibraryBaseDirs().map((base) => join(base, 'ORG-CHART.md'));

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
      message: 'No ORG-CHART.md found. It will be generated after running Skill 23 (AI Workforce Blueprint).',
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
      { success: false, message: 'Failed to read ORG-CHART.md' },
      { status: 500 }
    );
  }
}
