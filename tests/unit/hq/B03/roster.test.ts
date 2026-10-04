/**
 * B03 roster projection checks — the Q03 fixture set (SPEC S3 / qc Q03):
 * custom and archived departments, missing head, permanent/on-call/planned/
 * unknown/legacy rows, busy/degraded/null status, and the shared-executor
 * fixture (two role rows, one departmental runtime, one runtime presence).
 *
 * Pure module: no database, no filesystem, no clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HqRosterScopeError,
  buildRoster,
  hqObservedRuntimeCount,
  type HqRosterAgentRow,
  type HqRosterInput,
  type HqRosterWorkspaceRow,
} from '../../../../src/lib/hq/roster';

const CO = 'co-1';

function ws(over: Partial<HqRosterWorkspaceRow> & { id: string }): HqRosterWorkspaceRow {
  return {
    slug: over.id,
    name: over.id,
    companyId: CO,
    headAgentId: null,
    archivedAt: null,
    sortOrder: null,
    provisioningRaw: 'ready',
    ...over,
  };
}

function agent(over: Partial<HqRosterAgentRow> & { id: string; workspaceId: string }): HqRosterAgentRow {
  return {
    displayName: over.id,
    role: 'Specialist',
    isMaster: false,
    status: 'standby',
    observedAt: '2026-10-04T00:00:00Z',
    staffingRaw: 'permanent',
    openclawAgentId: null,
    resolvedRuntimeId: null,
    activeTaskIds: [],
    ...over,
  };
}

function base(over: Partial<HqRosterInput> = {}): HqRosterInput {
  return {
    companyId: CO,
    viewer: 'client',
    workspaces: [ws({ id: 'ws-one', slug: 'one', name: 'One' })],
    agents: [agent({ id: 'a1', workspaceId: 'ws-one' })],
    installedRuntimeIds: [],
    ...over,
  };
}

test('custom department is included; no 24/30 floor and no cap', () => {
  const workspaces = Array.from({ length: 31 }, (_, i) => ws({ id: `ws-${String(i).padStart(2, '0')}` }));
  const out = buildRoster(base({ workspaces, agents: [] }));
  assert.equal(out.departments.length, 31);
  assert.equal(out.departments[0].id, 'ws-00');
});

test('archived department is honored in archivedDepartments, never resurrected active', () => {
  const out = buildRoster(base({
    workspaces: [
      ws({ id: 'ws-live' }),
      ws({ id: 'ws-gone', archivedAt: '2026-09-01T00:00:00Z' }),
    ],
    agents: [agent({ id: 'a-live', workspaceId: 'ws-live' }), agent({ id: 'a-gone', workspaceId: 'ws-gone' })],
  }));
  assert.deepEqual(out.departments.map((d) => d.id), ['ws-live']);
  assert.deepEqual(out.archivedDepartments.map((d) => d.id), ['ws-gone']);
  // The archived department still projects its row truthfully rather than being dropped.
  assert.deepEqual(out.archivedDepartments[0].agents.map((a) => a.id), ['a-gone']);
});

test('missing head: declared head that resolves to no row reports null head plus a diagnostic, never a name guess', () => {
  const out = buildRoster(base({
    workspaces: [ws({ id: 'ws-one', headAgentId: 'a-missing' })],
    agents: [agent({ id: 'a1', workspaceId: 'ws-one', displayName: 'a-missing' })],
  }));
  assert.equal(out.departments[0].headAgentId, null);
  assert.equal(out.departments[0].agents[0].isHead, false);
  assert.deepEqual(out.diagnostics.filter((d) => d.code === 'missing_head'), [
    { code: 'missing_head', workspaceId: 'ws-one', declaredHeadAgentId: 'a-missing' },
  ]);
});

test('known statuses map to themselves; unrecognized collapses to unknown with the raw value in diagnostics only', () => {
  const out = buildRoster(base({
    agents: [
      agent({ id: 'a1', workspaceId: 'ws-one', status: 'busy', staffingRaw: 'permanent' }),
      agent({ id: 'a2', workspaceId: 'ws-one', status: 'degraded', staffingRaw: 'on-call' }),
      agent({ id: 'a3', workspaceId: 'ws-one', status: null }),
      agent({ id: 'a4', workspaceId: 'ws-one', status: 'vibing' }),
      agent({ id: 'a5', workspaceId: 'ws-one', status: 'working', staffingRaw: 'moonlighting' }),
    ],
  }));
  const byId = new Map(out.departments[0].agents.map((a) => [a.id, a]));
  assert.equal(byId.get('a1')!.status, 'busy');
  assert.equal(byId.get('a2')!.status, 'degraded');
  assert.equal(byId.get('a2')!.staffing, 'on-call');
  assert.equal(byId.get('a3')!.status, 'unknown');
  assert.equal(byId.get('a4')!.status, 'unknown');
  assert.equal(byId.get('a4')!.staffing, 'permanent');
  assert.equal(byId.get('a5')!.staffing, 'on-call'); // schema default, raw surfaced below
  assert.deepEqual(out.diagnostics.filter((d) => d.code === 'unrecognized_status'), [
    { code: 'unrecognized_status', agentId: 'a4', rawValue: 'vibing' },
  ]);
  assert.deepEqual(out.diagnostics.filter((d) => d.code === 'unrecognized_staffing'), [
    { code: 'unrecognized_staffing', agentId: 'a5', rawValue: 'moonlighting' },
  ]);
  assert.equal(out.diagnostics.filter((d) => d.code === 'status_not_observed').length, 1);
});

test('an open task is not live execution and a working flag is only what was reported', () => {
  const out = buildRoster(base({
    agents: [agent({ id: 'a1', workspaceId: 'ws-one', status: 'standby', activeTaskIds: ['t1', 't2'] })],
  }));
  assert.equal(out.departments[0].agents[0].status, 'standby');
  assert.deepEqual(out.departments[0].agents[0].activeTaskIds, ['t1', 't2']);
});

test('runtime binding: declared vs verified, unbound disables Talk, and an unverified explicit id never falls back', () => {
  const out = buildRoster(base({
    installedRuntimeIds: ['rt-verified'],
    agents: [
      agent({ id: 'a1', workspaceId: 'ws-one', openclawAgentId: 'rt-verified' }),
      agent({ id: 'a2', workspaceId: 'ws-one', openclawAgentId: 'rt-not-installed', resolvedRuntimeId: 'rt-verified' }),
      agent({ id: 'a3', workspaceId: 'ws-one', resolvedRuntimeId: 'rt-verified' }),
      agent({ id: 'a4', workspaceId: 'ws-one' }),
    ],
  }));
  const byId = new Map(out.departments[0].agents.map((a) => [a.id, a]));
  assert.deepEqual(
    { kind: byId.get('a1')!.bindingKind, bound: byId.get('a1')!.runtimeBound, talk: byId.get('a1')!.canTalk, rt: byId.get('a1')!.runtimeAgentId },
    { kind: 'explicit', bound: true, talk: true, rt: 'rt-verified' },
  );
  // Explicit binding stayed explicit (legible failure); it did NOT slide to the resolver fallback.
  assert.deepEqual(
    { kind: byId.get('a2')!.bindingKind, bound: byId.get('a2')!.runtimeBound, talk: byId.get('a2')!.canTalk, rt: byId.get('a2')!.runtimeAgentId },
    { kind: 'explicit', bound: false, talk: false, rt: 'rt-not-installed' },
  );
  assert.deepEqual(
    { kind: byId.get('a3')!.bindingKind, bound: byId.get('a3')!.runtimeBound, talk: byId.get('a3')!.canTalk, rt: byId.get('a3')!.runtimeAgentId },
    { kind: 'department-shared', bound: true, talk: true, rt: 'rt-verified' },
  );
  assert.deepEqual(
    { kind: byId.get('a4')!.bindingKind, bound: byId.get('a4')!.runtimeBound, talk: byId.get('a4')!.canTalk, rt: byId.get('a4')!.runtimeAgentId },
    { kind: 'unbound', bound: false, talk: false, rt: null },
  );
  assert.equal(out.diagnostics.filter((d) => d.code === 'runtime_binding_unavailable').length, 2);
});

test('shared department executor: two role rows, one runtime, one presence, linked role seats, no rows deleted', () => {
  const out = buildRoster(base({
    installedRuntimeIds: ['rt-dept'],
    agents: [
      agent({ id: 'a-head', workspaceId: 'ws-one', resolvedRuntimeId: 'rt-dept' }),
      agent({ id: 'a-role', workspaceId: 'ws-one', resolvedRuntimeId: 'rt-dept' }),
    ],
  }));
  const dept = out.departments[0];
  assert.equal(hqObservedRuntimeCount(dept), 1);
  const byId = new Map(dept.agents.map((a) => [a.id, a]));
  assert.deepEqual(byId.get('a-head')!.sharedRoleIds, ['a-role']);
  assert.deepEqual(byId.get('a-role')!.sharedRoleIds, ['a-head']);
  assert.equal(dept.agents.length, 2); // both role seats survive
  assert.equal(dept.agents.every((a) => a.bindingKind === 'department-shared'), true);
});

test('template-not-worker: a planned role is listed as planned and never becomes an agent or a running count', () => {
  const out = buildRoster(base({
    workspaces: [ws({ id: 'ws-one', provisioningRaw: 'ready' })],
    agents: [],
    plannedRoles: [{ workspaceId: 'ws-one', key: 'role:analyst', name: 'Analyst' }],
  }));
  const dept = out.departments[0];
  assert.deepEqual(dept.agents, []);
  assert.equal(dept.provisioning, 'incomplete'); // conflict shown, not repaired back to ready
  assert.deepEqual(out.plannedRoles, [{ workspaceId: 'ws-one', key: 'role:analyst', name: 'Analyst' }]);
  assert.equal(hqObservedRuntimeCount(dept), 0);
});

test('identical input yields an identical projection regardless of row order', () => {
  const workspaces = [
    ws({ id: 'ws-b', sortOrder: 20 }),
    ws({ id: 'ws-a', sortOrder: 10, archivedAt: '2026-08-01T00:00:00Z' }),
  ];
  const agents = [
    agent({ id: 'z9', workspaceId: 'ws-b', status: 'busy' }),
    agent({ id: 'a1', workspaceId: 'ws-b' }),
    agent({ id: 'm5', workspaceId: 'ws-a' }),
    agent({ id: 'legacy', workspaceId: 'ws-legacy' }),
  ];
  const first = buildRoster(base({ workspaces, agents, viewer: 'operator' }));
  const shuffled = buildRoster(base({
    workspaces: [...workspaces].reverse(),
    agents: [...agents].reverse(),
    viewer: 'operator',
  }));
  assert.deepEqual(shuffled, first);
  assert.deepEqual(first.departments.map((d) => d.id), ['ws-b']);
  assert.deepEqual(first.departments[0].agents.map((a) => a.id), ['a1', 'z9']);
});

test('legacy/unattributed rows sit in the operator-only section and never reach a client projection', () => {
  const input = base({
    workspaces: [ws({ id: 'ws-one' }), ws({ id: 'ws-default', companyId: 'default' }), ws({ id: 'ws-null', companyId: null })],
    agents: [
      agent({ id: 'a1', workspaceId: 'ws-one' }),
      agent({ id: 'legacy-1', workspaceId: 'ws-default' }),
      agent({ id: 'legacy-2', workspaceId: 'ws-null' }),
      agent({ id: 'orphan', workspaceId: 'ws-not-read' }),
    ],
  });
  const operator = buildRoster({ ...input, viewer: 'operator' });
  assert.deepEqual(operator.unassigned.map((a) => a.id), ['legacy-1', 'legacy-2', 'orphan']);
  assert.deepEqual(operator.departments.map((d) => d.id), ['ws-one']);
  const client = buildRoster({ ...input, viewer: 'client' });
  assert.deepEqual(client.unassigned, []);
});

test('a foreign-company row is refused loudly rather than merged or hidden', () => {
  assert.throws(
    () => buildRoster(base({ workspaces: [ws({ id: 'ws-one' }), ws({ id: 'ws-foreign', companyId: 'co-2' })] })),
    (err: unknown) => err instanceof HqRosterScopeError && err.code === 'foreign_workspace',
  );
});

test('the input is never mutated', () => {
  const input = base({
    workspaces: [ws({ id: 'ws-one', headAgentId: 'a1' })],
    agents: [agent({ id: 'a1', workspaceId: 'ws-one', activeTaskIds: ['t1'] })],
  });
  const snapshot = JSON.stringify(input);
  buildRoster(input);
  assert.equal(JSON.stringify(input), snapshot);
});
