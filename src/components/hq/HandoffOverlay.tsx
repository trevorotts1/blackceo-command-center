'use client';

/**
 * B25 — evidence-linked motion overlays (SPEC S4 "Movement truth", S11).
 *
 * "Animate only an activity with validated fromWorkspaceId, toWorkspaceId, an
 * actor binding, and an actual observed handoff/collaboration fact." A `working`
 * flag or a task creation without sender evidence does NOT invent a walk, so
 * `deriveHandoffLedger` is the gate: no validated fact, no overlay at all.
 *
 * The source actor keeps ONE home figure; the action overlay is a temporary
 * visit (0.6–1.5 s, default 0.9 s) that returns home — never a second employee,
 * never a stored location change, never a queue real tasks wait behind.
 * "At most four moving overlays on screen"; the rest becomes an explicit
 * aggregated indicator with a count and the full feed list, never discarded.
 *
 * Reduced motion (system preference or the caller's pause toggle) renders the
 * final static arrows/labels instead of the walk — same records, same count, no
 * animation — and the switch is immediate mid-flight, because pausing a view may
 * never pause real work (S4/S11, Q09).
 *
 * This component draws only. It never writes activity, tasks or locations: the
 * evidence it receives is produced by the activity read path (B05/B21) and the
 * feed (B26) owns the full record list.
 */
import { useEffect, useMemo, useRef } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { HqLayout } from '@/lib/hq/types';
import { worldToScreen, type HqCamera } from './useHqViewport';

/** SPEC S4 sets the 0.6–1.5 s action-overlay visit; 0.9 s is the recorded default. */
export const HQ_OVERLAY_VISIT_SECONDS = 0.9;
export const HQ_MAX_ACTIVE_OVERLAYS = 4;
export const HQ_OVERLAY_MS = Math.round(HQ_OVERLAY_VISIT_SECONDS * 1000);

/**
 * One validated handoff/collaboration fact. The consumer (roster/activity read
 * path) supplies it only after the source action was actually observed: the
 * actor binding, both workspace endpoints and the truthful receipt label. A
 * `historical` fact keeps its feed row and never replays an old walk.
 */
export type HqHandoffEvidence = {
  activityId: string;
  actorAgentId: string;
  actorLabel: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  /** Label per actual receipt: "Sent request" | "Handoff accepted" | "Reply received". */
  label: string;
  historical?: boolean;
};

export type HqHandoffOverlay = HqHandoffEvidence & {
  from: { x: number; y: number };
  to: { x: number; y: number };
};

