/**
 * C6 / AUD-16 — the ELIMINATE path: soft-archive declined workspaces.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * C1 (canonical_decline.py, merged v19.23.0) taught the system to CLASSIFY a
 * provenanced NO as "declined" rather than a "rejection". The web write path
 * (POST /api/interview/decision) records that provenanced NO correctly. But
 * NOTHING on the read side ever consumed the honored declined set — so a
 * department the owner explicitly said NO to kept its workspace row and kept
 * showing up as a live Kanban column. The board lied.
 *
 * `reseedWorkspacesFromConfig()` already honors an opt-out expressed in
 * departments.json (`isDepartmentOptedOut`). That is the PROVISION-time floor:
 * a dept never provisioned in the first place. It does NOT cover the case this
 * module exists for — a dept that WAS provisioned and is LATER declined. Its
 * row already exists, and a manifest that still lists it will happily re-upsert
 * it on every converge. The decline has to be honored against the DB, after the
 * reseed, by reading the honored declined set out of build-state.
 *
 * SOFT, NEVER HARD
 * ----------------
 * Archiving stamps `workspaces.archived_at` (+ `archived_reason`). Rows are
 * PRESERVED — never deleted. The board hides them; `?includeArchived=true`
 * still retrieves them. This is deliberate and it is the same posture the tasks
 * surface already takes (migration 058). A decline is a display decision, not a
 * data-destruction decision: the owner can flip NO → YES and the department's
 * history must survive the round trip. (It also means AUD-66 — disposal of the
 * declined department trees — needs no separate destructive path: soft-archive
 * IS the disposal.)
 *
 * IDEMPOTENT AND REVERSIBLE
 * -------------------------
 * `syncDeclinedWorkspaceArchive()` is a converge step, so it runs repeatedly.
 * It archives what is declined and it UN-archives what is no longer declined —
 * but the un-archive is scoped STRICTLY to rows this module archived
 * (`archived_reason = 'declined'`). An operator's manual archive carries a
 * different reason and is never clobbered by a converge.
 */

import fs from 'fs';
import type Database from 'better-sqlite3';
import { norm, readBuildState, computeDecisionCoverage } from '@/lib/interview/seam';
import { resolveDepartmentsConfigPath, isDepartmentOptedOut } from '@/lib/db/migrations';

/** `archived_reason` written by the decline path. Un-archive is scoped to this. */
export const DECLINED_REASON = 'declined';

export interface DeclineArchiveResult {
  /** Honored declined dept ids read out of build-state (raw, as recorded). */
  declined: string[];
  /** Workspace ids newly stamped archived_at on this run. */
  archived: string[];
  /** Workspace ids already archived-as-declined (no-op — proves idempotency). */
  alreadyArchived: string[];
  /** Workspace ids un-archived because the owner flipped NO → YES. */
  unarchived: string[];
  /** Declined ids with no matching workspace row (never provisioned — fine). */
  noWorkspace: string[];
}

/**
 * The honored declined set: dept ids carrying a fully-provenanced NO.
 *
 * Deliberately delegates to `computeDecisionCoverage(buildState, [])` — the SAME
 * function the interview gate and the seam-parity golden test use, which mirrors
 * canonical_decline.py's provenance tuple. Passing an EMPTY expected-set is
 * correct and intentional: `declined` is derived from the decisions map itself,
 * independent of the expected floor, so this needs no shell-out to
 * list-canonical-departments.py and cannot fail-open when that script is absent.
 * An un-provenanced "no" is a REJECTION, not a decline, and is never returned
 * here — so a bare-string decline can never archive a department.
 */
export function readHonoredDeclinedIds(): string[] {
  return computeDecisionCoverage(readBuildState(), []).declined;
}

/** True when the `workspaces.archived_at` column exists (migration 095 applied). */
export function hasWorkspaceArchiveColumn(db: Database.Database): boolean {
  const cols = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[];
  return cols.some((c) => c.name === 'archived_at');
}

/**
 * Soft-archive ONE workspace. Idempotent: re-archiving an already-archived row
 * does not restamp it (the original archived_at is the honest timestamp).
 * Returns true when this call is what archived it.
 */
export function archiveWorkspace(
  db: Database.Database,
  workspaceId: string,
  reason: string = DECLINED_REASON,
): boolean {
  const info = db
    .prepare(
      `UPDATE workspaces
          SET archived_at = COALESCE(archived_at, datetime('now')),
              archived_reason = COALESCE(archived_reason, ?),
              updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NULL`,
    )
    .run(reason, workspaceId);
  return info.changes > 0;
}

