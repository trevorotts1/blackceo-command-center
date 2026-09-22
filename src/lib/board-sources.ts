/**
 * board-sources.ts — the ONE canonical set of recognized board-producer
 * sources (INGEST-10) and its normalizer.
 *
 * WHY THIS EXISTS (FIX 36 / 01-FIX-PLAN FIX 23): the Presentations department
 * engine mints phase child cards via /api/tasks/ingest with
 * `source: "build_deck_phase"` (23-ai-workforce-blueprint/.../presentations/
 * scripts/cc_board.py, payload.source) and the interview app mints its own
 * cards with `source: "presentation-interview-app"` (intake/interview-app/
 * bridge/intake_writer.py). Neither value was in the status route's local
 * RECOGNIZED_BOARD_SOURCES set, so EVERY child status change (and every
 * interview-app card move) 403'd with "not a signed board-producer card" —
 * 13 such 200-on-parent / 403-on-child pairs in one live receipt. The set
 * lived in TWO copies (status route + TaskOverviewPanels labels) and had
 * already drifted; this module is the single source both consumers import.
 *
 * SECURITY SHAPE (unchanged from INGEST-10): board-producer scope is derived
 * from the IMMUTABLE, server-stamped `tasks.source` column — set ONLY at
 * creation by /api/tasks/ingest (from the validated ingest body) and never
 * exposed on any update surface. normalizeBoardSource() lowercases + trims
 * before the membership check, so a producer that sends "Build_Deck_Phase"
 * is recognized instead of silently 403'd, while an unknown value ("garbage")
 * still resolves to null and is rejected with 403 by the status route.
 */

/**
 * Sources recognized as signed board producers, lowercase:
 *
 *   funnel | survey | web-development — Skill 6 board hookup
 *     (06-ghl-install-pages/tools/cc_board.py ingest_task)
 *   anthology — Anthology Engine board mirror
 *     (mc_board.py, FAIL-SOFT client, W3.1)
 *   build_deck — Presentations engine PARENT deck cards
 *     (presentations/scripts/cc_board.py ingest_deck_task)
 *   presentations — Presentations engine alias (accepted for parity with the
 *     legacy description marker, which already allowed both spellings)
 *   build_deck_phase — Presentations engine per-PHASE child cards
 *     (presentations/scripts/cc_board.py payload.source; FIX 36)
 *   presentation-interview-app — Presentations intake interview-app cards
 *     (intake/interview-app/bridge/intake_writer.py payload.source; FIX 36)
 *   podcast-engine — Skill 58 state-machine mirror cards. They are status
 *     producers only; Command Center must never become a second executor.
 */
export const RECOGNIZED_BOARD_SOURCES: Set<string> = new Set([
  'funnel',
  'survey',
  'web-development',
  'anthology',
  'build_deck',
  'presentations',
  'build_deck_phase',
  'presentation-interview-app',
  'podcast-engine',
]);

/**
 * Human-readable name of the producer behind each recognized source.
 *
 * Lives HERE, next to the set it labels, rather than in a React component, for
 * the same reason the set itself does: it had a second consumer that could not
 * import a 'use client' module. `TaskOverviewPanels.engineSourceLabel()` (the
 * original home) reads this map; so does the board-hygiene job, which names the
 * owning engine in the operator alert for a card the board refuses to dispatch
 * (STRANDED-02). A recognized source with no entry here resolves to the
 * normalized source string itself — never null — so a new producer is named
 * before anyone remembers to add a label.
 */
export const BOARD_SOURCE_LABELS: Record<string, string> = {
  funnel: 'a Skill 6 funnel build',
  survey: 'a Skill 6 survey build',
  'web-development': 'a Skill 6 web-development build',
  anthology: 'the Anthology Engine',
  build_deck: 'the presentations deck build',
  build_deck_phase: 'a presentations deck phase build',
  'presentation-interview-app': 'the presentations interview app',
  'podcast-engine': 'the Podcast Engine',
};

/**
 * Sources whose cards an ENGINE owns end to end: the engine creates, sequences
 * and completes them, and the board's advancers must never dispatch one (FIX
 * 38a/38b — a board dispatch made a SECOND executor race the live engine run).
 * The refusal is correct; STRANDED-02 is about making it visible.
 *
 * This is the display/visibility vocabulary. The dispatcher and the sweeps each
 * keep their own copy for their SQL/guard paths; they are checked against this
 * one by tests/unit/engine-owned-card-visibility.test.ts.
 */
export const ENGINE_OWNED_SOURCES: readonly string[] = [
  'build_deck',
  'build_deck_phase',
  'podcast-engine',
];

/** True when a card's stamped `source` is owned by an engine, not by the board. */
export function isEngineOwnedBoardSource(source: unknown): boolean {
  const normalized = normalizeBoardSource(source);
  return normalized !== null && ENGINE_OWNED_SOURCES.includes(normalized);
}

/** The producer name to show for a card's source, or null when unrecognized. */
export function boardSourceLabel(source: unknown): string | null {
  const normalized = normalizeBoardSource(source);
  if (!normalized) return null;
  return BOARD_SOURCE_LABELS[normalized] ?? normalized;
}

/**
 * The board lanes in which a card is waiting to be dispatched. An engine-owned
 * card in one of these is one the board has REFUSED (every advancer excludes it
 * in its SELECT and GUARD 4d refuses it on any direct call) — the state that
 * used to be indistinguishable from ordinary queued work.
 */
const BOARD_WAITING_STATUSES = ['inbox', 'backlog', 'planning', 'pending_dispatch', 'assigned'];

/**
 * STRANDED-02 — the label a WAITING engine-owned card carries on the board, or
 * null when the card is not one (wrong source, or already moving). Pure and
 * derived, so it can never drift out of step with the refusal it describes, and
 * it disappears by itself the moment the owning engine advances the card.
 */
export function engineOwnedWaitingLabel(source: unknown, status: unknown): string | null {
  if (typeof status !== 'string' || !BOARD_WAITING_STATUSES.includes(status)) return null;
  if (!isEngineOwnedBoardSource(source)) return null;
  return `Waiting on ${boardSourceLabel(source)} — the board does not dispatch this card`;
}

/**
 * Normalize a caller-supplied board source to its canonical recognized form.
 * Returns the lowercased, trimmed string when it is a recognized producer
 * source; null for anything else (unknown value, non-string, blank) so the
 * caller's 403 path stays fail-closed.
 */
export function normalizeBoardSource(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return RECOGNIZED_BOARD_SOURCES.has(s) ? s : null;
}
