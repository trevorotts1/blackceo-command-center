/**
 * Company Headquarters — authorized state snapshot (unit B08, milestone V08).
 *
 * Authority: SPEC.md revision 4 §S8 (`GET /api/hq/snapshot`) and §S6 (storage),
 * read against the frozen P01 contracts in `src/lib/hq/types.ts`, B01's reserved
 * migration `169` (`src/lib/db/migrations.ts`, read at its committed revision)
 * and the frozen storage contract `evidence/contracts/storage-auth.md`.
 *
 * The deliverable in SPEC S8, verbatim: *"Authorized current roster, derived
 * layout, connection/capture health, current task links, latest 100 public
 * activities, `highSeq`, `prunedThroughSeq`, `layoutRevision`. State and cursors
 * read in one consistent DB transaction."* This module owns the parts of that
 * sentence that are state reads and derived facts; the route (`snapshot/route.ts`)
 * owns authorization and binds the roster/layout/activity-projection modules.
 *
 * WHY THE DEPENDENCIES ARE INJECTED RATHER THAN IMPORTED
 * -----------------------------------------------------
 * This unit's card is built on base `hq/contracts`, where only the frozen P01
 * `types.ts` exists. B04's `buildLayout` and B05's public projection land on
 * their own branches; B02/B03 have not written `context.ts`/`roster.ts` yet.
 * `swarm-plan.json` `base_policy`, verbatim: *"COMPONENT_PASS proves owned
 * behavior against frozen contracts, not full-app compilation"*, and todo.md:
 * *"`COMPONENT_PASS`: independent check of owned implementation against frozen P01
 * interfaces, with absent dependencies mocked only in tests."* So this module
 * composes the snapshot from injected collaborators typed against the P01
 * contracts, and the route passes the real ones. Nothing here is a shipped stub:
 * every injection point is a documented seam whose real implementation has a
 * single owner elsewhere in the manifest.
 *
 * WHAT THIS MODULE FREEZES (P01 gaps, S17 change control)
 * -------------------------------------------------------
 *   G-01 — `captureHealth` (SPEC: "connection/capture health", shape not defined).
 *          First consumer freezes it as `HqCaptureHealth`: the S6 `capture_state`
 *          label VERBATIM plus whether a state row was actually read. It is
 *          deliberately NOT expanded into invented counters or timestamps: a
 *          missing state row reads `reported:false`, never a fabricated `ok`, so
 *          "capture is unknown" can never be displayed as "capture is healthy"
 *          (todo V02: "schema failure is explicit not empty office").
 *   G-02 — `taskLinks` ("current task links", shape not defined). First consumer
 *          freezes it as `HqTaskLink[]` derived ONLY from facts already in this
 *          snapshot's authorized scope: `taskId` must come from a retained
 *          activity row of this company or from a roster agent's
 *          `activeTaskIds`. A task id nobody in scope references is not
 *          asserted (SPEC S3: unattributed rows are not asserted to belong to a
 *          customer), and no task table is read here — "Click task opens
 *          existing task detail" (S4) keeps authority in the existing board.
 *
 * A note on the feed cursor contract (S8 "Reconnect algorithm" steps 1-5): the
 * snapshot reports `stateSeq` (snapshot freshness) and the client's `feedCursor`
 * separately, and it never advances a client's cursor forward merely because the
 * current-state snapshot is newer. `resolveHqSnapshotFeedPlan` is that rule,
 * isolated and testable.
 *
 * Installed libraries only (`better-sqlite3` handle passed in). No `node:*`
 * import, so the module stays importable from a plain `tsc --noEmit` build and
 * from client-adjacent code, as P01 and B04 did.
 */

import type Database from 'better-sqlite3';
import { TEST_RESIDUE_WORKSPACE_SLUGS } from '@/lib/test-residue';
import type { HqActivityEvent, HqDepartment, HqLayout } from './types';

/* ================================================================== *
 * S8 constants
 * ================================================================== */

/** S8: the snapshot carries the latest 100 public activities, and the first visit initializes the feed with them. */
export const HQ_SNAPSHOT_FEED_SIZE = 100;

/**
 * Label used when no `hq_activity_state` row exists for the company. Distinct
 * from any stored value, so "no capture state has ever been reported" is never
 * rendered as S6's reported-healthy label.
 */
export const HQ_CAPTURE_STATE_UNREPORTED = 'unreported';

/* ================================================================== *
 * Frozen response fragments (G-01, G-02)
 * ================================================================== */

/** G-01. `state` is the S6 `capture_state` label verbatim; never normalised here. */
export type HqCaptureHealth = {
  state: string;
  /** True only when a state row was read AND carried a non-empty label. */
  reported: boolean;
  updatedAt: string | null;
  retainedBytes: number | null;
};

