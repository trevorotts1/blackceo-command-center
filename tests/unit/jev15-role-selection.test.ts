/**
 * JEV-015 role selection — two-stage pick (spec section 7).
 *
 * Offline tests over fixtures: 7.3 exclusions, capability-vs-load matrix,
 * queue-when-busy, owner-direct exception, lexical fallback when pool vectors
 * are missing (7.4). Plus the pickBestAgent seam: task-blind callers still
 * land on the specialist, and task context changes the pick.
 *
 * No network, no embedding keys. Pure module under test (role-selection.ts)
 * plus comDispatch as the seam caller.
 */
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  excludeWorker,
  hasTaskContent,
  selectRoleWorker,
  suitabilityScore,
  workerProfileFromAgent,
  type RoleSelectionTask,
  type SelectableWorker,
} from '../../src/lib/routing/role-selection';
import { comDispatch, type AgentWithLoad } from '../../src/lib/routing/department-router';
import type { DepartmentConfig } from '../../src/lib/routing/departments.config';

function worker(over: Partial<SelectableWorker> & { id: string }): SelectableWorker {
  return {
    name: over.id,
    role: 'Specialist',
    description: null,
    responsibilities: null,
    ownedOutcomes: null,
    supportedDeliverables: null,
    capabilities: null,
    exclusions: null,
    sources: null,
    companyId: null,
    status: 'active',
    isMaster: false,
    workspaceId: 'dept-1',
    roleType: null,
    embeddingsDeferred: false,
    authorized: true,
    activeTasks: 0,
    maxConcurrentExecutions: 1,
    ...over,
  };
}

function agent(over: Partial<AgentWithLoad> & { id: string; name: string; role: string }): AgentWithLoad {
  return {
    status: 'active',
    workspace_id: 'dept-video',
    is_master: false,
    active_tasks: 0,
    description: '',
    avatar_emoji: '',
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...over,
  } as AgentWithLoad;
}

function dept(over: Partial<DepartmentConfig> = {}): DepartmentConfig {
  return {
    id: 'dept-video',
    name: 'Video Production',
    purpose: 'Video editing and production.',
    keywords: ['video', 'edit', 'promo'],
    agentRoles: ['Video Editor'],
    priority: 6,
    ...over,
  };
}

const VIDEO_TASK: RoleSelectionTask = {
  title: 'Edit 60-second promo video',
  description: 'Cut the launch promo, color grade, add captions',
};

// --- 7.3 exclusions -------------------------------------------------------

test('7.3 exclusions: offline, foreign-company, unauthorized, QC-only removed from production candidates', () => {
  const pool = [
    worker({ id: 'w-good', role: 'Video Editor', companyId: 'c1' }),
    worker({ id: 'w-offline', role: 'Video Editor', companyId: 'c1', status: 'offline' }),
    worker({ id: 'w-foreign', role: 'Video Editor', companyId: 'c2' }),
    worker({ id: 'w-unauth', role: 'Video Editor', companyId: 'c1', authorized: false }),
    worker({ id: 'w-qc', role: 'Video Editor', companyId: 'c1', roleType: 'qc' }),
    worker({ id: 'w-retired', role: 'Video Editor', companyId: 'c1', availability: 'retired' }),
  ];
  const r = selectRoleWorker(pool, VIDEO_TASK, { companyId: 'c1' });
  assert.equal(r.status, 'assigned');
  assert.equal(r.worker!.id, 'w-good');
  const excludedIds = r.excluded.map((e) => e.id).sort();
  assert.deepEqual(excludedIds, ['w-foreign', 'w-offline', 'w-qc', 'w-retired', 'w-unauth']);
});

// --- capability beats idleness --------------------------------------------

test('capability-vs-load: busy qualified beats idle unqualified', () => {
  const pool = [
    worker({
      id: 'w-idle-unqualified', role: 'Accountant', description: 'Bookkeeping and invoices',
      responsibilities: 'monthly bookkeeping', activeTasks: 0,
    }),
    worker({
      id: 'w-busy-qualified', role: 'Video Editor', description: 'Edits promo video cuts',
      responsibilities: 'promo video editing and captions', activeTasks: 0,
      maxConcurrentExecutions: 4,
    }),
  ];
  // Fill the qualified worker to busy-but-available (3/4), idle stays idle.
  pool[1].activeTasks = 3;
  const r = selectRoleWorker(pool, VIDEO_TASK);
  assert.equal(r.status, 'assigned');
  assert.equal(r.worker!.id, 'w-busy-qualified', `idle unqualified must not win on idleness: ${r.reason}`);
});

// --- queue when busy -------------------------------------------------------

test('queue-when-busy: all qualified busy yields queued assignment, reason capacity, never ineligible', () => {
  const pool = [
    worker({ id: 'w-a', role: 'Video Editor', responsibilities: 'promo video editing', activeTasks: 2, maxConcurrentExecutions: 1 }),
    worker({ id: 'w-b', role: 'Video Editor', responsibilities: 'promo video editing', activeTasks: 5, maxConcurrentExecutions: 1 }),
  ];
  const r = selectRoleWorker(pool, VIDEO_TASK);
  assert.equal(r.status, 'queued');
  assert.equal(r.code, 'capacity-queued');
  assert.equal(r.worker!.id, 'w-a', 'queued on least-loaded suitable worker');
  assert.match(r.reason, /capacity/);
  assert.doesNotMatch(r.reason, /ineligible/i);
});

