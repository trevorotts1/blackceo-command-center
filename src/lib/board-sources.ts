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
]);

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
