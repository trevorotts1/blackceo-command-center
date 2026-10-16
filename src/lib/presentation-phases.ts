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

// ── Item 19 (FIX-PLAN) — the P-U upsell branch ─────────────────────────────
// The canonical PIPELINE-MANIFEST (v70) carries 22 P-U-* phase ids. None of
// them is in PHASE_TO_LABEL: the U060 table maps the 26 main-line ids, and
// its totality test pins exactly those 26. Before Item 19 every P-U activity
// therefore landed in the reducer's `unmapped` bucket, which no surface
// renders — a run that elected the sales/checkout or VSL branch built those
// pages invisibly (the diagnostic's forever-amber finding: the branch could
// neither complete nor be seen running).
//
// The branch maps to its OWN stepper steps, inserted after Images, and a
// step exists ONLY for a branch the run actually elected (or, when the
// election record cannot be read, a branch with real engine activity — the
// engine emits P-U signals only for elected branches, because the manifest's
// defers_unless gates defer the rest). A declined branch produces NO step:
// no phantom steps, and no main label waits forever on a phase that will
// never run.
//
// Grouping follows the manifest's own structure (defers_unless in
// parentheses; orders are the manifest's):
//   Sales Page — want_sales_checkout: P-U-SALES-COPY (3.6), P-U-DESIGN-SALES
//     (4.2), P-U-DESIGN-RENDER-SALES (4.21), P-U-HTML-SALES (5.2),
//     P-U-GHL-SALES (6.2, the GHL install), P-U-SALES-BUILD (8.75, ungated
//     build step of the same branch).
//   Checkout — want_sales_checkout: P-U-CHECKOUT-COPY (3.7),
//     P-U-DESIGN-CHECKOUT (4.3), P-U-DESIGN-RENDER-CHECKOUT (4.31),
//     P-U-HTML-CHECKOUT (5.3), P-U-CHECKOUT-BUILD (8.76, ungated),
//     P-U-FORM-CHECKOUT (8.77, ungated payment/lead form wiring).
//   VSL Page — want_vsl_page: P-U-VSL-RESEARCH (3.8), P-U-VSL-COPY (3.9),
//     P-U-DESIGN-VSL (4.4), P-U-DESIGN-RENDER-VSL (4.41), P-U-HTML-VSL (5.4),
//     P-U-FORM-GATE (5.6), P-U-GHL-VSL (6.4, the GHL install),
//     P-U-VSL-BUILD (8.93, ungated).
export const UPSELL_LABELS = ['Sales Page', 'Checkout', 'VSL Page'] as const;

export type PhaseStepLabel =
  | (typeof PHASE_LABELS)[number]
  | (typeof UPSELL_LABELS)[number];

export const UPSELL_PHASE_TO_LABEL: Record<string, (typeof UPSELL_LABELS)[number]> = {
  'P-U-SALES-COPY':           'Sales Page',
  'P-U-DESIGN-SALES':         'Sales Page',
  'P-U-DESIGN-RENDER-SALES':  'Sales Page',
  'P-U-HTML-SALES':           'Sales Page',
  'P-U-GHL-SALES':            'Sales Page',
  'P-U-SALES-BUILD':          'Sales Page',
  'P-U-CHECKOUT-COPY':        'Checkout',
  'P-U-DESIGN-CHECKOUT':      'Checkout',
  'P-U-DESIGN-RENDER-CHECKOUT': 'Checkout',
  'P-U-HTML-CHECKOUT':        'Checkout',
  'P-U-CHECKOUT-BUILD':       'Checkout',
  'P-U-FORM-CHECKOUT':        'Checkout',
  'P-U-VSL-RESEARCH':         'VSL Page',
  'P-U-VSL-COPY':             'VSL Page',
  'P-U-DESIGN-VSL':           'VSL Page',
  'P-U-DESIGN-RENDER-VSL':    'VSL Page',
  'P-U-HTML-VSL':             'VSL Page',
  'P-U-FORM-GATE':            'VSL Page',
  'P-U-GHL-VSL':              'VSL Page',
  'P-U-VSL-BUILD':            'VSL Page',
};

