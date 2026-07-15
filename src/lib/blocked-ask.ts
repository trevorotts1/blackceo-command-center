/**
 * blocked-ask.ts — the "blocked_on_human ⇒ answerable ask" invariant.
 *
 * THE POISON STATE (incident, 2026-07-14)
 * ---------------------------------------
 * A task can be parked in Blocked with `blocked_on_human` naming the human who
 * must act ('owner' | 'operator'). The `ask` column is the ONE thing that tells
 * that human WHAT to do.
 *
 * A row with `blocked_on_human` SET and `ask` EMPTY is unanswerable by
 * construction: the named human is handed a reminder with no question in it, so
 * they cannot clear it, so the task never leaves Blocked, so the stale-task
 * sweep re-pings them on the NEXT tick — forever. On a live box this produced a
 * standing set of un-clearable blocked tasks re-escalating every 10 minutes.
 *
 * The producer was NOT the API (its blocked gate already demanded a non-empty
 * `ask`). It was a raw sweep write: the stuck-in-progress sweep set
 * `blocked_on_human = 'operator'` and wrote its human-readable instruction into
 * `block_needs` — a DIFFERENT column — leaving `ask` NULL. The stale-task sweep
 * then rendered that NULL as the literal placeholder "(no ask specified)".
 *
 * THE INVARIANT
 * -------------
 *   blocked_on_human IS NOT NULL  ⇒  ask is a real, non-blank instruction.
 *
 * Blank means: NULL/undefined, whitespace-only, OR one of the rendered
 * placeholders below (a placeholder that gets round-tripped back into the column
 * is no more answerable than NULL).
 *
 * ENFORCED IN THREE PLACES, all fed from THIS module so they cannot drift:
 *   1. Request validation — UpdateTaskSchema / UpdateAdCampaignStageSchema
 *      (src/lib/validation.ts) reject the pair with a 400.
 *   2. Service code — the PATCH blocked-gate (api/tasks/[id]) and moveAdStage
 *      (ad-campaigns.ts) use isBlankAsk() so a placeholder can't slip past.
 *   3. The DB itself — two BEFORE INSERT/UPDATE triggers (migration 104) RAISE
 *      (ABORT) on the pair, so NO raw `run('UPDATE tasks SET ...')` anywhere in
 *      the codebase (present or future) can recreate it.
 *
 * WHY TRIGGERS AND NOT A CHECK CONSTRAINT: adding a CHECK to `tasks` requires a
 * SQLite 12-step table rebuild, and the rebuild's `INSERT INTO new SELECT * FROM
 * old` would ABORT on the very rows this incident already created — a migration
 * that destroys or refuses live history. Triggers are enforced only on rows
 * WRITTEN AFTER the migration; every existing row (and its deliverables and
 * activities) survives untouched, and remains readable, archivable, and
 * repairable. Forward-only enforcement is the whole point.
 *
 * NOTE ON SCOPE: this rejects the poison state. It does NOT silence escalation —
 * a task blocked WITH a real ask still escalates to its human exactly as before.
 */

/**
 * Rendered placeholders that mean "there is no ask". Stored in the column they
 * are indistinguishable from NULL to the human being paged, so they are BLANK.
 * Compared case-insensitively against the trimmed value.
 *
 * Keep in lockstep with the fallback strings any notifier renders for a missing
 * ask (today: stale-task-sweep.ts renders '(no ask specified)').
 */
export const NO_ASK_PLACEHOLDERS: readonly string[] = [
  '(no ask specified)',
  'no ask specified',
];

/** True when `ask` carries no answerable instruction (NULL, blank, placeholder). */
export function isBlankAsk(ask: unknown): boolean {
  if (typeof ask !== 'string') return true; // null | undefined | anything non-string
  const trimmed = ask.trim();
  if (trimmed.length === 0) return true;
  return NO_ASK_PLACEHOLDERS.includes(trimmed.toLowerCase());
}

/** True when `blocked_on_human` names a human (i.e. someone is being waited on). */
export function isBlockedOnHumanSet(blockedOnHuman: unknown): boolean {
  return typeof blockedOnHuman === 'string' && blockedOnHuman.trim().length > 0;
}

/** True for exactly the poison pair: a human is named, but there is no ask. */
export function violatesBlockedAskInvariant(input: {
  blocked_on_human?: unknown;
  ask?: unknown;
}): boolean {
  return isBlockedOnHumanSet(input.blocked_on_human) && isBlankAsk(input.ask);
}

/** The one message every layer uses when it rejects the poison pair. */
export const BLOCKED_ASK_INVARIANT_MESSAGE =
  'A task blocked on a human MUST carry a non-empty `ask` — a one-line instruction ' +
  'stating exactly what that human has to do. A task blocked on a human with no ask ' +
  'can never be answered, so it stays blocked forever and re-escalates forever. ' +
  'Supply an `ask`, or leave `blocked_on_human` unset.';

// ---------------------------------------------------------------------------
// DB-level enforcement (migration 104) — exported so the migration and the
// regression test share ONE definition of the trigger.
// ---------------------------------------------------------------------------

export const BLOCKED_ASK_TRIGGER_NAMES = [
  'trg_tasks_blocked_on_human_requires_ask_insert',
  'trg_tasks_blocked_on_human_requires_ask_update',
] as const;

/** SQL predicate matching the poison pair for a row alias (`NEW` in a trigger). */
function poisonPredicate(alias: string): string {
  const placeholderList = NO_ASK_PLACEHOLDERS.map((p) => `'${p.replace(/'/g, "''")}'`).join(', ');
  return (
    `${alias}.blocked_on_human IS NOT NULL AND trim(${alias}.blocked_on_human) <> '' AND (` +
    `${alias}.ask IS NULL OR trim(${alias}.ask) = '' OR lower(trim(${alias}.ask)) IN (${placeholderList})` +
    `)`
  );
}

// RAISE(ABORT) text: kept short and greppable. better-sqlite3 surfaces it as the
// Error message, so a caller that hits this sees exactly which invariant broke.
const ABORT_MESSAGE =
  'blocked_on_human requires a non-empty ask (a task blocked on a human with no ask can never be answered)';

/**
 * The two triggers that make the poison state unwritable. BEFORE-row triggers on
 * `tasks`:
 *   - INSERT: any new row.
 *   - UPDATE OF blocked_on_human, ask: fires ONLY when a write names one of those
 *     two columns, so unrelated writes to a legacy poisoned row (archiving it,
 *     bumping updated_at, moving it out of Blocked by NULLing the pair) are never
 *     touched by it. Existing rows are never re-validated.
 */
export const BLOCKED_ASK_TRIGGER_SQL: readonly string[] = [
  `CREATE TRIGGER IF NOT EXISTS ${BLOCKED_ASK_TRIGGER_NAMES[0]}
   BEFORE INSERT ON tasks
   FOR EACH ROW
   WHEN ${poisonPredicate('NEW')}
   BEGIN
     SELECT RAISE(ABORT, '${ABORT_MESSAGE}');
   END`,
  `CREATE TRIGGER IF NOT EXISTS ${BLOCKED_ASK_TRIGGER_NAMES[1]}
   BEFORE UPDATE OF blocked_on_human, ask ON tasks
   FOR EACH ROW
   WHEN ${poisonPredicate('NEW')}
   BEGIN
     SELECT RAISE(ABORT, '${ABORT_MESSAGE}');
   END`,
];