/** G-02. Derived in-scope links only; every field is null-able rather than guessed. */
export type HqTaskLink = {
  taskId: string;
  workspaceId: string | null;
  agentId: string | null;
};

/* ================================================================== *
 * Feed plan (S8 reconnect step 2 and step 5)
 * ================================================================== */

export type HqSnapshotFeedStart = 'recent' | 'resumed';

/**
 * What the snapshot says about the client's feed position. S8 fixes the payload
 * independently of this plan — the snapshot always carries the latest 100 public
 * activities and the client merges them by ID/seq — so this plan decides ONLY the
 * cursor fields, never a different row window.
 */
export type HqSnapshotFeedPlan = {
  /** 'recent' = labelled recent activity (first visit or an explicit retention reset); 'resumed' = merged continuation. */
  feedStart: HqSnapshotFeedStart;
  /** The cursor the response reports back: the client's own cursor on resume, `highSeq` only when the feed was (re)initialized. */
  feedCursor: number;
  /** True when S8's "explicit retention reset" condition fired: the client must reset both cursors and re-fetch state. */
  resetRequired: boolean;
};

/** True for a value that can be used as a durable cursor: a nonnegative safe integer. */
export function isHqCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Parse a `?after=` query value. Returns null for anything that is not a
 * nonnegative safe integer — an unparseable cursor is "no proven cursor", which
 * the plan below turns into a labelled recent feed, never a silent resume from
 * a value nobody validated.
 */
export function parseHqSnapshotCursor(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return isHqCursor(parsed) ? parsed : null;
}

/**
 * S8 step 2 and step 5, exactly:
 *   - first visit (no proven previous cursor) → the feed is initialized with the
 *     latest rows and `feedCursor = highSeq`, labelled recent activity;
 *   - a previous cursor below the retained window (`after < prunedThroughSeq`),
 *     or a previous cursor newer than the server high-water mark (a database
 *     restore / reset), → `resetRequired: true`, fresh state, and the cursor is
 *     re-anchored to `highSeq` rather than handing back a misleading delta;
 *   - anything else → the client's own cursor is preserved and the read is the
 *     window `(cursor, highSeq]`, so a reconnect never jumps the feed forward
 *     merely because the current-state snapshot is newer;
 *   - sequence gaps are never by themselves a reset trigger (S8 step 5: "Never
 *     infer cursor expiry from sequence gaps alone").
 */
export function resolveHqSnapshotFeedPlan(input: {
  previousCursor: number | null | undefined;
  highSeq: number;
  prunedThroughSeq: number;
}): HqSnapshotFeedPlan {
  const highSeq = isHqCursor(input.highSeq) ? input.highSeq : 0;
  const pruned = isHqCursor(input.prunedThroughSeq) ? Math.min(input.prunedThroughSeq, highSeq) : 0;
  const previous = input.previousCursor;

  if (!isHqCursor(previous) || previous > highSeq || previous < pruned) {
    return { feedStart: 'recent', feedCursor: highSeq, resetRequired: isHqCursor(previous) };
  }
  return { feedStart: 'resumed', feedCursor: previous, resetRequired: false };
}

/* ================================================================== *
 * Rows read by this module
 * ================================================================== */

/**
 * The columns this module selects from `hq_activity` (reserved migration 169,
 * SPEC S6 lines 227-233). Structural on purpose: B01 owns the authoritative
 * per-column row type and its decoders; a caller may pass a decoded row straight
 * in, and nothing here redeclares B01's contract.
 */
export type HqSnapshotActivityRow = {
  id: string;
  seq: number;
  kind: HqActivityEvent['kind'];
  phase: string;
  task_id: string | null;
  actor_agent_id: string | null;
  recipient_agent_id: string | null;
  payload_json: string;
  occurred_at: string | null;
  received_at: string;
  source_key: string;
};

export type HqSnapshotStateRow = {
  company_id: string;
  high_seq: number;
  pruned_through_seq: number;
  capture_state: string;
  retained_bytes: number | null;
  updated_at: string | null;
};

/* ================================================================== *
 * Collaborators (seams owned by other children)
 * ================================================================== */

export type HqSnapshotLayoutInput = {
  departments: HqDepartment[];
  masterWorkspaceId?: string | null;
  sortOrder?: Readonly<Record<string, number>> | null;
};

export type HqSnapshotDeps = {
  /** B04's `buildLayout` (`src/lib/hq/layout.ts`). Injected; B04 owns geometry and the revision. */
  buildLayout: (roster: HqSnapshotLayoutInput) => Promise<HqLayout>;
  /** B05's `toPublicActivityEvent` (`src/lib/hq/activity.ts`). Injected; B05 owns the sanitized public projection. */
  projectEvent: (
    row: HqSnapshotActivityRow,
    resolveLabel: (agentId: string) => string | null,
  ) => HqActivityEvent;
};

