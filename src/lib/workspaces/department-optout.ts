/**
 * department-optout.ts — U110 (E5-5, G2d — CC leg; ONB caller-wiring owed), the CC-side consumer of U108's
 * `provisioning/department-optout.json` contract.
 *
 * THE GAP THIS CLOSES
 * --------------------
 * U108 (`23-ai-workforce-blueprint/scripts/department-optout-sync.py`, openclaw-
 * onboarding) already computes and durably writes the ONE provenance-gated "the
 * owner explicitly opted this department OUT" set — a FLOOR department only
 * lands in it with `optedOut: true` when the owner saw and acknowledged the
 * functionality-loss warning (`lossWarningAck: true`); everything else lands in
 * `unconfirmed` and is never silently honored. But nothing on the Command Center
 * side ever read the file back — CHANGELOG.md's own U108 entry names this gap
 * explicitly: "CC board-column leg (U110) OWED."
 *
 * Left unread, a client whose real chosen set is smaller than the 28-department
 * floor — because they explicitly, provably opted departments out — still saw
 * those departments as live Kanban columns: GHOST COLUMNS the owner said no to.
 *
 * WHY THIS IS NOT THE SAME BUG U109 GUARDS AGAINST
 * --------------------------------------------------
 * U109 makes the ONB writer MERGE onto (never replace) the durable chosen-list,
 * and CC's own floor-invariant test proves `reseedWorkspacesFromConfig()` is
 * additive-only: a `departments.json` that shrinks for an AMBIGUOUS reason (a
 * partial write, a hand edit, a bad sync) must never wipe a previously
 * provisioned department — trusting bare manifest omission as intent would be
 * exactly the data-loss bug U109 closes.
 *
 * This module never acts on bare omission. It acts ONLY on an EXPLICIT,
 * provenance-gated opt-out record — the one channel U108 built for a client to
 * durably say "I chose fewer than the floor, on purpose." That is a
 * categorically stronger signal than "not currently listed in the manifest," so
 * this module and U109's invariant can both hold without contradiction: a
 * department is only ever hidden here because the owner explicitly, provably
 * declined it — never because it merely fell out of a manifest.
 *
 * ORCHESTRATOR COLUMN — ALWAYS EXEMPT; CATCH-ALL — DECLINABLE (operator ruling,
 * 2026-07-16, U110 send-back D1/openQuestionForOperator)
 * ------------------------------------------------------------------------------
 * QC surfaced a genuine spec conflict: ONB's `department-naming-map.json` lists
 * `general-task` under `mandatory` WITH an authored `loss_warning` written
 * specifically for the act of declining it — text that exists for exactly one
 * reason, to let an owner opt out of the catch-all with informed consent — while
 * this module's first revision hard-exempted it, unconditionally, from the
 * archive pass regardless of what the opt-out file said. The two sides
 * disagreed, and the disagreement was independently reachable: a build-state
 * decline of `general-task` made `syncDeclinedWorkspaceArchive` (which has no
 * exemption concept at all) archive it while `listChosenDepartmentIds` kept it
 * in `chosen` (the exemption overrode the decline there), so the converge parity
 * assertion saw `missingFromProvisioned=['general-task']` and hard-failed 500.
 *
 * RULING: the ONB reading wins. `general-task` IS declinable — the
 * loss-warning is the honest signal of intent — and every consumer of
 * `isDepartmentOptoutExempt()` (this file's own opt-out archive pass, and
 * `listChosenDepartmentIds`'s opt-out-file-side check) must agree on that.
 * `general-task` is therefore NOT in `DEPARTMENT_OPTOUT_EXEMPT_IDS` — an
 * opted-out or declined catch-all is archived exactly like any other
 * department.
 *
 * The `ceo` / `master-orchestrator` column is a DIFFERENT case: it does not
 * appear in ONB's naming map at all (no `loss_warning`, no floor status, no
 * modeled decline flow), so there is no upstream signal that it is ever meant
 * to be declinable. It remains permanently exempt from this archive pass,
 * regardless of what the opt-out file says — CC's own defense in depth, not
 * contingent on whatever ONB does or does not guarantee.
 *
 * U110 SEND-BACK D4-R2 — THE EXEMPTION BELONGS TO ONE INPUT SET, NOT THEIR
 * UNION: `isDepartmentOptoutExempt()` must be consulted ONLY by code paths
 * that mirror `syncDepartmentOptoutArchive` (this file's opt-out-file archive
 * pass, and `listChosenDepartmentIds`'s opt-out-file-side check). It must
 * NEVER be consulted by code paths that mirror `syncDeclinedWorkspaceArchive`
 * (a build-state decline) — that function has NO exemption concept at all, so
 * a declined `master-orchestrator` is archived unconditionally there, and
 * `listChosenDepartmentIds`'s declined-side check must exclude it just as
 * unconditionally or the two sides disagree and `assertConvergeParity`
 * hard-fails 500 (QC's proved A/B probe: the opt-out-file path stays
 * `parity.ok=true`; a build-state decline of the SAME id, pre-fix, produced
 * `parity.ok=false`). `listChosenDepartmentIds` (`archive.ts`) implements this
 * split with two independent, un-unioned checks — do not recombine them.
 */