/** Reverse a soft-archive. Returns true when a row was actually un-archived. */
export function unarchiveWorkspace(db: Database.Database, workspaceId: string): boolean {
  const info = db
    .prepare(
      `UPDATE workspaces
          SET archived_at = NULL, archived_reason = NULL, updated_at = datetime('now')
        WHERE id = ? AND archived_at IS NOT NULL`,
    )
    .run(workspaceId);
  return info.changes > 0;
}

export function isWorkspaceArchived(db: Database.Database, workspaceId: string): boolean {
  const row = db
    .prepare('SELECT archived_at FROM workspaces WHERE id = ?')
    .get(workspaceId) as { archived_at: string | null } | undefined;
  return !!row?.archived_at;
}

/**
 * Resolve declined dept ids → workspace ids by NORMALIZED match on BOTH id and
 * slug. The decisions map is keyed by the canonical dept id, but a workspace row
 * may carry the id under `slug` (or a punctuation variant), so matching on the
 * raw string alone silently misses rows — and a missed row is a declined
 * department still on the board, which is the exact bug C6 exists to kill.
 */
function resolveWorkspaceIds(db: Database.Database, declinedIds: string[]): Map<string, string[]> {
  const rows = db.prepare('SELECT id, slug FROM workspaces').all() as {
    id: string;
    slug: string | null;
  }[];

  const byNorm = new Map<string, string[]>();
  for (const r of rows) {
    for (const key of [norm(r.id), norm(r.slug || '')]) {
      if (!key) continue;
      const list = byNorm.get(key) ?? [];
      if (!list.includes(r.id)) list.push(r.id);
      byNorm.set(key, list);
    }
  }

  const out = new Map<string, string[]>();
  for (const declined of declinedIds) {
    out.set(declined, byNorm.get(norm(declined)) ?? []);
  }
  return out;
}

/**
 * THE C6 CONVERGE STEP. Reads the honored declined set and reconciles the
 * archive state of every workspace against it, in ONE transaction.
 *
 * Runs AFTER reseedWorkspacesFromConfig() in the converge route — order matters:
 * the reseed re-upserts every dept still present in departments.json (including
 * declined ones, whose manifest entry may not carry an opt-out flag), so the
 * archive pass has to come second or the reseed would resurrect the column. The
 * reseed's UPSERT deliberately does not touch archived_at, so an archive survives
 * it and this pass is a cheap no-op on steady state.
 */
export function syncDeclinedWorkspaceArchive(
  db: Database.Database,
  declinedIds: string[] = readHonoredDeclinedIds(),
): DeclineArchiveResult {
  const result: DeclineArchiveResult = {
    declined: declinedIds,
    archived: [],
    alreadyArchived: [],
    unarchived: [],
    noWorkspace: [],
  };

  if (!hasWorkspaceArchiveColumn(db)) {
    // Pre-095 DB. Report honestly rather than pretending the archive happened.
    console.warn(
      '[C6] workspaces.archived_at absent (migration 095 not applied) — skipping decline archive.',
    );
    return result;
  }

  const resolved = resolveWorkspaceIds(db, declinedIds);
  const resolvedEntries = Array.from(resolved.entries());
  const declinedWorkspaceIds = new Set<string>();
  for (const [, ids] of resolvedEntries) for (const id of ids) declinedWorkspaceIds.add(id);

  const tx = db.transaction(() => {
    for (const [declined, wsIds] of resolvedEntries) {
      if (wsIds.length === 0) {
        result.noWorkspace.push(declined);
        continue;
      }
      for (const wsId of wsIds) {
        if (archiveWorkspace(db, wsId, DECLINED_REASON)) result.archived.push(wsId);
        else result.alreadyArchived.push(wsId);
      }
    }

    // Reversal: a dept archived AS DECLINED that is no longer in the honored
    // declined set means the owner flipped NO → YES. Scoped to archived_reason =
    // 'declined' so an operator's own archive is never silently undone.
    const declinedArchived = db
      .prepare(
        `SELECT id FROM workspaces
          WHERE archived_at IS NOT NULL AND archived_reason = ?`,
      )
      .all(DECLINED_REASON) as { id: string }[];

    for (const row of declinedArchived) {
      if (!declinedWorkspaceIds.has(row.id) && unarchiveWorkspace(db, row.id)) {
        result.unarchived.push(row.id);
      }
    }
  });
  tx();

  console.log(
    `[C6] decline archive — declined=${declinedIds.length} archived=${result.archived.length} ` +
      `already=${result.alreadyArchived.length} unarchived=${result.unarchived.length} ` +
      `no-workspace=${result.noWorkspace.length}`,
  );
  return result;
}

/* ───────────────────── converge parity assertion (chosen == provisioned == displayed) ──────────────── */