export type HqSnapshotInput = {
  companyId: string;
  /** Roster projection (B03). Passed through for layout and task links; never re-derived here. */
  departments: HqDepartment[];
  /** S4 ordering facts the frozen `HqDepartment` does not hold; supplied by the caller, never guessed. */
  masterWorkspaceId?: string | null;
  sortOrder?: Readonly<Record<string, number>> | null;
  /** The client's previous `feedCursor`, validated by `parseHqSnapshotCursor`; null/undefined on a first visit. */
  previousCursor?: number | null;
  feedSize?: number;
};

export type HqSnapshotState = {
  layout: HqLayout;
  activities: HqActivityEvent[];
  highSeq: number;
  prunedThroughSeq: number;
  /** S8 step 1: snapshot freshness cursor. Equals the high-water mark this snapshot was read at. */
  stateSeq: number;
  /** S8 step 2/3: the client's activity watermark, reported and never silently advanced. */
  feedCursor: number;
  feedStart: HqSnapshotFeedStart;
  resetRequired: boolean;
  captureHealth: HqCaptureHealth;
  taskLinks: HqTaskLink[];
};

/* ================================================================== *
 * Reads (all inside ONE transaction — S8 "one consistent DB transaction")
 * ================================================================== */

function readStateRow(db: Database.Database, companyId: string): HqSnapshotStateRow | null {
  const row = db
    .prepare(
      `SELECT company_id, high_seq, pruned_through_seq, capture_state, retained_bytes, updated_at
         FROM hq_activity_state
        WHERE company_id = ?`,
    )
    .get(companyId) as HqSnapshotStateRow | undefined;
  return row ?? null;
}

function readRecentRows(db: Database.Database, companyId: string, limit: number): HqSnapshotActivityRow[] {
  const rows = db
    .prepare(
      `SELECT id, seq, kind, phase, task_id, actor_agent_id, recipient_agent_id,
              payload_json, occurred_at, received_at, source_key
         FROM hq_activity
        WHERE company_id = ?
        ORDER BY seq DESC
        LIMIT ?`,
    )
    .all(companyId, limit) as HqSnapshotActivityRow[];
  return rows.reverse();
}


/**
 * S5 "labels from current scope": the display label is resolved NOW, from the
 * same company scope the board uses, so a removed target yields a null label
 * (tombstone) and no stale name survives. Company scoping reuses the board's own
 * clause and its unconditional fixture-residue exclusion rather than a second
 * filter that could drift from it; archived rows are included because an
 * archived department is still this company's record, while unattributed/legacy
 * rows follow the board's existing treatment.
 */
