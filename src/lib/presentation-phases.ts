// PD-006 — the presentation phase table is GENERATED from the pipeline manifest.
//
// src/lib/presentation-phases.generated.ts holds every manifest phase id (56 at
// manifest_version 75) with its order, the client-facing step it belongs to and
// its election gate. `npm run check:phases` regenerates and refuses when this
// file is stale. This module derives every mapping the board reads from that
// one generated table, so a phase added to (or retired from) the manifest can
// never again be invisible, and a phase the manifest no longer has can never be
// waited on forever.
//
// Thirteen client-facing steps, in lifecycle order. A branch step exists ONLY
// for a run that elected the branch (BRANCH_STEPS names the election each
// branch step needs), so a declined sales/checkout or VSL branch produces NO
// step and no main step waits on a phase that will never run.
//
// Two design choices are deliberate and must NOT be "fixed":
//   (i) per-stage QC lives in its stage — P1Q-COPY-QC in Script, P-TYPO-QC /
//       P-PROMPT-QC in Design, P-IMAGE-QC in Images — because a client watching
//       "Images 1/2" wants the image QC inside that bar, not in a separate
//       bucket that turns amber halfway through. "Quality Check" carries the
//       cross-cutting gates (P-SHIFT-QC, P-SPEECH-QC, P-QC-AGGREGATE, P-U-QC).
//   (ii) P9-SPEECH, P8.4-FISH-TAG and P9.1-SPEECH-PDF are Script, not Audio and
//       Video — they produce written speech artifacts, and putting them in
//       Audio and Video would make a card show that bar running while nothing
//       has been recorded.

import {
  STEPS,
  PHASES,
  OWNER_ACTION_PHASES,
  BRANCH_STEPS,
} from './presentation-phases.generated';

/** The thirteen client-facing steps, in lifecycle order. */
export const PHASE_LABELS = STEPS;

export type PhaseStepLabel = (typeof PHASE_LABELS)[number];

/**
 * The three branch steps — a step that exists only when the run elected the
 * sales/checkout or the VSL branch. Derived from BRANCH_STEPS so there is one
 * source for the list and its election keys.
 */
export const UPSELL_LABELS = [
  'Sales Page',
  'Checkout',
  'Video Sales Page',
] as const;

type BranchStepLabel = (typeof UPSELL_LABELS)[number];

function branchStepOf(label: string): BranchStepLabel | null {
  return (UPSELL_LABELS as readonly string[]).includes(label)
    ? (label as BranchStepLabel)
    : null;
}

/** The manifest phases, by id, in manifest order. */
const PHASE_BY_ID = new Map(PHASES.map((p) => [p.id, p]));

/**
 * The election keys a phase defers on, read from the manifest's own
 * `defers_unless` expression (the phase rows are the only source). An ungated
 * phase returns [].
 */
function electionKeysOf(phaseId: string): string[] {
  const expr = PHASE_BY_ID.get(phaseId)?.defersUnless;
  if (typeof expr !== 'string' || expr.length === 0) return [];
  const keys: string[] = [];
  if (expr.includes('want_sales_checkout')) keys.push('want_sales_checkout');
  if (expr.includes('want_vsl_page')) keys.push('want_vsl_page');
  return keys;
}

/** Every manifest phase id mapped to its client-facing step. */
export const PHASE_TO_LABEL: Record<string, PhaseStepLabel> = Object.fromEntries(
  PHASES.map((p) => [p.id, p.step as PhaseStepLabel] as const),
);

/** The phases of the three branch steps. */
export const UPSELL_PHASE_TO_LABEL: Record<string, PhaseStepLabel> =
  Object.fromEntries(
    PHASES.filter((p) => branchStepOf(p.step) != null).map((p) => [
      p.id,
      p.step as PhaseStepLabel,
    ] as const),
  );

/**
 * The shared wrap-up phases: gated on EITHER election (`defers_unless:
 * want_sales_checkout == "yes" or want_vsl_page == "yes"`), and belonging to an
 * ordinary step rather than a branch step. P-U-QC joins Quality Check and
 * P-U-COLLATERAL joins Delivery — but ONLY for a run with an active upsell
 * branch, so a deck-only run's Quality Check and Delivery never wait on them.
 */
export const UPSELL_SHARED_PHASE_TO_LABEL: Record<string, PhaseStepLabel> =
  Object.fromEntries(
    PHASES.filter((p) => branchStepOf(p.step) == null && electionKeysOf(p.id).length > 0).map(
      (p) => [p.id, p.step as PhaseStepLabel] as const,
    ),
  );

