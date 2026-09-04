// U060: the 26 manifest phase ids collapsed to 7 client-facing labels.
// EXCLUSIVE (each id appears exactly once) and TOTAL (every id appears).
// No wildcards: a glob over ids cannot see P-SP-P3-HYGIENE, which is a QC
// phase whose id does not end in -QC.
//
// Two design choices are deliberate and must NOT be "fixed":
//   (i) per-stage QC lives in its stage — P1Q-COPY-QC in Script, P-TYPO-QC /
//       P-PROMPT-QC in Prompts, P-IMAGE-QC in Images — because a client watching
//       "Images 41/62" wants the image QC inside that bar, not in a separate
//       bucket that turns amber halfway through. The standalone QC label carries
//       only the two cross-cutting gates.
//   (ii) P9-SPEECH is Script, not Delivered — it produces PRESENTERS-SPEECH.md,
//        a script artifact, and putting it in Delivered would make a card show
//        "Delivered: in progress" while nothing has shipped.
//
// Per-label counts: Intake 9 · Script 5 · Prompts 4 · Images 3 · Teleprompter 0
// · QC 2 · Delivered 3. Checksum 9+5+4+3+0+2+3 = 26.

export const PHASE_LABELS = ['Intake','Script','Prompts','Images','Teleprompter','QC','Delivered'] as const;

export const PHASE_TO_LABEL: Record<string, typeof PHASE_LABELS[number]> = {
  'P-CONVERTER':        'Intake',
  'P-0.5-RESEARCH':     'Intake',
  'P0A-INTAKE':         'Intake',
  'P-SP-CLAIM':         'Intake',
  'P-SP-INTAKE':        'Intake',
  'P-SP-INTAKE-TRACE':  'Intake',
  'P0B-PRIORITY':       'Intake',
  'P3-ARC':             'Intake',
  'P-3.5-RESEARCH-MAP': 'Intake',
  'P4-COPY':            'Script',
  'P-SP-STRUCTURE':     'Script',
  'P-SP-P3-HYGIENE':    'Script',
  'P1Q-COPY-QC':        'Script',
  'P9-SPEECH':          'Script',
  'PF-DESIGN':          'Prompts',
  'P-TYPO-QC':          'Prompts',
  'P4-PROMPT':          'Prompts',
  'P-PROMPT-QC':        'Prompts',
  'P-STYLE-PREVIEW':    'Images',
  'P4-RENDER':          'Images',
  'P-IMAGE-QC':         'Images',
  'P-SHIFT-QC':         'QC',
  'P-SPEECH-QC':        'QC',
  'P8-ASSEMBLE':        'Delivered',
  'P9.5-NOTES-SYNC':    'Delivered',
  'P9-DELIVER':         'Delivered',
};

// Teleprompter has NO manifest phase. Its status is derived from deliverable
// presence, never from task_activities. The teleprompter is produced by
// build_teleprompter.py (1,643 lines, self-contained HTML, zero <link /
// script src / <img). Eventually U019 may add a phase id for it; when that
// lands, the reducer treats it as an additional signal, not a replacement
// — see computePhaseProgress.
export const DELIVERABLE_DERIVED_LABELS = ['Teleprompter'] as const;

// FIX 50b — teleprompter detection by basename. The registration contract
// (CreateDeliverableSchema, validation.ts) pins deliverable_type to the enum
// file|url|artifact|image — there IS no 'teleprompter' type, and the engine's
// register_deliverable (cc_board.py) posts type 'url' or 'artifact' with the
// artifact's location in `path`. A reducer that tests the type string can
// therefore NEVER see a real teleprompter row. The teleprompter's identity is
// its basename: presenter-teleprompter.html, the same name build_deck.py
// writes (DELIVERABLES_REQUIRED) and completion-evidence.ts's BUNDLE_SPECS
// matches by. Routes must SELECT the `path` column and pass it through.
export const TELEPROMPTER_BASENAME = 'presenter-teleprompter.html';

/**
 * FIX 50b — true when a deliverable row IS the teleprompter.
 *
 * Two accepted signals, OR-ed:
 *   1. basename match — path's final `/`-segment (or `\\`, for Windows-style
 *      paths that arrive through the ingest) equals presenter-teleprompter.html;
 *      trimming first, since registration paths have historically carried
 *      stray whitespace.
 *   2. legacy exact-type row — deliverable_type === 'teleprompter'. No writer
 *      emits it today (the Zod enum forbids it), but the type stays accepted so
 *      any fixture / hand-seeded row keeps meaning what it always meant.
 */
