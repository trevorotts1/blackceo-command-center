'use client';

/**
 * B23 — the illustrated Headquarters floor (SPEC S4; milestones V09/V11).
 *
 * Floor is the COMPOSITION unit. It owns no roster, no geometry and no art of
 * its own: the roster arrives as the frozen S3 projection (`HqDepartment[]`,
 * `@/lib/hq/types`), the geometry as the B04 `HqLayout`, the roam/pan camera and
 * the evidence-linked overlays as the B25 module. Every room and every seat is
 * drawn from that data — this file contains no employee name, no department name
 * and no fixed room count, so "no hardcoded employees" holds by construction.
 *
 * What it composes (S4 "Visual hierarchy"):
 *   - ambient isometric backplate (inline, original, theme tokens only);
 *   - one `<DepartmentRoom>` (B24) per layout room, in `layout.rooms` order,
 *     inside one camera transform, so zoom/pan move the whole floor together;
 *   - upright room label/count chips, which S4 requires "at small scale ... not
 *     hundreds of overlapping names", with the selected room expanded to full
 *     seats ("selecting a room expands all seats");
 *   - `<HandoffOverlay>` (B25), which renders nothing unless a validated
 *     handoff fact exists — "no event = no walk" holds because a missing
 *     evidence list can never draw a walk.
 *
 * Selection is a controlled prop in the shell's hands (`selection` +
 * `onSelect*`); Floor holds no selection state, so a re-render or a fresh
 * snapshot can never silently drop or re-point it. S4's removal rule is
 * implemented as a derived notice plus ONE callback: a selected entity that left
 * the roster shows the notice and returns to its department; Floor mutates
 * nothing, including its own `layout`/`roster`/`handoffs` inputs (the rendered
 * data is read-only and never sorted or written in place).
 *
 * Boundaries kept deliberately: the List alternative and the Floor/List switch
 * belong to the shell (B29) — not duplicated here; the camera math is B25's; the
 * room/figure artwork is B24's. Floor only wires them.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { HqDepartment, HqLayout } from '@/lib/hq/types';
import DepartmentRoom from './DepartmentRoom';
import HandoffOverlay, { type HqHandoffEvidence } from './HandoffOverlay';
import { useHqViewport, worldToScreen, type HqViewportSize } from './useHqViewport';

/**
 * Below this camera zoom a room is drawn as a label/count chip until it is
 * selected (S4 "At small scale show room labels/counts"). Recorded constant, not
 * a second information model — the SPEC permits recording chosen constants.
 */
export const HQ_FLOOR_COMPACT_ZOOM = 0.6;

/** Stable empty evidence list: "no event = no walk" without a fresh array per render. */
const NO_HANDOFFS: HqHandoffEvidence[] = [];

/** What the shell is showing; identity only, never a copied entity (S4 selection by ID). */
export type HqFloorSelection =
  | { kind: 'department'; workspaceId: string }
  | { kind: 'agent'; agentId: string; workspaceId: string };

export type HqFloorProps = {
  /** Frozen B04 geometry. Read-only: Floor never re-derives or mutates it. */
  layout: HqLayout;
  /** Frozen S3 roster projection; the only source of departments and agents. */
  departments: readonly HqDepartment[];
  /** Controlled selection, addressed by ID. `null` means nothing is selected. */
  selection: HqFloorSelection | null;
  onSelectDepartment?: (workspaceId: string) => void;
  onSelectAgent?: (agentId: string, workspaceId: string) => void;
  /** Validated handoff evidence for B25 overlays; absent means no motion at all. */
  handoffs?: HqHandoffEvidence[];
  /** Caller's reduce-motion state (system preference is also honoured by B25). */
  reducedMotion?: boolean;
  /** Pause-animation control (S11). Pauses the view, never real work. */
  animationPaused?: boolean;
  className?: string;
};

export type HqFloorResolvedSelection = {
  /** Department whose room is expanded and marked selected. */
  departmentId: string | null;
  agentId: string | null;
  notice: string | null;
  /** Set only when a vanished selection can be returned to a surviving department. */
  fallbackDepartmentId: string | null;
};

/**
 * Pure S4 selection resolution: addresses are looked up in the CURRENT roster, so
 * an ID that survived a roster change keeps its selection and an ID that did not
 * produces an explicit notice instead of a silent empty panel. Returns intent
 * only — the caller decides when to act on `fallbackDepartmentId`.
 */
