'use client';

/**
 * DepartmentRoom — one department's room on the Headquarters floor (unit B24,
 * milestones V09/V11).
 *
 * Authority: SPEC.md revision 4 §S3 (identity, conflicts, on-call placement),
 * §S4 (visual hierarchy, deterministic geometry, "no duplicate figure"), §S11
 * (labels, contrast). Geometry arrives as `HqRoomLayout` from `buildLayout` (B04);
 * this component renders the isometric room boundary, the furniture and the
 * upright figures at their frozen screen points, and mutates nothing.
 *
 * Truth rules honoured here, each traceable to a phase of the roster:
 *   - "Shared department executor" is shown when the roster's `bindingKind` is
 *     `department-shared` (S3): the roles are work areas and the department counts
 *     ONE observed runtime, not several employees. The room states the count it
 *     actually seats.
 *   - Unmaterialized roles / missing runtime are never silently repaired: `unbound`
 *     agents keep their seats and carry the S3 string "Runtime binding unavailable"
 *     on the figure, which this room does not override.
 *   - Enrolled but inactive on-call agents are NOT seated (`buildLayout` seats only
 *     on a current work signal) and are listed in the room's "On-call team" block
 *     with the label S3 uses, so staffing is visible without faking occupancy.
 *   - Planned roles (provisioning not `ready`) are visually distinct and are counted
 *     as planned, never as running agents (S3).
 *
 * `office.svg` is referenced by fragment (`<use href="/hq/office.svg#hq-rug">`) from
 * the `public/hq` asset B24 owns, so the artwork is one file and not a fetch per
 * employee (S11 route-splits HQ assets; no initial fetch per employee).
 */
import type { HqDepartment, HqRoomLayout } from '@/lib/hq/types';
import AgentFigure from './AgentFigure';

export type DepartmentRoomProps = {
  department: HqDepartment;
  room: HqRoomLayout;
  /** True when this room's department or an agent inside it is the selection (S4). */
  selected?: boolean;
  onSelectDepartment?: (workspaceId: string) => void;
  onSelectAgent?: (agentId: string) => void;
};