/** The branch a P-U phase id belongs to ('either' = the shared wrap-up). */
export function upsellBranchOfPhase(
  phaseId: string,
): 'sales_checkout' | 'vsl' | 'either' | null {
  if (!(phaseId in PHASE_TO_LABEL)) return null;
  const branch = branchStepOf(PHASE_TO_LABEL[phaseId]);
  if (branch != null) {
    return BRANCH_STEPS[branch] === 'want_vsl_page' ? 'vsl' : 'sales_checkout';
  }
  if (electionKeysOf(phaseId).length > 0) return 'either';
  return null;
}

/** True when the id is any phase that only exists for an elected upsell branch. */
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
 * The label ANY known phase id belongs to, or null for an id the manifest does
 * not have.
 */
export function labelForPhaseId(phaseId: string): PhaseStepLabel | null {
  return PHASE_TO_LABEL[phaseId] ?? null;
}

// No step is derived from a deliverable row any more: P7-TELEPROMPTER is an
// ordinary manifest phase of "Speaker Kit", so it advances like every other
// phase. The export is kept (empty) for importers; there is nothing in it.
export const DELIVERABLE_DERIVED_LABELS: readonly string[] = [];

// The teleprompter's identity is its basename: presenter-teleprompter.html,
// the same name build_deck.py writes (DELIVERABLES_REQUIRED) and
// completion-evidence.ts's BUNDLE_SPECS matches by. The registration contract
// (CreateDeliverableSchema) pins deliverable_type to file|url|artifact|image —
// there IS no 'teleprompter' type — so a type-only test can never see a real
// teleprompter row. Kept as a helper for callers that inspect deliverable rows;
// the stepper no longer uses it (P7-TELEPROMPTER is a phase now).
export const TELEPROMPTER_BASENAME = 'presenter-teleprompter.html';

/**
 * True when a deliverable row IS the teleprompter.
 *
 * Two accepted signals, OR-ed:
 *   1. basename match — path's final `/`-segment (or `\\`, for Windows-style
 *      paths that arrive through the ingest) equals presenter-teleprompter.html;
 *      trimming first, since registration paths have historically carried
 *      stray whitespace.
 *   2. legacy exact-type row — deliverable_type === 'teleprompter'.
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
 * An id that no mapping table knows is still RETURNED here; the reducer is
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
 *      Any id the manifest table knows maps directly ('P4-COPY' → Script).
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

/**
 * One branch step's step label, when the run's elections are UNDETERMINED and
 * the evidence is read from activities instead: the engine emits a branch's
 * phase signals only for an elected branch, because the manifest's
 * defers_unless gates defer the rest. So evidence is proof of election.
 */
function branchStepActive(label: PhaseStepLabel, elections: UpsellElections | null, evidenced: (branch: 'sales_checkout' | 'vsl') => boolean): boolean {
  const step = branchStepOf(label);
  if (step == null) return true;
  const needsVsl = BRANCH_STEPS[step] === 'want_vsl_page';
  if (elections != null) return needsVsl ? elections.vsl : elections.salesCheckout;
  return evidenced(needsVsl ? 'vsl' : 'sales_checkout');
}

/**
 * True when a phase id applies to a run with these elections. An ungated phase
 * always applies; a branch phase applies only to its elected branch; a shared
 * wrap-up phase applies to either elected branch.
 */
function phaseAppliesToElections(phaseId: string, elections: UpsellElections): boolean {
  const branch = branchStepOf(PHASE_TO_LABEL[phaseId]);
  if (branch != null) {
    return BRANCH_STEPS[branch] === 'want_vsl_page' ? elections.vsl : elections.salesCheckout;
  }
  const keys = electionKeysOf(phaseId);
  if (keys.length === 0) return true;
  return (
    (keys.includes('want_sales_checkout') && elections.salesCheckout) ||
    (keys.includes('want_vsl_page') && elections.vsl)
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
 * PRES-020 — required phase ids per label. A label is `done` only when EVERY
 * required phase id of that label has a completion signal. The required set is
 * exactly the generated manifest table, minus labels the caller explicitly
 * excludes (optional / not-applicable phases, approved manifest only) via
 * `excludedPhaseIds`, and minus phases the run's elections defer (a declined
 * sales/checkout branch, or a shared wrap-up phase when no branch is active).
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
  const ids = Object.entries(PHASE_TO_LABEL)
    .filter(([id, l]) => l === label && !excluded.has(id))
    .map(([id]) => id);
  if (elections == null) return ids;
  return ids.filter((id) => phaseAppliesToElections(id, elections));
}

export interface PhaseProgress {
  // The thirteen steps in PHASE_LABELS order, minus — Item 19 — any branch
  // step whose branch the run did not elect (or, when the elections are
  // UNDETERMINED, has no engine evidence for). Inactive branches emit no step
  // at all.
  phases: PhaseProgressStep[];
  unmapped: string[];            // phase ids seen that the manifest does not have
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
   * explicitly true). When omitted, every completion-typed activity counts
   * (legacy behavior for callers that have no receipt source).
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
   * engine evidence for that branch.
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
 *
 * `deliverables` no longer moves any step: PD-006 made P7-TELEPROMPTER an
 * ordinary manifest phase, so the teleprompter's step advances on its phase
 * completion like every other step. The parameter stays so the route keeps one
 * call site and every caller keeps its signature.
 */