import os from 'node:os';
import path from 'node:path';
import { safeReadFileUtf8, safeIsFile } from '@/lib/fs/safe-fs';

/** Board columns NEVER eligible for the opt-out archive pass, regardless of what
 * the opt-out file says. `general-task` is deliberately NOT here — see the
 * "ORCHESTRATOR COLUMN — ALWAYS EXEMPT; CATCH-ALL — DECLINABLE" note above. */
export const DEPARTMENT_OPTOUT_EXEMPT_IDS = ['ceo', 'master-orchestrator'] as const;

/** Same normalization as interview/seam.ts's `norm()` (byte-identical:
 * lowercase, strip everything that is not a-z0-9) — duplicated here rather
 * than imported so this module has no dependency on `@/lib/interview/seam`. */
function normalize(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

const EXEMPT_NORMALIZED = new Set(DEPARTMENT_OPTOUT_EXEMPT_IDS.map(normalize));

/**
 * True when `id` normalizes to a board column that must NEVER be archived by
 * the opt-out pass, regardless of what the opt-out file says — today that is
 * only the orchestrator column. Comparing on the NORMALIZED form (not a raw
 * Set.has on the hyphenated literal) matters: 'master-orchestrator' itself
 * normalizes to 'masterorchestrator' (hyphen stripped) — a raw string
 * comparison against the literal 'master-orchestrator' would never match a
 * caller that also normalizes its input, silently defeating the exemption.
 */
export function isDepartmentOptoutExempt(id: string): boolean {
  return EXEMPT_NORMALIZED.has(normalize(id));
}

/** `archived_reason` written by the opt-out archive pass. Un-archive is scoped
 * to this exact reason (see `archive.ts`) so a re-opt-in can never be clobbered
 * by, and can never clobber, the `'declined'` (build-state) or `'operator'`
 * (manual) archive paths. */
export const DEPARTMENT_OPTOUT_REASON = 'department-optout';

/**
 * Resolve `provisioning/department-optout.json` — the SAME per-box workspace
 * root `department-optout-sync.py` writes to by default (mirrors its own
 * `_resolve_workspace_dir()`: `/data/.openclaw/workspace` first, then
 * `~/.openclaw/workspace`), reusing the `OPENCLAW_WORKSPACE_PATH` env var CC
 * already honors for the identical root elsewhere (`role-library-import.ts`).
 *
 * This is a DIFFERENT directory tree than `departments.json`'s resolved
 * location (a `zero-human-company/<slug>/` folder or a Command Center config
 * root) — the two are not siblings on disk, so this gets its own resolver
 * rather than reusing `resolveDepartmentsConfigPath()`'s candidate list.
 */
export function resolveDepartmentOptoutPath(): string | null {
  const workspaceBase = (process.env.OPENCLAW_WORKSPACE_PATH || '/data/.openclaw/workspace').trim();
  const candidates = [
    path.join(workspaceBase, 'provisioning', 'department-optout.json'),
    path.join(os.homedir(), '.openclaw', 'workspace', 'provisioning', 'department-optout.json'),
  ];
  for (const p of candidates) {
    if (safeIsFile(p)) return p;
  }
  return null;
}

interface DepartmentOptoutRecord {
  optedOut?: boolean;
  [key: string]: unknown;
}

interface DepartmentOptoutFile {
  generatedAt?: string;
  source?: string | null;
  optedOut?: Record<string, DepartmentOptoutRecord>;
  unconfirmed?: Array<{ department: string; reason: string }>;
}

/**
 * The honored opted-out dept ids: every key of the file's `optedOut{}` object
 * whose record itself carries `optedOut: true` (belt-and-suspenders — the
 * writer only ever puts confirmed records there, but this reader never trusts
 * mere key presence over the record's own flag). `unconfirmed[]` entries are
 * NEVER included — an unconfirmed decision is, by U108's own design, not yet an
 * honored decline, and must never silently hide a department.
 *
 * Fail-quiet: a missing/unreadable/malformed file returns `[]` rather than
 * throwing — the same posture every other optional-artifact reader in this
 * codebase takes (`resolveDepartmentsConfigPath`, `readHonoredDeclinedIds`), so
 * a box that has never run `department-optout-sync.py` behaves exactly as it
 * did before this unit landed.
 */
export function readDepartmentOptoutIds(explicitPath?: string | null): string[] {
  const filePath = explicitPath ?? resolveDepartmentOptoutPath();
  if (!filePath) return [];
  const raw = safeReadFileUtf8(filePath);
  if (raw == null) return [];
  let parsed: DepartmentOptoutFile;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const optedOut = parsed?.optedOut;
  if (!optedOut || typeof optedOut !== 'object') return [];
  return Object.keys(optedOut).filter((id) => optedOut[id]?.optedOut === true);
}

/* ─────────────────────────────────────────────────────────────────────────────
 * AI Workforce standard-first (PHASE 6 item 9) — the RETIRE path's CC leg.
 *
 * `archiveDepartment(slug)` soft-archives ONE department's workspaces row —
 * the Command Center half of the confirmed-decline retire path
 * (retire-confirmed-decline.sh wraps the full four-step retirement: agent
 * deregistration, workspace-tree archive to company_dir/.retired/<slug>-<ts>/,
 * this CC row archive, and the chosen-artifact append).
 *
 * DOCTRINE (identical to the two archive passes above):
 *   • SOFT, NEVER HARD — stamps `workspaces.archived_at` (+ reason); rows are
 *     PRESERVED, never deleted (archive-only; APFS snapshot doctrine). The
 *     board hides the lane; the history survives a NO → YES flip.
 *   • IDEMPOTENT — re-archiving an already-archived row does not restamp it.
 *   • ORCHESTRATOR COLUMN EXEMPT — `ceo` / `master-orchestrator` is refused
 *     here exactly as in the opt-out pass (isDepartmentOptoutExempt). A retire
 *     caller that genuinely needs the orchestrator column gone must go through
 *     the decline pass, never this one.
 *   • NORMALIZED MATCH — the slug is matched the same way archive.ts resolves
 *     workspace ids (norm() over id AND slug), so a punctuation variant can
 *     never silently miss its lane.
 *   • NEVER acts on absence — only on an explicit slug handed in by a caller
 *     that has ALREADY provenanced the decline (the retire script gates on
 *     canonical_decline.py's reader).
 * ──────────────────────────────────────────────────────────────────────────── */

/** `archived_reason` written by the retire path. Distinct from 'declined'
 *  (build-state decline pass) and 'department-optout' (opt-out pass) so each
 *  pass's un-archive stays scoped to its own rows. */
export const DEPARTMENT_RETIRED_REASON = 'retired';

/** Result of a single retire-path archive. */
export interface ArchiveDepartmentResult {
  /** True when at least one workspace row exists for the slug. */
  found: boolean;
  /** Workspace ids newly stamped archived_at by this call. */
  archived: string[];
  /** Workspace ids already archived (no-op — idempotency proof). */
  alreadyArchived: string[];
  /** True when the call was refused (exempt orchestrator column / empty slug). */
  refused: boolean;
  /** Why a call was refused (null when it ran). */
  reason: string | null;
}

/**
 * Soft-archive the department named by `slug` (the retire path's CC leg).
 * Requires the DB handle + archive-column availability as arguments (same
 * shape as archive.ts's primitives) so the retire script's CC call site can
 * drive it inside its own transaction. Idempotent; never deletes; refuses the
 * exempt orchestrator column. The caller owns the provenance gate — this
 * primitive archives exactly what a provenanced retire tells it to.
 */
export function archiveDepartment(
  db: import('better-sqlite3').Database,
  slug: string,
  opts: { reason?: string; hasArchiveColumn?: boolean } = {},
): ArchiveDepartmentResult {
  const result: ArchiveDepartmentResult = {
    found: false,
    archived: [],
    alreadyArchived: [],
    refused: false,
    reason: null,
  };

  const key = normalize(slug);
  if (!key) {
    result.refused = true;
    result.reason = 'empty slug — nothing to archive';
    return result;
  }
  if (isDepartmentOptoutExempt(slug)) {
    result.refused = true;
    result.reason =
      'the orchestrator column (ceo / master-orchestrator) is exempt from the retire archive pass';
    return result;
  }

  const hasColumn =
    opts.hasArchiveColumn ??
    (
      db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]
    ).some((c) => c.name === 'archived_at');
  if (!hasColumn) {
    result.refused = true;
    result.reason = 'workspaces.archived_at absent (migration 095 not applied)';
    return result;
  }

  // Normalized match on BOTH id and slug (archive.ts resolveWorkspaceIds rule).
  const rows = db.prepare('SELECT id, slug FROM workspaces').all() as {
    id: string;
    slug: string | null;
  }[];
  const wsIds: string[] = [];
  for (const r of rows) {
    if (normalize(r.id) === key || normalize(r.slug || '') === key) {
      if (!wsIds.includes(r.id)) wsIds.push(r.id);
    }
  }
  if (wsIds.length === 0) return result; // found=false — never provisioned; fine.
  result.found = true;

  const reason = opts.reason || DEPARTMENT_RETIRED_REASON;
  for (const wsId of wsIds) {
    const info = db
      .prepare(
        `UPDATE workspaces
            SET archived_at = COALESCE(archived_at, datetime('now')),
                archived_reason = COALESCE(archived_reason, ?),
                updated_at = datetime('now')
          WHERE id = ? AND archived_at IS NULL`,
      )
      .run(reason, wsId);
    if (info.changes > 0) result.archived.push(wsId);
    else result.alreadyArchived.push(wsId);
  }
  return result;
}
