/**
 * Board Hygiene Job (P1-06 — "nothing stuck on the board").
 *
 * Codifies the lane SLAs the spec names so tasks never rot silently in
 * Blocked, Review/QC, Done, or a stale Backlog/Inbox column:
 *
 *   1. blocked > 48h with block_audience='OWNER' → re-ping the requester,
 *      max once/48h.
 *   2. blocked > 7d (any audience) → escalate to the operator lane via
 *      notifySystem() with the block reason. A blocked task with a human
 *      dependency is NEVER auto-archived, at any age — rule 2 only ever
 *      notifies + logs; the archive paths (rules 4/5) query `status = 'done'`
 *      and `status IN ('backlog','inbox')` respectively, which structurally
 *      excludes 'blocked' from ever being archived by this job.
 *   3. review with no qc_review event in 24h → force one judge scoring
 *      attempt (runQCOnReview). If the judge is unprovisioned (heuristic
 *      fallback, reason 'no-key'), surface `qc_starved` to the operator lane
 *      — visible, not silent (P1-05).
 *   4. done > 30d → auto-archive (soft — archived_at stamp; NEVER DELETE).
 *   5. stale backlog/inbox > 21d with no activity → message the requester
 *      "still want this?"; no reply in 7d → archive with an
 *      `auto_archived_stale` event. Tasks WITHOUT a requester id → operator
 *      digest instead (batched into ONE message per run, never a per-task
 *      drip — MOVE-IN-SILENCE / 2.5 batching doctrine).
 *
 * ── TRUST-ENGINE INTEGRATION SEAM (P1-04) ───────────────────────────────────
 * The spec's part (c).1 says the owner-facing re-ping and the stale-backlog
 * "still want this?" nudge go out "via the trust engine (P1-04 message
 * path)". P1-04 (the report-back engine: `requester_chat_id` on tasks, a
 * dedicated `trust-engine.ts` sender) had not yet merged into this repo at
 * the time this job was built (repos are merged serially — Section 2.6). Per
 * the 2.5 "decide autonomously" protocol this job makes the following call,
 * recorded here rather than left unbuilt:
 *
 *   DECISION: use the existing `notify.ts` owner/system channels (the only
 *   REAL delivery mechanism this repo has today) as the concrete
 *   implementation, isolated behind the single `sendOwnerMessage()` helper
 *   below (used by both rule 1's re-ping and rule 5's nudge). When P1-04
 *   merges and adds a per-task `requester_chat_id` + a dedicated trust-engine
 *   sender, swap that one function's body to call it — no other change in
 *   this file is required. This ships REAL client-facing delivery now instead
 *   of a stub that only writes an activity-feed row (the class of
 *   half-finished feature 2.8 exists to stop), while keeping the swap-in
 *   point single and obvious.
 *
 * All state (last-reping time, last-escalation time, nudge time) is tracked
 * via the `events` table — no new columns, no new migration — so this job
 * merges cleanly regardless of migration-numbering races with parallel units.
 *
 * Runs hourly (scheduler-registered — see scheduler.ts). Disable entirely
 * with DISABLE_BOARD_HYGIENE=1. Each of the five sub-checks can also be
 * disabled independently for staged rollout / debugging.
 */

import { queryAll, queryOne, run, sqlTime, parseDbTime, timeNow } from '@/lib/db';
import { notifyOwner, notifySystem, notifyTelegram } from '@/lib/notify';
import { runQCOnReview } from '@/lib/qc-scorer';
import { isContentTask } from '@/lib/tasks';
import { v4 as uuidv4 } from 'uuid';

export const BOARD_HYGIENE_CRON = '0 * * * *'; // hourly, on the hour

// ── Thresholds (env-overridable for tests / tuning) ─────────────────────────