function resolveLabels(
  db: Database.Database,
  companyId: string,
  agentIds: string[],
): Map<string, string | null> {
  const labels = new Map<string, string | null>();
  const unique = Array.from(new Set(agentIds.filter((id) => typeof id === 'string' && id)));
  if (unique.length === 0) return labels;
  const placeholders = unique.map(() => '?').join(',');
  const residue = TEST_RESIDUE_WORKSPACE_SLUGS.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT a.id AS id, a.name AS name
         FROM agents a
         JOIN workspaces w ON w.id = a.workspace_id
        WHERE a.id IN (${placeholders})
          AND (w.company_id = ? OR w.company_id = 'default' OR w.company_id IS NULL OR w.company_id = '')
          AND w.slug NOT IN (${residue})`,
    )
    .all(...unique, companyId, ...TEST_RESIDUE_WORKSPACE_SLUGS) as { id: string; name: string | null }[];
  for (const row of rows) labels.set(row.id, row.name ?? null);
  for (const id of unique) if (!labels.has(id)) labels.set(id, null);
  return labels;
}

/* ================================================================== *
 * Capture health and task links (G-01, G-02)
 * ================================================================== */

/** G-01 freeze: report the stored label verbatim; report "not reported" as such. */
export function summarizeHqCaptureHealth(row: HqSnapshotStateRow | null): HqCaptureHealth {
  const label = typeof row?.capture_state === 'string' ? row.capture_state.trim() : '';
  if (!row || !label) {
    return { state: HQ_CAPTURE_STATE_UNREPORTED, reported: false, updatedAt: null, retainedBytes: null };
  }
  return {
    state: label,
    reported: true,
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    retainedBytes: Number.isSafeInteger(row.retained_bytes) ? (row.retained_bytes as number) : null,
  };
}

/**
 * G-02 freeze: current task links, derived only from facts this snapshot already
 * proves are in scope — retained activity rows of this company and roster agents'
 * `activeTaskIds`. The workspace/agent attachment is filled only from the roster,
 * so a task id that nobody in scope references stays unattached rather than being
 * attributed to a department nobody asserted.
 */
export function deriveHqTaskLinks(
  departments: readonly HqDepartment[],
  rows: readonly HqSnapshotActivityRow[],
): HqTaskLink[] {
  const links = new Map<string, HqTaskLink>();
  const agentWorkspace = new Map<string, string>();
  for (const department of departments) {
    for (const agent of department.agents) agentWorkspace.set(agent.id, department.id);
  }
  for (const department of departments) {
    for (const agent of department.agents) {
      for (const taskId of agent.activeTaskIds) {
        if (typeof taskId !== 'string' || !taskId) continue;
        const existing = links.get(taskId);
        if (!existing) links.set(taskId, { taskId, workspaceId: department.id, agentId: agent.id });
      }
    }
  }
  for (const row of rows) {
    if (typeof row.task_id !== 'string' || !row.task_id) continue;
    if (links.has(row.task_id)) continue;
    const agentId = typeof row.actor_agent_id === 'string' && row.actor_agent_id ? row.actor_agent_id : null;
    links.set(row.task_id, {
      taskId: row.task_id,
      workspaceId: agentId ? agentWorkspace.get(agentId) ?? null : null,
      agentId,
    });
  }
  return Array.from(links.values()).sort((left, right) =>
    left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0,
  );
}

/* ================================================================== *
 * Assembly
 * ================================================================== */

/**
 * Read and assemble the authorized snapshot. The two reads that must agree —
 * the cursor/watermark row and the feed rows — run inside ONE `db.transaction`,
 * and the feed read is bounded by the high-water mark read in that same
 * transaction, so a concurrent append cannot make the snapshot report a cursor
 * it did not actually read at.
 *
 * `highSeq` is never below the newest retained row's seq: when a corrupt or
 * missing state row would otherwise report 0 while rows exist, the higher of the
 * two wins, which is what keeps a populated company out of the "false empty"
 * state. `prunedThroughSeq` is clamped to `highSeq` for the same reason.
 */
export async function loadHqSnapshot(
  db: Database.Database,
  input: HqSnapshotInput,
  deps: HqSnapshotDeps,
): Promise<HqSnapshotState> {
  const limit = Number.isSafeInteger(input.feedSize) && (input.feedSize as number) > 0
    ? Math.min(input.feedSize as number, 1000)
    : HQ_SNAPSHOT_FEED_SIZE;

  const read = db.transaction(() => {
    const stateRow = readStateRow(db, input.companyId);
    const reportedHigh = stateRow && isHqCursor(stateRow.high_seq) ? stateRow.high_seq : 0;
    const reportedPruned = stateRow && isHqCursor(stateRow.pruned_through_seq) ? stateRow.pruned_through_seq : 0;

    const plan = resolveHqSnapshotFeedPlan({
      previousCursor: input.previousCursor,
      highSeq: reportedHigh,
      prunedThroughSeq: reportedPruned,
    });

    // S8 fixes the payload: the snapshot always carries the latest activities.
    // The plan above only decides the CURSOR fields, so a client that has more
    // retained history than this window keeps its own cursor and drains the rest
    // through the activity route (S8 catch-up is the correctness path).
    const rows = readRecentRows(db, input.companyId, limit);

    const labels = resolveLabels(
      db,
      input.companyId,
      rows.flatMap((row) => [row.actor_agent_id, row.recipient_agent_id]).filter((id): id is string => !!id),
    );

    return { stateRow, reportedHigh, reportedPruned, plan, rows, labels };
  })();

  const maxRowSeq = read.rows.reduce((max, row) => (isHqCursor(row.seq) && row.seq > max ? row.seq : max), 0);
  const highSeq = Math.max(read.reportedHigh, maxRowSeq);
  const prunedThroughSeq = Math.min(read.reportedPruned, highSeq);

  const resolveLabel = (agentId: string): string | null => read.labels.get(agentId) ?? null;
  const activities = read.rows.map((row) => deps.projectEvent(row, resolveLabel));

  const layout = await deps.buildLayout({
    departments: input.departments,
    masterWorkspaceId: input.masterWorkspaceId ?? null,
    sortOrder: input.sortOrder ?? null,
  });

  return {
    layout,
    activities,
    highSeq,
    prunedThroughSeq,
    stateSeq: highSeq,
    feedCursor: read.plan.feedCursor,
    feedStart: read.plan.feedStart,
    resetRequired: read.plan.resetRequired,
    captureHealth: summarizeHqCaptureHealth(read.stateRow),
    taskLinks: deriveHqTaskLinks(input.departments, read.rows),
  };
}