// --- owner-direct exception -------------------------------------------------

test('owner-direct exception: named worker resolves as its own path past exclusions', () => {
  const pool = [
    worker({ id: 'w-star', name: 'Maya Star', role: 'Video Editor', responsibilities: 'promo video editing', roleType: 'qc' }),
    worker({ id: 'w-plain', role: 'Video Editor', responsibilities: 'promo video editing' }),
  ];
  const r = selectRoleWorker(pool, VIDEO_TASK, { ownerDirectTarget: 'maya star' });
  assert.equal(r.status, 'assigned');
  assert.equal(r.code, 'owner-direct');
  assert.equal(r.worker!.id, 'w-star');
  const r2 = selectRoleWorker(pool, VIDEO_TASK, { ownerDirectTarget: 'w-star' });
  assert.equal(r2.worker!.id, 'w-star');
});

// --- lexical fallback, vectors missing (7.4) --------------------------------

test('lexical fallback: deferred-embedding role stays in pool and wins on real role text', () => {
  const pool = [
    worker({ id: 'w-deferred', role: 'Podcast Editor', responsibilities: 'podcast audio editing and mastering', embeddingsDeferred: true }),
    worker({ id: 'w-other', role: 'Designer', responsibilities: 'logo design' }),
  ];
  const task: RoleSelectionTask = { title: 'Master the podcast episode audio', description: 'noise removal and leveling' };
  const r = selectRoleWorker(pool, task);
  assert.equal(r.status, 'assigned');
  assert.equal(r.worker!.id, 'w-deferred');
});

// --- deterministic tie-break --------------------------------------------------

test('ties broken stable by worker id', () => {
  const pool = [
    worker({ id: 'w-zzz', role: 'Video Editor', responsibilities: 'promo video editing' }),
    worker({ id: 'w-aaa', role: 'Video Editor', responsibilities: 'promo video editing' }),
  ];
  const r1 = selectRoleWorker(pool, VIDEO_TASK);
  const r2 = selectRoleWorker([...pool].reverse(), VIDEO_TASK);
  assert.equal(r1.worker!.id, 'w-aaa');
  assert.equal(r2.worker!.id, 'w-aaa', 'input order must not decide ties');
});

// --- A19: similarly labeled workers, different methods, equal load ------------
//
// The gap the D15 suite left: every earlier test paired workers with DIFFERENT
// labels, so a same-label pair whose methods differ was never exercised and the
// id collation in the old Stage 2 went unnoticed. Both workers here carry the
// same role label, the same load (0/1) and the same capacity (1) — only their
// METHODS differ — so the pick must follow method fit, never the id.

/** Same label, different method text; load/capacity equal. */
function sameLabelPair(firstId: string, secondId: string, secondMethod: 'video' | 'copy') {
  const copy = () => worker({
    id: 'unused', role: 'Content Producer',
    description: 'long-form copywriting and article drafting',
    responsibilities: 'draft articles, edit newsletter copy',
    capabilities: ['copywriting'],
  });
  const video = () => worker({
    id: 'unused', role: 'Content Producer',
    description: 'video editing and promo cut assembly',
    responsibilities: 'cut promo video, color grade footage',
    capabilities: ['video editing'],
  });
  const a = { ...copy(), id: firstId };
  const b = { ...(secondMethod === 'video' ? video() : copy()), id: secondId };
  return [a, b];
}

test('A19: same-label workers with different methods — task fit decides, not id order', () => {
  // Video task; the video-method worker carries the LATER id in arm 1 and the
  // EARLIER id in arm 2. Under id collation the pick follows the id and flips.
  const arm1 = sameLabelPair('w-aaa', 'w-zzz', 'video');
  const arm2 = sameLabelPair('w-zzz', 'w-aaa', 'video');

  const r1 = selectRoleWorker(arm1, VIDEO_TASK);
  const r2 = selectRoleWorker(arm2, VIDEO_TASK);

  assert.equal(r1.worker!.id, 'w-zzz', `video method must win regardless of id: ${r1.reason}`);
  assert.equal(r2.worker!.id, 'w-aaa', `video method must win regardless of id: ${r2.reason}`);
  assert.notEqual(r1.worker!.id, r2.worker!.id, 'the pick must follow the method, not the id');
  // The two arms swap ids only; the winner is the video-method worker both times.
  assert.equal(r1.worker!.description, 'video editing and promo cut assembly');
  assert.equal(r2.worker!.description, 'video editing and promo cut assembly');
});

