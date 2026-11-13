/**
 * PD-006 — presentation-phases unit tests.
 *
 * The table is GENERATED from the pipeline manifest (manifest_version 75, 56
 * phases, 13 client-facing steps). Proves:
 *   - totality   — every manifest phase id has a step (nothing invisible)
 *   - exclusivity — no id is named twice, and no id outside the manifest maps
 *   - the 13 steps and their order
 *   - no wildcard keys
 *   - P7-TELEPROMPTER is an ordinary phase of Speaker Kit (the old special
 *     case is gone; there is no 'Teleprompter' step)
 *   - a retired phase id is unmapped, never silently tolerated
 *   - the reducer: every phase of manifest version 75 done (sales and checkout
 *     elected) leaves EVERY step done and `unmapped` empty; a declined branch
 *     emits no branch step; branch steps ride on evidence when elections are
 *     unknown
 *   - phaseIdOf / activitySchemaInfo / isTeleprompterDeliverable contracts
 *   - the stepper's owner-action text: parked on P-STYLE-PICK shows the exact
 *     "Your turn: pick style A, B or C" text on the Your Style Pick step
 */

import { describe, it, expect } from 'vitest';
import {
  PHASE_TO_LABEL,
  PHASE_LABELS,
  DELIVERABLE_DERIVED_LABELS,
  PHASE_ACTIVITY_METADATA_KEY,
  TELEPROMPTER_BASENAME,
  UPSELL_PHASE_TO_LABEL,
  UPSELL_SHARED_PHASE_TO_LABEL,
  YOUR_TURN_TEXT,
  isTeleprompterDeliverable,
  labelForPhaseId,
  phaseIdOf,
  requiredPhaseIdsForLabel,
  yourTurnStepLabel,
  computePhaseProgress,
  phaseElapsedSeconds,
} from '@/lib/presentation-phases';
import { MANIFEST_VERSION, PHASES, STEPS } from '@/lib/presentation-phases.generated';

const MANIFEST_IDS = PHASES.map((p) => p.id);

const BRANCH_STEPS = ['Sales Page', 'Checkout', 'Video Sales Page'];

const EXPECTED_STEPS = [
  'Getting Started',
  'Research',
  'Script',
  'Design',
  'Your Style Pick',
  'Images',
  'Sales Page',
  'Checkout',
  'Video Sales Page',
  'Speaker Kit',
  'Audio and Video',
  'Quality Check',
  'Delivery',
];

// The nine phase ids the old hand-typed table waited on that manifest
// version 75 no longer has (design/render/HTML staged phases).
const RETIRED_IDS = [
  'P-U-DESIGN-SALES',
  'P-U-DESIGN-RENDER-SALES',
  'P-U-HTML-SALES',
  'P-U-DESIGN-CHECKOUT',
  'P-U-DESIGN-RENDER-CHECKOUT',
  'P-U-HTML-CHECKOUT',
  'P-U-DESIGN-VSL',
  'P-U-DESIGN-RENDER-VSL',
  'P-U-HTML-VSL',
];

const doneActivity = (phase_id: string) => ({
  activity_type: 'phase_completed',
  metadata: { phase_id },
});

