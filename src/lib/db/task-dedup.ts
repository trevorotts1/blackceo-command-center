/**
 * task-dedup.ts — board-health de-duplication primitives (FM-6).
 *
 * Two independent furnaces flooded the board on a real client box:
 *   (b) the SOP-authoring fast-loop re-created an IDENTICAL open "Author SOP: X"
 *       sub-task on every ~2-minute dispatch sweep (300+ stuck `in_progress`), and
 *   — duplicate WORKSPACE rows for what is semantically ONE department (e.g.
 *       `ceo` + `master-orchestrator`, `app-development` + `engineering`) split a
 *       single department across two Kanban columns and two agent rosters.
 *
 * This module holds the pure, import-light SQL primitives that heal both. It is
 * imported BOTH by the migration runner (one-time heal of already-broken boards)
 * AND by runtime code (the SOP-authoring idempotency guard), so it must stay
 * free of heavy/node-only imports — only `better-sqlite3` (a type) and the pure
 * `canonical-slug` module. It NEVER throws to its callers on a row-level problem;
 * a failed sub-step is logged and the function returns what it healed.
 *
 * Direction note (department dedup): the keeper's slug is ALWAYS the output of
 * `canonicalDeptSlug()` — the repo's single source of truth used at every
 * routing / SOP-match join point. That is why the merge collapses TOWARD the
 * canonical slug (`ceo` → `master-orchestrator`, `app-development` → `engineering`
 * per the 2026-06-28 UNIT-ENG promotion) rather than the reverse: a workspace row
 * whose slug disagreed with `canonicalDeptSlug()` is exactly the row routing can
 * never find, so the canonical value is the only safe keeper.
 */

import type { Database } from 'better-sqlite3';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

// ── Open-task predicate ──────────────────────────────────────────────────────
// "Open" = not in a terminal/closed state and not archived. Used by the reaper.
const OPEN_TASK_PREDICATE = `status != 'done' AND (archived_at IS NULL OR archived_at = '')`;

// ── Live-dispatch states (DATA-04 / DATA-05) ─────────────────────────────────
// A task in one of these has (or is about to have) an ACTIVE specialist session:
// the runtime session key is derived from the task's workspace/agent. Neither
// destructive heal below may delete such a row (reaper) or re-home its workspace
// (workspace merge) — doing so strands an in-flight run. Kept as a JS list for
// the reaper's in-memory filter; the workspace merge uses the same literals in
// its SQL COUNT (SQLite has no clean bound-array IN).
const LIVE_DISPATCH_STATES = ['in_progress', 'assigned'];

/** Returns the list of tables (excluding `workspaces` itself) that carry a
 *  `workspace_id` column, discovered at run-time so the dedup reassigns EVERY
 *  referencing table (FK and non-FK alike) before a loser row is deleted. */
function tablesWithWorkspaceId(db: Database): string[] {
  const out: string[] = [];
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    if (name === 'workspaces') continue;
    try {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
      if (cols.some((c) => c.name === 'workspace_id')) out.push(name);
    } catch {
      /* table vanished mid-iteration — skip */
    }
  }
  return out;
}

export interface WorkspaceDedupResult {
  groups_merged: number;
  rows_deleted: number;
  rows_reassigned: number;
  merges: { canonical: string; keeper: string; losers: string[] }[];
}

/**
 * Collapse duplicate workspace rows that canonicalize to the SAME department.
 *
 * For each group of >1 workspace sharing a `canonicalDeptSlug(slug)`:
 *   1. Pick a keeper — prefer the row whose slug is ALREADY the canonical slug;
 *      else the row with the most agents+tasks; else the lowest rowid (oldest).
 *   2. Reassign every `workspace_id`-bearing table from each loser → keeper.
 *   3. Delete the loser workspace rows.
 *   4. Promote the keeper's slug to the canonical value (no-op when it already is).
 *
 * Idempotent: a board with no duplicates is left untouched (returns zeros).
 * Never throws on a row-level failure — logs and continues.
 */
