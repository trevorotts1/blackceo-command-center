/**
 * Company Headquarters — deterministic floor geometry (unit B04, milestones V03/V09).
 *
 * Authority: SPEC.md revision 4 §S4 ("Deterministic geometry"), read against the
 * frozen S3/S4 contracts in `src/lib/hq/types.ts` (P01). `buildLayout` is a pure
 * function from the roster projection to `HqLayout`: no database, no second org
 * store, no mutation of its input, and byte-identical output — ids, positions and
 * revision — whatever order the caller's department and agent rows arrive in.
 *
 * SPEC S4 constants (recorded here because S4 requires a changed constant to be
 * recorded, not silently retuned): room width 480, corridor 80, four room columns,
 * 96-unit seat spacing, room height `max(320, 144 + 72 * ceil(seatedCount / 4))`
 * exactly as written in S4, with `seatedCount` = the room's total seats including
 * the head (the head occupies the 144-unit top band, so the stated height always
 * contains the stated content). Camera/viewport state is not an input.
 *
 * P01 gap resolutions frozen by this first consumer (S17 change control; the gaps
 * are listed as G-03..G-07 in `evidence/contracts/interfaces.md`):
 *
 *   G-03 — signature `buildLayout(roster: HqLayoutInput): Promise<HqLayout>`. S4 also
 *          orders departments by "master/CEO first when explicitly identified" and
 *          "then existing sort order"; neither fact has a field in the frozen
 *          `HqDepartment`, so both arrive as explicit caller-supplied facts. Nothing
 *          is inferred from a person's name, a slug, a role string or a display name.
 *   G-04 — the four seat columns sit at room-local x = 96 * (column + 1):
 *          96 / 192 / 288 / 384 inside a 480-wide room — 96-unit spacing and
 *          96-unit side margins, so the stated width contains the stated columns.
 *   G-05 — room origins: first row and column start at (80, 80); column pitch
 *          480 + 80; every row sits `rowHeight + 80` below the previous one, where
 *          rowHeight is that row's tallest room (S4). Rooms therefore never overlap.
 *   G-06 — head station at room-local (240, 72), the centre of the 144-unit top band.
 *          Label hit areas are screen-space, anchored above the seat's projected
 *          point: `hqSeatLabelBox` returns 128 x 44 (44 meets the S11 control floor).
 *   G-07 — revision preimage is the S7 canonical serialization (P01
 *          `hqSemanticSerialize`) of, per department in layout order: order index,
 *          workspace id, effective head binding; and per seat in layout order: order
 *          index, agent id, staffing, isHead. Those are exactly the four facts S4
 *          names — normalized ids, sort orders, staffing, explicit head bindings.
 *          Status, display name, observation time, task links and geometry constants
 *          are excluded, so a status refresh cannot rotate the revision.
 *
 * Seating rule: permanent agents have fixed home seats (S3). On-call agents take a
 * seat only while they show a current work signal — a reported `working`/`busy`
 * status or an open task link; an enrolled but inactive on-call agent has no seat and
 * belongs to the "On-call team" list (S3), which is a view concern outside this
 * module. Seating is a rendering fact and claims no execution proof: `standby` is the
 * reported state, and an open task alone does not prove live execution (S3).
 *
 * One runtime presence, one seat: if the same agent id appears in more than one
 * department (S3's head row and imported department runtime sharing one binding), the
 * first department in layout order keeps the seat and the later duplicate is not
 * duplicated on the floor (S4 "No duplicate figure"). The roster itself is never
 * modified — this function only projects it.
 *
 * No `node:` imports: the SHA-256 digest uses WebCrypto, so this module stays
 * importable from both server and client code, as P01 did for the contract module.
 */
import {
  hqSemanticSerialize,
  type HqAgent,
  type HqDepartment,
  type HqLayout,
  type HqRoomLayout,
  type HqSeatLayout,
  type HqWorldPoint,
} from './types';

/* ------------------------------------------------------------------ *
 * S4 geometry constants (recorded; see header)
 * ------------------------------------------------------------------ */

export const HQ_ROOM_WIDTH = 480;
export const HQ_ROOM_COLUMNS = 4;
export const HQ_CORRIDOR = 80;
export const HQ_SEAT_SPACING = 96;
export const HQ_SEAT_ROW_HEIGHT = 72;
export const HQ_ROOM_HEADER = 144;
export const HQ_ROOM_MIN_HEIGHT = 320;

