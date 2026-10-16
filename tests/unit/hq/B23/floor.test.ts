/**
 * B23 focused checks — SPEC S4 floor composition (milestones V09/V11).
 *
 * Owned behavior only: what Floor COMPOSES and what it refuses to invent.
 * Renders the real `Floor.tsx`; the three sibling modules B24/B25 own are
 * supplied by the seam stubs in `./stubs` through `floor-stub-register.mjs`,
 * because they are not on disk in this worktree (see that hook's follow-up note).
 * No database, no live data, no network.
 *
 * Run:
 *   node --import tsx --import ./tests/unit/hq/B23/floor-stub-register.mjs \
 *        --test tests/unit/hq/B23/floor.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import * as ReactNamespace from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HqAgent, HqDepartment, HqLayout } from '@/lib/hq/types';
import Floor, { HQ_FLOOR_COMPACT_ZOOM, resolveFloorSelection } from '@/components/hq/Floor';
import {
  __hqViewportStubCalls,
  __resetHqViewportStub,
  __setHqViewportCamera,
} from './stubs/useHqViewport';

// tsx compiles JSX to the classic factory; the render checks need the namespace
// on globalThis. Nothing in src/ depends on this shim (Next/tsc use the automatic
// runtime per tsconfig "jsx": "react-jsx").
(globalThis as Record<string, unknown>).React = ReactNamespace;

/* ------------------------------------------------------------- fixtures */

function agent(overrides: Partial<HqAgent> = {}): HqAgent {
  return {
    id: 'a1',
    workspaceId: 'w1',
    displayName: 'Ada',
    role: 'Engineer',
    isHead: true,
    staffing: 'permanent',
    runtimeBound: true,
    canTalk: true,
    runtimeAgentId: 'rt-1',
    bindingKind: 'explicit',
    sharedRoleIds: [],
    status: 'standby',
    observedAt: '2026-10-04T00:00:00Z',
    activeTaskIds: [],
    ...overrides,
  };
}

function department(overrides: Partial<HqDepartment> = {}): HqDepartment {
  return {
    id: 'w1',
    slug: 'engineering',
    name: 'Engineering',
    headAgentId: 'a1',
    provisioning: 'ready',
    agents: [agent()],
    ...overrides,
  };
}

/** SPEC S4 numbers verbatim: width 480, four columns at 96 units, corridor 80. */
function layout(rooms: { workspaceId: string; x: number; seats?: string[] }[]): HqLayout {
  return {
    revision: 'rev-fixture',
    rooms: rooms.map((room) => ({
      workspaceId: room.workspaceId,
      world: { x: room.x ?? 0, y: 0 },
      width: 480,
      height: 320,
      seats: (room.seats ?? []).map((agentId, index) => ({
        agentId,
        isHead: index === 0,
        world: { x: 96 * (index + 1), y: 144 },
        screenX: 96 * (index + 1),
        screenY: 96,
      })),
    })),
  };
}

function render(props: Partial<Parameters<typeof Floor>[0]> = {}): string {
  return renderToStaticMarkup(
    h(Floor, {
      layout: layout([{ workspaceId: 'w1', x: 0, seats: ['a1'] }]),
      departments: [department()],
      selection: null,
      ...props,
    }),
  );
}

/** Room divs only: `data-room-workspace` is set by the neighbor contract, nothing else. */
function roomIds(html: string): string[] {
  return [...html.matchAll(/data-room-workspace="([^"]+)"/g)].map((match) => match[1]);
}

function chipIds(html: string): string[] {
  return [...html.matchAll(/data-floor-chip="([^"]+)"/g)].map((match) => match[1]);
}

/** One full start tag, so attribute checks cannot be fooled by class names. */
function tag(html: string, testId: string): string {
  const match = html.match(new RegExp(`<[a-z]+[^>]*data-testid="${testId}"[^>]*>`));
  return match ? match[0] : '';
}

/* --------------------------------------------------- sparse and full sizing */

test('B23: one department renders exactly one room, at the geometry it was given', () => {
  const html = render();
  assert.deepEqual(roomIds(html), ['w1'], 'sparse roster: one department, one room');
  assert.match(html, /data-testid="stub-room-w1"[^>]*data-room-workspace="w1"/);
  assert.match(html, /data-testid="stub-room-w1"[^>]*data-room-seats="1"/);
  assert.match(html, /data-testid="stub-room-w1"[^>]*data-room-height="320"/);
  assert.match(html, /data-testid="stub-room-w1"[^>]*data-room-name="Engineering"/);
  assert.match(html, /data-testid="stub-room-w1"[^>]*data-room-head="a1"/);
});

