/**
 * GET /api/operator/workspace/list
 *
 * Track B3 (Operator Console Workspace sub-module, PRD Section 4.4).
 *
 * Two modes:
 *   - With no `agent` query param: returns a directory of every agent's
 *     scratch root plus per-agent counts. Used by the "By Agent" landing
 *     view to render the agent picker.
 *   - With `?agent=<slug>`: returns the file listing for one agent's
 *     scratch root (newest first, capped at 500).
 *
 * The response intentionally omits `absPath` from the file rows so we
 * never leak server-side filesystem paths to the browser.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  OPERATOR_AGENTS,
  parseAgentSlug,
  walkAgentScratch,
  walkAllAgents,
  type WorkspaceFile,
} from '@/lib/workspaces/aggregator';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function stripAbs(file: WorkspaceFile) {
  const { absPath: _abs, ...rest } = file;
  return rest;
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const agentParam = url.searchParams.get('agent');

  try {
    if (agentParam) {
      const agent = parseAgentSlug(agentParam);
      if (!agent) {
        return NextResponse.json(
          { error: 'invalid_agent', valid: OPERATOR_AGENTS },
          { status: 400 }
        );
      }
      const scratch = await walkAgentScratch(agent);
      return NextResponse.json({
        agent: scratch.agent,
        root: scratch.root,
        exists: scratch.exists,
        fileCount: scratch.fileCount,
        files: scratch.files.map(stripAbs),
      });
    }

    const all = await walkAllAgents();
    return NextResponse.json({
      agents: all.map((s) => ({
        agent: s.agent,
        root: s.root,
        exists: s.exists,
        fileCount: s.fileCount,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'list_failed', detail: err instanceof Error ? err.message : 'unknown' },
      { status: 500 }
    );
  }
}
