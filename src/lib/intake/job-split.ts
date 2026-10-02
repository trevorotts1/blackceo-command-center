/**
 * ACC-001-09 / ACC-001-11 — the two intake failure classes this module
 * answers, from the operator-box acceptance set
 * (tests/acceptance/intake/messages.json):
 *
 *   09 — "Can you change the webinar date to the 15th? I think that works
 *        better." A change request refers to a card already on the board:
 *        it UPDATES that card and creates NO new card
 *        (existing_update_no_new_card).
 *   11 — "Reorder printer toner and schedule the carpet cleaning for Monday."
 *        One message holding two separate jobs is ONE CARD PER JOB
 *        (two_cards). Single-job and one-job rambling messages stay ONE card
 *        (items 02, 10, 15).
 *
 * Both functions are pure, offline, deterministic text readers: they decide
 * from the message alone (the acceptance rules), never from a filesystem or
 * network probe, and they make no AI call. The DOOR (route.ts) owns the board
 * action — this module only says what the message is.
 */

/**
 * The work verbs a job clause may open with. Deliberately the same verb set
 * the classifier's bare-imperative rule uses, minus the informational-adjacent
 * ones: a second clause is a second JOB only when it opens with work.
 * "Create the campaign and explain why you chose it." stays one job — it is
 * exactly the mixed message spec 4.4 row 4 requires to make ONE card.
 */
const WORK_VERB =
  /^(reorder|schedule|order|book|send|draft|write|create|build|make|prepare|generate|design|plan|review|update|fix|publish|set|put|take|arrange|organize|install|renew)\b/i;

/** Clause boundaries: punctuation splices and explicit coordination. */
const CLAUSE_SPLIT = /\s*[,;—–]\s*|\s+\b(?:and|then|also|plus)\b\s+/i;

/**
 * ACC-001-11 — the separate jobs this message holds, as job titles.
 *
 * A clause counts as a job only when it OPENS with a work verb; at least two
 * such clauses make a multi-job message. Everything else returns the whole
 * message as one job:
 *  - "Build me a 10-slide deck for the November investor update." — one clause.
 *  - the item-15 ramble — clauses exist but none opens with work.
 *  - "Create the campaign and explain why you chose it." — the second clause
 *    is informational, not a job (A13: ONE card).
 */
export function splitJobs(message: string): string[] {
  const text = message.trim().replace(/\s+/g, ' ');
  if (!text) return [''];
  const clauses = text
    .split(CLAUSE_SPLIT)
    .map((c) => c.trim())
    .filter(Boolean);
  const jobs = clauses.filter((c) => WORK_VERB.test(c));
  const single = [text];
  return jobs.length >= 2 ? jobs.map((j) => j.replace(/[.]+$/, '')) : single;
}

/**
 * ACC-001-09 — the card reference a question-phrased change request names, or
 * null when the message is not one.
 *
 * Shape required: a change verb, an identifiable subject (never a bare
 * "it"/"this"), and the update preposition that carries the new value —
 * "change the webinar date to the 15th", "move the podcast recording to
 * Friday". "Can you change the banner to blue?" names no existing card; the
 * door's find then returns NONE and the message stays a new-task card, which
 * is exactly mc-route.sh's NOT_FOUND -> run `task` contract. JEV-501 is
 * untouched: a change with nothing on the board is still new work.
 */
export function changeRequestRef(message: string): string | null {
  const match = message
    .trim()
    .match(
      /\b(?:change|move|update|reschedule|push|shift|postpone|bump)\s+(?:the\s+|our\s+|my\s+|a\s+)?([a-z0-9][a-z0-9'’\- ]*?)\s+(?:to|for|into)\b/i,
    );
  if (!match) return null;
  const subject = match[1].trim();
  if (!subject) return null;
  if (/^(it|this|that|them|those|these|one|something|anything)$/i.test(subject)) return null;
  return subject;
}