describe('PD-006 — the generated phase table', () => {
  it('is manifest version 75 with 56 phases and 13 steps', () => {
    expect(MANIFEST_VERSION).toBe(75);
    expect(MANIFEST_IDS.length).toBe(56);
    expect(STEPS.length).toBe(13);
    expect(PHASE_LABELS).toEqual(STEPS);
  });

  it('has the 13 client-facing steps in lifecycle order', () => {
    expect(PHASE_LABELS).toEqual(EXPECTED_STEPS);
  });

  it('maps every manifest phase id exactly once (totality)', () => {
    expect(Object.keys(PHASE_TO_LABEL).length).toBe(MANIFEST_IDS.length);
    const missing = MANIFEST_IDS.filter((id) => !(id in PHASE_TO_LABEL));
    expect(missing).toEqual([]);
  });

  it('maps no id the manifest does not have (nothing waits forever)', () => {
    const known = new Set(MANIFEST_IDS);
    const extra = Object.keys(PHASE_TO_LABEL).filter((id) => !known.has(id));
    expect(extra).toEqual([]);
  });

  it('maps every id to one of the thirteen steps', () => {
    const steps = new Set<string>(PHASE_LABELS);
    const bad = Object.entries(PHASE_TO_LABEL).filter(([, step]) => !steps.has(step));
    expect(bad).toEqual([]);
  });

  it('has no wildcard keys', () => {
    expect(Object.keys(PHASE_TO_LABEL).filter((k) => k.includes('*'))).toEqual([]);
  });

  it('makes P7-TELEPROMPTER an ordinary phase of Speaker Kit', () => {
    expect(PHASE_TO_LABEL['P7-TELEPROMPTER']).toBe('Speaker Kit');
    expect((PHASE_LABELS as readonly string[]).includes('Teleprompter')).toBe(false);
    expect(DELIVERABLE_DERIVED_LABELS).toEqual([]);
  });

  it('leaves every retired phase id unmapped', () => {
    for (const id of RETIRED_IDS) {
      expect(labelForPhaseId(id)).toBeNull();
    }
  });

  it('names only branch-step phases in UPSELL_PHASE_TO_LABEL', () => {
    for (const [id, step] of Object.entries(UPSELL_PHASE_TO_LABEL)) {
      expect(BRANCH_STEPS).toContain(step);
      expect(PHASE_TO_LABEL[id]).toBe(step);
    }
    expect(UPSELL_PHASE_TO_LABEL['P-U-SALES-COPY']).toBe('Sales Page');
    expect(UPSELL_PHASE_TO_LABEL['P-U-SALES-BUILD']).toBe('Sales Page');
    expect(UPSELL_PHASE_TO_LABEL['P-U-VSL-BUILD']).toBe('Video Sales Page');
  });

  it('keeps the two shared wrap-up phases out of the branch tables', () => {
    expect(UPSELL_SHARED_PHASE_TO_LABEL['P-U-QC']).toBe('Quality Check');
    expect(UPSELL_SHARED_PHASE_TO_LABEL['P-U-COLLATERAL']).toBe('Delivery');
    expect('P-U-QC' in UPSELL_PHASE_TO_LABEL).toBe(false);
  });

  it('has PHASE_ACTIVITY_METADATA_KEY set to phase_id', () => {
    expect(PHASE_ACTIVITY_METADATA_KEY).toBe('phase_id');
  });
});

describe('requiredPhaseIdsForLabel', () => {
  it('Script holds the nine script phases', () => {
    expect(requiredPhaseIdsForLabel('Script').sort()).toEqual(
      [
        'P0B-PRIORITY',
        'P3-ARC',
        'P4-COPY',
        'P-SP-STRUCTURE',
        'P-SP-P3-HYGIENE',
        'P1Q-COPY-QC',
        'P9-SPEECH',
        'P8.4-FISH-TAG',
        'P9.1-SPEECH-PDF',
      ].sort(),
    );
  });

  it('a declined branch step has no required ids and no shared wrap-up joins', () => {
    const declined = { salesCheckout: false, vsl: false };
    expect(requiredPhaseIdsForLabel('Sales Page', null, declined)).toEqual([]);
    expect(requiredPhaseIdsForLabel('Video Sales Page', null, declined)).toEqual([]);
    expect(requiredPhaseIdsForLabel('Quality Check', null, declined)).not.toContain('P-U-QC');
    expect(requiredPhaseIdsForLabel('Delivery', null, declined)).not.toContain('P-U-COLLATERAL');
  });

  it('an elected branch keeps its ids and the shared wrap-up joins', () => {
    const elected = { salesCheckout: true, vsl: false };
    expect(requiredPhaseIdsForLabel('Sales Page', null, elected).length).toBe(4);
    expect(requiredPhaseIdsForLabel('Video Sales Page', null, elected)).toEqual([]);
    expect(requiredPhaseIdsForLabel('Quality Check', null, elected)).toContain('P-U-QC');
    expect(requiredPhaseIdsForLabel('Delivery', null, elected)).toContain('P-U-COLLATERAL');
  });

  it('honours excludedPhaseIds', () => {
    expect(requiredPhaseIdsForLabel('Script', ['P9-SPEECH']).length).toBe(8);
  });
});

