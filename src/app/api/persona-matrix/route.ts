import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * GET /api/persona-matrix
 *
 * Reads persona-matrix.md from the CEO workspace.
 * This is the master pre-qualified persona pool across all departments.
 */
export async function GET() {
  const homedir = process.env.HOME || process.env.USERPROFILE || '/root';
  const workspaceBase = process.env.WORKSPACE_BASE_PATH
    ? resolve(process.env.WORKSPACE_BASE_PATH.replace(/^~/, homedir))
    : join(homedir, 'clawd');

  const candidatePaths = [
    join(homedir, 'clawd', 'persona-matrix.md'),
    join(workspaceBase, 'persona-matrix.md'),
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
  } catch (error) {
    console.error('Failed to read persona-matrix.md:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to read persona-matrix.md' },
      { status: 500 }
    );
  }
}