export type HqOverlayCounts = {
  /** Overlays actually drawn in the layer (never more than four). */
  shown: number;
  /** Validated live handoffs beyond the bound: counted here, listed in the feed. */
  aggregated: number;
  /** shown + aggregated. Historical/backfilled and unvalidated rows are excluded. */
  total: number;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The evidence gate alone — true only for a fact that may legally move a figure. */
export function isEvidenceLinkedHandoff(evidence: HqHandoffEvidence): boolean {
  if (evidence.historical === true) return false;
  if (!isNonEmptyString(evidence.activityId)) return false;
  if (!isNonEmptyString(evidence.actorAgentId)) return false;
  if (!isNonEmptyString(evidence.fromWorkspaceId)) return false;
  if (!isNonEmptyString(evidence.toWorkspaceId)) return false;
  if (evidence.fromWorkspaceId === evidence.toWorkspaceId) return false;
  return true;
}

/**
 * Gate + identity + bound in one pure step.
 *
 * Input order is feed order (oldest first), so scanning from the end makes the
 * newest fact win: one moving overlay per actor keeps the employee identity
 * singular under simultaneous work, and older facts for that same actor join the
 * aggregated count instead of cloning the figure. Ordering is stable for a given
 * input — no clock, no randomness, no stored location change.
 */
export function deriveHandoffLedger(
  layout: HqLayout,
  evidence: HqHandoffEvidence[],
): { overlays: HqHandoffOverlay[]; counts: HqOverlayCounts } {
  const rooms = new Map(layout.rooms.map((room) => [room.workspaceId, room]));
  const moving: HqHandoffOverlay[] = [];
  const claimedActors = new Set<string>();
  let validated = 0;

  for (let index = evidence.length - 1; index >= 0; index -= 1) {
    const fact = evidence[index];
    if (!isEvidenceLinkedHandoff(fact)) continue;
    const fromRoom = rooms.get(fact.fromWorkspaceId);
    const toRoom = rooms.get(fact.toWorkspaceId);
    if (!fromRoom || !toRoom) continue;
    validated += 1;
    if (claimedActors.has(fact.actorAgentId)) continue;
    claimedActors.add(fact.actorAgentId);
    moving.push({
      ...fact,
      from: { x: fromRoom.world.x + fromRoom.width / 2, y: fromRoom.world.y + fromRoom.height / 2 },
      to: { x: toRoom.world.x + toRoom.width / 2, y: toRoom.world.y + toRoom.height / 2 },
    });
  }

  const overlays = moving.slice(0, HQ_MAX_ACTIVE_OVERLAYS);
  return {
    overlays,
    counts: { shown: overlays.length, aggregated: validated - overlays.length, total: validated },
  };
}

/**
 * Placement contract: render as a direct child of the camera layer, at that
 * layer's origin. Overlay pixels are the camera's projected pixels, so a
 * decorator between the layer and this component would shift every arrow.
 */
export interface HandoffOverlayProps {
  layout: HqLayout;
  evidence: HqHandoffEvidence[];
  camera: HqCamera;
  /** System `prefers-reduced-motion` OR the caller's pause-animation toggle. */
  reducedMotion?: boolean;
  /** Called once per shown overlay after its 0.6–1.5 s visit completes. */
  onComplete?: (activityId: string) => void;
  /** Called whenever the shown/aggregated counts change. */
  onCounts?: (counts: HqOverlayCounts) => void;
  className?: string;
}

function overlayBox(
  start: { x: number; y: number },
  end: { x: number; y: number },
  pad: number,
): { left: number; top: number; width: number; height: number } {
  const left = Math.min(start.x, end.x) - pad;
  const top = Math.min(start.y, end.y) - pad;
  return {
    left,
    top,
    width: Math.abs(end.x - start.x) + pad * 2,
    height: Math.abs(end.y - start.y) + pad * 2,
  };
}

/**
 * The overlay layer. Renders nothing when no handoff validates — an idle floor
 * stays idle. Under reduced motion the same validated records render as static
 * arrows and text labels, so the information survives without the motion, and
 * the static state is retired by the consumer's live window rather than by an
 * animation timer.
 */
export default function HandoffOverlay({
  layout,
  evidence,
  camera,
  reducedMotion = false,
  onComplete,
  onCounts,
  className,
}: HandoffOverlayProps) {
  const systemReduced = useReducedMotion();
  const staticMode = reducedMotion || systemReduced === true;
  const { overlays, counts } = useMemo(() => deriveHandoffLedger(layout, evidence), [layout, evidence]);

  // Latest props and the displayed set live in refs so the visit timer restarts
  // only when the shown overlay set or the motion mode actually changes.
  const onCompleteRef = useRef(onComplete);
  const onCountsRef = useRef(onCounts);
  const overlaysRef = useRef(overlays);
  const retiredRef = useRef(new Set<string>());
  const { shown, aggregated, total } = counts;
  const shownKey = overlays.map((overlay) => overlay.activityId).join('|');

  useEffect(() => {
    onCompleteRef.current = onComplete;
    onCountsRef.current = onCounts;
    overlaysRef.current = overlays;
  });

  useEffect(() => {
    onCountsRef.current?.({ shown, aggregated, total });
  }, [shown, aggregated, total]);

  useEffect(() => {
    if (staticMode) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const overlay of overlaysRef.current) {
      if (retiredRef.current.has(overlay.activityId)) continue;
      timers.push(
        setTimeout(() => {
          retiredRef.current.add(overlay.activityId);
          onCompleteRef.current?.(overlay.activityId);
        }, HQ_OVERLAY_MS),
      );
    }
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [staticMode, shownKey]);

  if (overlays.length === 0) return null;

  const pad = 24 * camera.zoom;

  return (
    <div
      className={className}
      data-testid="hq-handoff-overlays"
      data-overlay-count={shown}
      data-aggregated-count={aggregated}
      data-reduced-motion={staticMode ? 'true' : 'false'}
    >
      {overlays.map((overlay) => {
        const start = worldToScreen(camera, overlay.from);
        const end = worldToScreen(camera, overlay.to);
        const box = overlayBox(start, end, pad);
        const localStart = { x: start.x - box.left, y: start.y - box.top };
        const localEnd = { x: end.x - box.left, y: end.y - box.top };
        return (
          <svg
            key={overlay.activityId}
            data-testid={`hq-handoff-${overlay.activityId}`}
            data-activity-id={overlay.activityId}
            data-actor-id={overlay.actorAgentId}
            data-from-workspace={overlay.fromWorkspaceId}
            data-to-workspace={overlay.toWorkspaceId}
            data-label={overlay.label}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0"
            style={{ width: box.width, height: box.height, transform: `translate(${box.left}px, ${box.top}px)` }}
            viewBox={`0 0 ${box.width} ${box.height}`}
          >
            {staticMode ? (
              <g data-testid={`hq-handoff-static-${overlay.activityId}`}>
                <line
                  x1={localStart.x}
                  y1={localStart.y}
                  x2={localEnd.x}
                  y2={localEnd.y}
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                />
                <circle cx={localEnd.x} cy={localEnd.y} r={5} fill="currentColor" />
                <text x={localEnd.x + 8} y={localEnd.y - 8} className="fill-current text-[11px]">
                  {overlay.label}
                </text>
              </g>
            ) : (
              <motion.g
                data-testid={`hq-handoff-moving-${overlay.activityId}`}
                initial={{ x: localStart.x, y: localStart.y }}
                animate={{ x: [localStart.x, localEnd.x, localStart.x], y: [localStart.y, localEnd.y, localStart.y] }}
                transition={{ duration: HQ_OVERLAY_VISIT_SECONDS, times: [0, 0.5, 1], ease: 'easeInOut' }}
              >
                <circle r={6} fill="currentColor" />
                <text x={8} y={-8} className="fill-current text-[11px]">
                  {overlay.label}
                </text>
              </motion.g>
            )}
          </svg>
        );
      })}
      {/* Polite aggregate status: announces a count, never every token or walk. */}
      <span
        role="status"
        data-testid="hq-handoff-aggregate"
        className="absolute bottom-2 left-2 rounded bg-bcc-white/90 px-2 py-1 text-[11px] text-bcc-text-secondary shadow-card"
      >
        {aggregated > 0
          ? `${shown} moving · ${aggregated} more handoff${aggregated === 1 ? '' : 's'} in activity`
          : `${shown} handoff${shown === 1 ? '' : 's'} in progress`}
      </span>
    </div>
  );
}