const BLOCKED_OWNER_REPING_HOURS = numEnv('BOARD_HYGIENE_BLOCKED_OWNER_REPING_HOURS', 48);
const BLOCKED_OPERATOR_ESCALATE_HOURS = numEnv('BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS', 24 * 7); // 7d
const REVIEW_UNSCORED_HOURS = numEnv('BOARD_HYGIENE_REVIEW_UNSCORED_HOURS', 24);
const DONE_ARCHIVE_DAYS = numEnv('BOARD_HYGIENE_DONE_ARCHIVE_DAYS', 30);
const STALE_BACKLOG_NUDGE_DAYS = numEnv('BOARD_HYGIENE_STALE_BACKLOG_NUDGE_DAYS', 21);
const STALE_BACKLOG_ARCHIVE_AFTER_NUDGE_DAYS = numEnv('BOARD_HYGIENE_STALE_ARCHIVE_AFTER_NUDGE_DAYS', 7);

// Re-fire cooldowns — not individually specified by the spec beyond the
// explicit "max once/48h" on the owner re-ping (rule 1); the same cadence is
// reused for the other two dedup-guarded alerts (operator escalation,
// qc_starved) so an hourly job never spams a chat every tick for a task that
// has been stuck for weeks. Documented decision, not a silent default.
const OWNER_REPING_COOLDOWN_HOURS = numEnv('BOARD_HYGIENE_OWNER_REPING_COOLDOWN_HOURS', 48);
const OPERATOR_ESCALATE_COOLDOWN_HOURS = numEnv('BOARD_HYGIENE_ESCALATE_COOLDOWN_HOURS', 48);
const QC_STARVED_COOLDOWN_HOURS = numEnv('BOARD_HYGIENE_QC_STARVED_COOLDOWN_HOURS', 48);

