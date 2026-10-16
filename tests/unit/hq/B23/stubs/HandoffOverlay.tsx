/**
 * TEST-ONLY stub for `./HandoffOverlay` (B25's owned module, not on disk in the
 * B23 worktree). Loaded only through `floor-stub-register.mjs`; never shipped and
 * never imported by product code.
 *
 * It publishes the props Floor composed — evidence list, camera, reduced motion —
 * as data attributes and renders a marker only when evidence exists, so the test
 * can prove Floor passes the caller's facts through untouched and that a missing
 * evidence list reaches the overlay as an empty list ("no event = no walk" starts
 * at this seam). B25's gate, four-overlay bound and reduced-motion rendering are
 * proved by B25's own tests against the real module.
 */
import { createElement } from 'react';
import type { HqLayout } from '@/lib/hq/types';

export type HqHandoffEvidence = {
  activityId: string;
  actorAgentId: string;
  actorLabel: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  label: string;
  historical?: boolean;
};

export type HqHandoffOverlayProps = {
  layout: HqLayout;
  evidence: HqHandoffEvidence[];
  camera: { x: number; y: number; zoom: number };
  reducedMotion?: boolean;
  onComplete?: (activityId: string) => void;
  onCounts?: () => void;
  className?: string;
};

export default function HandoffOverlay({ evidence, camera, reducedMotion = false }: HqHandoffOverlayProps) {
  return createElement('div', {
    'data-testid': 'stub-handoff-layer',
    'data-evidence-ids': evidence.map((item) => item.activityId).join(','),
    'data-evidence-count': String(evidence.length),
    'data-reduced-motion': reducedMotion ? 'true' : 'false',
    'data-camera-zoom': String(camera.zoom),
  });
}