export function isTeleprompterDeliverable(d: {
  deliverable_type: string;
  path?: string | null;
}): boolean {
  if (d.deliverable_type === 'teleprompter') return true;
  const raw = d.path;
  if (typeof raw !== 'string') return false;
  const base = raw.trim().split('/').pop()?.split('\\').pop() ?? '';
  return base === TELEPROMPTER_BASENAME;
}

export const PHASE_ACTIVITY_METADATA_KEY = 'phase_id';

/**
 * Extract the phase id from an activity's metadata. `metadata` may be a nested
 * object or a pre-stringified JSON string — validation.ts:152 accepts both.
 * Returns null — never throws — for absent, malformed, or wrong-shaped input.
 * An id that is NOT in PHASE_TO_LABEL is still RETURNED here; the reducer is
 * what records it in `unmapped`. Filtering unknown ids to null inside this
 * function reads as defensive and silently destroys `unmapped`.
 */
export function phaseIdOf(
  activity: { metadata?: string | Record<string, unknown> | null },
): string | null {
  const raw = activity?.metadata;
  if (raw == null) return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const v = (obj as Record<string, unknown>)[PHASE_ACTIVITY_METADATA_KEY];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * FIX 52 (W18a-B3) — a child card's display label, derived from data instead
 * of the child's title text. Resolution order, most authoritative first:
 *   1. tasks.stage_slug — the explicit phase id a producer stamped on the row
 *      (FIX 52/W16a: ingest accepts `phase_id` and persists it as stage_slug).
 *      Any id PHASE_TO_LABEL knows maps directly ('P4-COPY' → Script).
 *   2. the child's own task_activities metadata.phase_id (the pre-W16a
 *      signal) — first mapped id wins.
 *   3. legacy title-substring match — last resort, only so pre-existing rows
 *      created before any phase signal existed still show something sensible.
 * Returns null when nothing matches: the caller decides its own fallback
 * (the raw title), exactly the way the old title-only code did.
 */
export function childPhaseLabel(input: {
  stage_slug?: string | null;
  activities?: Array<{ activity_type: string; metadata?: string | Record<string, unknown> | null }>;
  title?: string | null;
}): typeof PHASE_LABELS[number] | null {
  // 1. Explicit stage_slug on the row — the FIX 52 write path.
  if (typeof input.stage_slug === 'string' && input.stage_slug.length > 0) {
    const mapped = PHASE_TO_LABEL[input.stage_slug];
    if (mapped) return mapped;
  }
  // 2. Phase id carried in the child's activity metadata.
  if (input.activities) {
    for (const a of input.activities) {
      const id = phaseIdOf(a);
      if (id == null) continue;
      const mapped = PHASE_TO_LABEL[id];
      if (mapped) return mapped;
    }
  }
  // 3. Legacy fallback: title contains a label verbatim (case-insensitive).
  if (typeof input.title === 'string' && input.title.length > 0) {
    const lower = input.title.toLowerCase();
    for (const label of PHASE_LABELS) {
      if (lower.includes(label.toLowerCase())) return label;
    }
  }
  return null;
}

export type PhaseStepStatus = 'not_started' | 'in_progress' | 'done';

/**
 * FIX 50a (R5A §H3) — activity types that mark a phase COMPLETED.
 *
 * The engine logs phase completion in two shapes:
 *   - 'phase_completed'  — FIX 37 enum widening (validation.ts), the
 *                          first-class signal the engine writes per phase id
 *   - 'completed'        — the pre-existing generic activity type that the
 *                          engine's per-phase writers used before the enum
 *                          widened (and still do on older runs in the DB)
 *
 * Before this fix computePhaseProgress could never emit `done` for an
 * activity-derived label — any phase id seen in activities stayed
 * `in_progress` forever, so the stepper could never show a green step and a
 * phase card could never be read as finished from the board.
 */
export const PHASE_COMPLETED_ACTIVITY_TYPES = [
  'completed',
  'phase_completed',
] as const;

function isPhaseCompletedActivity(activityType: string): boolean {
  return (PHASE_COMPLETED_ACTIVITY_TYPES as readonly string[]).includes(
    activityType,
  );
}

export interface PhaseProgressStep {
  label: typeof PHASE_LABELS[number];
  status: PhaseStepStatus;
}