export function dedupeCanonicalWorkspaces(db: Database): WorkspaceDedupResult {
  const result: WorkspaceDedupResult = {
    groups_merged: 0,
    rows_deleted: 0,
    rows_reassigned: 0,
    merges: [],
  };

  let rows: { id: string; slug: string; sort_order: number | null; rowid: number }[];
  try {
    rows = db
      .prepare('SELECT rowid, id, slug, sort_order FROM workspaces')
      .all() as { id: string; slug: string; sort_order: number | null; rowid: number }[];
  } catch (err) {
    console.warn('[task-dedup] workspace read failed (non-fatal):', (err as Error).message);
    return result;
  }

  // Group rows by their canonical slug.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const canon = canonicalDeptSlug(row.slug) || row.slug.toLowerCase();
    const bucket = groups.get(canon);
    if (bucket) bucket.push(row);
    else groups.set(canon, [row]);
  }

  const wsTables = tablesWithWorkspaceId(db);

  for (const [canon, members] of Array.from(groups.entries())) {
    if (members.length < 2) continue;

    // Score each candidate keeper: agents + tasks attached (more = keep).
    const scored = members.map((m) => {
      let weight = 0;
      try {
        const a = db.prepare('SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ?').get(m.id) as { n: number };
        const t = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ?').get(m.id) as { n: number };
        weight = (a?.n ?? 0) + (t?.n ?? 0);
      } catch {
        /* counting is best-effort */
      }
      return { ...m, weight, isCanonical: m.slug.toLowerCase() === canon };
    });

    // Keeper preference: canonical slug first, then most attached rows, then oldest rowid.
    scored.sort((a, b) => {
      if (a.isCanonical !== b.isCanonical) return a.isCanonical ? -1 : 1;
      if (a.weight !== b.weight) return b.weight - a.weight;
      return a.rowid - b.rowid;
    });

    const keeper = scored[0];
    const losers = scored.slice(1);

    // DATA-05: never collapse a workspace that still has live work. Reassigning
    // a loser's workspace_id mid-dispatch can strand an in-flight specialist
    // session (the runtime session key is derived from the workspace/agent). If
    // ANY loser in this group owns an in_progress/assigned task, SKIP the whole
    // merge and log — the board keeps the (rare) duplicate column until a quiet
    // boot re-attempts, which is strictly safer than breaking a running task.
    // (Uses the same literals as LIVE_DISPATCH_STATES; kept inline for a static
    //  SQL IN-list.)
    const liveLoser = losers.find((l) => {
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n FROM tasks
              WHERE workspace_id = ? AND status IN ('in_progress', 'assigned')`,
          )
          .get(l.id) as { n: number };
        return (row?.n ?? 0) > 0;
      } catch {
        // Read failure is non-fatal; err on the side of NOT merging.
        return true;
      }
    });
    if (liveLoser) {
      console.warn(
        `[task-dedup] SKIP merge for canonical "${canon}": loser workspace "${liveLoser.id}" ` +
          'has live in_progress/assigned task(s) — deferring to a quiet boot',
      );
      continue;
    }

    try {
      const tx = db.transaction(() => {
        for (const loser of losers) {
          for (const table of wsTables) {
            const info = db
              .prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id = ?`)
              .run(keeper.id, loser.id);
            result.rows_reassigned += info.changes;
          }
          db.prepare('DELETE FROM workspaces WHERE id = ?').run(loser.id);
          result.rows_deleted += 1;
        }
        // Promote keeper slug to the canonical value (losers are already gone,
        // so the UNIQUE(slug) constraint can no longer collide within this group).
        if (keeper.slug.toLowerCase() !== canon) {
          db.prepare('UPDATE workspaces SET slug = ? WHERE id = ?').run(canon, keeper.id);
        }
      });
      tx();
      result.groups_merged += 1;
      result.merges.push({ canonical: canon, keeper: keeper.id, losers: losers.map((l) => l.id) });
      console.log(
        `[task-dedup] merged ${losers.length} duplicate workspace row(s) into "${keeper.id}" (canonical "${canon}")`,
      );
    } catch (err) {
      console.warn(`[task-dedup] merge for canonical "${canon}" failed (non-fatal):`, (err as Error).message);
    }
  }

  return result;
}

/**
 * Is there already a workspace whose slug canonicalizes to the same department
 * as `slug`? Returns the existing workspace id (the canonical row) or null.
 *
 * The slug-uniqueness guard at every seeding path calls this BEFORE inserting a
 * new workspace, so a second slug that canonicalizes to an existing department
 * (e.g. inserting `ceo` when `master-orchestrator` already exists) is recognised
 * as the same department instead of creating a duplicate Kanban column.
 */
export function findCanonicalWorkspaceId(db: Database, slug: string): string | null {
  // Null-guard the input: a departments.json entry that is a bare string or an
  // object missing both slug and id resolves to `undefined` here. Without this
  // guard `slug.toLowerCase()` throws ("Cannot read properties of undefined"),
  // and because the auto-seed loop calls this per department, ONE malformed
  // entry aborted the WHOLE seed — leaving the board with zero/partial
  // departments. Treat an unusable slug as "no canonical match".
  if (!slug || typeof slug !== 'string') return null;
  const canon = canonicalDeptSlug(slug) || slug.toLowerCase();
  let rows: { id: string; slug: string }[];
  try {
    rows = db.prepare('SELECT id, slug FROM workspaces').all() as { id: string; slug: string }[];
  } catch {
    return null;
  }
  for (const row of rows) {
    if ((canonicalDeptSlug(row.slug) || row.slug.toLowerCase()) === canon) return row.id;
  }
  return null;
}

