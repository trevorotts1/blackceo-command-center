/**
 * Pure, framework-free model for the Anthology Engine card face + Gate Panel
 * (SPEC B11 / Unit U12). NO React, NO client-only imports — so it is unit
 * testable with the Node built-in test runner (`node --import tsx --test`) and
 * safe to import from both the list-view card (MissionQueue) and the modal
 * panel (GatePanel).
 *
 * WHY EVERYTHING IS DERIVED FROM `task` FIELDS THE CLIENT ALREADY HOLDS:
 * the Command Center never re-implements the ledger. `mc_board.py` (in the
 * Anthology engine skill) projects each ledger subject onto a board card via
 * POST /api/tasks/ingest + POST /api/tasks/{id}/status, and the Command Center
 * folds that provenance into the card's own columns:
 *
 *   • TITLE           "Anthology chapter — <name> · <anthology_id>"   (participant)
 *                     "Anthology assembly — <book name>"             (assembly)
 *   • DESCRIPTION     "…\n\n— Captured via task-ingest —\nSource: anthology\n
 *                      Ref: anthology:card:<contact_id>::<anthology_id>"
 *                     (the ingest route folds `source_ref` in as a `Ref:` line)
 *   • DESCRIPTION     "[status → review @ <iso>] stage_cursor=s2_gate"
 *                     (the status route appends every mc_board move-note as a
 *                      timestamped audit line — see /api/tasks/[id]/status)
 *
 * So the card face reads the participant name + book id from the TITLE, the
 * SOLE-WRITER subject key (participant_key | anthology_id) from the `Ref:` line,
 * and the live stage from the LAST `stage_cursor=` / `assembly_state=` note —
 * all without a single extra request. The subject key is what the Gate Panel
 * hands to GET/POST /api/anthology/gate (Unit U11); it is NOT reconstructable
 * from the title alone (the title carries no contact_id), which is exactly why
 * we read it from the `Ref:` provenance line.
 */

/** The minimal task shape this model needs. Structurally compatible with the
 *  full `Task` in src/lib/types.ts, but declared narrowly so the pure module
 *  never depends on the client store's types. */