export interface ConvergeParity {
  ok: boolean;
  /** manifest depts MINUS opt-outs MINUS honored declines — what the owner chose. */
  chosen: string[];
  /** live (non-archived) workspace rows — what the box actually provisioned. */
  provisioned: string[];
  /** what the board query returns — what the owner actually SEES. */
  displayed: string[];
  /** chosen but not provisioned — a department the owner picked that has no lane. */
  missingFromProvisioned: string[];
  /** provisioned but not chosen — a lane for a department the owner did not pick. */
  unexpectedlyProvisioned: string[];
  /** provisioned but not displayed — a lane that exists but is invisible. */
  provisionedNotDisplayed: string[];
  /** displayed but not provisioned — a phantom column. */
  displayedNotProvisioned: string[];
}

/**
 * THE C6 ASSERTION: `chosen == provisioned == displayed`.
 *
 * Three sets that must be identical, compared on NORMALIZED ids:
 *
 *   chosen      the manifest, minus opt-outs, minus the honored declined set.
 *   provisioned workspace rows that are live (archived_at IS NULL).
 *   displayed   the rows the board query actually returns.
 *
 * This is what makes a decline PROVABLE rather than merely coded: if a declined
 * dept is still provisioned, `unexpectedlyProvisioned` is non-empty and ok=false.
 * The board can no longer disagree with the owner's answers in silence.
 *
 * `displayed` is passed in by the caller (the converge route hands it the board
 * query's own result) so the assertion tests THE REAL READ PATH rather than a
 * re-implementation of it that could drift from the route.
 */
export function assertConvergeParity(args: {
  chosen: string[];
  provisioned: string[];
  displayed: string[];
}): ConvergeParity {
  const setOf = (xs: string[]) => new Set(xs.map(norm).filter(Boolean));
  const chosenSet = setOf(args.chosen);
  const provSet = setOf(args.provisioned);
  const dispSet = setOf(args.displayed);

  const diff = (a: Set<string>, b: Set<string>, source: string[]) =>
    source.filter((x) => a.has(norm(x)) && !b.has(norm(x)));

  const missingFromProvisioned = diff(chosenSet, provSet, args.chosen);
  const unexpectedlyProvisioned = diff(provSet, chosenSet, args.provisioned);
  const provisionedNotDisplayed = diff(provSet, dispSet, args.provisioned);
  const displayedNotProvisioned = diff(dispSet, provSet, args.displayed);

  return {
    ok:
      missingFromProvisioned.length === 0 &&
      unexpectedlyProvisioned.length === 0 &&
      provisionedNotDisplayed.length === 0 &&
      displayedNotProvisioned.length === 0,
    chosen: args.chosen,
    provisioned: args.provisioned,
    displayed: args.displayed,
    missingFromProvisioned,
    unexpectedlyProvisioned,
    provisionedNotDisplayed,
    displayedNotProvisioned,
  };
}

/**
 * The `chosen` set: what the owner actually asked for.
 *
 *   departments.json  −  opt-outs (isDepartmentOptedOut)  −  honored declines
 *
 * Both subtractions are load-bearing and they are NOT the same thing:
 *   • an OPT-OUT is expressed in the manifest — the dept is never provisioned;
 *   • a DECLINE is expressed in build-state, usually AFTER provisioning — the row
 *     already exists and a manifest that still lists the dept will keep re-upserting
 *     it on every converge. Subtracting only opt-outs is exactly the hole C6 closes.
 *
 * Returns null when no departments.json can be resolved — the caller must then
 * SKIP the parity assertion rather than assert against an empty manifest (which
 * would report every live department as `unexpectedlyProvisioned`). Fail-quiet,
 * never fail-wrong.
 */
export function listChosenDepartmentIds(
  declinedIds: string[] = readHonoredDeclinedIds(),
): string[] | null {
  const configPath = resolveDepartmentsConfigPath();
  if (!configPath) return null;

  let depts: unknown;
  try {
    depts = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(depts) || depts.length === 0) return null;

  const declinedNorm = new Set(declinedIds.map(norm).filter(Boolean));

  const chosen: string[] = [];
  for (const dept of depts) {
    if (!dept || typeof dept !== 'object') continue;
    const d = dept as Record<string, unknown>;
    const id = String(d.id || d.slug || '');
    if (!id) continue;
    if (isDepartmentOptedOut(dept)) continue;
    if (declinedNorm.has(norm(id))) continue;
    chosen.push(id);
  }
  return chosen;
}

/** Live (non-archived) workspace ids — the `provisioned` set. */
export function listProvisionedWorkspaceIds(db: Database.Database): string[] {
  if (!hasWorkspaceArchiveColumn(db)) {
    return (db.prepare('SELECT id FROM workspaces ORDER BY id').all() as { id: string }[]).map(
      (r) => r.id,
    );
  }
  return (
    db
      .prepare('SELECT id FROM workspaces WHERE archived_at IS NULL ORDER BY id')
      .all() as { id: string }[]
  ).map((r) => r.id);
}