// The two shared wrap-up phases gate on EITHER election
// (defers_unless: want_sales_checkout == "yes" or want_vsl_page == "yes").
// They are not steps of their own: P-U-QC is the upsell QC gate and joins
// the QC label's required set, and P-U-COLLATERAL (the delivery backup of
// the upsell pages) joins Delivered's — ONLY for a run with an active
// upsell branch, so a deck-only run's QC stays 2 units and Delivered 3.
export const UPSELL_SHARED_PHASE_TO_LABEL: Record<string, (typeof PHASE_LABELS)[number]> = {
  'P-U-QC':         'QC',
  'P-U-COLLATERAL': 'Delivered',
};

/** The branch a P-U phase id belongs to ('either' = the shared wrap-up). */
export function upsellBranchOfPhase(
  phaseId: string,
): 'sales_checkout' | 'vsl' | 'either' | null {
  const label = UPSELL_PHASE_TO_LABEL[phaseId];
  if (label === 'Sales Page' || label === 'Checkout') return 'sales_checkout';
  if (label === 'VSL Page') return 'vsl';
  if (phaseId in UPSELL_SHARED_PHASE_TO_LABEL) return 'either';
  return null;
}

/** True when the id is any of the 22 manifest P-U ids. */
export function isUpsellPhaseId(phaseId: string): boolean {
  return upsellBranchOfPhase(phaseId) != null;
}

/**
 * A run's upsell elections, resolved from the engine's own records (the
 * sealed intake record's pre_presentation_capture answers, or the operator
 * contract's yes/no fields). `null` means UNDETERMINED — no readable
 * election record — never a guess in either direction.
 */
export interface UpsellElections {
  salesCheckout: boolean;
  vsl: boolean;
}

/**
 * The label ANY known phase id (main line, upsell branch, or shared
 * wrap-up) belongs to, or null for an id no table knows.
 */
export function labelForPhaseId(phaseId: string): PhaseStepLabel | null {
  return (
    PHASE_TO_LABEL[phaseId] ??
    UPSELL_PHASE_TO_LABEL[phaseId] ??
    UPSELL_SHARED_PHASE_TO_LABEL[phaseId] ??
    null
  );
}

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

// PRES-040 (W3 WF12-B) — activity schema version the producer stamps in
// metadata and the install preflight negotiates. Version 1 is the first
// versioned shape: { phase_id, event_id, schema_version: 1, ... }. Unversioned
// legacy rows (no schema_version) are read as version 0 — historical data,
// never silently promoted to current. The consumer accepts 0 and 1; a future
// version 2 event stays PENDING (not applied) until the consumer upgrades,
// which is exactly the replay-after-upgrade path the producer outbox serves.
export const ACTIVITY_SCHEMA_VERSION = 1;
export const ACTIVITY_SCHEMA_KNOWN_VERSIONS: readonly number[] = [0, 1];

/**
 * Extract the phase id from an activity's metadata. `metadata` may be a nested
 * object or a pre-stringified JSON string — validation.ts:152 accepts both.
 * Returns null — never throws — for absent, malformed, or wrong-shaped input.
 * An id that is NOT in PHASE_TO_LABEL is still RETURNED here; the reducer is
 * what records it in `unmapped`. Filtering unknown ids to null inside this
 * function reads as defensive and silently destroys `unmapped`.
 *
 * PRES-040: a caller that needs the version/event identity uses
 * activitySchemaInfo() alongside — this function keeps its exact contract
 * (phase id or null) so every existing reducer is untouched.
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
 * PRES-040 companion to phaseIdOf: the structured identity of an activity
 * row — schema version (0 when the producer stamped none), event id, and
 * whether the consumer understands the version. Never throws. Malformed
 * metadata yields { version: 0, eventId: null, known: true } — a historical
 * text note, readable but never structured-verified.
 */
