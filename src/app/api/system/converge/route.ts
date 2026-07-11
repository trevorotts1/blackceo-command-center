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
 *   { ok: true, ran_at, workspaces: { created, updated }, sops: { imported, updated },
 *     untagged_personas: [...], deploy: { rebuild_required_after_code_change, command, note } }
 *
 * FAIL LOUD: returns 500 on any sub-step error — never silently reports ok:true
 * with a partial result.
 *
 * REBUILD CONTRACT (BUILD-01):
 *   This route re-seeds DB ROWS ONLY (workspaces / SOPs / persona tags). Database
 *   rows are runtime data read per-request — they need NO recompile, and this
 *   route deliberately does NOT rebuild or restart (a Next.js request handler
 *   cannot safely shell out to rebuild + restart its OWN serving process).
 *
 *   BUT a converge is usually the LAST step of an onboarding "add department /
 *   add role / sync extensions" flow that also pulled NEW CODE (e.g. a new
 *   department's pages/components). That new code must be recompiled and swapped
 *   in, or the box keeps serving the STALE build and the new department shows a
 *   dead Kanban. That rebuild is the SHELL converge path's responsibility:
 *   after this route returns, the caller (openclaw-onboarding sync-extensions.sh
 *   Step 4) MUST run `scripts/atomic-deploy.sh` (atomic build + fresh-BUILD_ID
 *   gate + swap + health-gated rollback) to guarantee a fresh build. The
 *   response's `deploy` block below carries that directive machine-readably so a
 *   shell caller can act on it. The CC-side updater (update.sh) and the
 *   deprecated deploy.sh shim already route through atomic-deploy.sh.
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
    sops?: { imported: number; updated: number; active_total?: number };
    untagged_personas?: string[];
    deploy?: {
      rebuild_required_after_code_change: boolean;
      command: string;
      note: string;
    };
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

      // C2 — ASSERT scope=sops actually produced an SOP library. The live failure
      // this guards: the on-disk role library was never wired into the installer,
      // so importRoleLibrary reads 0 rows and the `sops` table stays empty/stale
      // while converge still returns ok:true — a "ghost library" that silently
      // blocks the Triad Rule on every task. Fail LOUD (500) when a scope=sops
      // converge leaves zero active SOP rows, so the ingest wiring gets fixed
      // instead of shipping a dead board. (Deprecated + test-dept rows carry
      // deleted_at and are excluded, matching every downstream `deleted_at IS
      // NULL` reader.)
      const db = getDb();
      const activeSopCount =
        (db.prepare('SELECT COUNT(*) AS c FROM sops WHERE deleted_at IS NULL').get() as
          | { c: number }
          | undefined)?.c ?? 0;
      if (activeSopCount === 0) {
        return NextResponse.json(
          {
            ok: false,
            ran_at,
            scope,
            error:
              'converge scope=sops produced an EMPTY SOP library (0 active rows). ' +
              'The on-disk role library was not ingested into `sops` — the Triad Rule ' +
              'will block every task. Verify the ingest wiring (Phase 6c ingest-sop-library.sh) ' +
              'and re-run converge scope=sops.',
          },
          { status: 500 }
        );
      }

      // ImportResult has inserted + updated + skipped. Map:
      //   inserted → imported (new rows created)
      //   updated  → updated  (existing rows refreshed)
      result.sops = {
        imported: sopResult.inserted,
        updated: sopResult.updated,
        active_total: activeSopCount,
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

  // BUILD-01 rebuild contract: a converge only reseeds DB rows and never
  // recompiles. Emit a machine-readable directive so the SHELL converge caller
  // (onboarding sync-extensions.sh Step 4) rebuilds via atomic-deploy.sh when
  // this converge followed a code/extension sync — otherwise new department UI
  // serves stale (dead-Kanban class).
  result.deploy = {
    rebuild_required_after_code_change: true,
    command: 'bash scripts/atomic-deploy.sh --pm2-app blackceo-command-center',
    note:
      'DB reseed only — no recompile happened. If this converge followed a code/extension ' +
      'sync (e.g. new department pages/components), run atomic-deploy.sh to build + swap + ' +
      'restart, or the new code serves stale (dead Kanban).',
  };

  result.ok = true;
  return NextResponse.json(result);
}
