/**
 * POST /api/system/converge
 *
 * Idempotent workforce re-sync — re-seeds workspaces from departments.json,
 * ingests the on-disk role library + SOPs into the `sops` table, and surfaces
 * any personas that are missing domain/perspective tags.
 *
 * Called by:
 *   - The box-side converge script (sync-extensions.sh --converge) after an
 *     add-department / add-role / add-sop operation.
 *   - The dashboard "Rewire / Resync" button (operator-initiated CC-local re-seed).
 *
 * Auth: bearer MC_API_TOKEN (same gate as /api/system/bootstrap).
 *
 * Body (all optional):
 *   { "scope": "all" | "workspaces" | "sops" | "personas" }
 *   Default: "all"
 *
 * Response:
 *   { ok: true, ran_at, workspaces: { created, updated }, sops: { imported, updated }, untagged_personas: [...] }
 *
 * FAIL LOUD: returns 500 on any sub-step error — never silently reports ok:true
 * with a partial result.
 */

import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import os from 'os';
import { getDb, reseedWorkspacesFromConfig } from '@/lib/db';
// Direct module import (not re-exported via @/lib/db): resolve the departments/
// tree that pairs with the seeded departments.json so SOP import reads the SAME
// company the workspaces came from (Gap C ↔ Gap D lockstep, G12-FLOOR-CC-SEED).
import { resolveDepartmentsTreePath } from '@/lib/db/migrations';
import { importRoleLibrary } from '@/lib/role-library-import';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ── needs-tags.json reader ──────────────────────────────────────────────────
// Written by box-side converge (sync-extensions.sh --converge) at
//   <OC_ROOT>/extension-sync/needs-tags.json
// Schema: { "generated_at": "ISO-8601", "untagged": ["<slug>", ...] }

interface NeedsTagsFile {
  generated_at: string;
  untagged: string[];
}

function loadNeedsTags(): string[] {
  const home = process.env.HOME || os.homedir();
  const ocRoot = process.env.OPENCLAW_ROOT ||
    (existsSync('/data/.openclaw') ? '/data/.openclaw' : join(home, '.openclaw'));

  const candidates = [
    join(ocRoot, 'extension-sync', 'needs-tags.json'),
    // Also check workspace-relative path for dev installs
    join(process.cwd(), 'extension-sync', 'needs-tags.json'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as NeedsTagsFile;
        return Array.isArray(raw.untagged) ? raw.untagged : [];
      } catch {
        // Corrupt file — treat as empty
      }
    }
  }
  return [];
}

// ── Auth gate (mirrors bootstrap/route.ts:66–81) ───────────────────────────
function checkAuth(req: NextRequest): Response | null {
  const expectedToken = process.env.MC_API_TOKEN;
  if (!expectedToken) {
    // DATA-14: never return OPEN when the bearer token is unset. In production a
    // missing MC_API_TOKEN is a misconfiguration, not a dev convenience — so a
    // request that reaches this route with no token configured (e.g. middleware
    // bypassed) is hard-failed 503, never let through. Only non-production runs
    // open for local dev.
    if (process.env.NODE_ENV === 'production') {
      console.error('[/api/system/converge] MC_API_TOKEN not set in production — refusing (fail-closed 503).');
      return new Response(
        JSON.stringify({ error: 'This deployment is misconfigured: MC_API_TOKEN is not set. Contact the operator.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }
    console.warn('[/api/system/converge] MC_API_TOKEN not set, bearer auth disabled (local dev mode)');
    return null;
  }
  const authHeader = req.headers.get('authorization') || '';
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const token = authHeader.substring(7);
  if (token !== expectedToken) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}

// ── Route handler ───────────────────────────────────────────────────────────
export async function POST(req: NextRequest): Promise<Response> {
  const authError = checkAuth(req);
  if (authError) return authError;

  const ran_at = new Date().toISOString();

  let scope: 'all' | 'workspaces' | 'sops' | 'personas' = 'all';
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const rawScope = body?.scope;
    if (rawScope === 'workspaces' || rawScope === 'sops' || rawScope === 'personas') {
      scope = rawScope;
    }
  } catch {
    // Ignore body parse failure — default to "all"
  }

  const result: {
    ok: boolean;
    ran_at: string;
    scope: string;
    workspaces?: { created: number; updated: number };
    sops?: { imported: number; updated: number };
    untagged_personas?: string[];
  } = { ok: false, ran_at, scope };

  // ── Step 1: Re-seed workspaces ────────────────────────────────────────────
  if (scope === 'all' || scope === 'workspaces') {
    try {
      const db = getDb();
      const counts = reseedWorkspacesFromConfig(db, { force: true });
      result.workspaces = counts;
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          ran_at,
          scope,
          error: `workspaces reseed failed: ${(err as Error).message}`,
        },
        { status: 500 }
      );
    }
  }

  // ── Step 2: Ingest role-library / SOPs ────────────────────────────────────
  if (scope === 'all' || scope === 'sops') {
    try {
      // Prefer the departments/ tree that pairs with the resolved
      // departments.json; fall back (undefined) to the importer's own
      // OPENCLAW_WORKSPACE_PATH default when no ZHC company tree is present.
      const departmentsPath = resolveDepartmentsTreePath() ?? undefined;
      const sopResult = importRoleLibrary({ pruneMissing: false, departmentsPath });
      // ImportResult has inserted + updated + skipped. Map:
      //   inserted → imported (new rows created)
      //   updated  → updated  (existing rows refreshed)
      result.sops = {
        imported: sopResult.inserted,
        updated: sopResult.updated,
      };
    } catch (err) {
      return NextResponse.json(
        {
          ok: false,
          ran_at,
          scope,
          error: `role-library import failed: ${(err as Error).message}`,
        },
        { status: 500 }
      );
    }
  }

  // ── Step 3: Read needs-tags.json ─────────────────────────────────────────
  if (scope === 'all' || scope === 'personas') {
    result.untagged_personas = loadNeedsTags();
  }

  result.ok = true;
  return NextResponse.json(result);
}