// ── FK-safe task delete ───────────────────────────────────────────────────────
// Many tables reference tasks(id) via a `task_id` column — some ON DELETE CASCADE,
// some with NO action (events, openclaw_sessions, and a couple migration-created
// tables) which would otherwise BLOCK the delete. We discover EVERY `task_id`-
// bearing table at run-time and clear its rows, preserving `conversations` (a real
// entity) by unlinking rather than deleting it. Then the task row is removed.
function deleteTaskFkSafe(db: Database, taskId: string): void {
  // Conversations are real shared entities — unlink, never delete (matches the
  // DELETE /api/tasks/[id] route's intent).
  try {
    db.prepare('UPDATE conversations SET task_id = NULL WHERE task_id = ?').run(taskId);
  } catch {
    /* table may be absent on an older DB */
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    if (name === 'tasks' || name === 'conversations') continue;
    try {
      const cols = db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
      if (cols.some((c) => c.name === 'task_id')) {
        db.prepare(`DELETE FROM ${name} WHERE task_id = ?`).run(taskId);
      }
    } catch {
      /* table vanished / unreadable — best-effort */
    }
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
}

export interface AuthoringReapResult {
  groups: number;
  deleted: number;
}

/**
 * Reap duplicate OPEN "Author SOP: …" sub-tasks (FM-6b furnace heal).
 *
 * The SOP-authoring fast loop re-created an identical authoring sub-task on every
 * dispatch sweep, so a single un-authored task could accrue hundreds of stuck
 * `in_progress` "Author SOP: X" clones. This reaper groups OPEN authoring tasks
 * by (title, department, original-task link), KEEPS the oldest of each group, and
 * FK-safely deletes the rest. Tightly scoped to the `Author SOP:%` signature so
 * it can never touch a real client deliverable.
 *
 * Idempotent: a board with at most one authoring task per group is untouched.
 * Returns the number of groups collapsed and rows deleted.
 */
export function reapDuplicateOpenAuthoringTasks(db: Database): AuthoringReapResult {
  const out: AuthoringReapResult = { groups: 0, deleted: 0 };

  let dupeGroups: { title: string; department: string | null; link: string | null; n: number }[];
  try {
    dupeGroups = db
      .prepare(
        `SELECT title,
                department,
                sop_authoring_for_task_id AS link,
                COUNT(*) AS n
           FROM tasks
          WHERE title LIKE 'Author SOP:%'
            AND ${OPEN_TASK_PREDICATE}
          GROUP BY title, COALESCE(department, ''), COALESCE(sop_authoring_for_task_id, '')
         HAVING COUNT(*) > 1`,
      )
      .all() as { title: string; department: string | null; link: string | null; n: number }[];
  } catch (err) {
    console.warn('[task-dedup] authoring-reap scan failed (non-fatal):', (err as Error).message);
    return out;
  }

  for (const group of dupeGroups) {
    try {
      const members = db
        .prepare(
          `SELECT id, status FROM tasks
            WHERE title = ?
              AND COALESCE(department, '') = COALESCE(?, '')
              AND COALESCE(sop_authoring_for_task_id, '') = COALESCE(?, '')
              AND ${OPEN_TASK_PREDICATE}
            ORDER BY created_at ASC, rowid ASC`,
        )
        .all(group.title, group.department, group.link) as { id: string; status: string }[];
      if (members.length < 2) continue;

      // DATA-04: NEVER reap a task with a live dispatch. Prefer KEEPING a live
      // row as the group keeper (oldest live first), else the oldest open row.
      // Then delete only the NON-live clones — a second live row is left intact
      // rather than killed, so the reaper can never strand an in-flight run.
      const liveMembers = members.filter((m) => LIVE_DISPATCH_STATES.includes(m.status));
      const keeper = liveMembers[0] ?? members[0];
      const losers = members.filter(
        (m) => m.id !== keeper.id && !LIVE_DISPATCH_STATES.includes(m.status),
      );
      if (losers.length === 0) continue;

      const tx = db.transaction(() => {
        for (const loser of losers) {
          deleteTaskFkSafe(db, loser.id);
          out.deleted += 1;
        }
      });
      tx();
      out.groups += 1;
    } catch (err) {
      console.warn(
        `[task-dedup] authoring-reap for "${group.title}" failed (non-fatal):`,
        (err as Error).message,
      );
    }
  }

  if (out.deleted > 0) {
    console.log(`[task-dedup] reaped ${out.deleted} duplicate "Author SOP" task(s) across ${out.groups} group(s)`);
  }
  return out;
}