describe('computePhaseProgress', () => {
  it('returns the non-branch steps for empty input (no phantom branch steps)', () => {
    const result = computePhaseProgress([], []);
    expect(result.phases.map((p) => p.label)).toEqual(
      EXPECTED_STEPS.filter((s) => !BRANCH_STEPS.includes(s)),
    );
    expect(result.phases.every((p) => p.status === 'not_started')).toBe(true);
    expect(result.unmapped).toEqual([]);
  });

  it('every phase of manifest version 75 done with sales and checkout elected leaves every step done', () => {
    const result = computePhaseProgress(
      MANIFEST_IDS.map(doneActivity),
      [],
      { electedBranches: { salesCheckout: true, vsl: false } },
    );
    // Sales Page and Checkout are steps; Video Sales Page is declined, so no step.
    expect(result.phases.map((p) => p.label)).toEqual(
      EXPECTED_STEPS.filter((s) => s !== 'Video Sales Page'),
    );
    for (const step of result.phases) {
      expect({ label: step.label, status: step.status }).toEqual({
        label: step.label,
        status: 'done',
      });
    }
    expect(result.unmapped).toEqual([]);
  });

  it('a declined branch produces no step at all', () => {
    const result = computePhaseProgress([], [], {
      electedBranches: { salesCheckout: false, vsl: false },
    });
    expect(result.phases.map((p) => p.label)).not.toContain('Sales Page');
    expect(result.phases.map((p) => p.label)).not.toContain('Checkout');
    expect(result.phases.map((p) => p.label)).not.toContain('Video Sales Page');
  });

  it('with the elections UNDETERMINED a branch step rides on engine evidence', () => {
    const result = computePhaseProgress(
      [{ activity_type: 'status_changed', metadata: { phase_id: 'P-U-VSL-COPY' } }],
      [],
    );
    const vsl = result.phases.find((p) => p.label === 'Video Sales Page');
    expect(vsl?.status).toBe('in_progress');
    expect(result.phases.map((p) => p.label)).not.toContain('Sales Page');
  });

  it('records an id the manifest does not have in unmapped', () => {
    const result = computePhaseProgress(
      [{ activity_type: 'status_changed', metadata: { phase_id: 'P-DOES-NOT-EXIST' } }],
      [],
    );
    expect(result.unmapped).toEqual(['P-DOES-NOT-EXIST']);
  });

  it('deduplicates unmapped ids', () => {
    const result = computePhaseProgress(
      [doneActivity('P-UNKNOWN'), doneActivity('P-UNKNOWN')],
      [],
    );
    expect(result.unmapped).toEqual(['P-UNKNOWN']);
  });

  it('the teleprompter advances its own step (Speaker Kit), never a separate one', () => {
    const result = computePhaseProgress([doneActivity('P7-TELEPROMPTER')], []);
    const speakerKit = result.phases.find((p) => p.label === 'Speaker Kit')!;
    expect(speakerKit.status).toBe('in_progress');
    expect(speakerKit.doneIds).toBe(1);
    expect(speakerKit.totalIds).toBe(4);
    expect((result.phases as Array<{ label: string }>).map((p) => p.label)).not.toContain(
      'Teleprompter',
    );
  });

  it('does not advance a step from activity_type alone — only from phase_id', () => {
    const result = computePhaseProgress([{ activity_type: 'status_changed', metadata: null }], []);
    expect(result.phases.filter((p) => p.status !== 'not_started')).toEqual([]);
  });

  it('handles stringified metadata', () => {
    const result = computePhaseProgress(
      [{ activity_type: 'status_changed', metadata: JSON.stringify({ phase_id: 'P3-ARC' }) }],
      [],
    );
    expect(result.phases.find((p) => p.label === 'Script')!.status).toBe('in_progress');
  });
});

describe('the stepper owner-action text (PD-006)', () => {
  it('is exactly the approved sentence', () => {
    expect(YOUR_TURN_TEXT).toBe('Your turn: pick style A, B or C');
  });

  it('names the Your Style Pick step when the run is parked on P-STYLE-PICK', () => {
    expect(yourTurnStepLabel('P-STYLE-PICK')).toBe('Your Style Pick');
  });

  it('names no step for a park on a phase that is not an owner action', () => {
    expect(yourTurnStepLabel('P4-RENDER')).toBeNull();
    expect(yourTurnStepLabel('P-DOES-NOT-EXIST')).toBeNull();
    expect(yourTurnStepLabel(null)).toBeNull();
    expect(yourTurnStepLabel(undefined)).toBeNull();
  });
});

