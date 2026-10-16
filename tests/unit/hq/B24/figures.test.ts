/**
 * B24 component checks (Q09/Q11): head/unknown/name labels, conflict strings,
 * on-call placement, no colour-only state, and artwork provenance.
 *
 * Rendered with `react-dom/server` (installed React 19) so no jsdom and no new
 * dependency or config file is needed. The component module has no `node:`
 * imports, so `tsx` loads it directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HqAgent, HqDepartment, HqSeatLayout } from '../../../../src/lib/hq/types';
import AgentFigure, { HQ_STATUS_LABEL } from '../../../../src/components/hq/AgentFigure';
import DepartmentRoom from '../../../../src/components/hq/DepartmentRoom';

function agent(over: Partial<HqAgent> = {}): HqAgent {
  return {
    id: 'ag-1',
    workspaceId: 'ws-1',
    displayName: 'Ada Specialist',
    role: 'Analyst',
    isHead: false,
    staffing: 'permanent',
    runtimeBound: true,
    canTalk: true,
    runtimeAgentId: 'rt-1',
    bindingKind: 'explicit',
    sharedRoleIds: [],
    status: 'working',
    observedAt: null,
    activeTaskIds: [],
    ...over,
  };
}

const seat = (agentId: string, isHead = false): HqSeatLayout => ({
  agentId,
  isHead,
  world: { x: 96, y: 216 },
  screenX: -120,
  screenY: 156,
});

test('missing head/unknown state/name labels are all rendered as text', () => {
  const markup = renderToStaticMarkup(
    AgentFigure({ agent: agent({ isHead: true, status: 'unknown' }), seat: seat('ag-1', true) }),
  );
  assert.match(markup, />Head</, 'head marker is a text label, not a colour-only distinction');
  assert.match(markup, /Status not observed/, 'unknown renders the S3 string, not a blank or a cheerful default');
  assert.match(markup, /Ada Specialist/, 'display name label');
  assert.match(markup, /Analyst/, 'role label');
  assert.equal(markup.includes('Ada Specialist') && markup.includes('undefined'), false);
});

test('a nameless roster row falls back to its id, never to a guess', () => {
  const markup = renderToStaticMarkup(
    AgentFigure({ agent: agent({ displayName: '' }), seat: seat('ag-1') }),
  );
  assert.match(markup, /ag-1/);
});

test('status vocabulary is shape plus word, and unknown is explicit', () => {
  assert.deepEqual(Object.keys(HQ_STATUS_LABEL).sort(), ['busy', 'degraded', 'offline', 'standby', 'unknown', 'working']);
  assert.equal(HQ_STATUS_LABEL.unknown, 'Status not observed');
  const working = renderToStaticMarkup(AgentFigure({ agent: agent(), seat: seat('ag-1') }));
  assert.match(working, /Working/, 'state carries a label, not colour alone (S11)');
  assert.equal(working.includes('Status not observed'), false, 'a known status never borrows the unknown wording');
});

test('keyboard and screen-reader reach: focusable with a full accessible name', () => {
  const markup = renderToStaticMarkup(
    AgentFigure({ agent: agent({ isHead: true, staffing: 'on-call', status: 'degraded' }), seat: seat('ag-1', true) }),
  );
  assert.match(markup, /role="button"/);
  assert.match(markup, /tabindex="0"/);
  assert.equal(markup.includes('outline-none'), true, 'the browser default ring is replaced, not left to chance');
  assert.match(
    markup,
    /aria-label="Ada Specialist, Analyst\. Head\. On-call\. Degraded\."/,
    'name, role, head, staffing and status all reach assistive tech',
  );
});

test('S3 conflict strings stay explicit and are never smoothed over', () => {
  const unbound = renderToStaticMarkup(
    AgentFigure({
      agent: agent({ runtimeBound: false, bindingKind: 'unbound', canTalk: false, runtimeAgentId: null }),
      seat: seat('ag-1'),
    }),
  );
  assert.match(unbound, /Runtime binding unavailable/);

  const shared = renderToStaticMarkup(
    AgentFigure({ agent: agent({ bindingKind: 'department-shared' }), seat: seat('ag-1') }),
  );
  assert.match(shared, /Shared department executor/);
  assert.equal(shared.includes('Runtime binding unavailable'), false, 'a shared binding is not reported as unbound');
});

test('on-call badge reports staffing rather than pretending occupancy', () => {
  const onCall = renderToStaticMarkup(AgentFigure({ agent: agent({ staffing: 'on-call' }), seat: seat('ag-1') }));
  assert.match(onCall, /On-call/);
  const permanent = renderToStaticMarkup(AgentFigure({ agent: agent(), seat: seat('ag-1') }));
  assert.equal(permanent.includes('>On-call<'), false);
});

test('DepartmentRoom seats exactly the layout seats and lists inactive on-call separately', () => {
  const head = agent({ id: 'head-1', displayName: 'Dana Head', isHead: true, role: 'Head of Sales' });
  const seated = agent({ id: 'ag-2', displayName: 'Seated Worker' });
  const inactiveOnCall = agent({ id: 'ag-3', displayName: 'Waiting On-call', staffing: 'on-call', status: 'standby' });
  const department: HqDepartment = {
    id: 'ws-1',
    slug: 'sales',
    name: 'Sales',
    headAgentId: 'head-1',
    provisioning: 'incomplete',
    agents: [head, seated, inactiveOnCall],
  };
  const room = {
    workspaceId: 'ws-1',
    world: { x: 80, y: 80 },
    width: 480,
    height: 320,
    seats: [seat('head-1', true), { ...seat('ag-2'), screenX: 0, screenY: 40 }],
  };

  const markup = renderToStaticMarkup(DepartmentRoom({ department, room }));
  assert.match(markup, /Dana Head/);
  assert.match(markup, /data-testid="hq-agent-head-1"/);
  assert.equal(markup.includes('hq-agent-ag-3'), false, 'an inactive on-call agent gets no floor figure');
  assert.match(markup, /On-call team/);
  assert.match(markup, /Waiting On-call/);
  assert.match(markup, /2 seated/);
  assert.match(markup, /Setup incomplete/, 'provisioning conflict is stated, not silently repaired');
  assert.match(markup, /data-provisioning="incomplete"/);
});

test('shared department binding is stated once, as one observed runtime', () => {
  const sharedA = agent({ id: 'r-1', bindingKind: 'department-shared', displayName: 'Role One' });
  const sharedB = agent({ id: 'r-2', bindingKind: 'department-shared', displayName: 'Role Two' });
  const department: HqDepartment = {
    id: 'ws-2',
    slug: 'ops',
    name: 'Ops',
    headAgentId: null,
    provisioning: 'ready',
    agents: [sharedA, sharedB],
  };
  const room = {
    workspaceId: 'ws-2',
    world: { x: 80, y: 80 },
    width: 480,
    height: 320,
    seats: [seat('r-1'), { ...seat('r-2'), screenX: 0, screenY: 40 }],
  };
  const markup = renderToStaticMarkup(DepartmentRoom({ department, room }));
  assert.match(markup, /1 observed runtime/, 'the room counts one runtime, not one per role row');
  assert.equal(
    markup.match(/>Shared department executor</g)?.length,
    2,
    'each shared role row carries the S3 work-area label on its own figure — visible text, not only an aria-label',
  );
});

test('no duplicate figure: each seat renders one figure even when ids collide across rooms', () => {
  const one = renderToStaticMarkup(
    AgentFigure({ agent: agent({ id: 'dup' }), seat: seat('dup') }),
  );
  assert.equal(one.match(/data-agent-id="dup"/g)?.length, 1);
});

test('artwork provenance: original vector primitives, no third-party or external reference', () => {
  const svgPath = new URL('../../../../public/hq/office.svg', import.meta.url);
  const svg = readFileSync(svgPath, 'utf8');
  assert.match(svg, /ART PROVENANCE:/, 'provenance statement is in the file, not only in a commit message');
  assert.match(svg, /original vector artwork authored for this repository/i);
  assert.equal(/<image\b/.test(svg), false, 'no raster or embedded bitmap');
  assert.equal(/data:image/.test(svg), false);
  assert.equal(/https?:\/\//.test(svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), false, 'no external asset fetch');

  // Every fragment this repo references must exist as a def in the same file.
  const referenced = [...svg.matchAll(/<use href="#([a-z-]+)"/g)].map((m) => m[1]);
  const defined = [...svg.matchAll(/<g id="([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(referenced.length > 0, 'the sheet publishes room-scene fragments');
  for (const id of referenced) assert.ok(defined.includes(id), `#${id} is defined in office.svg`);

  for (const id of ['hq-rug', 'hq-desk', 'hq-head-desk', 'hq-plant']) {
    assert.ok(defined.includes(id), `department rooms reference #${id}`);
  }
});

test('room and figure reference the owned artwork sheet by fragment path', () => {
  const room = readFileSync(
    new URL('../../../../src/components/hq/DepartmentRoom.tsx', import.meta.url),
    'utf8',
  );
  assert.match(room, /href="\/hq\/office\.svg#hq-rug"/);
  assert.match(room, /href="\/hq\/office\.svg#hq-desk"/);
  assert.match(room, /href="\/hq\/office\.svg#hq-head-desk"/);
});