export default function DepartmentRoom({
  department,
  room,
  selected = false,
  onSelectDepartment,
  onSelectAgent,
}: DepartmentRoomProps) {
  const agentById = new Map(department.agents.map((agent) => [agent.id, agent]));

  // S3: an on-call agent with no current work signal is enrolled, not seated.
  const seatedIds = new Set(room.seats.map((seat) => seat.agentId));
  const onCallTeam = department.agents.filter(
    (agent) => agent.staffing === 'on-call' && !seatedIds.has(agent.id),
  );
  const plannedCount = department.agents.filter((agent) => !agent.runtimeBound).length;

  // The room floor is the parallelogram between the four projected footprint
  // corners. `originScreen` is the projection of room-local (0,0) — the corner the
  // department label is anchored to.
  const originScreen = { x: room.world.x - room.world.y, y: (room.world.x + room.world.y) / 2 };
  const farCorner = {
    x: room.world.x + room.width - room.world.y,
    y: (room.world.x + room.width + room.world.y) / 2,
  };
  const nearCorner = {
    x: room.world.x + room.width - (room.world.y + room.height),
    y: (room.world.x + room.width + room.world.y + room.height) / 2,
  };
  const deepCorner = {
    x: room.world.x - (room.world.y + room.height),
    y: (room.world.x + room.world.y + room.height) / 2,
  };
  const floorPath = `M ${originScreen.x} ${originScreen.y} L ${farCorner.x} ${farCorner.y} L ${nearCorner.x} ${nearCorner.y} L ${deepCorner.x} ${deepCorner.y} Z`;

  return (
    <g
      data-testid={`hq-room-${department.id}`}
      data-workspace-id={department.id}
      data-provisioning={department.provisioning}
      data-seated={room.seats.length}
    >
      {/* S4 room boundary. Clicking the room focuses the department. */}
      {/* The room is a click target, so its outline meets S11's 3:1 non-text floor:
          brand-600 is 3.30:1 on white (brand-300 would be 2.01:1). */}
      <path
        d={floorPath}
        className={`${selected ? 'fill-brand-50' : 'fill-bcc-white'} ${selected ? 'stroke-brand-700' : 'stroke-brand-600'}`}
        strokeWidth={selected ? 3 : 1.5}
        onClick={() => onSelectDepartment?.(department.id)}
        style={{ cursor: 'pointer' }}
      />

      {/* Furniture: fragment references into the one B24 artwork sheet. */}
      <use href="/hq/office.svg#hq-rug" x={originScreen.x} y={originScreen.y + room.height / 2} />
      {room.seats
        .filter((seat) => seat.isHead)
        .map((seat) => (
          <use key={`desk-${seat.agentId}`} href="/hq/office.svg#hq-head-desk" x={seat.screenX} y={seat.screenY} />
        ))}
      {room.seats
        .filter((seat) => !seat.isHead)
        .map((seat) => (
          <use key={`desk-${seat.agentId}`} href="/hq/office.svg#hq-desk" x={seat.screenX} y={seat.screenY} />
        ))}

      {/* Department label above the room, with the seated count it actually has.
          Sits above the floor fill, so white behind: token text fill keeps every
          label pair at the same ≥14.9:1 on any surface the room can paint. */}
      <text x={originScreen.x} y={originScreen.y - 26} textAnchor="middle" className="fill-bcc-text text-[13px] font-semibold">
        {department.name}
      </text>
      <text x={originScreen.x} y={originScreen.y - 14} textAnchor="middle" className="fill-bcc-text text-[10px]">
        {department.slug} · {room.seats.length} seated
      </text>

      {/* S3 explicit conflicts: provisioning and the shared-executor binding. amber-800,
          not amber-700: the label sits at the room edge and can overlap the selected
          room's brand-50 floor, where amber-700 measures 4.464:1 (amber-800 is 6.30:1). */}
      {department.provisioning !== 'ready' && (
        <text x={originScreen.x} y={originScreen.y - 2} textAnchor="middle" className="fill-amber-800 text-[10px] font-medium">
          {department.provisioning === 'incomplete' ? 'Setup incomplete' : 'Provisioning unknown'}
        </text>
      )}
      {/* S3 shared binding: the roles are labeled on their own figures; the room
          states the runtime count it observes — one, not one per role row. Token text
          fill: these lines sit inside the room, so on the selected brand-50 floor
          #6B7280 would measure 4.298:1 — below the S11 floor (#1A1D26 is 14.96:1). */}
      {department.agents.some((agent) => agent.bindingKind === 'department-shared') && (
        <text x={originScreen.x} y={originScreen.y + 10} textAnchor="middle" className="fill-bcc-text text-[10px]">
          1 observed runtime
        </text>
      )}
      {plannedCount > 0 && (
        <text x={originScreen.x} y={originScreen.y + 22} textAnchor="middle" className="fill-bcc-text text-[10px]">
          Planned roles: {plannedCount}
        </text>
      )}

      {/* Upright figures, drawn after the furniture so nobody stands behind a desk. */}
      {room.seats.map((seat) => {
        const agent = agentById.get(seat.agentId);
        if (!agent) return null;
        return (
          <AgentFigure
            key={seat.agentId}
            agent={agent}
            seat={seat}
            onSelect={onSelectAgent}
          />
        );
      })}

      {/* S3 "On-call team" list: enrolled, not seated, not counted as employees at work.
          List text keeps the token text fill, not bcc-text-secondary: the list always
          overlaps the rug (#E8F5E9), where #6B7280 measures 4.298:1 — below the S11
          floor — while #1A1D26 measures 14.96:1 there. */}
      {onCallTeam.length > 0 && (
        <g transform={`translate(${originScreen.x} ${originScreen.y + room.height / 2 - 8})`}>
          <text x={0} y={0} textAnchor="middle" className="fill-bcc-text text-[10px] font-medium">
            On-call team
          </text>
          {onCallTeam.map((agent, index) => (
            <text
              key={agent.id}
              x={0}
              y={12 + index * 11}
              textAnchor="middle"
              className="fill-bcc-text text-[10px]"
            >
              {agent.displayName || agent.id}
            </text>
          ))}
        </g>
      )}
    </g>
  );
}