test('B23: a full fixture renders every room with its own seat count, in layout order', () => {
  const departments = [
    department({ id: 'w1', slug: 'eng', name: 'Engineering', headAgentId: 'a1' }),
    department({
      id: 'w2',
      slug: 'sales',
      name: 'Sales',
      headAgentId: 'b1',
      agents: [agent({ id: 'b1', workspaceId: 'w2', displayName: 'Bo' }), agent({ id: 'b2', workspaceId: 'w2', displayName: 'Cy' })],
    }),
    department({
      id: 'w3',
      slug: 'support',
      name: 'Support',
      headAgentId: null,
      provisioning: 'incomplete',
      agents: [agent({ id: 'c1', workspaceId: 'w3', displayName: 'Dee' })],
    }),
  ];
  const html = render({
    layout: layout([
      { workspaceId: 'w1', x: 0, seats: ['a1'] },
      { workspaceId: 'w2', x: 560, seats: ['b1', 'b2'] },
      { workspaceId: 'w3', x: 1120, seats: ['c1'] },
    ]),
    departments,
  });
  const rooms = [...html.matchAll(/data-testid="stub-room-(w\d)"[^>]*data-room-seats="(\d)"/g)].map(
    (match) => `${match[1]}:${match[2]}`,
  );
  assert.deepEqual(rooms, ['w1:1', 'w2:2', 'w3:1'], 'every room drawn, seat counts from the layout');
  assert.match(html, /data-testid="stub-room-w3"[^>]*data-room-head="none"/, 'missing head stays missing');
});

/* --------------------------------------------------- no hardcoded employees */

test('B23: a different roster at the same layout renders that roster, nothing else', () => {
  const html = render({
    departments: [
      department({
        id: 'w1',
        slug: 'legal',
        name: 'Legal',
        headAgentId: 'z9',
        agents: [agent({ id: 'z9', displayName: 'Zoe', role: 'Counsel' })],
      }),
    ],
  });
  assert.match(html, /data-room-name="Legal"/);
  assert.match(html, /data-testid="stub-room-agent-z9"/);
  assert.doesNotMatch(html, /Ada|Engineering|a1/, 'no fixture or built-in employee leaks through');
});

test('B23: a layout room with no department record is not drawn, and the count says so', () => {
  const html = render({
    layout: layout([
      { workspaceId: 'w1', x: 0, seats: ['a1'] },
      { workspaceId: 'w-ghost', x: 560 },
    ]),
  });
  assert.equal(roomIds(html).length, 1, 'no invented occupant for a room nobody is in');
  assert.match(html, /1 layout room\(s\) without a department record/);
});

/* ----------------------------------------------------------- selection */

test('B23: selection by ID survives and is handed to exactly one room', () => {
  const html = render({
    layout: layout([
      { workspaceId: 'w1', x: 0, seats: ['a1'] },
      { workspaceId: 'w2', x: 560, seats: ['b1'] },
    ]),
    departments: [
      department({ id: 'w1' }),
      department({ id: 'w2', slug: 'sales', name: 'Sales', headAgentId: 'b1', agents: [agent({ id: 'b1', workspaceId: 'w2' })] }),
    ],
    selection: { kind: 'department', workspaceId: 'w2' },
  });
  assert.match(html, /data-testid="stub-room-w2"[^>]*data-room-selected="true"/);
  assert.match(html, /data-testid="stub-room-w1"[^>]*data-room-selected="false"/);
  assert.doesNotMatch(html, /hq-floor-notice/, 'a selectable ID produces no notice');
});

test('B23: a removed department shows the notice and returns to no room', () => {
  const html = render({ selection: { kind: 'department', workspaceId: 'gone' } });
  assert.match(html, /data-testid="hq-floor-notice"/);
  assert.match(html, /no longer in the roster/);
});

test('B23: a removed agent falls back to its surviving department, and only once', () => {
  const resolved = resolveFloorSelection(
    { kind: 'agent', agentId: 'ghost', workspaceId: 'w1' },
    [department()],
  );
  assert.equal(resolved.departmentId, 'w1');
  assert.equal(resolved.agentId, null);
  assert.equal(resolved.fallbackDepartmentId, 'w1');
  assert.match(String(resolved.notice), /no longer in the roster/);

  const orphaned = resolveFloorSelection(
    { kind: 'agent', agentId: 'ghost', workspaceId: 'gone' },
    [department()],
  );
  assert.equal(orphaned.departmentId, null);
  assert.equal(orphaned.fallbackDepartmentId, null, 'no department to return to: notice only');
});

test('B23: an agent selection marks the room its agent is actually in', () => {
  const html = render({
    layout: layout([
      { workspaceId: 'w1', x: 0, seats: ['a1'] },
      { workspaceId: 'w2', x: 560, seats: ['b1'] },
    ]),
    departments: [
      department({ id: 'w1' }),
      department({ id: 'w2', slug: 'sales', name: 'Sales', headAgentId: 'b1', agents: [agent({ id: 'b1', workspaceId: 'w2' })] }),
    ],
    selection: { kind: 'agent', agentId: 'b1', workspaceId: 'w2' },
  });
  assert.match(html, /data-testid="stub-room-w2"[^>]*data-room-selected="true"/);
  assert.match(html, /data-testid="stub-room-w1"[^>]*data-room-selected="false"/);
});