export interface PhaseProgress {
  phases: PhaseProgressStep[];   // always 7, in PHASE_LABELS order
  unmapped: string[];            // phase ids seen that PHASE_TO_LABEL does not know
}

/**
 * Pure function — no DB access of its own. The route queries task_activities and
 * task_deliverables and passes the rows straight through, so this function, and
 * only this function, is what QC-2 and QC-3 call directly: no running server,
 * no duplicated reduction logic between the test and the route.
 */
export function computePhaseProgress(
  activities: Array<{ activity_type: string; metadata?: string | Record<string, unknown> | null }>,
  deliverables: Array<{ deliverable_type: string; path?: string | null }>,
): PhaseProgress {
  const seen = new Set<string>();
  const completed = new Set<string>();
  const unmapped: string[] = [];
  for (const a of activities) {
    const id = phaseIdOf(a);
    if (id == null) continue;
    const label = PHASE_TO_LABEL[id];
    if (label == null) { if (!unmapped.includes(id)) unmapped.push(id); continue; }
    seen.add(label);
    // FIX 50a — a completion-typed activity marks the label done, not just
    // started. Only a mapped label can be completed; an unmapped id is
    // recorded in `unmapped` and never advances a bar.
    if (isPhaseCompletedActivity(a.activity_type)) completed.add(label);
  }
  // FIX 50b — teleprompter detected by basename (path column) OR the legacy
  // 'teleprompter' type. Callers must SELECT path; a row without one only
  // matches via the legacy type.
  const hasTeleprompterDeliverable = deliverables.some(isTeleprompterDeliverable);
  const phases: PhaseProgressStep[] = PHASE_LABELS.map((label) => {
    if (label === 'Teleprompter') {
      return { label, status: hasTeleprompterDeliverable ? 'done' : 'not_started' };
    }
    if (completed.has(label)) return { label, status: 'done' };
    return { label, status: seen.has(label) ? 'in_progress' : 'not_started' };
  });
  return { phases, unmapped };
}

/**
 * FIX 53 (R5A §E, §H6) — per-label elapsed seconds from stage-timing rows.
 *
 * The presentation engine's stage-timings stream (one `phase_exit` row per
 * executed phase, POSTed to /api/presentations/stage-timings) is the ONLY
 * wall-clock source the stepper has — task_activities carry no durations.
 * This reducer turns raw rows into { label → seconds } so the phases route
 * can fill `elapsed_s` per step (previously hardcoded null) and the stepper
 * can show how long each bar took.
 *
 * PURE — no DB access, same contract as computePhaseProgress: the route runs
 * the SQL, this function runs the arithmetic, so the QC proof (FIX 53) can
 * call it directly without a server.
 *
 * LATEST-RUN semantics: rows arrive ordered by insertion (rowid). The run of
 * the LAST row with a run_id is the current run; only that run's rows sum.
 * A re-run therefore REPLACES the previous run's elapsed rather than
 * accumulating it — a job re-executed twice must not report the sum of both.
 * run_summary rows (phase_id null) contribute nothing.
 */
export interface StageTimingRowLite {
  run_id: string;
  phase_id: string | null;
  duration_s: number | null;
}

export type PhaseElapsedSeconds = Partial<
  Record<(typeof PHASE_LABELS)[number], number>
>;

export function phaseElapsedSeconds(
  rows: StageTimingRowLite[],
): PhaseElapsedSeconds {
  const elapsed: PhaseElapsedSeconds = {};
  if (rows.length === 0) return elapsed;

  // Latest run = run_id of the last row that carries one (rows are inserted
  // in engine emission order, and every row carries a NOT NULL run_id).
  let latestRun: string | null = null;
  for (const r of rows) {
    if (typeof r.run_id === 'string' && r.run_id.length > 0) latestRun = r.run_id;
  }
  if (latestRun == null) return elapsed;

  for (const r of rows) {
    if (r.run_id !== latestRun) continue;
    if (typeof r.phase_id !== 'string' || r.phase_id.length === 0) continue;
    if (typeof r.duration_s !== 'number' || !Number.isFinite(r.duration_s)) continue;
    const label = PHASE_TO_LABEL[r.phase_id];
    if (label == null) continue; // unmapped ids never advance a bar (same rule as computePhaseProgress)
    elapsed[label] = (elapsed[label] ?? 0) + r.duration_s;
  }
  return elapsed;
}