export function activitySchemaInfo(
  activity: { metadata?: string | Record<string, unknown> | null },
): { version: number; eventId: string | null; known: boolean } {
  const raw = activity?.metadata;
  if (raw == null) return { version: 0, eventId: null, known: true };
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { version: 0, eventId: null, known: true }; }
  }
  if (typeof obj !== 'object' || obj === null) return { version: 0, eventId: null, known: true };
  const rec = obj as Record<string, unknown>;
  const v = rec.schema_version;
  const version = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0;
  const e = rec.event_id;
  const eventId = typeof e === 'string' && e.length > 0 ? e : null;
  return { version, eventId, known: (ACTIVITY_SCHEMA_KNOWN_VERSIONS as readonly number[]).includes(version) };
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
}): PhaseStepLabel | null {
  // 1. Explicit stage_slug on the row — the FIX 52 write path.
  if (typeof input.stage_slug === 'string' && input.stage_slug.length > 0) {
    const mapped = labelForPhaseId(input.stage_slug);
    if (mapped) return mapped;
  }
  // 2. Phase id carried in the child's activity metadata.
  if (input.activities) {
    for (const a of input.activities) {
      const id = phaseIdOf(a);
      if (id == null) continue;
      const mapped = labelForPhaseId(id);
      if (mapped) return mapped;
    }
  }
  // 3. Legacy fallback: title contains a label verbatim (case-insensitive).
  if (typeof input.title === 'string' && input.title.length > 0) {
    const lower = input.title.toLowerCase();
    for (const label of [...PHASE_LABELS, ...UPSELL_LABELS]) {
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
  label: PhaseStepLabel;
  status: PhaseStepStatus;
  /** PRES-020 — how many required phase ids of this label are done. */
  doneIds: number;
  /** PRES-020 — how many required phase ids of this label apply here. */
  totalIds: number;
  /**
   * Item 19 — the exact required phase ids behind this step, so consumers
   * (the phases route's receipt projection) never re-derive a set that can
   * drift from the one the reducer scored.
   */
  requiredIds: string[];
}

/**
 * PRES-020 — required phase ids per label. The defect: computePhaseProgress
 * collected completed LABELS, so any single completion-typed activity (e.g.
 * P4-COPY alone) flipped the whole Script label `done` before structure,
 * copy QC, or speech ran. The fix: a label is `done` only when EVERY
 * required phase id of that label has a completion signal. The required set
 * is exactly the manifest table above, minus labels the caller explicitly
 * excludes (optional / not-applicable phases, approved manifest only) via
 * `excludedPhaseIds`. DELIVERABLE_DERIVED_LABELS (Teleprompter) never takes
 * part: no manifest phase id maps to it, so it stays deliverable-derived.
 */
export function requiredPhaseIdsForLabel(
  label: PhaseStepLabel,
  excludedPhaseIds?: ReadonlySet<string> | ReadonlyArray<string> | null,
  elections?: UpsellElections | null,
): string[] {
  const excluded =
    excludedPhaseIds instanceof Set
      ? excludedPhaseIds
      : new Set(excludedPhaseIds ?? []);
  // Item 19 — an upsell branch label's required set is its manifest ids.
  // With elections KNOWN and the branch declined, the set is empty (the
  // phases are deferred for this run; nothing may wait on them).
  if ((UPSELL_LABELS as readonly string[]).includes(label)) {
    if (elections != null) {
      const active =
        label === 'VSL Page' ? elections.vsl : elections.salesCheckout;
      if (!active) return [];
    }
    return Object.entries(UPSELL_PHASE_TO_LABEL)
      .filter(([id, l]) => l === label && !excluded.has(id))
      .map(([id]) => id);
  }
  const main = Object.entries(PHASE_TO_LABEL)
    .filter(([id, l]) => l === label && !excluded.has(id))
    .map(([id]) => id);
  // Item 19 — the shared wrap-up ids join their main label ONLY when the
  // caller knows an upsell branch is active for this run.
  if (elections != null && (elections.salesCheckout || elections.vsl)) {
    for (const [id, l] of Object.entries(UPSELL_SHARED_PHASE_TO_LABEL)) {
      if (l === label && !excluded.has(id)) main.push(id);
    }
  }
  return main;
}

export interface PhaseProgress {
  // The 7 main steps in PHASE_LABELS order, plus — Item 19 — one step per
  // ACTIVE upsell branch (Sales Page / Checkout / VSL Page) inserted after
  // Images. Inactive or unevidenced branches emit no step at all.
  phases: PhaseProgressStep[];
  unmapped: string[];            // phase ids seen that no mapping table knows
}

export interface PhaseActivityLite {
  activity_type: string;
  metadata?: string | Record<string, unknown> | null;
  /**
   * PRES-020 — the run/attempt this activity belongs to. Rows are compared
   * as opaque strings: activities whose scope differs from the ACTIVE scope
   * (see `activeScope` on the options) are obsolete — a late completion from
   * an old attempt must not override a retry. Rows WITHOUT a scope stay
   * visible for back-compat (the engine's phase rows never carried run
   * identity; FIX 57 keeps it on the card's provenance lines instead).
   */
  run_id?: string | null;
  attempt_id?: string | number | null;
}

export interface ComputePhaseProgressOptions {
  /**
   * PRES-020 — phase ids that do NOT apply to this run (approved manifest's
   * optional / not-applicable set). A label with zero remaining required ids
   * is `done` only when at least one completion touched the label — the
   * exclusion is then real work the manifest waived, not an empty vacuous
   * pass over a label the run never started.
   */
  excludedPhaseIds?: ReadonlySet<string> | ReadonlyArray<string> | null;
  /**
   * PRES-020 — completion receipts per phase id. A completion-typed activity
   * marks the id done ONLY when its receipt validates (id present and
   * explicitly true). Teleprompter completions still require the deliverable
   * signal (see FIX 50b): presence alone never completes it. When omitted,
   * every completion-typed activity counts (legacy behavior for callers that
   * have no receipt source).
   */
  completionReceipts?: Record<string, boolean | null | undefined> | null;
  /**
   * PRES-020 — the authoritative run/attempt scope. When set, scoped rows
   * outside it are obsolete and ignored; unscoped rows still count.
   */
  activeScope?: { run_id?: string | null; attempt_id?: string | number | null } | null;
  /**
   * Item 19 — the run's upsell elections, when a caller could read them
   * from the engine's own records. Known elections decide branch-step
   * emission exactly (elected → step with real states; declined → NO step).
   * When omitted/null (UNDETERMINED), a branch step is emitted only on real
   * engine evidence for that branch — the engine emits P-U signals only for
   * elected branches, so evidence is proof of election, and its absence
   * keeps the stepper at the 7 main steps rather than inventing branches.
   */
  electedBranches?: UpsellElections | null;
}

function scopeOf(a: PhaseActivityLite): string | null {
  const run = typeof a.run_id === 'string' && a.run_id.length > 0 ? a.run_id : null;
  const att =
    typeof a.attempt_id === 'string'
      ? (a.attempt_id.length > 0 ? a.attempt_id : null)
      : typeof a.attempt_id === 'number' && Number.isFinite(a.attempt_id)
        ? String(a.attempt_id)
        : null;
  if (run == null && att == null) return null;
  return JSON.stringify([run, att]);
}

function scopeActive(
  rowScope: string | null,
  active: { run_id?: string | null; attempt_id?: string | number | null } | null | undefined,
): boolean {
  // No authoritative scope: nothing is obsolete (legacy callers).
  if (active == null) return true;
  // Unscoped row: still visible (engine phase rows carry no run identity).
  if (rowScope == null) return true;
  const activeRun = typeof active.run_id === 'string' && active.run_id.length > 0 ? active.run_id : null;
  const activeAtt =
    typeof active.attempt_id === 'string'
      ? (active.attempt_id.length > 0 ? active.attempt_id : null)
      : typeof active.attempt_id === 'number' && Number.isFinite(active.attempt_id)
        ? String(active.attempt_id)
        : null;
  if (activeRun == null && activeAtt == null) return true;
  return rowScope === JSON.stringify([activeRun, activeAtt]);
}

/**
 * Pure function — no DB access of its own. The route queries task_activities and
 * task_deliverables and passes the rows straight through, so this function, and
 * only this function, is what QC-2 and QC-3 call directly: no running server,
 * no duplicated reduction logic between the test and the route.
 */
export function computePhaseProgress(
  activities: Array<PhaseActivityLite>,
  deliverables: Array<{ deliverable_type: string; path?: string | null }>,
  options?: ComputePhaseProgressOptions,
): PhaseProgress {
  const seenIds = new Set<string>();
  const completedIds = new Set<string>();
  const touchedLabels = new Set<string>();
  const unmapped: string[] = [];
  const receipts = options?.completionReceipts ?? null;
  const activeScope = options?.activeScope ?? null;
  for (const a of activities) {
    const id = phaseIdOf(a);
    if (id == null) continue;
    // Item 19 — P-U ids are KNOWN ids (branch/shared tables), never
    // `unmapped`: unmapped means "no table knows this id", and a mapped
    // branch the run did not elect is not-applicable, not unknown.
    const label = labelForPhaseId(id);
    if (label == null) { if (!unmapped.includes(id)) unmapped.push(id); continue; }
    // PRES-020 — stale-scope rows are obsolete: a late completion from an
    // old run/attempt must not flip the label, and stale starts must not
    // hold it in_progress either. Unscoped rows still count.
    if (!scopeActive(scopeOf(a), activeScope)) continue;
    seenIds.add(id);
    touchedLabels.add(label);
    // PRES-020 — a completion-typed activity marks the PHASE ID done, never
    // the whole label. With receipts, the id completes only when its receipt
    // validates (explicit true). Without receipts, legacy behavior holds.
    // Teleprompter has no phase ids; its only signal stays the deliverable.
    if (isPhaseCompletedActivity(a.activity_type)) {
      if (receipts == null || receipts[id] === true) completedIds.add(id);
    }
  }
  // FIX 50b — teleprompter detected by basename (path column) OR the legacy
  // 'teleprompter' type. Callers must SELECT path; a row without one only
  // matches via the legacy type.
  const hasTeleprompterDeliverable = deliverables.some(isTeleprompterDeliverable);

  // ── Item 19 — which upsell branches are ACTIVE for this run ────────────
  // Known elections decide exactly. UNDETERMINED elections fall back to
  // evidence: the engine's defers_unless gates mean P-U signals exist only
  // for elected branches, so scoped, current evidence is proof of election.
  const elections = options?.electedBranches ?? null;
  const evidenced = (branch: 'sales_checkout' | 'vsl' | 'either') =>
    [...seenIds, ...completedIds].some((id) => upsellBranchOfPhase(id) === branch);
  const salesActive = elections ? elections.salesCheckout : evidenced('sales_checkout');
  const vslActive = elections ? elections.vsl : evidenced('vsl');
  const sharedActive =
    salesActive || vslActive || (elections == null && evidenced('either'));
  // The elections view the required-set helper scores against: known
  // elections verbatim; in evidence mode, a synthesized view that is true
  // exactly when some upsell work is active (drives the shared wrap-up ids
  // joining QC / Delivered, and nothing else).
  const scoringElections: UpsellElections | null = elections ?? {
    salesCheckout: sharedActive,
    vsl: sharedActive,
  };

  const scoreStep = (
    label: PhaseStepLabel,
    required: string[],
  ): PhaseProgressStep => {
    const doneIds = required.filter((id) => completedIds.has(id)).length;
    const seenCount = required.filter((id) => seenIds.has(id)).length;
    // PRES-020 — done requires EVERY applicable required id done. An empty
    // required set (whole label waived by the approved manifest) is done only
    // when a completion actually touched the label — never vacuous.
    if (required.length === 0) {
      const touchedDone = [...completedIds].some((id) => labelForPhaseId(id) === label);
      return {
        label,
        status: touchedDone ? 'done' : 'not_started',
        doneIds: touchedDone ? 1 : 0,
        totalIds: 0,
        requiredIds: required,
      };
    }
    if (doneIds === required.length) {
      return { label, status: 'done', doneIds, totalIds: required.length, requiredIds: required };
    }
    if (seenCount > 0 || doneIds > 0) {
      return { label, status: 'in_progress', doneIds, totalIds: required.length, requiredIds: required };
    }
    return { label, status: 'not_started', doneIds: 0, totalIds: required.length, requiredIds: required };
  };

  const phases: PhaseProgressStep[] = PHASE_LABELS.map((label) => {
    if (label === 'Teleprompter') {
      return {
        label,
        status: hasTeleprompterDeliverable ? 'done' : 'not_started',
        doneIds: hasTeleprompterDeliverable ? 1 : 0,
        totalIds: 1,
        requiredIds: [],
      };
    }
    return scoreStep(
      label,
      requiredPhaseIdsForLabel(label, options?.excludedPhaseIds, scoringElections),
    );
  });
  void touchedLabels;

  // Item 19 — branch steps, inserted after Images (the branch's design /
  // render / HTML mass sits mid-pipeline), one per ACTIVE branch, in
  // manifest order. A step's state is scored from the same seen/completed
  // evidence as every main step: a phase the engine has not reached shows
  // not_started — its true state, never a default success or a stuck amber.
  const branchSteps: PhaseProgressStep[] = [];
  if (salesActive) {
    branchSteps.push(scoreStep('Sales Page', requiredPhaseIdsForLabel('Sales Page', options?.excludedPhaseIds, scoringElections)));
    branchSteps.push(scoreStep('Checkout', requiredPhaseIdsForLabel('Checkout', options?.excludedPhaseIds, scoringElections)));
  }
  if (vslActive) {
    branchSteps.push(scoreStep('VSL Page', requiredPhaseIdsForLabel('VSL Page', options?.excludedPhaseIds, scoringElections)));
  }
  if (branchSteps.length > 0) {
    const imagesIdx = phases.findIndex((p) => p.label === 'Images');
    phases.splice(imagesIdx + 1, 0, ...branchSteps);
  }
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

export type PhaseElapsedSeconds = Partial<Record<PhaseStepLabel, number>>;

/**
 * PRES-020 — canonical run selection for wall-clock attribution. The defect:
 * `phaseElapsedSeconds()` picked the latest INSERTED run, so delayed older
 * events arriving late changed which run displayed. Prefer an explicit
 * authoritative run id (the canonical execution record, e.g. the parent
 * card's `Ref:` run identity / stage-timings task linkage); fall back to
 * latest-inserted only when the caller names none. Never throws on junk.
 */
export function selectCanonicalRunId(
  rows: StageTimingRowLite[],
  authoritativeRunId?: string | null,
): string | null {
  if (typeof authoritativeRunId === 'string' && authoritativeRunId.length > 0) {
    if (rows.some((r) => r.run_id === authoritativeRunId)) return authoritativeRunId;
  }
  let latest: string | null = null;
  for (const r of rows) {
    if (typeof r.run_id === 'string' && r.run_id.length > 0) latest = r.run_id;
  }
  return latest;
}

export function phaseElapsedSeconds(
  rows: StageTimingRowLite[],
  authoritativeRunId?: string | null,
  electedBranches?: UpsellElections | null,
): PhaseElapsedSeconds {
  const elapsed: PhaseElapsedSeconds = {};
  if (rows.length === 0) return elapsed;

  // PRES-020 — canonical run wins over arrival order: an authoritative run id
  // (caller's execution record) keeps delayed older events from hijacking the
  // display. Latest-inserted is only the fallback when none is named.
  const latestRun = selectCanonicalRunId(rows, authoritativeRunId);
  if (latestRun == null) return elapsed;

  // Item 19 — P-U timing rows attribute to their branch step (or, for the
  // shared wrap-up ids, to QC / Delivered) under the same activation rules
  // as computePhaseProgress: known elections decide; otherwise the timing
  // rows themselves are the evidence (a phase_exit row exists only for a
  // phase the engine actually ran).
  const canonicalRows = rows.filter((r) => r.run_id === latestRun);
  const rowBranch = (branch: 'sales_checkout' | 'vsl' | 'either') =>
    canonicalRows.some(
      (r) => typeof r.phase_id === 'string' && upsellBranchOfPhase(r.phase_id) === branch,
    );
  const salesActive = electedBranches ? electedBranches.salesCheckout : rowBranch('sales_checkout');
  const vslActive = electedBranches ? electedBranches.vsl : rowBranch('vsl');
  const sharedActive =
    salesActive || vslActive || (electedBranches == null && rowBranch('either'));

  for (const r of canonicalRows) {
    if (typeof r.phase_id !== 'string' || r.phase_id.length === 0) continue;
    if (typeof r.duration_s !== 'number' || !Number.isFinite(r.duration_s)) continue;
    let label: PhaseStepLabel | null = PHASE_TO_LABEL[r.phase_id] ?? null;
    if (label == null) {
      const branch = upsellBranchOfPhase(r.phase_id);
      if (branch === 'sales_checkout' && salesActive) label = UPSELL_PHASE_TO_LABEL[r.phase_id];
      else if (branch === 'vsl' && vslActive) label = UPSELL_PHASE_TO_LABEL[r.phase_id];
      else if (branch === 'either' && sharedActive) label = UPSELL_SHARED_PHASE_TO_LABEL[r.phase_id];
    }
    if (label == null) continue; // unmapped ids never advance a bar (same rule as computePhaseProgress)
    elapsed[label] = (elapsed[label] ?? 0) + r.duration_s;
  }
  return elapsed;
}
