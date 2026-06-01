import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { zhcLibraryBaseDirs } from '@/lib/platform';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/departments/[id]/personas
 *
 * Reads governing-personas.md for a department from the client's Zero-Human-
 * Company library. Skill 23 (build-workforce.py) writes it to
 * `<root>/zero-human-company/<slug>/departments/<dept-id>/governing-personas.md`
 * since v9.6.0 (pre-v9.6.0 used the flat `<root>/departments/<dept-id>/`).
 *
 * The dashboard's department id can arrive in several shapes, so we probe each:
 *   - bare canonical id (Skill 23's folder name, e.g. `customer-support`)
 *   - `dept-`-prefixed id (the shape stored in departments.json / workspaces)
 *   - legacy `<id>-dept` suffixed folder
 * crossed with every ZHC base dir (canonical-first, platform-aware).
 *
 * Returns the raw markdown content and a parsed summary of persona names.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!id || typeof id !== 'string') {
    return NextResponse.json(
      { success: false, message: 'Missing department id' },
      { status: 400 }
    );
  }

  // Sanitize dept id to prevent path traversal
  const safeId = id.replace(/[^a-z0-9-]/gi, '');
  if (safeId !== id) {
    return NextResponse.json(
      { success: false, message: 'Invalid department id' },
      { status: 400 }
    );
  }

  // Normalize to the set of folder names Skill 23 / the dashboard might use.
  // Skill 23's folder name is the BARE canonical id (no `dept-` prefix, no
  // `-dept` suffix). departments.json stores `dept-<id>`; the workspaces table
  // stores the bare id (the sync script strips `dept-`). We also keep the
  // legacy `<id>-dept` folder shape for very old installs.
  const bare = safeId.replace(/^dept-/, '').replace(/-dept$/, '');
  const folderNames = Array.from(
    new Set([bare, `dept-${bare}`, `${bare}-dept`, safeId])
  );

  const candidatePaths: string[] = [];
  for (const base of zhcLibraryBaseDirs()) {
    for (const folder of folderNames) {
      candidatePaths.push(join(base, 'departments', folder, 'governing-personas.md'));
    }
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
      department: id,
      personas: [],
      raw: null,
      message: 'No governing-personas.md found. Personas will be available after running Skill 23 (AI Workforce Blueprint).',
    });
  }

  try {
    const raw = await readFile(filePath, 'utf-8');

    // Parse persona names from the markdown
    // Expected format: lines like "- **Seth Godin** - Purple Cow" or "## Seth Godin"
    const personaNames: string[] = [];
    const lines = raw.split('\n');
    for (const line of lines) {
      // Match "- **Name**" or "## Name" patterns
      const boldMatch = line.match(/^[-*]\s+\*\*([^*]+)\*\*/);
      const headerMatch = line.match(/^#{2,3}\s+(.+)/);
      if (boldMatch) {
        personaNames.push(boldMatch[1].trim());
      } else if (headerMatch && !headerMatch[1].toLowerCase().includes('governing') && !headerMatch[1].toLowerCase().includes('persona')) {
        personaNames.push(headerMatch[1].trim());
      }
    }

    return NextResponse.json({
      success: true,
      department: id,
      personas: personaNames,
      raw,
      source: filePath,
    });
  } catch {
    return NextResponse.json(
      { success: false, message: 'Failed to read governing-personas.md' },
      { status: 500 }
    );
  }
}
