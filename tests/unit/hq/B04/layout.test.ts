/**
 * B04 focused behavior checks: SPEC S4 deterministic geometry and layout revision.
 * Pure-function tests only — no database, no fixtures, no server imports.
 *
 * Acceptance covered (swarm-plan B04 check / todo V03 Q03): reordered-input
 * equality, sparse and large rosters, unique home position, readable room spacing,
 * plus the seating order, single-figure and revision-stability rules S3/S4 state.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HQ_CORRIDOR,
  HQ_ROOM_COLUMNS,
  HQ_ROOM_WIDTH,
  HQ_SEAT_SPACING,
  buildLayout,
  hqIsSeated,
  hqSeatLabelBox,
  type HqLayoutInput,
} from '../../../../src/lib/hq/layout';
import type { HqAgent, HqDepartment } from '../../../../src/lib/hq/types';

function agent(over: Partial<HqAgent> & { id: string }): HqAgent {
  return {
    workspaceId: 'ws-1',
    displayName: over.id,
    role: 'specialist',
    isHead: false,
    staffing: 'permanent',
    runtimeBound: true,
    canTalk: true,
    runtimeAgentId: null,
    bindingKind: 'unbound',
    sharedRoleIds: [],
    status: 'standby',
    observedAt: null,
    activeTaskIds: [],
    ...over,
  };
}

function department(over: Partial<HqDepartment> & { id: string; agents: HqAgent[] }): HqDepartment {
  return { slug: over.id, name: over.id, headAgentId: null, provisioning: 'ready', ...over };
}

const ws1 = 'ws-1';

function threeDepartments(): HqDepartment[] {
  return [
    department({
      id: ws1,
      headAgentId: 'a-head',
      agents: [
        agent({ id: 'a-head', workspaceId: ws1, isHead: true, role: 'head', isHead: true }),
        agent({ id: 'a-b', workspaceId: ws1, role: 'beta' }),
        agent({ id: 'a-a', workspaceId: ws1, role: 'alpha' }),
      ],
    }),
    department({
      id: 'ws-2',
      headAgentId: 'b-head',
      agents: [
        agent({ id: 'b-head', workspaceId: 'ws-2', isHead: true, role: 'head' }),
        agent({ id: 'b-oncall', workspaceId: 'ws-2', staffing: 'on-call', status: 'working' }),
      ],
    }),
    department({ id: 'ws-3', agents: [] }),
  ];
}

test('sparse roster: one department, one head seat, no crash, exact constants', async () => {
  const sparse: HqLayoutInput = {
    departments: [department({ id: 'ws-only', headAgentId: 'h', agents: [agent({ id: 'h', workspaceId: 'ws-only', isHead: true, role: 'ceo' })] })],
  };
  const layout = await buildLayout(sparse);
  assert.equal(layout.rooms.length, 1);
  const room = layout.rooms[0];
  assert.equal(room.workspaceId, 'ws-only');
  assert.equal(room.width, HQ_ROOM_WIDTH);
  assert.equal(room.height, 320); // max(320, 144 + 72*ceil(1/4)) = max(320, 216)
  assert.equal(room.world.x, HQ_CORRIDOR);
  assert.equal(room.world.y, HQ_CORRIDOR);
  assert.equal(room.seats.length, 1);
  assert.equal(room.seats[0].isHead, true);
  assert.match(layout.revision, /^[0-9a-f]{64}$/);

  // Empty department still gets a room and occupies a column, with no seats.
  const emptyDept = await buildLayout({ departments: [department({ id: 'ws-empty', agents: [] })] });
  assert.equal(emptyDept.rooms.length, 1);
  assert.equal(emptyDept.rooms[0].seats.length, 0);
  assert.equal(emptyDept.rooms[0].height, 320);
});

test('isometric projection is exactly screenX=x-y, screenY=(x+y)/2 on world points', async () => {
  const layout = await buildLayout({ departments: threeDepartments() });
  for (const room of layout.rooms) {
    for (const seat of room.seats) {
      assert.equal(seat.screenX, seat.world.x - seat.world.y);
      assert.equal(seat.screenY, (seat.world.x + seat.world.y) / 2);
      assert.ok(seat.world.x >= room.world.x && seat.world.x <= room.world.x + room.width);
      assert.ok(seat.world.y >= room.world.y);
    }
  }
});

test('reordered input yields an identical layout and revision (Q03)', async () => {
  const base = threeDepartments();
  const shuffled: HqDepartment[] = [base[2], base[0], base[1]]
    .map((dept) => ({ ...dept, agents: [...dept.agents].reverse() }));
  const [straight, reordered] = await Promise.all([buildLayout({ departments: base }), buildLayout({ departments: shuffled })]);
  assert.deepEqual(reordered, straight);
  assert.equal(reordered.revision, straight.revision);
  // Reordering cannot change the projection either.
  assert.deepEqual(reordered.rooms.map((room) => room.workspaceId), straight.rooms.map((room) => room.workspaceId));
});

test('explicit master and sort order drive department order; nothing is inferred', async () => {
  const departments = [
    department({ id: 'ws-z', agents: [] }),
    department({ id: 'ws-a', agents: [] }),
    department({ id: 'ws-m', agents: [] }),
  ];
  const byId = await buildLayout({ departments, sortOrder: { 'ws-z': 5, 'ws-a': 20 } });
  // ws-m carries no sort order, so it sorts after every ordered row (stable id order).
  assert.deepEqual(byId.rooms.map((r) => r.workspaceId), ['ws-z', 'ws-a', 'ws-m']);
  const bySort = await buildLayout({ departments, sortOrder: { 'ws-z': 5, 'ws-a': 20, 'ws-m': 30 } });
  assert.deepEqual(bySort.rooms.map((r) => r.workspaceId), ['ws-z', 'ws-a', 'ws-m']);
  const byMaster = await buildLayout({ departments, masterWorkspaceId: 'ws-a', sortOrder: { 'ws-z': 1, 'ws-m': 2 } });
  assert.deepEqual(byMaster.rooms.map((r) => r.workspaceId), ['ws-a', 'ws-z', 'ws-m']);
});

test('seat order: head first, then permanent by role then id, then active on-call by id', async () => {
  const layout = await buildLayout({
    departments: [
      department({
        id: ws1,
        headAgentId: 'z-head',
        agents: [
          agent({ id: 'c-oncall', workspaceId: ws1, staffing: 'on-call', status: 'busy' }),
          agent({ id: 'b-perm', workspaceId: ws1, role: 'zeta' }),
          agent({ id: 'a-perm', workspaceId: ws1, role: 'alpha' }),
          agent({ id: 'z-head', workspaceId: ws1, isHead: true, role: 'head' }),
          agent({ id: 'd-perm', workspaceId: ws1, role: 'alpha' }),
        ],
      }),
    ],
  });
  assert.deepEqual(layout.rooms[0].seats.map((seat) => seat.agentId), ['z-head', 'a-perm', 'd-perm', 'b-perm', 'c-oncall']);
});

test('on-call agent without a current work signal is not seated; reported status is not execution proof', async () => {
  assert.equal(hqIsSeated(agent({ id: 'x', staffing: 'on-call', status: 'standby' })), false);
  assert.equal(hqIsSeated(agent({ id: 'x', staffing: 'on-call', status: 'offline' })), false);
  assert.equal(hqIsSeated(agent({ id: 'x', staffing: 'on-call', status: 'unknown' })), false);
  assert.equal(hqIsSeated(agent({ id: 'x', staffing: 'on-call', status: 'working' })), true);
  assert.equal(hqIsSeated(agent({ id: 'x', staffing: 'on-call', status: 'busy' })), true);
  assert.equal(hqIsSeated(agent({ id: 'x', staffing: 'on-call', status: 'standby', activeTaskIds: ['t-1'] })), true);
  assert.equal(hqIsSeated(agent({ id: 'x', staffing: 'permanent', status: 'offline' })), true);

  const layout = await buildLayout({
    departments: [department({ id: ws1, agents: [agent({ id: 'idle-oncall', workspaceId: ws1, staffing: 'on-call', status: 'standby' })] })],
  });
  assert.equal(layout.rooms[0].seats.length, 0);
});

test('one runtime presence keeps one seat: a duplicate agent id is not drawn twice', async () => {
  const shared = agent({ id: 'shared-runtime', workspaceId: ws1, role: 'shared department executor', bindingKind: 'department-shared' });
  const layout = await buildLayout({
    departments: [
      department({ id: 'ws-a', headAgentId: 'shared-runtime', agents: [shared] }),
      department({ id: 'ws-b', headAgentId: 'shared-runtime', agents: [{ ...shared, workspaceId: 'ws-b' }] }),
    ],
  });
  assert.deepEqual(layout.rooms.map((room) => room.seats.map((seat) => seat.agentId)), [['shared-runtime'], []]);
  assert.equal(layout.rooms[0].seats[0].isHead, true);
});

test('large roster: unique home position for every seat and readable, non-overlapping rooms', async () => {
  const departments: HqDepartment[] = [];
  for (let d = 0; d < 12; d += 1) {
    const id = `ws-${String(d).padStart(2, '0')}`;
    const agents: HqAgent[] = [];
    for (let a = 0; a < 9; a += 1) agents.push(agent({ id: `${id}-a${String(a).padStart(2, '0')}`, workspaceId: id, role: `role-${a % 3}` }));
    departments.push(department({ id, headAgentId: agents[0].id, agents: [{ ...agents[0], isHead: true, role: 'head' }, ...agents.slice(1)] }));
  }
  const layout = await buildLayout({ departments, sortOrder: Object.fromEntries(departments.map((dept, index) => [dept.id, index])) });
  assert.equal(layout.rooms.length, 12);

  const seen = new Set<string>();
  for (const room of layout.rooms) {
    assert.equal(room.seats.length, 9);
    // S4 height formula, with the head counted inside seatedCount.
    assert.equal(room.height, Math.max(320, 144 + 72 * Math.ceil(9 / HQ_ROOM_COLUMNS)));
    for (const seat of room.seats) {
      const key = `${seat.world.x},${seat.world.y}`;
      assert.equal(seen.has(key), false, `duplicate home position ${key}`);
      seen.add(key);
      const box = hqSeatLabelBox(seat);
      assert.equal(box.width, 128);
      assert.equal(box.height, 44);
      assert.equal(box.x, seat.screenX - 64);
    }
  }

  // Room rows/columns occupy distinct footprints with a corridor between them.
  for (let i = 0; i < layout.rooms.length; i += 1) {
    for (let j = i + 1; j < layout.rooms.length; j += 1) {
      const a = layout.rooms[i];
      const b = layout.rooms[j];
      const disjoint =
        a.world.x + a.width + HQ_CORRIDOR <= b.world.x ||
        b.world.x + b.width + HQ_CORRIDOR <= a.world.x ||
        a.world.y + a.height + HQ_CORRIDOR <= b.world.y ||
        b.world.y + b.height + HQ_CORRIDOR <= a.world.y;
      assert.equal(disjoint, true, `rooms ${a.workspaceId} and ${b.workspaceId} too close`);
    }
  }

  // Seat spacing inside one room is the S4 96 units from the room origin, and columns are ordered.
  const seats = layout.rooms[0].seats.filter((seat) => !seat.isHead).map((seat) => seat.world.x - layout.rooms[0].world.x);
  assert.deepEqual([...new Set(seats)].sort((x, y) => x - y), [HQ_SEAT_SPACING, HQ_SEAT_SPACING * 2, HQ_SEAT_SPACING * 3, HQ_SEAT_SPACING * 4]);
});

test('revision tracks roster facts, not status refresh or input order', async () => {
  const base = await buildLayout({ departments: threeDepartments() });

  // A status-only refresh of permanent seats must not rotate the layout revision.
  const restatted = threeDepartments().map((dept) => ({
    ...dept,
    agents: dept.agents.map((entry) => (entry.staffing === 'permanent' ? { ...entry, status: 'degraded' as const, observedAt: '2026-10-04T00:00:00Z' } : entry)),
  }));
  const afterStatus = await buildLayout({ departments: restatted });
  assert.equal(afterStatus.revision, base.revision);
  assert.deepEqual(afterStatus.rooms, base.rooms);

  // A real roster change moves it.
  const renamed = threeDepartments();
  renamed[0].agents.push(agent({ id: 'a-new', workspaceId: ws1, role: 'gamma' }));
  const afterAdd = await buildLayout({ departments: renamed });
  assert.notEqual(afterAdd.revision, base.revision);

  // Changing the explicit head binding moves it too (S4 names explicit head bindings).
  const rebound = threeDepartments();
  rebound[0].headAgentId = 'a-a';
  const afterHead = await buildLayout({ departments: rebound });
  assert.notEqual(afterHead.revision, base.revision);

  // Staffing change on a seated agent moves it (S4 names staffing).
  const restaffed = threeDepartments();
  restaffed[0].agents[1] = { ...restaffed[0].agents[1], staffing: 'on-call', status: 'working' };
  const afterStaffing = await buildLayout({ departments: restaffed });
  assert.notEqual(afterStaffing.revision, base.revision);
});

test('buildLayout is pure: it does not mutate the roster it was handed', async () => {
  const departments = threeDepartments();
  const snapshot = JSON.parse(JSON.stringify(departments));
  await buildLayout({ departments });
  assert.deepEqual(JSON.parse(JSON.stringify(departments)), snapshot);
  // Same input twice, including the revision.
  const first = await buildLayout({ departments });
  const second = await buildLayout({ departments });
  assert.deepEqual(second, first);
});
