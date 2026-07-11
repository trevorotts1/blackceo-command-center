/**
 * finalize-action.ts — the SINGLE source of truth for which board action is the
 * assembly "confirm / finalize the running order" action (U9/U13).
 *
 * WHY THIS EXISTS. The order payload {order, opener, closer} must be relayed to
 * the engine by the board-door route (src/app/api/anthology/gate/route.ts) for the
 * confirm/finalize decision, and the cockpit (assembly-cockpit-logic.ts) POSTs
 * whatever finalize action the ENGINE surfaces — `pickConfirmOrderAction` fuzzy-
 * matches the engine's action set. If the route hard-codes a single literal
 * (`confirm_order`) while the picker matches a broader set, the route silently
 * DROPS order/opener/closer for any other finalize name the engine may use (e.g.
 * `finalize_order`) — a data-loss wiring defect with no error. Both sides now
 * import this one predicate, so the picker and the relay can NEVER drift again.
 *
 * The predicate matches `confirm_order`, `finalize`/`finalize_order`, and any
 * `*order*` finalize name, while excluding every genuinely non-finalize board
 * action (approve, hold, exclude, escalate, select, approve_as_is,
 * request_rewrite_with_notes, ready_to_assemble, sign_off — none contain
 * "order"/"finaliz"), so the order payload can never leak onto an unrelated
 * decision. The engine remains authoritative: it validates the order against the
 * finalized set and refuses a bad one.
 */

/** The shared finalize-action predicate. Non-global (safe to reuse `.test()`). */
export const FINALIZE_ACTION_RE = /confirm_order|finaliz|order/i;

/** The default finalize action when the engine surfaces none by name. */
export const DEFAULT_FINALIZE_ACTION = 'confirm_order';

/**
 * True iff `action` is the assembly confirm/finalize-order action (whatever name
 * the engine gives it), so its order/opener/closer payload MUST be relayed.
 */
export function isFinalizeAction(action: string): boolean {
  return FINALIZE_ACTION_RE.test(action);
}