export function computePhaseProgress(
  activities: Array<PhaseActivityLite>,
  deliverables: Array<{ deliverable_type: string; path?: string | null }>,
  options?: ComputePhaseProgressOptions,
): PhaseProgress {
  const seenIds = new Set<string>();
  const completedIds = new Set<string>();
  const unmapped: string[] = [];
  const receipts = options?.completionReceipts ?? null;
  const activeScope = options?.activeScope ?? null;
  for (const a of activities) {
    const id = phaseIdOf(a);
    if (id == null) continue;
    // Item 19 — a phase the manifest has is KNOWN, never `unmapped`:
    // unmapped means "the manifest has no such id", and a mapped branch the
    // run did not elect is not-applicable, not unknown.
    const label = labelForPhaseId(id);
    if (label == null) { if (!unmapped.includes(id)) unmapped.push(id); continue; }
    // PRES-020 — stale-scope rows are obsolete: a late completion from an
    // old run/attempt must not flip the label, and stale starts must not
    // hold it in_progress either. Unscoped rows still count.
    if (!scopeActive(scopeOf(a), activeScope)) continue;
    seenIds.add(id);
    // PRES-020 — a completion-typed activity marks the PHASE ID done, never
    // the whole label. With receipts, the id completes only when its receipt
    // validates (explicit true). Without receipts, legacy behavior holds.
    if (isPhaseCompletedActivity(a.activity_type)) {
      if (receipts == null || receipts[id] === true) completedIds.add(id);
    }
  }
  void deliverables;

  // ── Item 19 — which upsell branches are ACTIVE for this run ────────────
  // Known elections decide exactly. UNDETERMINED elections fall back to
  // evidence: the engine's defers_unless gates mean branch signals exist only
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
  // joining Quality Check / Delivery, and nothing else).
  const scoringElections: UpsellElections = elections ?? {
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

  const phases: PhaseProgressStep[] = [];
  for (const label of PHASE_LABELS) {
    // Item 19 — a branch step exists only for an active branch. A declined
    // branch produces NO step: no phantom steps, and no main step waits on a
    // phase that will never run.
    if (!branchStepActive(label, elections, evidenced)) continue;
    phases.push(
      scoreStep(
        label,
        requiredPhaseIdsForLabel(label, options?.excludedPhaseIds, scoringElections),
      ),
    );
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

  // Item 19 — branch timing rows attribute to their branch step under the
  // same activation rules as computePhaseProgress: known elections decide;
  // otherwise the timing rows themselves are the evidence (a phase_exit row
  // exists only for a phase the engine actually ran).
  const canonicalRows = rows.filter((r) => r.run_id === latestRun);
  const rowBranch = (branch: 'sales_checkout' | 'vsl' | 'either') =>
    canonicalRows.some(
      (r) => typeof r.phase_id === 'string' && upsellBranchOfPhase(r.phase_id) === branch,
    );
  const salesActive = electedBranches ? electedBranches.salesCheckout : rowBranch('sales_checkout');
  const vslActive = electedBranches ? electedBranches.vsl : rowBranch('vsl');

  for (const r of canonicalRows) {
    if (typeof r.phase_id !== 'string' || r.phase_id.length === 0) continue;
    if (typeof r.duration_s !== 'number' || !Number.isFinite(r.duration_s)) continue;
    const label = labelForPhaseId(r.phase_id);
    if (label == null) continue; // unmapped ids never advance a bar (same rule as computePhaseProgress)
    const branch = branchStepOf(label);
    if (branch != null) {
      const needsVsl = BRANCH_STEPS[branch] === 'want_vsl_page';
      if (needsVsl ? !vslActive : !salesActive) continue;
    }
    elapsed[label] = (elapsed[label] ?? 0) + r.duration_s;
  }
  return elapsed;
}

/**
 * PD-006 — the stepper's owner-action render. When the engine's park record
 * names a phase in OWNER_ACTION_PHASES (the manifest's human phases), that
 * step is the one waiting on the client, and the stepper replaces its label
 * text with YOUR_TURN_TEXT and a distinct colour. Returns null — never a
 * guess — when the park record names no owner-action phase.
 */
export const YOUR_TURN_TEXT = 'Your turn: pick style A, B or C';

export function yourTurnStepLabel(
  parkPhaseId: string | null | undefined,
): PhaseStepLabel | null {
  if (typeof parkPhaseId !== 'string' || parkPhaseId.length === 0) return null;
  if (!(OWNER_ACTION_PHASES as readonly string[]).includes(parkPhaseId)) return null;
  return labelForPhaseId(parkPhaseId);
}
