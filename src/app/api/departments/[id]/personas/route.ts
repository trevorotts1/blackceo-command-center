import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * GET /api/departments/[id]/personas
 *
 * Reads governing-personas.md from the department workspace.
 * Searches for the file in this order:
 *   1. ~/clawd/departments/[dept-id]/governing-personas.md
 *   2. WORKSPACE_BASE_PATH/departments/[dept-id]/governing-personas.md
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

  const homedir = process.env.HOME || process.env.USERPROFILE || '/root';
  const workspaceBase = process.env.WORKSPACE_BASE_PATH
    ? resolve(process.env.WORKSPACE_BASE_PATH.replace(/^~/, homedir))
    : join(homedir, 'clawd');

  // Department folder uses -dept suffix
  const deptSlug = safeId.endsWith('-dept') ? safeId : `${safeId}-dept`;

  const candidatePaths = [
    join(homedir, 'clawd', 'departments', deptSlug, 'governing-personas.md'),
    join(workspaceBase, 'departments', deptSlug, 'governing-personas.md'),
    // Also check without -dept suffix for flexibility
    join(homedir, 'clawd', 'departments', safeId, 'governing-personas.md'),
    join(workspaceBase, 'departments', safeId, 'governing-personas.md'),
  ];

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
  } catch (error) {
    console.error('Failed to read governing-personas.md:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to read governing-personas.md' },
      { status: 500 }
    );
  }
}