/** Room-local position of the single head station, centred in the top band. */
export const HQ_HEAD_STATION: HqWorldPoint = { x: HQ_ROOM_WIDTH / 2, y: HQ_ROOM_HEADER / 2 };

/** G-06 label hit area, in screen units, sized to the S11 44-unit control floor. */
export const HQ_SEAT_LABEL_WIDTH = 128;
export const HQ_SEAT_LABEL_HEIGHT = 44;

/* ------------------------------------------------------------------ *
 * Inputs and helpers
 * ------------------------------------------------------------------ */

/**
 * `buildLayout` input. `departments` is the S3 roster projection; row order is not
 * significant. `masterWorkspaceId` and `sortOrder` carry the two ordering facts S4
 * names but the frozen `HqDepartment` does not hold — pass them from the explicit
 * source facts (for example an `is_master` row and `workspaces.sort_order`); pass
 * nothing rather than guessing.
 */
export type HqLayoutInput = {
  departments: HqDepartment[];
  /** Workspace id explicitly identified as CEO/master. Never inferred from a name. */
  masterWorkspaceId?: string | null;
  /** Existing department sort order, keyed by workspace id. */
  sortOrder?: Readonly<Record<string, number>> | null;
};

/** Screen-space rectangle, e.g. a label hit area. */
export type HqLayoutLabelBox = { x: number; y: number; width: number; height: number };

/** Room height for a seat count, exactly as S4 states it. */
function hqRoomHeight(seatedCount: number): number {
  return Math.max(HQ_ROOM_MIN_HEIGHT, HQ_ROOM_HEADER + HQ_SEAT_ROW_HEIGHT * Math.ceil(seatedCount / HQ_ROOM_COLUMNS));
}

/** Room-local position of the column seat at `slot` (0-based, head station excluded). */
function hqColumnSeatPoint(slot: number): HqWorldPoint {
  const column = slot % HQ_ROOM_COLUMNS;
  const row = Math.floor(slot / HQ_ROOM_COLUMNS);
  return {
    x: HQ_SEAT_SPACING * (column + 1),
    y: HQ_ROOM_HEADER + HQ_SEAT_ROW_HEIGHT * row,
  };
}

/** Code-unit comparison: deterministic across environments, unlike locale collation. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * S3/S4 seating: permanent agents always have a home seat; an on-call agent is
 * seated only while it shows a current work signal. Reported status is not proof of
 * execution (S3) — this decides placement on the floor, not a liveness claim.
 */
export function hqIsSeated(agent: HqAgent): boolean {
  if (agent.staffing === 'permanent') return true;
  return agent.status === 'working' || agent.status === 'busy' || agent.activeTaskIds.length > 0;
}

/**
 * G-06 label hit area for a seat: screen-space, 128 x 44, centred on the seat's
 * projected point and sitting directly above it. Upright labels are rendered
 * separately from the isometric floor (S4), so the box is screen-space.
 */
export function hqSeatLabelBox(seat: HqSeatLayout): HqLayoutLabelBox {
  return {
    x: seat.screenX - HQ_SEAT_LABEL_WIDTH / 2,
    y: seat.screenY - HQ_SEAT_LABEL_HEIGHT,
    width: HQ_SEAT_LABEL_WIDTH,
    height: HQ_SEAT_LABEL_HEIGHT,
  };
}

/** S4 seat order: head first, then permanent by role then agent id, then on-call by id. */
function hqSeatRank(agent: HqAgent, headAgentId: string | null): number {
  if (agent.isHead || agent.id === headAgentId) return 0;
  return agent.staffing === 'permanent' ? 1 : 2;
}

type OrderedSeat = { agent: HqAgent; inputIndex: number; rank: number };

function compareSeats(left: OrderedSeat, right: OrderedSeat): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.rank === 1) {
    const byRole = compareText(left.agent.role, right.agent.role);
    if (byRole !== 0) return byRole;
  }
  const byId = compareText(left.agent.id, right.agent.id);
  if (byId !== 0) return byId;
  return left.inputIndex - right.inputIndex;
}

