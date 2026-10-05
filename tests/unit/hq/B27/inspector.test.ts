/**
 * B27 — Inspector behavior checks (Q10 safe detail / tombstone / foreign cases
 * and same-task source links). Renders the real component to static markup, so
 * every assertion is made against actual output, not a shape description.
 *
 * Run: node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *        --import ./tests/setup/tmp-sandbox.ts \
 *        --test tests/unit/hq/B27/inspector.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import Inspector, {
  hqBoardTaskHref,
  type HqInspectorSelection,
} from '../../../../src/components/hq/Inspector';
import type { HqActivityEvent, HqAgent } from '../../../../src/lib/hq/types';

function render(selection: HqInspectorSelection | null, companyId: string | null = 'co-1') {
  return renderToStaticMarkup(
    createElement(Inspector, { selection, companyId, departmentId: 'dept-1' }),
  );
}

function activityEvent(over: Partial<HqActivityEvent> = {}): HqActivityEvent {
  return {
    id: 'ev-1',
    seq: 12,
    kind: 'task',
    phase: 'created',
    taskId: 'task-9',
    actorLabel: 'Roster Bot',
    recipientLabel: null,
    occurredAt: '2026-10-04T00:00:00Z',
    receivedAt: '2026-10-04T00:00:01Z',
    reference: 'task:task-9',
    payload: { status: 'in_progress', previousStatus: 'backlog' },
    ...over,
  };
}

test('tombstone: renders the deleted-source label and no retained detail', () => {
  const html = render({
    kind: 'activity',
    activityId: 'ev-1',
    detail: { state: 'tombstone' },
  });
  assert.match(html, /Source deleted/);
  assert.match(html, /Current state: tombstone/);
  assert.doesNotMatch(html, /Open task/);
  assert.doesNotMatch(html, /ev-1/);
});

test('foreign and unknown records render the SAME not-available state (no existence probe)', () => {
  const html = render({
    kind: 'activity',
    activityId: 'foreign-id',
    detail: { state: 'notAvailable' },
  });
  assert.match(html, /Not available/);
  assert.doesNotMatch(html, /foreign-id/);
  assert.doesNotMatch(html, /Open task/);
  // The panel must not name the record it refused, so two different refused IDs
  // produce byte-identical markup.
  const other = render({
    kind: 'activity',
    activityId: 'unknown-id',
    detail: { state: 'notAvailable' },
  });
  assert.equal(html, other);
});

test('error state names only the code, never raw exception text', () => {
  const html = render({
    kind: 'activity',
    activityId: 'ev-1',
    detail: { state: 'error', code: 'request_conflict' },
  });
  assert.match(html, /request_conflict/);
  assert.doesNotMatch(html, /Error:/);
});

test('hostile message text is escaped, never executed or linked', () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const html = render({
    kind: 'activity',
    activityId: 'ev-2',
    detail: {
      state: 'ready',
      event: activityEvent({
        kind: 'exchange',
        phase: 'replied',
        reference: 'exchange:abc:replied',
        payload: { message: hostile, summary: 'javascript:alert(3)' },
      }),
    },
  });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
  // The hostile text never becomes a navigable target.
  assert.doesNotMatch(html, /href="javascript:/);
  assert.ok(!html.includes('href="javascript'));
});

test('same-task source links point at the same canonical board target', () => {
  const created = render({
    kind: 'activity',
    activityId: 'ev-3',
    detail: { state: 'ready', event: activityEvent({ id: 'ev-3' }) },
  });
  const replied = render({
    kind: 'activity',
    activityId: 'ev-4',
    detail: {
      state: 'ready',
      event: activityEvent({
        id: 'ev-4',
        kind: 'exchange',
        phase: 'replied',
        payload: { message: 'done', summary: 'reply' },
      }),
    },
  });
  const href = hqBoardTaskHref({ taskId: 'task-9', companyId: 'co-1', workspaceId: 'dept-1' });
  assert.equal(href, '/tasks/by-department?company=co-1&department=dept-1&task=task-9');
  for (const html of [created, replied]) {
    assert.ok(html.includes(`href="${href!.replace(/&/g, '&amp;')}"`), 'board link present');
    assert.match(html, /task-9/);
  }
});

test('unbound record: no guessed task link, explicit missing binding instead', () => {
  const html = render({
    kind: 'activity',
    activityId: 'ev-5',
    detail: {
      state: 'ready',
      event: activityEvent({
        kind: 'exchange',
        phase: 'requested',
        taskId: null,
        payload: { message: 'hi', summary: 'request' },
      }),
    },
  });
  assert.match(html, /No task binding/);
  assert.doesNotMatch(html, /Open task/);
  assert.equal(hqBoardTaskHref({ taskId: null, companyId: 'co-1' }), null);
});

test('no selection renders the empty hint, never an empty-company claim', () => {
  const html = render(null);
  assert.match(html, /Select a department, agent, or activity/);
  assert.doesNotMatch(html, /Seats/);
});

test('decision detail: shadow and unavailable are distinct, not zero-confidence', () => {
  const decision = activityEvent({
    kind: 'decision',
    phase: 'shadow',
    taskId: null,
    payload: {
      intent: null,
      routeAction: 'route',
      departmentSlug: 'marketing',
      confidenceBps: null,
      fallback: null,
      mode: 'shadow',
      resolvedBy: null,
    },
  });
  const shadowHtml = render({
    kind: 'activity',
    activityId: 'ev-6',
    detail: { state: 'ready', event: decision },
  });
  assert.match(shadowHtml, /not applied/);
  assert.match(shadowHtml, /Not supplied/);
  assert.doesNotMatch(shadowHtml, /0 bps/);

  const unavailableHtml = render({
    kind: 'activity',
    activityId: 'ev-7',
    detail: {
      state: 'ready',
      event: {
        ...decision,
        phase: 'unavailable',
        payload: { ...decision.payload, mode: 'off' },
      } as HqActivityEvent,
    },
  });
  assert.match(unavailableHtml, /Route unavailable/);
  assert.doesNotMatch(unavailableHtml, /not applied/);
});

test('agent detail: missing runtime binding is labelled and Talk states setup incomplete', () => {
  const agent: HqAgent = {
    id: 'agent-1',
    workspaceId: 'dept-1',
    displayName: 'Nova',
    role: 'Specialist',
    isHead: false,
    staffing: 'on-call',
    runtimeBound: false,
    canTalk: false,
    runtimeAgentId: null,
    bindingKind: 'unbound',
    sharedRoleIds: [],
    status: 'unknown',
    observedAt: null,
    activeTaskIds: [],
  };
  const html = render({ kind: 'agent', agent, departmentName: 'Marketing' });
  assert.match(html, /Runtime binding unavailable/);
  assert.match(html, /Status not observed/);
  assert.match(html, /Setup incomplete/);
  assert.match(html, /On-call/);
  assert.match(html, /No task binding observed/);
});

test('agent detail: bound head links each assigned task to the board', () => {
  const agent: HqAgent = {
    id: 'agent-2',
    workspaceId: 'dept-1',
    displayName: 'Ada',
    role: 'Head of Marketing',
    isHead: true,
    staffing: 'permanent',
    runtimeBound: true,
    canTalk: true,
    runtimeAgentId: 'rt-2',
    bindingKind: 'explicit',
    sharedRoleIds: [],
    status: 'working',
    observedAt: '2026-10-04T01:00:00Z',
    activeTaskIds: ['task-11'],
  };
  const html = render({ kind: 'agent', agent, departmentName: 'Marketing' });
  assert.match(html, /Head/);
  assert.match(html, /rt-2/);
  const href = hqBoardTaskHref({ taskId: 'task-11', companyId: 'co-1', workspaceId: 'dept-1' });
  assert.ok(html.includes(`href="${href!.replace(/&/g, '&amp;')}"`));
  assert.doesNotMatch(html, /Setup incomplete/);
});

test('department detail: absent head binding is explicit, not silently blank', () => {
  const html = render({
    kind: 'department',
    department: {
      id: 'dept-1',
      slug: 'marketing',
      name: 'Marketing',
      headAgentId: null,
      provisioning: 'incomplete',
      agents: [
        {
          id: 'agent-3',
          workspaceId: 'dept-1',
          displayName: 'Rose',
          role: 'Specialist',
          isHead: false,
          staffing: 'permanent',
          runtimeBound: true,
          canTalk: true,
          runtimeAgentId: 'rt-3',
          bindingKind: 'department-shared',
          sharedRoleIds: ['role-a', 'role-b'],
          status: 'standby',
          observedAt: '2026-10-04T01:00:00Z',
          activeTaskIds: [],
        },
      ],
    },
  });
  assert.match(html, /No head binding/);
  assert.match(html, /Setup incomplete/);
  // S3: a shared department executor is labelled and counted as ONE runtime.
  assert.match(html, /Shared department executor/);
  assert.match(html, /Seats/);
});