export interface AnthologyTaskLike {
  title?: string | null;
  description?: string | null;
  source?: string | null;
  status?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/** Whether a board card is an Anthology Engine card. Prefers the immutable,
 *  server-stamped `tasks.source` column; falls back to the legacy
 *  `Source: anthology` description marker for pre-migration rows — the same
 *  precedence the status route's resolveBoardSource() uses. */
export function isAnthologyTask(task: AnthologyTaskLike | null | undefined): boolean {
  if (!task) return false;
  if (typeof task.source === 'string' && task.source.trim().toLowerCase() === 'anthology') {
    return true;
  }
  return /^Source:\s*anthology\s*$/m.test(task.description ?? '');
}

// --------------------------------------------------------------------------- //
// Stage vocabulary. Byte-for-byte the engine's stage_cursor names
// (anthology_state.STAGE_CURSORS, mirrored in mc_board.STATUS_BY_CURSOR).
// The 9-segment bar spans S0 → S9 (ten labelled points, nine segments between
// them): segment k is "lit" once the current stage index passes it.
// --------------------------------------------------------------------------- //

export const STAGE_LABELS: readonly string[] = [
  'Intake', // S0
  'Avatar', // S1
  'Tone', // S2
  'Title', // S3
  'Outline', // S4
  'Chapter', // S5
  'Rewrite', // S6
  'Cover', // S7
  'Deliver', // S8
  'Assembly', // S9
];

/** The last labelled point index (S9). The bar therefore has TOTAL_SEGMENTS = 9. */
export const MAX_STAGE_INDEX = STAGE_LABELS.length - 1; // 9
export const TOTAL_SEGMENTS = MAX_STAGE_INDEX; // 9 segments across S0..S9

/** stage_cursor → S-index (0..9). Every mirrored participant cursor maps here;
 *  the two exception cursors (held/exception) return null so the caller can
 *  render an "on hold / needs attention" chip instead of a stage. */
const CURSOR_TO_INDEX: Record<string, number | null> = {
  s0_intake: 0,
  s1_avatar: 1,
  s1_gate: 1,
  s2_tone: 2,
  s2_gate: 2,
  s3_title: 3,
  s3_gate: 3,
  s4_blurb_outline: 4,
  s4_gate_producer: 4,
  s4_gate_participant: 4,
  s5_chapter: 5,
  s5_gate: 5,
  s6_rewrite: 6,
  s7_cover: 7,
  s8_deliver: 8,
  s9_wait_assembly: 9,
  approved: 9,
  delivered: 9,
  held: null,
  exception: null,
};

/** assembly_state → S-index. The Assembly card lives entirely in S9. */
const ASSEMBLY_STATE_TO_INDEX: Record<string, number | null> = {
  not_ready: 9,
  armed: 9,
  ready_confirmed: 9,
  proposed: 9,
  adjusted: 9,
  compiled: 9,
  signed_off: 9,
};

export interface StageInfo {
  /** The live cursor / assembly_state string as read from the note. */
  cursor: string;
  /** S-index 0..9, or null for a held/exception cursor with no stage. */
  index: number | null;
  /** e.g. "S2". Null when index is null. */
  code: string | null;
  /** e.g. "Tone". A friendly label for a held/exception cursor otherwise. */
  label: string;
  /** e.g. "S2 · Tone" — the card's stage badge. */
  badge: string;
  /** true when the cursor is a durable hold / exception (no stage number). */
  exceptional: boolean;
}

function stageFromCursor(cursor: string, isAssembly: boolean): StageInfo | null {
  const c = cursor.trim();
  if (!c) return null;
  const index = isAssembly ? ASSEMBLY_STATE_TO_INDEX[c] : CURSOR_TO_INDEX[c];
  if (index === undefined) return null; // unrecognized cursor — do not guess

  if (index === null) {
    // held | exception — no S-number; render a plain-language chip.
    const label = c === 'held' ? 'On hold' : 'Needs attention';
    return { cursor: c, index: null, code: null, label, badge: label, exceptional: true };
  }
  const code = `S${index}`;
  const label = STAGE_LABELS[index] ?? c;
  return { cursor: c, index, code, label, badge: `${code} · ${label}`, exceptional: false };
}

// --------------------------------------------------------------------------- //
// Provenance parsing (all from `task.description`).
// --------------------------------------------------------------------------- //

/** The `Ref: anthology:(card|assembly):<subjectKey>` provenance line the ingest
 *  route folds in from mc_board's `source_ref`. Returns the SOLE-WRITER subject
 *  key + whether it is a participant (card) or assembly subject. */
export function extractSubject(
  description: string | null | undefined
): { subjectKey: string; kind: 'participant' | 'anthology' } | null {
  if (!description) return null;
  const m = description.match(/^Ref:\s*anthology:(card|assembly):(\S.*?)\s*$/m);
  if (!m) return null;
  const subjectKey = m[2].trim();
  if (!subjectKey) return null;
  return { subjectKey, kind: m[1] === 'assembly' ? 'anthology' : 'participant' };
}

/**
 * INGEST WRITE-SIDE companion to extractSubject(). The board's card parsers read
 * the sole-writer subject key ONLY from a `Ref: anthology:(card|assembly):<key>`
 * description line (the tasks table has no source_ref column). mc_board.py carries
 * that key as the ingest `idempotency_key` (`anthology:assembly:<aid>` /
 * `anthology:card:<pk>`) but may not send a separate `source_ref`. This resolves
 * the value the ingest route should fold into the `Ref:` line so the anthology_id
 * reaches the card the client holds: an explicit `source_ref` wins; otherwise an
 * anthology-subject idempotency_key is surfaced; otherwise undefined (the honest
 * "not wired" state). Pure + framework-free so it is unit-testable and import-safe
 * from the server route. Dedupe is unaffected — the dedupe key is computed
 * independently of this Ref surfacing.
 */
export function resolveIngestSourceRef(
  sourceRef: string | null | undefined,
  idempotencyKey: string | null | undefined
): string | undefined {
  const explicit = (sourceRef ?? '').trim();
  if (explicit) return explicit;
  const key = (idempotencyKey ?? '').trim();
  return /^anthology:(?:card|assembly):\S+$/i.test(key) ? key : undefined;
}

/** The LAST `stage_cursor=<value>` (participant) or `assembly_state=<value>`
 *  (assembly) note the status route appended. The latest note wins — a card is
 *  re-synced on every ledger move, so the final occurrence is the live cursor. */
export function extractLatestCursor(
  description: string | null | undefined,
  isAssembly: boolean
): string | null {
  if (!description) return null;
  const key = isAssembly ? 'assembly_state' : 'stage_cursor';
  const re = new RegExp(`${key}=([A-Za-z0-9_]+)`, 'g');
  const matches = Array.from(description.matchAll(re));
  return matches.length ? matches[matches.length - 1][1] : null;
}

const CHAPTER_PREFIX = 'Anthology chapter — ';
const ASSEMBLY_PREFIX = 'Anthology assembly — ';
const TITLE_SEP = ' · ';

/** Participant display name + anthology id, parsed from the card TITLE built by
 *  mc_board._participant_title(): "Anthology chapter — <name> · <anthology_id>".
 *  Falls back gracefully when the title was clipped to just the id. */
function parseParticipantTitle(title: string): { name: string | null; anthologyId: string | null } {
  let rest = title;
  if (rest.startsWith(CHAPTER_PREFIX)) rest = rest.slice(CHAPTER_PREFIX.length);
  const sepAt = rest.lastIndexOf(TITLE_SEP);
  if (sepAt === -1) {
    // No " · <id>" suffix survived. If the prefix was present the remainder is
    // the name; otherwise the whole title is the (degenerate) id-only clip.
    return title.startsWith(CHAPTER_PREFIX)
      ? { name: rest.trim() || null, anthologyId: null }
      : { name: null, anthologyId: rest.trim() || null };
  }
  return {
    name: rest.slice(0, sepAt).trim() || null,
    anthologyId: rest.slice(sepAt + TITLE_SEP.length).trim() || null,
  };
}

export interface AnthologyCard {
  kind: 'participant' | 'anthology';
  /** participant_key (contains "::") or anthology_id — the Gate Panel subject. */
  subjectKey: string | null;
  /** The Assembly card's book name, or the participant's display name. */
  displayName: string | null;
  /** First token of the display name, for "Approve & Release to <first name>". */
  firstName: string | null;
  /** The book id chip (anthology_id). On a participant card this is the only
   *  book identifier the title carries; the human book NAME lives on the
   *  Assembly card, not the chapter card. */
  bookId: string | null;
  /** Live stage, or null when it cannot be determined from the notes. */
  stage: StageInfo | null;
  isAssembly: boolean;
}

/** Parse an Anthology board card into its face fields. Returns null when the
 *  task is not an Anthology card (so callers can no-op cleanly). */
export function parseAnthologyCard(task: AnthologyTaskLike | null | undefined): AnthologyCard | null {
  if (!isAnthologyTask(task) || !task) return null;

  const title = (task.title ?? '').trim();
  const subject = extractSubject(task.description);
  const isAssembly =
    subject?.kind === 'anthology' || title.startsWith(ASSEMBLY_PREFIX);

  let displayName: string | null = null;
  let bookId: string | null = null;

  if (isAssembly) {
    displayName = title.startsWith(ASSEMBLY_PREFIX)
      ? title.slice(ASSEMBLY_PREFIX.length).trim() || null
      : title || null;
    // The assembly subject key IS the anthology id.
    bookId = subject?.subjectKey ?? null;
  } else {
    const parsed = parseParticipantTitle(title);
    displayName = parsed.name;
    // Prefer the id parsed from the title; fall back to the "::"-suffix of the
    // participant_key when the title lost its disambiguator to truncation.
    bookId =
      parsed.anthologyId ||
      (subject?.subjectKey.includes('::')
        ? subject.subjectKey.split('::', 2)[1] || null
        : null);
  }

  const firstName = displayName ? displayName.split(/\s+/)[0] || null : null;

  const cursor = extractLatestCursor(task.description, isAssembly);
  const stage = cursor ? stageFromCursor(cursor, isAssembly) : null;

  return {
    kind: isAssembly ? 'anthology' : 'participant',
    subjectKey: subject?.subjectKey ?? null,
    displayName,
    firstName,
    bookId,
    stage,
    isAssembly,
  };
}

// --------------------------------------------------------------------------- //
// "Waiting on you" age (only meaningful while the card sits in Review — the
// producer's approval queue). Derived from `updated_at`, which is stamped on
// every status move, so it measures time-since-this-gate-opened.
// --------------------------------------------------------------------------- //

/** A short "waiting on you for N days / N hours" string, or null when the card
 *  is not in Review or has no usable timestamp. `now` is injectable for tests. */
export function waitingAge(
  task: AnthologyTaskLike | null | undefined,
  now: number = Date.now()
): string | null {
  if (!task || (task.status ?? '') !== 'review') return null;
  const stamp = task.updated_at || task.created_at;
  if (!stamp) return null;
  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return null;
  const ms = Math.max(0, now - then);
  const mins = Math.floor(ms / 60000);
  if (mins < 60) {
    return mins <= 1 ? 'waiting on you' : `waiting on you for ${mins} minutes`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `waiting on you for ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.floor(hours / 24);
  return `waiting on you for ${days} ${days === 1 ? 'day' : 'days'}`;
}

// --------------------------------------------------------------------------- //
// Artifact links for the "work" zone. Read-only extraction from the card's
// own text (delivery notes drop the PDF / editable-Doc links into the
// description). We classify but never fabricate: if nothing is posted yet, the
// caller renders an honest "no deliverable yet" state.
// --------------------------------------------------------------------------- //

export type ArtifactKind = 'pdf' | 'doc' | 'link';

export interface Artifact {
  url: string;
  kind: ArtifactKind;
}

function classifyUrl(url: string): ArtifactKind {
  const u = url.toLowerCase();
  if (/\.pdf(\?|#|$)/.test(u) || /\/pdf(\/|\?|#|$)/.test(u)) return 'pdf';
  if (u.includes('docs.google.com/document') || u.includes('docs.google.com/open')) {
    return 'doc';
  }
  if (u.includes('docs.google.com')) return 'doc';
  return 'link';
}

/** Unique http(s) links found in the text, classified as pdf / doc / link, in
 *  first-seen order. Trailing punctuation is trimmed so a URL at the end of a
 *  sentence still resolves. */
export function extractArtifacts(text: string | null | undefined): Artifact[] {
  if (!text) return [];
  const out: Artifact[] = [];
  const seen = new Set<string>();
  for (const m of Array.from(text.matchAll(/https?:\/\/[^\s<>"')]+/g))) {
    const url = m[0].replace(/[.,;:]+$/, '');
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: classifyUrl(url) });
  }
  return out;
}