export function resolveFloorSelection(
  selection: HqFloorSelection | null,
  departments: readonly HqDepartment[],
): HqFloorResolvedSelection {
  if (!selection) {
    return { departmentId: null, agentId: null, notice: null, fallbackDepartmentId: null };
  }
  if (selection.kind === 'department') {
    const known = departments.some((department) => department.id === selection.workspaceId);
    return known
      ? { departmentId: selection.workspaceId, agentId: null, notice: null, fallbackDepartmentId: null }
      : {
          departmentId: null,
          agentId: null,
          notice: 'Selected department is no longer in the roster.',
          fallbackDepartmentId: null,
        };
  }
  const owner = departments.find((department) =>
    department.agents.some((agent) => agent.id === selection.agentId),
  );
  if (owner) {
    return { departmentId: owner.id, agentId: selection.agentId, notice: null, fallbackDepartmentId: null };
  }
  const fallback = departments.some((department) => department.id === selection.workspaceId)
    ? selection.workspaceId
    : null;
  return {
    departmentId: fallback,
    agentId: null,
    notice: fallback
      ? 'Selected agent is no longer in the roster; returned to its department.'
      : 'Selected agent is no longer in the roster.',
    fallbackDepartmentId: fallback,
  };
}

export default function Floor({
  layout,
  departments,
  selection,
  onSelectDepartment,
  onSelectAgent,
  handoffs,
  reducedMotion = false,
  animationPaused = false,
  className,
}: HqFloorProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const viewport = useHqViewport();
  const { camera } = viewport;

  const departmentsById = useMemo(
    () => new Map(departments.map((department) => [department.id, department])),
    [departments],
  );
  const roomIds = useMemo(
    () => new Set(layout.rooms.map((room) => room.workspaceId)),
    [layout],
  );
  const resolved = useMemo(
    () => resolveFloorSelection(selection, departments),
    [selection, departments],
  );

  // S4 removal rule, as one callback: a selection that vanished returns to the
  // department it still has. Guarded by the last fallback acted on, so a
  // re-render with unchanged props never fires twice.
  const fallbackRef = useRef<string | null>(null);
  useEffect(() => {
    const fallback = resolved.fallbackDepartmentId;
    if (!fallback) {
      fallbackRef.current = null;
      return;
    }
    if (fallbackRef.current === fallback) return;
    fallbackRef.current = fallback;
    onSelectDepartment?.(fallback);
  }, [resolved.fallbackDepartmentId, onSelectDepartment]);

  const selectedDepartmentId = resolved.departmentId;
  const compactScale = camera.zoom < HQ_FLOOR_COMPACT_ZOOM;
  const motionOff = reducedMotion || animationPaused;

  const measure = (): HqViewportSize => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    // An unmeasured surface (jsdom, or not yet laid out) stays honest: 0 x 0
    // makes B25 return the default camera rather than a guessed size.
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };

  const selectDepartment = (workspaceId: string) => {
    onSelectDepartment?.(workspaceId);
  };

  const selectAgent = (agentId: string, workspaceId: string) => {
    onSelectAgent?.(agentId, workspaceId);
  };

  const seatedTotal = layout.rooms.reduce((total, room) => total + room.seats.length, 0);
  const unmatchedRooms = layout.rooms.filter((room) => !departmentsById.has(room.workspaceId)).length;
  const unplacedDepartments = departments.filter((department) => !roomIds.has(department.id)).length;

  return (
    <section
      ref={surfaceRef}
      data-testid="hq-floor"
      data-compact={compactScale ? 'true' : 'false'}
      aria-label="Company floor"
      tabIndex={0}
      onKeyDown={(event) => {
        // B25's handler owns exactly the four arrow keys; everything else (Tab,
        // Escape, typing) falls through, so the pan surface is not a keyboard trap.
        if (viewport.handleKey(event.key)) event.preventDefault();
      }}
      className={`relative flex min-h-[320px] flex-col overflow-hidden bg-bcc-bg ${className ?? ''}`}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-bcc-border bg-bcc-white/80 p-2">
        <button
          type="button"
          data-testid="hq-fit-company"
          onClick={() => viewport.fit(layout, measure())}
          className="min-h-[44px] rounded-xl border border-bcc-border bg-bcc-white px-3 text-label font-medium text-bcc-text hover:border-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
        >
          Fit company
        </button>
        <button
          type="button"
          data-testid="hq-focus-department"
          disabled={!selectedDepartmentId}
          onClick={() => {
            if (selectedDepartmentId) viewport.focus(layout, selectedDepartmentId, measure());
          }}
          className="min-h-[44px] rounded-xl border border-bcc-border bg-bcc-white px-3 text-label font-medium text-bcc-text hover:border-brand-300 disabled:cursor-not-allowed disabled:text-bcc-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
        >
          Focus department
        </button>
        <p
          role="status"
          data-testid="hq-floor-counts"
          className="text-caption text-bcc-text-secondary"
        >
          {layout.rooms.length} rooms · {seatedTotal} seated
          {unmatchedRooms > 0 ? ` · ${unmatchedRooms} layout room(s) without a department record` : ''}
          {unplacedDepartments > 0 ? ` · ${unplacedDepartments} department(s) not placed in this layout` : ''}
        </p>
      </div>

      {resolved.notice && (
        <p
          role="status"
          data-testid="hq-floor-notice"
          className="border-b border-bcc-border bg-semantic-warningLight px-2 py-1 text-caption text-bcc-text"
        >
          {resolved.notice}
        </p>
      )}

      {/* Positioning context for the overlay layers; the camera area may pan (S11). */}
      <div className="relative flex-1 overflow-hidden">
        <svg
          className="absolute inset-0 h-full w-full"
          role="presentation"
          data-testid="hq-floor-surface"
        >
          <defs>
            {/* Original inline artwork: an isometric grid, no copied asset, no per-employee fetch. */}
            <pattern id="hq-floor-grid" width="48" height="24" patternUnits="userSpaceOnUse">
              <path
                d="M 0 12 L 24 0 L 48 12 L 24 24 Z"
                className="fill-none stroke-bcc-border"
                strokeWidth="1"
              />
            </pattern>
          </defs>
          <rect className="fill-bcc-white" x="0" y="0" width="100%" height="100%" />
          {/* The pattern fill is a presentation attribute, not a utility class: a
              Tailwind fill-* class would win the cascade and hide the grid. */}
          <rect x="0" y="0" width="100%" height="100%" fill="url(#hq-floor-grid)" />

          <g
            data-testid="hq-floor-rooms"
            transform={`translate(${-camera.x * camera.zoom} ${-camera.y * camera.zoom}) scale(${camera.zoom})`}
          >
            {layout.rooms.map((room) => {
              const department = departmentsById.get(room.workspaceId);
              // No department record, no drawn room: the count line above reports it
              // rather than inventing an occupant for a room nobody is in.
              if (!department) return null;
              const roomSelected = selectedDepartmentId === room.workspaceId;
              if (compactScale && !roomSelected) return null;
              return (
                <g
                  key={room.workspaceId}
                  data-floor-room={room.workspaceId}
                  data-floor-selected={roomSelected ? 'true' : 'false'}
                  data-floor-seats={room.seats.length}
                >
                  <DepartmentRoom
                    department={department}
                    room={room}
                    selected={roomSelected}
                    onSelectDepartment={selectDepartment}
                    onSelectAgent={(agentId: string) => selectAgent(agentId, room.workspaceId)}
                  />
                </g>
              );
            })}
          </g>
        </svg>

        {/* Upright room labels/counts (S4: labels render separately from the floor). */}
        {compactScale &&
          layout.rooms.map((room) => {
            const department = departmentsById.get(room.workspaceId);
            if (!department || selectedDepartmentId === room.workspaceId) return null;
            const point = worldToScreen(camera, {
              x: room.world.x + room.width / 2,
              y: room.world.y + room.height / 2,
            });
            return (
              <button
                key={room.workspaceId}
                type="button"
                data-floor-chip={room.workspaceId}
                aria-pressed={false}
                onClick={() => selectDepartment(room.workspaceId)}
                style={{ left: point.x, top: point.y }}
                className="absolute -translate-x-1/2 -translate-y-1/2 min-h-[44px] rounded-xl border border-bcc-border bg-bcc-white px-3 text-label font-medium text-bcc-text shadow-card hover:border-brand-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
              >
                {department.name}
                <span className="ml-2 text-bcc-text-secondary">{room.seats.length} seated</span>
              </button>
            );
          })}

        <HandoffOverlay
          layout={layout}
          evidence={handoffs ?? NO_HANDOFFS}
          camera={camera}
          reducedMotion={motionOff}
          className="pointer-events-none absolute inset-0 text-brand-700"
        />
      </div>
    </section>
  );
}