/** S4 department order: explicit master first, then existing sort order, then workspace id. */
function hqOrderedDepartments(roster: HqLayoutInput): HqDepartment[] {
  const masterWorkspaceId = roster.masterWorkspaceId ?? null;
  const sortOrder = roster.sortOrder ?? null;
  const orderOf = (department: HqDepartment, inputIndex: number): number => {
    if (masterWorkspaceId !== null && department.id === masterWorkspaceId) return 0;
    const supplied = sortOrder?.[department.id];
    if (typeof supplied === 'number' && Number.isFinite(supplied)) return supplied;
    return Number.MAX_SAFE_INTEGER;
  };
  return roster.departments
    .map((department, inputIndex) => ({
      department,
      inputIndex,
      master: masterWorkspaceId !== null && department.id === masterWorkspaceId,
      order: orderOf(department, inputIndex),
    }))
    .sort((left, right) => {
      if (left.master !== right.master) return left.master ? -1 : 1;
      if (left.order !== right.order) return left.order - right.order;
      const byId = compareText(left.department.id, right.department.id);
      if (byId !== 0) return byId;
      return left.inputIndex - right.inputIndex;
    })
    .map((entry) => entry.department);
}

/** G-07 preimage: canonical bytes over exactly the four facts S4 names. */
function hqLayoutRevisionPreimage(
  built: { department: HqDepartment; seated: HqAgent[]; headSeatId: string | null }[],
): string {
  return hqSemanticSerialize({
    departments: built.map((entry, index) => ({
      id: entry.department.id,
      index,
      headAgentId: entry.headSeatId,
      seats: entry.seated.map((agent, seatIndex) => ({
        agentId: agent.id,
        index: seatIndex,
        isHead: agent.id === entry.headSeatId,
        staffing: agent.staffing,
      })),
    })),
  });
}

async function hqSha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ *
 * buildLayout
 * ------------------------------------------------------------------ */

/**
 * Derive the S4 floor: one room per department, seats in the S4 order, isometric
 * projection `screenX = x - y`, `screenY = (x + y) / 2` on absolute world points,
 * and the layout revision. Pure and deterministic: identical roster facts produce an
 * identical layout and revision regardless of input row order or caller clock.
 */
export async function buildLayout(roster: HqLayoutInput): Promise<HqLayout> {
  const seatedAgentIds = new Set<string>();

  const built = hqOrderedDepartments(roster).map((department) => {
    const headAgentId = department.headAgentId ?? null;
    const seated = department.agents
      .filter((agent) => hqIsSeated(agent))
      .map((agent, inputIndex) => ({ agent, inputIndex, rank: hqSeatRank(agent, headAgentId) }))
      .sort(compareSeats)
      .map((entry) => entry.agent)
      // One runtime presence, one figure (S3 shared binding, S4 no duplicate figure).
      .filter((agent) => {
        if (seatedAgentIds.has(agent.id)) return false;
        seatedAgentIds.add(agent.id);
        return true;
      });
    const headSeatId = seated.find((agent) => agent.isHead || agent.id === headAgentId)?.id ?? null;
    return { department, seated, headSeatId, height: hqRoomHeight(seated.length) };
  });

  const rowHeights: number[] = [];
  built.forEach((entry, index) => {
    const row = Math.floor(index / HQ_ROOM_COLUMNS);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, entry.height);
  });

  const rooms: HqRoomLayout[] = built.map((entry, index) => {
    const column = index % HQ_ROOM_COLUMNS;
    const row = Math.floor(index / HQ_ROOM_COLUMNS);
    let originY = HQ_CORRIDOR;
    for (let previous = 0; previous < row; previous += 1) originY += rowHeights[previous] + HQ_CORRIDOR;
    const origin: HqWorldPoint = { x: HQ_CORRIDOR + column * (HQ_ROOM_WIDTH + HQ_CORRIDOR), y: originY };

    let columnSlot = 0;
    const seats: HqSeatLayout[] = entry.seated.map((agent) => {
      const isHead = agent.id === entry.headSeatId;
      const local = isHead ? HQ_HEAD_STATION : hqColumnSeatPoint(columnSlot++);
      const world: HqWorldPoint = { x: origin.x + local.x, y: origin.y + local.y };
      return {
        agentId: agent.id,
        isHead,
        world,
        screenX: world.x - world.y,
        screenY: (world.x + world.y) / 2,
      };
    });

    return {
      workspaceId: entry.department.id,
      world: origin,
      width: HQ_ROOM_WIDTH,
      height: entry.height,
      seats,
    };
  });

  return { revision: await hqSha256Hex(hqLayoutRevisionPreimage(built)), rooms };
}