describe('phaseIdOf', () => {
  it('returns the id from object metadata', () => {
    expect(phaseIdOf({ metadata: { phase_id: 'P4-COPY' } })).toBe('P4-COPY');
  });

  it('returns the id from stringified metadata', () => {
    expect(phaseIdOf({ metadata: JSON.stringify({ phase_id: 'P4-COPY' }) })).toBe('P4-COPY');
  });

  it('returns null for absent metadata', () => {
    expect(phaseIdOf({})).toBeNull();
  });

  it('returns null for null metadata', () => {
    expect(phaseIdOf({ metadata: null })).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(phaseIdOf({ metadata: '{not json' })).toBeNull();
  });

  it('returns null for wrong-shaped metadata (a bare string)', () => {
    expect(phaseIdOf({ metadata: '"a string"' })).toBeNull();
  });

  it('returns null for empty phase_id string', () => {
    expect(phaseIdOf({ metadata: { phase_id: '' } })).toBeNull();
  });

  it('returns an unknown id — NOT null — so the reducer can record it in unmapped', () => {
    expect(phaseIdOf({ metadata: { phase_id: 'P-DOES-NOT-EXIST' } })).toBe('P-DOES-NOT-EXIST');
  });

  it('returns null for an empty object in metadata', () => {
    expect(phaseIdOf({ metadata: {} })).toBeNull();
  });

  it('returns null when phase_id is a number', () => {
    expect(phaseIdOf({ metadata: { phase_id: 42 } })).toBeNull();
  });
});

describe('isTeleprompterDeliverable (FIX 50b, helper contract)', () => {
  it('TELEPROMPTER_BASENAME is the producer filename', () => {
    expect(TELEPROMPTER_BASENAME).toBe('presenter-teleprompter.html');
  });

  it('matches an artifact row by basename of path', () => {
    expect(
      isTeleprompterDeliverable({
        deliverable_type: 'artifact',
        path: 'working/deliverables/presenter-teleprompter.html',
      }),
    ).toBe(true);
  });

  it('matches a file row with a bare basename', () => {
    expect(isTeleprompterDeliverable({ deliverable_type: 'file', path: 'presenter-teleprompter.html' })).toBe(true);
  });

  it('matches through backslash separators', () => {
    expect(
      isTeleprompterDeliverable({
        deliverable_type: 'file',
        path: 'C:\\runs\\deck\\deliverables\\presenter-teleprompter.html',
      }),
    ).toBe(true);
  });

  it('matches a legacy type row even without a path', () => {
    expect(isTeleprompterDeliverable({ deliverable_type: 'teleprompter' })).toBe(true);
  });

  it('does not match other basenames or a prefix-extended basename', () => {
    expect(
      isTeleprompterDeliverable({ deliverable_type: 'artifact', path: 'working/deliverables/PRESENTER-GUIDE.pdf' }),
    ).toBe(false);
    expect(
      isTeleprompterDeliverable({ deliverable_type: 'artifact', path: 'working/deliverables/presenter-teleprompter.html.bak' }),
    ).toBe(false);
    expect(
      isTeleprompterDeliverable({ deliverable_type: 'url', path: 'https://cdn.example.com/decks/old-presenter-teleprompter.html' }),
    ).toBe(false);
  });

  it('handles null / undefined / non-string paths without throwing', () => {
    expect(isTeleprompterDeliverable({ deliverable_type: 'url', path: null })).toBe(false);
    expect(isTeleprompterDeliverable({ deliverable_type: 'url', path: undefined })).toBe(false);
    expect(isTeleprompterDeliverable({ deliverable_type: 'url' })).toBe(false);
  });
});

describe('phaseElapsedSeconds', () => {
  it('sums a label from the canonical run only and skips unmapped ids', () => {
    const rows = [
      { run_id: 'run-old', phase_id: 'P4-COPY', duration_s: 100 },
      { run_id: 'run-new', phase_id: 'P4-COPY', duration_s: 7.5 },
      { run_id: 'run-new', phase_id: 'NOT-A-REAL-PHASE', duration_s: 50 },
    ];
    expect(phaseElapsedSeconds(rows)).toEqual({ Script: 7.5 });
    expect(phaseElapsedSeconds(rows, 'run-new')).toEqual({ Script: 7.5 });
  });

  it('attributes a branch phase only to an active branch', () => {
    const rows = [{ run_id: 'r', phase_id: 'P-U-SALES-COPY', duration_s: 3 }];
    expect(phaseElapsedSeconds(rows, null, { salesCheckout: true, vsl: false })).toEqual({ 'Sales Page': 3 });
    expect(phaseElapsedSeconds(rows, null, { salesCheckout: false, vsl: false })).toEqual({});
  });
});