function numEnv(name: string, fallback: number): number {
  const v = parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Event type constants (single source, avoid typo drift across queries) ──

const EVT_OWNER_REPINGED = 'board_hygiene_owner_repinged';
const EVT_OPERATOR_ESCALATED = 'board_hygiene_operator_escalated';
const EVT_QC_STARVED = 'qc_starved';
const EVT_DONE_ARCHIVED = 'board_hygiene_auto_archived_done';
const EVT_STALE_NUDGED = 'board_hygiene_stale_nudged';
const EVT_STALE_ARCHIVED = 'auto_archived_stale';
// P4-02 step 6 — the board-level silent-blend-regression lock.
const EVT_BLEND_REGRESSION = 'persona_blend_regression';

// The trailing window the blend-regression check evaluates (spec: "any 7-day
// window with content tasks created but zero bundles written") + its re-alert
// cooldown (reuse the 48h cadence the other operator-lane alerts use).
const BLEND_REGRESSION_WINDOW_DAYS = numEnv('BOARD_HYGIENE_BLEND_REGRESSION_WINDOW_DAYS', 7);
const BLEND_REGRESSION_COOLDOWN_HOURS = numEnv('BOARD_HYGIENE_BLEND_REGRESSION_COOLDOWN_HOURS', 48);

// ── Result shape ─────────────────────────────────────────────────────────────

export interface BoardHygieneResult {
  ranAt: string;
  skippedReason?: string;
  ownerRepinged: number;
  ownerRepingedIds: string[];
  operatorEscalated: number;
  operatorEscalatedIds: string[];
  reviewForceScored: number;
  reviewForceScoredIds: string[];
  qcStarved: number;
  qcStarvedIds: string[];
  doneArchived: number;
  doneArchivedIds: string[];
  staleNudged: number;
  staleNudgedIds: string[];
  staleArchived: number;
  staleArchivedIds: string[];
  operatorDigestSent: boolean;
  /** P4-02 step 6 — true when the trailing window had content tasks created but
   *  ZERO persona bundles written (the D1 silent-regression signal fired). */
  blendRegressionFlagged: boolean;
  /** Content tasks created in the regression window (diagnostic). */
  blendWindowContentTasks: number;
  /** Persona bundles written in the regression window (diagnostic). */
  blendWindowBundles: number;
  /** A-U6 companion — true when a CONFIRMED content-task bundle in the
   *  trailing window still reports below-min on validate_blend_invariant
   *  (persona_blend.py's min-2/max-4 role-count invariant). */
  blendInvariantRegressionFlagged: boolean;
  /** CONFIRMED content-task bundles in the window reading below-min (diagnostic). */
  blendInvariantBelowMinCount: number;
}

function emptyResult(ranAt: string, skippedReason?: string): BoardHygieneResult {
  return {
    ranAt,
    skippedReason,
    ownerRepinged: 0,
    ownerRepingedIds: [],
    operatorEscalated: 0,
    operatorEscalatedIds: [],
    reviewForceScored: 0,
    reviewForceScoredIds: [],
    qcStarved: 0,
    qcStarvedIds: [],
    doneArchived: 0,
    doneArchivedIds: [],
    staleNudged: 0,
    staleNudgedIds: [],
    staleArchived: 0,
    staleArchivedIds: [],
    operatorDigestSent: false,
    blendRegressionFlagged: false,
    blendWindowContentTasks: 0,
    blendWindowBundles: 0,
    blendInvariantRegressionFlagged: false,
    blendInvariantBelowMinCount: 0,
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/** True when a task has had an event of `type` within the last `hours`. */
function hasRecentEvent(taskId: string, type: string, hours: number): boolean {
  const row = queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM events
      WHERE task_id = ? AND type = ?
        AND ${sqlTime('created_at')} >= datetime('now', ?)`,
    [taskId, type, `-${hours} hours`],
  );
  return (row?.n ?? 0) > 0;
}

/** Most recent event of `type` for a task, or null. */
function lastEvent(taskId: string, type: string): { created_at: string; message: string } | null {
  return (
    queryOne<{ created_at: string; message: string }>(
      `SELECT created_at, message FROM events
        WHERE task_id = ? AND type = ?
        ORDER BY ${sqlTime('created_at')} DESC LIMIT 1`,
      [taskId, type],
    ) ?? null
  );
}

function writeEvent(taskId: string, type: string, message: string): void {
  run(
    `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, ?, ?, ?)`,
    [uuidv4(), type, taskId, message, timeNow()],
  );
}

/** Does the live `tasks` schema carry the P1-04 requester column yet? */
function hasRequesterColumn(): boolean {
  try {
    const cols = queryAll<{ name: string }>('PRAGMA table_info(tasks)', []);
    return cols.some((c) => c.name === 'requester_chat_id');
  } catch {
    return false;
  }
}

/**
 * Trust-engine integration seam (owner re-ping / stale nudge). See the file
 * header DECISION note: today this sends via the real notify.ts channel;
 * swap the body for the P1-04 trust-engine sender once it merges.
 */
function sendOwnerMessage(chatId: string | null, message: string): boolean {
  if (chatId) {
    return notifyTelegram({ chatId, message });
  }
  return notifyOwner(message);
}

// ── Rule 1 + 2: Blocked lane ────────────────────────────────────────────────

interface BlockedTaskRow {
  id: string;
  title: string;
  block_reason: string | null;
  block_needs: string | null;
  block_audience: string | null;
  ask: string | null;
  last_progress_at: string | null;
  updated_at: string;
}

async function processBlockedLane(result: BoardHygieneResult): Promise<void> {
  let rows: BlockedTaskRow[];
  try {
    rows = queryAll<BlockedTaskRow>(
      `SELECT id, title, block_reason, block_needs, block_audience,
              ask, last_progress_at, updated_at
         FROM tasks
        WHERE status = 'blocked' AND archived_at IS NULL`,
      [],
    );
  } catch (err) {
    console.warn('[board-hygiene] blocked-lane query failed:', (err as Error).message);
    return;
  }

  for (const task of rows) {
    try {
      const progressTs = task.last_progress_at ?? task.updated_at;
      const progressMs = parseDbTime(progressTs);
      if (Number.isNaN(progressMs)) continue;
      const ageHours = (Date.now() - progressMs) / (1000 * 60 * 60);

      // Rule 1: blocked > 48h, audience=OWNER → re-ping the requester, max
      // once/48h. NEVER touches status — re-ping only.
      if (
        task.block_audience === 'OWNER' &&
        ageHours >= BLOCKED_OWNER_REPING_HOURS &&
        !hasRecentEvent(task.id, EVT_OWNER_REPINGED, OWNER_REPING_COOLDOWN_HOURS)
      ) {
        const message =
          `[BOARD-HYGIENE] Task "${task.title}" has been Blocked for ${Math.round(ageHours)}h ` +
          `waiting on you. Needs: ${task.block_needs ?? task.ask ?? task.block_reason ?? '(no detail recorded)'}`;
        sendOwnerMessage(null, message);
        writeEvent(task.id, EVT_OWNER_REPINGED, `Re-pinged owner on blocked task (${Math.round(ageHours)}h). ${message}`);
        result.ownerRepinged++;
        result.ownerRepingedIds.push(task.id);
      }

      // Rule 2: blocked > 7d, ANY audience → escalate to the operator lane.
      // Structurally never archives — this branch only notifies + logs.
      if (
        ageHours >= BLOCKED_OPERATOR_ESCALATE_HOURS &&
        !hasRecentEvent(task.id, EVT_OPERATOR_ESCALATED, OPERATOR_ESCALATE_COOLDOWN_HOURS)
      ) {
        const message =
          `[BOARD-HYGIENE] Task "${task.title}" (id: ${task.id}) has been Blocked for ${Math.round(ageHours)}h ` +
          `(audience: ${task.block_audience ?? 'unset'}). Reason: ${task.block_reason ?? '(no reason recorded)'}. ` +
          `Needs: ${task.block_needs ?? task.ask ?? '(none recorded)'}. NOT auto-archived — human dependency.`;
        notifySystem(message, { agent: 'board-hygiene', action: 'escalate' });
        writeEvent(task.id, EVT_OPERATOR_ESCALATED, message);
        result.operatorEscalated++;
        result.operatorEscalatedIds.push(task.id);
      }
    } catch (err) {
      console.warn(`[board-hygiene] blocked-lane processing failed for ${task.id}:`, (err as Error).message);
    }
  }
}

// ── Rule 3: Review / QC lane ────────────────────────────────────────────────

async function processReviewLane(result: BoardHygieneResult): Promise<void> {
  // Candidates for a forced scoring attempt: in review, no qc_review event in
  // the SLA window, and not already permanently terminal
  // ([QC-HEURISTIC-FINAL] — QC-02; re-scoring a terminal task would corrupt
  // its no-key-pass counter and is explicitly forbidden by qc-scorer's own
  // invariant).
  let unscored: Array<{ id: string; title: string }>;
  try {
    unscored = queryAll<{ id: string; title: string }>(
      `SELECT t.id, t.title
         FROM tasks t
        WHERE t.status = 'review'
          AND t.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id = t.id AND e.type = 'qc_review'
               AND e.message LIKE '%[QC-HEURISTIC-FINAL]%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id = t.id AND e.type = 'qc_review'
               AND ${sqlTime('e.created_at')} >= datetime('now', ?)
          )`,
      [`-${REVIEW_UNSCORED_HOURS} hours`],
    );
  } catch (err) {
    console.warn('[board-hygiene] review-lane query failed:', (err as Error).message);
    unscored = [];
  }

  for (const task of unscored) {
    try {
      const qcResult = await runQCOnReview(task.id);
      if (qcResult === null) continue; // task left review / scorer disabled — nothing to force
      result.reviewForceScored++;
      result.reviewForceScoredIds.push(task.id);

      if (qcResult.scoringPath === 'heuristic' && qcResult.heuristicReason === 'no-key') {
        if (!hasRecentEvent(task.id, EVT_QC_STARVED, QC_STARVED_COOLDOWN_HOURS)) {
          const message =
            `[BOARD-HYGIENE] QC judge unprovisioned for task "${task.title}" (id: ${task.id}) — ` +
            `no client Ollama Cloud judge model/key configured. Task held in review for human review/promote.`;
          notifySystem(message, { agent: 'board-hygiene', action: 'qc_starved' });
          writeEvent(task.id, EVT_QC_STARVED, message);
          result.qcStarved++;
          result.qcStarvedIds.push(task.id);
        }
      }
    } catch (err) {
      console.warn(`[board-hygiene] review-lane force-score failed for ${task.id}:`, (err as Error).message);
    }
  }

  // A task already permanently terminal ([QC-HEURISTIC-FINAL]) is a KNOWN
  // qc_starved condition that will never re-enter the scan above. Surface it
  // once (cooldown-guarded) so it is never silently starved forever.
  let terminal: Array<{ id: string; title: string }>;
  try {
    terminal = queryAll<{ id: string; title: string }>(
      `SELECT t.id, t.title
         FROM tasks t
        WHERE t.status = 'review'
          AND t.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM events e
             WHERE e.task_id = t.id AND e.type = 'qc_review'
               AND e.message LIKE '%[QC-HEURISTIC-FINAL]%'
          )`,
      [],
    );
  } catch (err) {
    console.warn('[board-hygiene] terminal-review query failed:', (err as Error).message);
    terminal = [];
  }

  for (const task of terminal) {
    if (hasRecentEvent(task.id, EVT_QC_STARVED, QC_STARVED_COOLDOWN_HOURS)) continue;
    const message =
      `[BOARD-HYGIENE] QC judge unprovisioned for task "${task.title}" (id: ${task.id}) — ` +
      `permanently terminal heuristic state ([QC-HEURISTIC-FINAL]); needs a human promote or a judge key.`;
    notifySystem(message, { agent: 'board-hygiene', action: 'qc_starved' });
    writeEvent(task.id, EVT_QC_STARVED, message);
    result.qcStarved++;
    result.qcStarvedIds.push(task.id);
  }
}

// ── Rule 4: Done lane ────────────────────────────────────────────────────────

interface DoneTaskRow {
  id: string;
  completed_at: string | null;
  updated_at: string;
}

function processDoneLane(result: BoardHygieneResult): void {
  let rows: DoneTaskRow[];
  try {
    rows = queryAll<DoneTaskRow>(
      `SELECT id, completed_at, updated_at FROM tasks
        WHERE status = 'done' AND archived_at IS NULL`,
      [],
    );
  } catch (err) {
    console.warn('[board-hygiene] done-lane query failed:', (err as Error).message);
    return;
  }

  for (const task of rows) {
    try {
      const ts = task.completed_at ?? task.updated_at;
      const ms = parseDbTime(ts);
      if (Number.isNaN(ms)) continue;
      const ageDays = (Date.now() - ms) / (1000 * 60 * 60 * 24);
      if (ageDays < DONE_ARCHIVE_DAYS) continue;

      run(`UPDATE tasks SET archived_at = ? WHERE id = ? AND status = 'done' AND archived_at IS NULL`, [
        timeNow(),
        task.id,
      ]);
      writeEvent(task.id, EVT_DONE_ARCHIVED, `[BOARD-HYGIENE] Soft-archived done task after ${Math.round(ageDays)}d.`);
      result.doneArchived++;
      result.doneArchivedIds.push(task.id);
    } catch (err) {
      console.warn(`[board-hygiene] done-lane archive failed for ${task.id}:`, (err as Error).message);
    }
  }
}

// ── Rule 5: Stale backlog/inbox lane ────────────────────────────────────────

interface StaleTaskRow {
  id: string;
  title: string;
  status: string;
  last_progress_at: string | null;
  updated_at: string;
  requester_chat_id?: string | null;
}

function processStaleBacklogLane(result: BoardHygieneResult): void {
  const requesterColPresent = hasRequesterColumn();
  const selectCols = requesterColPresent
    ? 'id, title, status, last_progress_at, updated_at, requester_chat_id'
    : 'id, title, status, last_progress_at, updated_at';

  let rows: StaleTaskRow[];
  try {
    rows = queryAll<StaleTaskRow>(
      `SELECT ${selectCols} FROM tasks
        WHERE status IN ('backlog', 'inbox') AND archived_at IS NULL`,
      [],
    );
  } catch (err) {
    console.warn('[board-hygiene] stale-backlog query failed:', (err as Error).message);
    return;
  }

  const digestNoRequester: string[] = [];

  for (const task of rows) {
    try {
      const progressTs = task.last_progress_at ?? task.updated_at;
      const progressMs = parseDbTime(progressTs);
      if (Number.isNaN(progressMs)) continue;
      const ageDays = (Date.now() - progressMs) / (1000 * 60 * 60 * 24);
      if (ageDays < STALE_BACKLOG_NUDGE_DAYS) continue;

      const prevNudge = lastEvent(task.id, EVT_STALE_NUDGED);

      if (!prevNudge) {
        // First time past the nudge threshold: message the requester, or —
        // absent a requester id (pre-P1-04 boxes) — queue for the operator
        // digest instead of messaging nobody.
        const requesterId = requesterColPresent ? (task.requester_chat_id ?? null) : null;
        const message = `[BOARD-HYGIENE] "${task.title}" has sat untouched in ${task.status} for ${Math.round(ageDays)}d — still want this? Reply to keep it active, or it will auto-archive in ${STALE_BACKLOG_ARCHIVE_AFTER_NUDGE_DAYS}d.`;

        if (requesterId) {
          sendOwnerMessage(requesterId, message);
        } else {
          digestNoRequester.push(`${task.title} (id: ${task.id}, ${Math.round(ageDays)}d stale)`);
        }

        writeEvent(
          task.id,
          EVT_STALE_NUDGED,
          `${message} [requester:${requesterId ? 'messaged' : 'none — operator digest'}]`,
        );
        result.staleNudged++;
        result.staleNudgedIds.push(task.id);
        continue;
      }

      // Already nudged — has 7d elapsed since the nudge with NO activity
      // (the progress timestamp never moved past the nudge) and no reply?
      const nudgeMs = parseDbTime(prevNudge.created_at);
      if (Number.isNaN(nudgeMs)) continue;
      const daysSinceNudge = (Date.now() - nudgeMs) / (1000 * 60 * 60 * 24);
      const noActivitySinceNudge = progressMs <= nudgeMs;

      if (daysSinceNudge >= STALE_BACKLOG_ARCHIVE_AFTER_NUDGE_DAYS && noActivitySinceNudge) {
        run(
          `UPDATE tasks SET archived_at = ? WHERE id = ? AND status IN ('backlog','inbox') AND archived_at IS NULL`,
          [timeNow(), task.id],
        );
        writeEvent(
          task.id,
          EVT_STALE_ARCHIVED,
          `[BOARD-HYGIENE] Auto-archived: no reply ${Math.round(daysSinceNudge)}d after the "still want this?" nudge.`,
        );
        result.staleArchived++;
        result.staleArchivedIds.push(task.id);
      }
    } catch (err) {
      console.warn(`[board-hygiene] stale-backlog processing failed for ${task.id}:`, (err as Error).message);
    }
  }

  if (digestNoRequester.length > 0) {
    const digestMessage =
      `[BOARD-HYGIENE] ${digestNoRequester.length} stale backlog/inbox task(s) with no requester on file ` +
      `(nudge could not be sent — trust-engine requester stamping (P1-04) not yet live on this box):\n` +
      digestNoRequester.map((l) => `  - ${l}`).join('\n');
    notifySystem(digestMessage, { agent: 'board-hygiene', action: 'stale_digest' });
    result.operatorDigestSent = true;
  }
}

// ── Rule 6: Persona-blend silent-regression check (P4-02 step 6) ────────────
//
// The D1 bug ("--blend never passed → duality dead in prod") was invisible: a
// board with zero persona bundles looked identical to a board where nobody made
// a content task. This check makes a recurrence LOUD. Over the trailing window,
// if content tasks were created (isContentTask over title+description — a
// semantic classifier, never grep-as-content-judge, meta-rule 2.4) but ZERO
// persona bundles were written, the blend has silently died again — surface it
// to the operator lane, cooldown-guarded. `persona_blend_missing` (emitted by
// resolvePersonaAndPin) catches the PER-TASK failure; this catches the BOARD-WIDE
// "the whole pipeline is dead" pattern that a single missing task can't reveal.
function processBlendRegressionCheck(result: BoardHygieneResult): void {
  const windowExpr = `-${BLEND_REGRESSION_WINDOW_DAYS} days`;

  // Count persona bundles written in the window. If the table is absent
  // (pre-090 box) there is no blend pipeline to regress — skip silently.
  let bundlesInWindow: number;
  try {
    const b = queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM task_persona_bundle
        WHERE ${sqlTime('created_at')} >= datetime('now', ?)`,
      [windowExpr],
    );
    bundlesInWindow = b?.n ?? 0;
  } catch {
    return; // no bundle table → feature not present on this box
  }

  // Content tasks created in the window (semantic filter in TS, not SQL LIKE).
  let created: Array<{ id: string; title: string; description: string | null }>;
  try {
    created = queryAll<{ id: string; title: string; description: string | null }>(
      `SELECT id, title, description FROM tasks
        WHERE archived_at IS NULL
          AND ${sqlTime('created_at')} >= datetime('now', ?)`,
      [windowExpr],
    );
  } catch (err) {
    console.warn('[board-hygiene] blend-regression query failed:', (err as Error).message);
    return;
  }

  const contentTasks = created.filter((t) =>
    isContentTask(`${t.title}${t.description ? ` ${t.description}` : ''}`),
  );

  result.blendWindowContentTasks = contentTasks.length;
  result.blendWindowBundles = bundlesInWindow;

  // The regression signal: content demand existed, zero blends were produced.
  if (contentTasks.length > 0 && bundlesInWindow === 0) {
    result.blendRegressionFlagged = true;

    // Cooldown: at most one operator alert per COOLDOWN window (global, not
    // task-scoped — this is a board-wide condition). task_id is nullable on
    // events, so the marker rides with a NULL task_id.
    let recentAlert = 0;
    try {
      recentAlert =
        queryOne<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events
            WHERE type = ? AND ${sqlTime('created_at')} >= datetime('now', ?)`,
          [EVT_BLEND_REGRESSION, `-${BLEND_REGRESSION_COOLDOWN_HOURS} hours`],
        )?.n ?? 0;
    } catch {
      recentAlert = 0;
    }
    if (recentAlert > 0) return; // already alerted within the cooldown

    const message =
      `[BOARD-HYGIENE] PERSONA-BLEND REGRESSION: ${contentTasks.length} content task(s) were created in ` +
      `the last ${BLEND_REGRESSION_WINDOW_DAYS}d but ZERO persona bundles were written — the audience/topic ` +
      `voice blend appears DEAD again (the D1 "duality dead in prod" pattern). Check --blend wiring / the ` +
      `selector install. Sample: ${contentTasks.slice(0, 3).map((t) => `"${t.title}"`).join(', ')}.`;
    notifySystem(message, { agent: 'board-hygiene', action: 'blend_regression' });
    try {
      run(
        `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, NULL, ?, ?)`,
        [uuidv4(), EVT_BLEND_REGRESSION, message, timeNow()],
      );
    } catch { /* audit best-effort */ }
  }
}

// ── Rule 6 companion: min-2/max-4 invariant BELOW-MIN regression (A-U6) ─────
//
// ONB's validate_blend_invariant (23-ai-workforce-blueprint/scripts/
// persona_blend.py, A-U6) counts the directive's ROLE slots (voice/topic/
// task) and records the reading on EVERY content bundle as
// `rationale.invariant` — collapse satisfies min-2 by ROLE COUNT (D-A2,
// ratified 2026-07-14), and the validator RECORDS/ALERTS, it NEVER BLOCKS
// the write. `persistPersonaBundle` (tasks.ts) carries that full bundle JSON
// into `task_persona_bundle.bundle_json` unmodified, so this companion check
// reads the ALREADY-COMPUTED reading — it never re-runs the Python matcher
// and never re-derives the invariant itself.
//
// Distinct from Rule 6 above (which fires on ZERO bundles in the window —
// the pipeline being silently DEAD): this fires when the pipeline IS
// producing bundles, has been CONFIRMED by the operator, and is STILL
// engaging fewer than 2 named personas — a live, ongoing match-quality
// regression rather than an outage. Same alert lane
// (`persona_blend_regression`, board-hygiene.ts:95) per A.7 — one alert per
// run regardless of how many below-min rows are found in the window; a
// window with everything at-or-above-min raises zero.
interface BundledTaskRow {
  task_id: string;
  bundle_json: string | null;
  confirm_state: string | null;
}

function processBlendInvariantRegressionCheck(result: BoardHygieneResult): void {
  const windowExpr = `-${BLEND_REGRESSION_WINDOW_DAYS} days`;

  let rows: BundledTaskRow[];
  try {
    rows = queryAll<BundledTaskRow>(
      `SELECT task_id, bundle_json, confirm_state FROM task_persona_bundle
        WHERE confirm_state = 'confirmed'
          AND ${sqlTime('created_at')} >= datetime('now', ?)`,
      [windowExpr],
    );
  } catch {
    return; // no bundle table → feature not present on this box
  }

  let belowMinCount = 0;
  for (const row of rows) {
    if (!row.bundle_json) continue;
    let bundle: { content_task?: boolean; rationale?: { invariant?: { ok?: boolean; reason?: string } } };
    try {
      bundle = JSON.parse(row.bundle_json);
    } catch {
      continue; // malformed/legacy bundle_json — never crash the hygiene job on it
    }
    if (bundle?.content_task !== true) continue; // exempt, mirrors the ONB validator
    const invariant = bundle?.rationale?.invariant;
    if (
      invariant &&
      invariant.ok === false &&
      typeof invariant.reason === 'string' &&
      invariant.reason.startsWith('below-min')
    ) {
      belowMinCount++;
    }
  }

  result.blendInvariantBelowMinCount = belowMinCount;
  if (belowMinCount === 0) return; // at-or-above-min → zero alerts

  result.blendInvariantRegressionFlagged = true;

  // Cooldown: reuse the same lane's cooldown so this and the zero-bundle
  // check above never double-fire within one window.
  let recentAlert = 0;
  try {
    recentAlert =
      queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events
          WHERE type = ? AND ${sqlTime('created_at')} >= datetime('now', ?)`,
        [EVT_BLEND_REGRESSION, `-${BLEND_REGRESSION_COOLDOWN_HOURS} hours`],
      )?.n ?? 0;
  } catch {
    recentAlert = 0;
  }
  if (recentAlert > 0) return; // already alerted within the cooldown

  const message =
    `[BOARD-HYGIENE] PERSONA-BLEND INVARIANT REGRESSION: ${belowMinCount} CONFIRMED content-task bundle(s) ` +
    `in the last ${BLEND_REGRESSION_WINDOW_DAYS}d still report below-min on the min-2/max-4 persona-count ` +
    `invariant (validate_blend_invariant, ONB persona_blend.py, A-U6) — the blend is engaging FEWER than 2 ` +
    `named roles after operator confirmation. Investigate audience/topic match quality.`;
  notifySystem(message, { agent: 'board-hygiene', action: 'blend_invariant_regression' });
  try {
    run(
      `INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, ?, NULL, ?, ?)`,
      [uuidv4(), EVT_BLEND_REGRESSION, message, timeNow()],
    );
  } catch { /* audit best-effort */ }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function runBoardHygiene(): Promise<BoardHygieneResult> {
  const ranAt = timeNow();

  if (process.env.DISABLE_BOARD_HYGIENE === '1' || process.env.DISABLE_BOARD_HYGIENE === 'true') {
    return emptyResult(ranAt, 'DISABLE_BOARD_HYGIENE env is set');
  }

  const result = emptyResult(ranAt);

  if (!(process.env.DISABLE_BOARD_HYGIENE_BLOCKED === '1')) {
    await processBlockedLane(result);
  }
  if (!(process.env.DISABLE_BOARD_HYGIENE_REVIEW === '1')) {
    await processReviewLane(result);
  }
  if (!(process.env.DISABLE_BOARD_HYGIENE_DONE === '1')) {
    processDoneLane(result);
  }
  if (!(process.env.DISABLE_BOARD_HYGIENE_STALE === '1')) {
    processStaleBacklogLane(result);
  }
  if (!(process.env.DISABLE_BOARD_HYGIENE_BLEND_REGRESSION === '1')) {
    processBlendRegressionCheck(result);
  }
  if (!(process.env.DISABLE_BOARD_HYGIENE_BLEND_INVARIANT === '1')) {
    processBlendInvariantRegressionCheck(result);
  }

  return result;
}
