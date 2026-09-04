/**
 * U060 — presentation-phases unit tests.
 *
 * Proves:
 *   - exclusivity — every phase id appears exactly once (no double-assignments)
 *   - totality   — the 26 real ids are all present
 *   - checksum   — per-label counts sum to 26
 *   - no wildcards — no key contains `*`
 *   - P7 is absent — the audit's non-existent phase can never leak in
 *   - P-SP-P3-HYGIENE is mapped (the phase the audit's *-QC wildcard missed)
 *   - phaseIdOf returns the id from object metadata, stringified metadata,
 *     and null for absent/malformed/wrong-shaped/empty input
 *   - computePhaseProgress returns 7 labels always, in order, with correct
 *     statuses and unmapped
 */

import { describe, it, expect } from 'vitest';
import {
  PHASE_TO_LABEL,
  PHASE_LABELS,
  DELIVERABLE_DERIVED_LABELS,
  PHASE_ACTIVITY_METADATA_KEY,
  TELEPROMPTER_BASENAME,
  isTeleprompterDeliverable,
  phaseIdOf,
  computePhaseProgress,
} from '@/lib/presentation-phases';

// The 26 real phase ids in manifest order, hard-coded so the test fails when
// the manifest and the table drift.
const MANIFEST_26 = [
  'P-CONVERTER',
  'P-0.5-RESEARCH',
  'P0A-INTAKE',
  'P-SP-CLAIM',
  'P-SP-INTAKE',
  'P-SP-INTAKE-TRACE',
  'P0B-PRIORITY',
  'P3-ARC',
  'P-3.5-RESEARCH-MAP',
  'P4-COPY',
  'P-SP-STRUCTURE',
  'P-SP-P3-HYGIENE',
  'P1Q-COPY-QC',
  'PF-DESIGN',
  'P-TYPO-QC',
  'P4-PROMPT',
  'P-PROMPT-QC',
  'P-STYLE-PREVIEW',
  'P4-RENDER',
  'P-IMAGE-QC',
  'P-SHIFT-QC',
  'P8-ASSEMBLE',
  'P9-SPEECH',
  'P-SPEECH-QC',
  'P9.5-NOTES-SYNC',
  'P9-DELIVER',
];

const EXPECTED_COUNTS: Record<string, number> = {
  Intake: 9,
  Script: 5,
  Prompts: 4,
  Images: 3,
  Teleprompter: 0,
  QC: 2,
  Delivered: 3,
};