/* ------------------------------------------------- small-scale room chips */

test('B23: above the compact threshold all rooms draw seats; below it labels replace them', () => {
  __resetHqViewportStub();
  __setHqViewportCamera({ x: 0, y: 0, zoom: HQ_FLOOR_COMPACT_ZOOM });
  const full = render();
  assert.match(full, /data-testid="hq-floor"[^>]*data-compact="false"/);
  assert.equal(chipIds(full).length, 0);

  __setHqViewportCamera({ x: 0, y: 0, zoom: HQ_FLOOR_COMPACT_ZOOM / 2 });
  const compact = render();
  assert.match(compact, /data-testid="hq-floor"[^>]*data-compact="true"/);
  assert.equal(roomIds(compact).length, 0, 'names, not overlapping figures');
  assert.deepEqual(chipIds(compact), ['w1'], 'room label/count remains reachable');
  assert.match(compact, /Engineering/);
  assert.match(compact, /1 seated/);
});

/* ------------------------------------------------- camera controls and motion */

test('B23: Fit and Focus drive the camera layer; Focus needs a selection', () => {
  __resetHqViewportStub();
  __setHqViewportCamera({ x: 0, y: 0, zoom: 1 });
  const html = render({ selection: { kind: 'department', workspaceId: 'w1' } });
  // The controls are plain buttons over the B25 camera seam, not decoration.
  assert.match(html, /data-testid="hq-fit-company"/);
  const focusTag = tag(html, 'hq-focus-department');
  assert.ok(focusTag.length > 0, 'Focus control exists');
  // The boolean attribute only (`disabled=""` or bare): `disabled:` Tailwind
  // utilities live in `class=` and never count. React omits the attribute when false.
  assert.doesNotMatch(focusTag, /\sdisabled[=\s>]/, 'a selected department can be focused');
  const noSelection = render();
  assert.match(tag(noSelection, 'hq-focus-department'), /\sdisabled[=\s>]/, 'no selection, no focus target');
});

test('B23: no evidence means no walk; supplied evidence reaches the overlay untouched', () => {
  const quiet = render();
  assert.match(quiet, /data-testid="stub-handoff-layer"[^>]*data-evidence-count="0"/);
  assert.doesNotMatch(quiet, /data-evidence-ids="[^"]+"/, 'an idle floor draws no overlay');

  const moving = render({
    handoffs: [
      {
        activityId: 'act-1',
        actorAgentId: 'a1',
        actorLabel: 'Ada',
        fromWorkspaceId: 'w1',
        toWorkspaceId: 'w2',
        label: 'Sent request',
      },
    ],
  });
  assert.match(moving, /data-evidence-ids="act-1"/);
  assert.match(moving, /data-evidence-count="1"/);
});

test('B23: reduced motion or a pause reaches the overlay as reduced motion', () => {
  const paused = render({ animationPaused: true });
  assert.match(paused, /data-testid="stub-handoff-layer"[^>]*data-reduced-motion="true"/);
  const reduced = render({ reducedMotion: true });
  assert.match(reduced, /data-testid="stub-handoff-layer"[^>]*data-reduced-motion="true"/);
  const normal = render();
  assert.match(normal, /data-testid="stub-handoff-layer"[^>]*data-reduced-motion="false"/);
});

/* ------------------------------------------------------------ immutability */

test('B23: rendering never mutates the roster, layout or evidence it was given', () => {
  const departments = [department(), department({ id: 'w2', slug: 'sales', name: 'Sales', agents: [] })];
  const geometry = layout([
    { workspaceId: 'w1', x: 0, seats: ['a1'] },
    { workspaceId: 'w2', x: 560 },
  ]);
  const handoffs = [
    {
      activityId: 'act-1',
      actorAgentId: 'a1',
      actorLabel: 'Ada',
      fromWorkspaceId: 'w1',
      toWorkspaceId: 'w2',
      label: 'Reply received',
    },
  ];
  const rosterSnapshot = JSON.stringify(departments);
  const layoutSnapshot = JSON.stringify(geometry);
  const evidenceSnapshot = JSON.stringify(handoffs);
  render({ departments, layout: geometry, handoffs });
  assert.equal(JSON.stringify(departments), rosterSnapshot);
  assert.equal(JSON.stringify(geometry), layoutSnapshot);
  assert.equal(JSON.stringify(handoffs), evidenceSnapshot);
  assert.equal(__hqViewportStubCalls().pan.length, 0, 'drawing is not a pan');
});
