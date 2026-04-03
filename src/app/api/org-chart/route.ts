import { NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * GET /api/org-chart
 *
 * Reads ORG-CHART.md from the CEO workspace.
 * Returns the raw markdown content for display in the Command Center.
 */
export async function GET() {
  const homedir = process.env.HOME || process.env.USERPROFILE || '/root';
  const workspaceBase = process.env.WORKSPACE_BASE_PATH
    ? resolve(process.env.WORKSPACE_BASE_PATH.replace(/^~/, homedir))
    : join(homedir, 'clawd');

  const candidatePaths = [
    join(homedir, 'clawd', 'ORG-CHART.md'),
    join(workspaceBase, 'ORG-CHART.md'),
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
  } catch (error) {
    console.error('Failed to read ORG-CHART.md:', error);
    return NextResponse.json(
      { success: false, message: 'Failed to read ORG-CHART.md' },
      { status: 500 }
    );
  }
}