describe('U060 — presentation-phases', () => {
  describe('PHASE_TO_LABEL table', () => {
    it('maps exactly all 26 manifest phases with no extras', () => {
      const keys = Object.keys(PHASE_TO_LABEL);
      const keySet = new Set(keys);
      const manifestSet = new Set(MANIFEST_26);

      const missingFromTable = [...manifestSet].filter((id) => !keySet.has(id));
      const extraInTable = [...keySet].filter((id) => !manifestSet.has(id));

      expect(keys.length).toBe(26);
      expect(missingFromTable).toEqual([]);
      expect(extraInTable).toEqual([]);
    });

    it('has exclusive mappings — no phase id appears twice', () => {
      // Trivially true for a JS object literal, but we assert that no id is
      // also in a deliverable-derived source set.
      const deliverableDerivedSet = new Set(DELIVERABLE_DERIVED_LABELS);
      // This is a structural check: PHASE_TO_LABEL has phase ids as keys.
      // No phase id key is also a deliverable-derived label name.
      const overlap = Object.keys(PHASE_TO_LABEL).filter((id) =>
        deliverableDerivedSet.has(id),
      );
      expect(overlap).toEqual([]);
    });

    it('has no id mapped to more than one label (invert and check)', () => {
      // Invert: label -> set of ids
      const labelToIds: Record<string, string[]> = {};
      for (const [id, label] of Object.entries(PHASE_TO_LABEL)) {
        if (!labelToIds[label]) labelToIds[label] = [];
        labelToIds[label].push(id);
      }
      // Each id should appear exactly once (JS objects enforce this),
      // so duplicate detection is just a sanity check.
      const allIds: string[] = [];
      for (const ids of Object.values(labelToIds)) {
        allIds.push(...ids);
      }
      expect(allIds.length).toBe(26);
      expect(new Set(allIds).size).toBe(26);
    });

    it('has per-label counts matching expected: 9-5-4-3-0-2-3', () => {
      const counts: Record<string, number> = {};
      for (const lbl of PHASE_LABELS) counts[lbl] = 0;
      for (const label of Object.values(PHASE_TO_LABEL)) {
        counts[label] = (counts[label] ?? 0) + 1;
      }
      for (const [label, expected] of Object.entries(EXPECTED_COUNTS)) {
        expect(counts[label]).toBe(expected);
      }
      const sum = Object.values(counts).reduce((a, b) => a + b, 0);
      expect(sum).toBe(26);
    });

    it('has 7 labels in PHASE_LABELS', () => {
      expect(PHASE_LABELS.length).toBe(7);
      expect(PHASE_LABELS).toEqual([
        'Intake',
        'Script',
        'Prompts',
        'Images',
        'Teleprompter',
        'QC',
        'Delivered',
      ]);
    });

    it('has no wildcard keys', () => {
      const wildcardKeys = Object.keys(PHASE_TO_LABEL).filter((k) =>
        k.includes('*'),
      );
      expect(wildcardKeys).toEqual([]);
    });

    it('does not contain P7', () => {
      expect('P7' in PHASE_TO_LABEL).toBe(false);
    });

    it('maps P-SP-P3-HYGIENE — the phase the audit\'s *-QC wildcard missed', () => {
      expect(PHASE_TO_LABEL['P-SP-P3-HYGIENE']).toBe('Script');
    });

    it('maps the three previously-double-assigned phases exactly once each', () => {
      // P-PROMPT-QC was in Prompts AND QC via the audit's wildcard.
      expect(PHASE_TO_LABEL['P-PROMPT-QC']).toBe('Prompts');
      // P-IMAGE-QC was in Images AND QC.
      expect(PHASE_TO_LABEL['P-IMAGE-QC']).toBe('Images');
      // P9-SPEECH was in Script AND Delivered.
      expect(PHASE_TO_LABEL['P9-SPEECH']).toBe('Script');
    });

    it('has DELIVERABLE_DERIVED_LABELS containing only Teleprompter', () => {
      expect(DELIVERABLE_DERIVED_LABELS).toEqual(['Teleprompter']);
    });

    it('has PHASE_ACTIVITY_METADATA_KEY set to phase_id', () => {
      expect(PHASE_ACTIVITY_METADATA_KEY).toBe('phase_id');
    });
  });

  describe('phaseIdOf', () => {
    it('returns the id from object metadata', () => {
      expect(phaseIdOf({ metadata: { phase_id: 'P4-COPY' } })).toBe('P4-COPY');
    });

    it('returns the id from stringified metadata', () => {
      expect(
        phaseIdOf({ metadata: JSON.stringify({ phase_id: 'P4-COPY' }) }),
      ).toBe('P4-COPY');
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
      expect(phaseIdOf({ metadata: { phase_id: 'P-DOES-NOT-EXIST' } })).toBe(
        'P-DOES-NOT-EXIST',
      );
    });

    it('returns null for an empty object in metadata', () => {
      expect(phaseIdOf({ metadata: {} })).toBeNull();
    });

    it('returns null when phase_id is a number', () => {
      expect(phaseIdOf({ metadata: { phase_id: 42 } })).toBeNull();
    });
  });

  describe('isTeleprompterDeliverable (FIX 50b)', () => {
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
      expect(
        isTeleprompterDeliverable({
          deliverable_type: 'file',
          path: 'presenter-teleprompter.html',
        }),
      ).toBe(true);
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

    it('does not match other basenames or other files in the same dir', () => {
      expect(
        isTeleprompterDeliverable({
          deliverable_type: 'artifact',
          path: 'working/deliverables/PRESENTER-GUIDE.pdf',
        }),
      ).toBe(false);
      expect(
        isTeleprompterDeliverable({
          deliverable_type: 'artifact',
          path: 'working/deliverables/presenter-teleprompter.html.bak',
        }),
      ).toBe(false);
    });

    it('does not match a prefix-extended basename (basename must be exact)', () => {
      expect(
        isTeleprompterDeliverable({
          deliverable_type: 'url',
          path: 'https://cdn.example.com/decks/old-presenter-teleprompter.html',
        }),
      ).toBe(false);
    });

    it('handles null / undefined / non-string paths without throwing', () => {
      expect(isTeleprompterDeliverable({ deliverable_type: 'url', path: null })).toBe(false);
      expect(isTeleprompterDeliverable({ deliverable_type: 'url', path: undefined })).toBe(false);
      expect(isTeleprompterDeliverable({ deliverable_type: 'url' })).toBe(false);
    });
  });

  describe('computePhaseProgress', () => {
    it('returns 7 phases in PHASE_LABELS order', () => {
      const result = computePhaseProgress([], []);
      expect(result.phases.length).toBe(7);
      expect(result.phases.map((p) => p.label)).toEqual([
        'Intake',
        'Script',
        'Prompts',
        'Images',
        'Teleprompter',
        'QC',
        'Delivered',
      ]);
    });

    it('returns all not_started for empty input', () => {
      const result = computePhaseProgress([], []);
      for (const step of result.phases) {
        if (step.label === 'Teleprompter') {
          expect([step.status]).toContain('not_started');
        } else {
          expect(step.status).toBe('not_started');
        }
      }
    });

    it('marks labels with activity as in_progress', () => {
      const activities = [
        { activity_type: 'status_changed', metadata: { phase_id: 'P0A-INTAKE' } },
        { activity_type: 'status_changed', metadata: { phase_id: 'P4-COPY' } },
        { activity_type: 'status_changed', metadata: { phase_id: 'P4-RENDER' } },
      ];
      const result = computePhaseProgress(activities, []);
      const advanced = result.phases
        .filter((p) => p.status !== 'not_started')
        .map((p) => p.label)
        .sort();
      expect(advanced).toEqual(['Images', 'Intake', 'Script']);
    });

    it('does NOT advance labels from activity_type alone — only from phase_id', () => {
      const activities = [
        { activity_type: 'status_changed', metadata: null },
      ];
      const result = computePhaseProgress(activities, []);
      const advanced = result.phases.filter((p) => p.status !== 'not_started');
      expect(advanced).toEqual([]);
    });

    it('records unmapped phase ids', () => {
      const activities = [
        { activity_type: 'status_changed', metadata: { phase_id: 'P-DOES-NOT-EXIST' } },
      ];
      const result = computePhaseProgress(activities, []);
      expect(result.unmapped).toContain('P-DOES-NOT-EXIST');
    });

    it('Teleprompter is not_started with no deliverable', () => {
      const result = computePhaseProgress([], []);
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('not_started');
    });

    it('Teleprompter is done when a teleprompter deliverable exists', () => {
      const result = computePhaseProgress(
        [],
        [{ deliverable_type: 'teleprompter' }],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('done');
    });

    // FIX 50b — basename detection. The registration enum has no
    // 'teleprompter' type, so the REAL row is a file/artifact with the
    // teleprompter's basename in `path`.
    it('FIX 50b — Teleprompter is done from a basename match on path (artifact row)', () => {
      const result = computePhaseProgress(
        [],
        [
          { deliverable_type: 'artifact', path: 'working/deliverables/presenter-teleprompter.html' },
        ],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('done');
    });

    it('FIX 50b — Teleprompter done from a bare-filename path (url row, published)', () => {
      const result = computePhaseProgress(
        [],
        [{ deliverable_type: 'url', path: 'presenter-teleprompter.html' }],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('done');
    });

    it('FIX 50b — Teleprompter done when basename is the only path segment after a deep prefix', () => {
      const result = computePhaseProgress(
        [],
        [
          {
            deliverable_type: 'file',
            path: '/var/openclaw/runs/deck-12/working/deliverables/presenter-teleprompter.html',
          },
        ],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('done');
    });

    it('FIX 50b — basename match tolerates surrounding whitespace in path', () => {
      const result = computePhaseProgress(
        [],
        [
          { deliverable_type: 'artifact', path: '  working/deliverables/presenter-teleprompter.html  ' },
        ],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('done');
    });

    it('FIX 50b — other basenames do NOT advance Teleprompter', () => {
      const result = computePhaseProgress(
        [],
        [
          { deliverable_type: 'artifact', path: 'working/deliverables/PRESENTER-GUIDE.pdf' },
          { deliverable_type: 'file', path: 'out.pptx' },
          { deliverable_type: 'url', path: 'https://teleprompter.example.com/presenter-teleprompter.htmlX' },
        ],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('not_started');
    });

    it('FIX 50b — a non-teleprompter row with no path stays not_started (no crash on null)', () => {
      const result = computePhaseProgress(
        [],
        [{ deliverable_type: 'url', path: null }],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('not_started');
    });

    it('FIX 50b — rows lacking a path field entirely do not crash the reducer', () => {
      const result = computePhaseProgress(
        [],
        [{ deliverable_type: 'artifact' } as unknown as { deliverable_type: string; path?: string | null }],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('not_started');
    });

    it('a P7 activity does NOT advance Teleprompter (unmapped only)', () => {
      const activities = [
        { activity_type: 'status_changed', metadata: { phase_id: 'P7' } },
      ];
      const result = computePhaseProgress(
        activities,
        [{ deliverable_type: 'teleprompter' }],
      );
      const tp = result.phases.find((p) => p.label === 'Teleprompter')!;
      expect(tp.status).toBe('done'); // from the deliverable, not P7
      expect(result.unmapped).toContain('P7');
    });

    it('deduplicates unmapped ids', () => {
      const activities = [
        { activity_type: 'status_changed', metadata: { phase_id: 'P-UNKNOWN' } },
        { activity_type: 'status_changed', metadata: { phase_id: 'P-UNKNOWN' } },
      ];
      const result = computePhaseProgress(activities, []);
      expect(result.unmapped).toEqual(['P-UNKNOWN']);
    });

    it('handles stringified metadata in computePhaseProgress', () => {
      const activities = [
        {
          activity_type: 'status_changed',
          metadata: JSON.stringify({ phase_id: 'P3-ARC' }),
        },
      ];
      const result = computePhaseProgress(activities, []);
      expect(
        result.phases.find((p) => p.label === 'Intake')!.status,
      ).toBe('in_progress');
    });
  });
});
