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
 *     untagged_personas: [...], warnings?: [...],
 *     deploy: { rebuild_required_after_code_change, command, note } }
 *
 *   `warnings` (C8) is present only when a NON-fatal residue finding exists — today
 *   that is a test/fixture `companies` row, which is not a client-facing surface.
 *   Client-facing residue (workspaces / active SOP departments) is FATAL (500), not
 *   a warning. See Step 2.5 for the full severity rationale.
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
import { resolveDepartmentsTreePath, detectTestResidue } from '@/lib/db/migrations';
import { importRoleLibrary } from '@/lib/role-library-import';
import { resolveActiveCompanyId } from '@/lib/company';
// C6 / AUD-16 — the eliminate path + its parity assertion.
import {
  readHonoredDeclinedIds,
  syncDeclinedWorkspaceArchive,
  readDepartmentOptoutIds,
  syncDepartmentOptoutArchive,
  listChosenDepartmentIds,
  listProvisionedWorkspaceIds,
  assertConvergeParity,
  type ConvergeParity,
} from '@/lib/workspaces/archive';
import { listDisplayedWorkspaceIds } from '@/lib/workspaces/board-query';

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
    // C6: what the honored declined set did to the board on this run.
    declined_workspaces?: {
      declined: string[];
      archived: string[];
      already_archived: string[];
      unarchived: string[];
      no_workspace: string[];
    };
    // U110 (E5-5, G2d): what the U108 provenance-gated opt-out file did to the
    // board on this run — the ghost/orphan-column close for a below-floor set.
    department_optout?: {
      opted_out: string[];
      archived: string[];
      already_archived: string[];
      unarchived: string[];
      no_workspace: string[];
    };
    // C6: the chosen == provisioned == displayed proof.
    converge_parity?: ConvergeParity;
    sops?: { imported: number; updated: number; active_total?: number };
    untagged_personas?: string[];
    /** C8 — non-fatal residue findings (currently: test/fixture company rows). */
    warnings?: string[];
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

      // ── Step 1b (C6 / AUD-16): honor the declined set — the ELIMINATE path ──
      //
      // MUST run AFTER the reseed. The reseed re-upserts every dept still listed in
      // departments.json — including declined ones, whose manifest entry usually
      // carries NO opt-out flag (the decline lives in build-state, not the manifest).
      // So the archive pass has to come second, or the reseed would resurrect the
      // column it just removed. The reseed's UPSERT deliberately never touches
      // archived_at, so an archive survives it and this is a no-op at steady state.
      //
      // The declined set read here is the HONORED one — provenanced NOs only, via
      // the same computeDecisionCoverage() the interview gate uses (mirroring
      // canonical_decline.py). A bare-string / un-provenanced "no" is a REJECTION,
      // never a decline, and can never archive a department.
      const declined = readHonoredDeclinedIds();
      const archive = syncDeclinedWorkspaceArchive(db, declined);
      result.declined_workspaces = {
        declined: archive.declined,
        archived: archive.archived,
        already_archived: archive.alreadyArchived,
        unarchived: archive.unarchived,
        no_workspace: archive.noWorkspace,
      };

      // ── Step 1b-2 (U110 / E5-5, G2d — CC leg; ONB caller-wiring owed): honor the U108 provenance-gated
      // opt-out file — THE BOARD-WIRING FIX for a below-floor department set.
      //
      // A SEPARATE durable record from build-state's honored declines above:
      // department-optout.json is written by department-optout-sync.py (U108)
      // only for a FULLY provenanced, functionality-loss-warning-acknowledged
      // decision. Reading it here (and archiving what it names) is what makes a
      // below-floor chosen set actually render as exactly that set on the board
      // — no ghost columns for a department the owner explicitly opted out of.
      // MUST also run AFTER the reseed for the same resurrection reason as 1b,
      // and BEFORE the chosen/parity computation below so `chosen` (which now
      // subtracts this same set) and `provisioned`/`displayed` agree.
      const optedOut = readDepartmentOptoutIds();
      const optoutArchive = syncDepartmentOptoutArchive(db, optedOut);
      result.department_optout = {
        opted_out: optoutArchive.declined,
        archived: optoutArchive.archived,
        already_archived: optoutArchive.alreadyArchived,
        unarchived: optoutArchive.unarchived,
        no_workspace: optoutArchive.noWorkspace,
      };

      // ── Step 1c (C6): the converge ASSERTION — chosen == provisioned == displayed.
      //
      // This is what makes the decline PROVABLE instead of merely coded. If a
      // declined department still holds a lane, `unexpectedly_provisioned` is
      // non-empty and we FAIL LOUD (500) rather than return ok:true over a board
      // that disagrees with the owner's own answers. `displayed` comes from the
      // BOARD'S OWN query (shared boardWhereClause), so the assertion cannot pass
      // against a re-implementation that has drifted from what users actually see.
      const chosen = listChosenDepartmentIds(declined, optedOut);
      if (chosen !== null) {
        const parity = assertConvergeParity({
          chosen,
          provisioned: listProvisionedWorkspaceIds(db),
          displayed: listDisplayedWorkspaceIds(db, resolveActiveCompanyId(db)),
        });
        result.converge_parity = parity;

        if (!parity.ok) {
          return NextResponse.json(
            {
              ok: false,
              ran_at,
              scope,
              error:
                'CONVERGE PARITY FAILED — chosen != provisioned != displayed. The board does ' +
                'not match the owner\'s decisions. ' +
                `chosen=${parity.chosen.length} provisioned=${parity.provisioned.length} ` +
                `displayed=${parity.displayed.length}; ` +
                `missing_from_provisioned=[${parity.missingFromProvisioned.join(', ')}] ` +
                `unexpectedly_provisioned=[${parity.unexpectedlyProvisioned.join(', ')}] ` +
                `provisioned_not_displayed=[${parity.provisionedNotDisplayed.join(', ')}] ` +
                `displayed_not_provisioned=[${parity.displayedNotProvisioned.join(', ')}]`,
              converge_parity: parity,
              declined_workspaces: result.declined_workspaces,
              department_optout: result.department_optout,
            },
            { status: 500 },
          );
        }
      } else {
        // No resolvable departments.json — assert nothing rather than assert wrong
        // (an empty manifest would flag every live department as unexpected).
        console.warn('[C6] No departments.json resolved — skipping converge parity assertion.');
      }
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

  // ── Step 2.5: C8 test/fixture residue assertion ──────────────────────────
  // FAIL LOUD (mirrors the C2 empty-SOP-library assertion above) when a
  // WORKSPACE or an active SOP DEPARTMENT still looks test/fixture-shaped after
  // reseed/ingest — the un-isolated QC-harness leak this guards against must
  // never quietly ride onto a client's board/API. Detection is pattern OR
  // exact-allowlist (see lib/test-residue.ts) so a NEW leak shape is caught even
  // before anyone allowlists it, AND a known-but-token-less slug like
  // `no-script-dept` can't slip through a pattern-only check.
  //
  // SEVERITY SPLIT — companies are a WARNING, not a 500. Deliberate:
  //
  //   • A `workspaces` row IS a client-facing surface (it renders as a Kanban
  //     lane) and an active `sops.department` IS one (it renders in the SOP
  //     library). Residue there is a real client-visible leak → FATAL. Both are
  //     remediable: migrations 091/093 hard-delete them by exact slug, and the
  //     C8 ingest guards stop converge from re-creating them from a stale
  //     departments.json / a leftover departments/<slug>/ directory. So a 500
  //     here is a condition the operator can actually clear.
  //
  //   • A `companies` row is an ingest-ROOT record — no client page or API
  //     response renders companies.slug. And it is NOT always removable:
  //     purgeTestResidueCompanies (migration 094) correctly REFUSES to delete a
  //     company any workspace still references (workspaces.company_id is a real
  //     FK), so an operator can be left holding a flagged row with no supported
  //     way to clear it. Hard-failing converge — the mechanism the box's own
  //     exit test depends on — on non-client-facing state with no guaranteed
  //     remediation is a brick, not a gate. It surfaces loudly in `warnings`
  //     (and in the server log) on an otherwise-successful 200 instead.
  //
  // This is the exact defect that made the previous revision unmergeable:
  // companies were converge-FATAL while nothing anywhere deleted the `testco`
  // row, and the 500's own remediation text pointed at migrations 091/093 —
  // neither of which touches `companies`. Merging that would have permanently
  // 500'd POST /api/system/converge on the default scope=all path.
  const warnings: string[] = [];
  if (scope === 'all' || scope === 'workspaces' || scope === 'sops') {
    const db = getDb();
    const residue = detectTestResidue(db);

    const fatalHits = residue.workspaces.length + residue.sopDepartments.length;
    if (fatalHits > 0) {
      return NextResponse.json(
        {
          ok: false,
          ran_at,
          scope,
          error:
            'converge detected test/fixture-shaped residue on a CLIENT-FACING surface, which must ' +
            `never ride onto a client board/API — workspaces=[${residue.workspaces.join(', ')}] ` +
            `sopDepartments=[${residue.sopDepartments.join(', ')}]. ` +
            'Remediation: reboot the box so the deferred C8 cleanup migrations run ' +
            '(091 rekeyAndPurgeGhostSops, 093 purgeTestResidueWorkspaces — both are ' +
            'deferInAdditiveSelfHeal, so they land on a controlled boot, NOT on a request-time ' +
            'self-heal). If a workspace is reported as SKIPPED by 093, it holds a task whose title ' +
            'is not test-shaped: review that task by hand (it is never auto-deleted — a hard-delete ' +
            'path errs toward keeping data). If a hit is a legitimate client department that merely ' +
            'matches the detection pattern, confirm it manually; it is never auto-deleted.',
        },
        { status: 500 }
      );
    }

    if (residue.companies.length > 0) {
      const warning =
        `test/fixture-shaped company row(s) present: [${residue.companies.join(', ')}]. ` +
        'Not client-facing (no page or API renders companies.slug), so this does NOT fail the converge. ' +
        'Reboot to run migration 094 (purgeTestResidueCompanies), which deletes them by exact slug — ' +
        'unless a workspace still references the row, in which case 094 refuses (FK safety) and the ' +
        'row needs manual review.';
      console.warn(`[/api/system/converge] ${warning}`);
      warnings.push(warning);
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

  // C8 — surface non-fatal residue findings on the successful response rather
  // than swallowing them. Omitted entirely when clean, so a green converge stays
  // noise-free.
  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  result.ok = true;
  return NextResponse.json(result);
}
