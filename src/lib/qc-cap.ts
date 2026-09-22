/**
 * qc-cap.ts — the QC retry cap, in ONE place.
 *
 * The cap was previously defaulted in three modules independently
 * (`qc-scorer.ts`, `grading.ts`, the return-to-orchestrator route), each
 * parsing the same `QC_MAX_REROUTES` env var with its own `'3'` literal. An
 * operator override kept them in step; a change to the DEFAULT did not, so the
 * scorer could stop retrying at one number while the handback endpoint
 * escalated at another. This leaf module holds the default so there is nothing
 * left to drift.
 *
 * It deliberately imports NOTHING. `grading.ts` is pulled into client
 * components, so the cap cannot live anywhere that reaches `fs` or the model
 * providers — which is exactly why those modules re-derived it rather than
 * importing `qc-scorer`.
 */

/**
 * How many times a card may FAIL QC before the loop stops and the owner is
 * alerted. The Nth failure does not re-route: it blocks the card and sends one
 * alert (see `qcCapAlertMessage` in qc-scorer.ts).
 *
 * Raised 3 → 5 on 2026-09-22: three attempts blocked cards that a fourth run
 * would have cleared, and the block was silent. Override with the
 * `QC_MAX_REROUTES` env var.
 */
export const QC_MAX_REROUTES = Math.max(1, parseInt(process.env.QC_MAX_REROUTES || '5', 10) || 5);