test('A19: same-label sibling — method fit decided at equal load, not reversed by input order', () => {
  const pool = sameLabelPair('w-copy', 'w-video', 'video');
  const forward = selectRoleWorker(pool, VIDEO_TASK);
  const reversed = selectRoleWorker([...pool].reverse(), VIDEO_TASK);
  assert.equal(forward.worker!.id, 'w-video', forward.reason);
  assert.equal(reversed.worker!.id, 'w-video', `input order must not decide: ${reversed.reason}`);
});

test('A19 control: idle unqualified same-label worker still loses to the qualified one', () => {
  // Guards the fix against "always take the higher score": the loser here is
  // eligible but genuinely unqualified, and the winner is loaded yet qualified.
  const pool = [
    worker({
      id: 'w-idle-unqualified', role: 'Content Producer',
      description: 'bookkeeping and invoices', responsibilities: 'monthly bookkeeping',
      activeTasks: 0, maxConcurrentExecutions: 1,
    }),
    worker({
      id: 'w-busy-qualified', role: 'Content Producer',
      description: 'video editing and promo cut assembly',
      responsibilities: 'cut promo video, color grade footage',
      capabilities: ['video editing'], activeTasks: 2, maxConcurrentExecutions: 4,
    }),
  ];
  const r = selectRoleWorker(pool, VIDEO_TASK);
  assert.equal(r.worker!.id, 'w-busy-qualified', `7.3: ${r.reason}`);
});

// --- worker profile mapping (7.2 fields, existing-row source) ------------------

test('workerProfileFromAgent maps existing agent row columns to 7.2 profile', () => {
  const a = agent({
    id: 'a1', name: 'Maya', role: 'Video Editor', description: 'Cuts promos',
    workspace_id: 'dept-video',
  });
  (a as Record<string, unknown>).role_type = 'qc';
  (a as Record<string, unknown>).max_concurrent_executions = 3;
  (a as AgentWithLoad).active_tasks = 2;
  const w = workerProfileFromAgent(a, {
    companyId: 'c1',
    extra: {
      responsibilities: 'promo video editing',
      ownedOutcomes: ['finished promo'],
      supportedDeliverables: ['video'],
      capabilities: ['color grade'],
      exclusions: ['legal review'],
      sources: ['roles/video-editor/how-to.md#abc123'],
    },
  });
  assert.equal(w.id, 'a1');
  assert.equal(w.roleType, 'qc');
  assert.equal(w.maxConcurrentExecutions, 3);
  assert.equal(w.activeTasks, 2);
  assert.equal(w.companyId, 'c1');
  assert.deepEqual(w.ownedOutcomes, ['finished promo']);
  assert.deepEqual(w.sources, ['roles/video-editor/how-to.md#abc123']);
  assert.equal(excludeWorker(w, { companyId: 'c1' }), 'QC-only worker');
  assert.ok(suitabilityScore(w, VIDEO_TASK) > 0, 'qualified profile must score positive on matching task');
});

// --- seam: pickBestAgent via comDispatch ---------------------------------------

test('seam: task-blind keyword path still lands on the specialist (legacy floor preserved)', async () => {
  const d = dept();
  const specialist = agent({ id: 'a-video', name: 'Vera', role: 'Video Editor', workspace_id: d.id });
  const stranger = agent({ id: 'a-stranger', name: 'Sam', role: 'Sales Rep', workspace_id: d.id });
  const r = await comDispatch(
    { title: 'Edit 60-second promo video', description: 'cut and captions', priority: 'medium' },
    [stranger, specialist],
    [d],
  );
  assert.ok(r);
  assert.equal(r!.agentId, 'a-video');
});

test('seam: task context steers the pick — specialist fit beats idle non-fit', async () => {
  const d = dept({ agentRoles: ['Generalist'] });
  const generalist = agent({ id: 'a-gen', name: 'Gus', role: 'Generalist', workspace_id: d.id, description: 'general admin help' });
  const videoPro = agent({ id: 'a-pro', name: 'Vera', role: 'Video Editor', workspace_id: d.id, description: 'edits promo video cuts with captions', active_tasks: 1 });
  const r = await comDispatch(
    { title: 'Edit 60-second promo video', description: 'cut the launch promo with captions', priority: 'medium' },
    [generalist, videoPro],
    [d],
  );
  assert.ok(r);
  assert.equal(r!.agentId, 'a-pro', `task-aware fit must beat the idle generalist: ${r!.reason}`);
});

test('seam: busy qualified department still assigns (existing capacity policy retained)', async () => {
  const d = dept();
  const busy = agent({ id: 'a-busy', name: 'Vera', role: 'Video Editor', workspace_id: d.id, active_tasks: 4 });
  const r = await comDispatch(
    { title: 'Edit 60-second promo video', description: 'cut and captions', priority: 'medium' },
    [busy],
    [d],
  );
  assert.ok(r, 'must not collapse to none-suitable on a busy specialist');
  assert.equal(r!.agentId, 'a-busy');
});

test('hasTaskContent gates legacy path', () => {
  assert.equal(hasTaskContent({ title: '' }), false);
  assert.equal(hasTaskContent({ title: '  ', description: null }), false);
  assert.equal(hasTaskContent({ title: 'fix it' }), true);
});
