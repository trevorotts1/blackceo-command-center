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

export type PhaseStepStatus = 'not_started' | 'in_progress' | 'done';

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
  deliverables: Array<{ deliverable_type: string }>,
): PhaseProgress {
  const seen = new Set<string>();
  const unmapped: string[] = [];
  for (const a of activities) {
    const id = phaseIdOf(a);
    if (id == null) continue;
    const label = PHASE_TO_LABEL[id];
    if (label == null) { if (!unmapped.includes(id)) unmapped.push(id); continue; }
    seen.add(label);
  }
  const hasTeleprompterDeliverable = deliverables.some((d) => d.deliverable_type === 'teleprompter');
  const phases: PhaseProgressStep[] = PHASE_LABELS.map((label) => {
    if (label === 'Teleprompter') {
      return { label, status: hasTeleprompterDeliverable ? 'done' : 'not_started' };
    }
    return { label, status: seen.has(label) ? 'in_progress' : 'not_started' };
  });
  return { phases, unmapped };
}
