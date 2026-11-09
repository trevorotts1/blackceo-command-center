/**
 * WF33 / GHL-033 — Command Center -> GHL Projects one-way projection.
 *
 * Acceptance coverage:
 *   B20                opt-in CC-to-Projects sync preserves completion authority,
 *                      does not loop, and never duplicates tasks.
 *   IG-PROJECT-07      CC synchronization does not echo-loop or promote an
 *                      unverified build to done.
 *
 * Every case runs against an injected in-memory store and a scripted adapter
 * fixture. No DB, no network, no GoHighLevel credentials: the WF32 adapter and
 * the WF18 migration store are not yet recorded as checkpoints, so this lane
 * tests the domain logic against an honest fixture that fails loudly. The two
 * checkpoint assumptions are named in the file header of the run evidence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProjectsMapping,
  correlationMarkerFor,
  DEFAULT_FIELD_OWNERSHIP,
  SYNC_POLICY_VERSION,
  type GhlProjectsMapping,
  type ProjectsSyncIntent,
  type ProjectsSyncStore,
} from '../../src/lib/ghl-projects-mappings';
import {
  projectCcTaskEvent,
  type AdapterResult,
  type CcTaskProjectionSource,
  type GhlProjectTaskCreateRequest,
  type GhlProjectTaskSnapshot,
  type GhlProjectTaskUpdateRequest,
  type GhlProjectsAdapter,
} from '../../src/lib/ghl-projects-sync';

const NOW = '2026-11-08T12:00:00.000Z';

// ── fixtures ────────────────────────────────────────────────────────────────

function memoryStore(): ProjectsSyncStore & {
  mappings: Map<string, GhlProjectsMapping>;
  intents: Map<string, ProjectsSyncIntent>;
} {
  const mappings = new Map<string, GhlProjectsMapping>();
  const intents = new Map<string, ProjectsSyncIntent>();
  const mapKey = (c: string, l: string, t: string) => `${c}|${l}|${t}`;
  return {
    mappings,
    intents,
    getMapping: (c, l, t) => {
      const row = mappings.get(mapKey(c, l, t));
      return row ? { ...row } : null;
    },
    saveMapping: (m) => {
      mappings.set(mapKey(m.company_id, m.location_id, m.cc_task_id), { ...m });
    },
    getIntent: (key) => {
      const row = intents.get(key);
      return row ? { ...row } : null;
    },
    saveIntent: (i) => {
      intents.set(i.logical_key, { ...i });
    },
  };
}

interface FakeAdapter extends GhlProjectsAdapter {
  calls: string[];
  created: GhlProjectTaskCreateRequest[];
  updated: GhlProjectTaskUpdateRequest[];
  remote: Map<string, GhlProjectTaskSnapshot>;
  hooks: {
    create?: (req: GhlProjectTaskCreateRequest) => Promise<AdapterResult<GhlProjectTaskSnapshot>> | AdapterResult<GhlProjectTaskSnapshot>;
    update?: (req: GhlProjectTaskUpdateRequest) => Promise<AdapterResult<GhlProjectTaskSnapshot>> | AdapterResult<GhlProjectTaskSnapshot>;
    read?: (id: string) => Promise<AdapterResult<GhlProjectTaskSnapshot | null>> | AdapterResult<GhlProjectTaskSnapshot | null>;
    find?: (marker: string) => Promise<AdapterResult<GhlProjectTaskSnapshot | null>> | AdapterResult<GhlProjectTaskSnapshot | null>;
  };
  makeSnapshot(req: GhlProjectTaskCreateRequest): GhlProjectTaskSnapshot;
}

function fakeAdapter(): FakeAdapter {
  let n = 0;
  const remote = new Map<string, GhlProjectTaskSnapshot>();
  const adapter: FakeAdapter = {
    calls: [],
    created: [],
    updated: [],
    remote,
    hooks: {},
    makeSnapshot(req) {
      n += 1;
      const snapshot: GhlProjectTaskSnapshot = {
        projectTaskId: `remote-task-${n}`,
        spaceId: req.spaceId,
        homeListId: req.homeListId,
        title: req.title,
        status: req.status,
        dueDate: req.dueDate,
        notes: req.notes,
        assigneeIds: [req.assigneeId],
        marker: req.marker,
      };
      remote.set(snapshot.projectTaskId, snapshot);
      return snapshot;
    },
    async createTask(req) {
      adapter.calls.push('create');
      adapter.created.push(req);
      if (adapter.hooks.create) return adapter.hooks.create(req);
      return { ok: true, value: adapter.makeSnapshot(req) };
    },
    async updateTask(req) {
      adapter.calls.push('update');
      adapter.updated.push(req);
      if (adapter.hooks.update) return adapter.hooks.update(req);
      const existing = remote.get(req.ref.projectTaskId);
      if (!existing) {
        return { ok: false, reason: 'project task not found', retryable: false, notFound: true };
      }
      const merged: GhlProjectTaskSnapshot = {
        ...existing,
        title: typeof req.fields.title === 'string' ? req.fields.title : existing.title,
        status: typeof req.fields.status === 'string' ? req.fields.status : existing.status,
        notes: typeof req.fields.notes === 'string' ? req.fields.notes : existing.notes,
      };
      remote.set(merged.projectTaskId, merged);
      return { ok: true, value: merged };
    },
    async readTask(ref) {
      adapter.calls.push('read');
      if (adapter.hooks.read) return adapter.hooks.read(ref.projectTaskId);
      return { ok: true, value: remote.get(ref.projectTaskId) ?? null };
    },
    async findTaskByMarker(req) {
      adapter.calls.push('find');
      if (adapter.hooks.find) return adapter.hooks.find(req.marker);
      for (const snapshot of remote.values()) {
        if (snapshot.marker === req.marker) return { ok: true, value: snapshot };
      }
      return { ok: true, value: null };
    },
  };
  return adapter;
}

function source(overrides: Partial<CcTaskProjectionSource> = {}): CcTaskProjectionSource {
  return {
    origin: 'cc',
    companyId: 'company-synthetic',
    locationId: 'location-synthetic',
    ccTaskId: 'task-100',
    sourceRevision: 'rev-1',
    sourceSequence: 1,
    title: 'Build the course landing page',
    status: 'in_progress',
    verifiedCompletion: false,
    evidenceLinks: ['evidence/B20/readback.json'],
    approvedDueDate: '2026-11-20',
    approvedAssigneeIds: ['user-approved-owner'],
    humanNotes: 'Owner note.',
    taskScopes: ['verified_completion'],
    ...overrides,
  };
}

function deps(store: ProjectsSyncStore, adapter: GhlProjectsAdapter) {
  let id = 0;
  return { store, adapter, now: () => NOW, newId: () => `id-${++id}` };
}

function seedMapping(store: ReturnType<typeof memoryStore>, overrides: Partial<GhlProjectsMapping> = {}): GhlProjectsMapping {
  const built = buildProjectsMapping({
    auth: { companyId: 'company-synthetic', locationId: 'location-synthetic' },
    ccTaskId: 'task-100',
    target: { spaceId: 'space-1', homeListId: 'list-1' },
    allowedTaskScopes: ['verified_completion'],
    enabled: true,
  });
  assert.equal(built.ok, true);
  const mapping = { ...(built as { ok: true; mapping: GhlProjectsMapping }).mapping, ...overrides };
  store.saveMapping(mapping);
  return mapping;
}

// ── opt-in binding ──────────────────────────────────────────────────────────

test('B20: no authorized binding means no projection at all (never a whole-board export)', async () => {
  const store = memoryStore();
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(result.outcome, 'not_requested');
  assert.equal(result.reason, 'no_authorized_binding');
  assert.deepEqual(adapter.calls, []);
});

test('B20: a disabled tenant binding performs no remote call', async () => {
  const store = memoryStore();
  seedMapping(store, { enabled: false });
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(result.outcome, 'not_requested');
  assert.equal(result.reason, 'projection_disabled_for_tenant');
  assert.deepEqual(adapter.calls, []);
});

test('B20: a task outside the authorized scope is not projected', async () => {
  const store = memoryStore();
  seedMapping(store, { allowed_task_scopes: ['verified_completion'] });
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(source({ taskScopes: ['unrelated_scope'] }), deps(store, adapter));
  assert.equal(result.outcome, 'not_requested');
  assert.equal(result.reason, 'task_outside_authorized_scope');
  assert.deepEqual(adapter.calls, []);
});

test('B20: binding rejects a body-supplied tenant that disagrees with the authenticated company', () => {
  const companyMismatch = buildProjectsMapping({
    auth: { companyId: 'company-a', locationId: 'location-a' },
    ccTaskId: 'task-1',
    target: { companyId: 'company-b', spaceId: 'space-1', homeListId: 'list-1' },
    allowedTaskScopes: ['verified_completion'],
  });
  assert.deepEqual(companyMismatch, { ok: false, reason: 'target_company_mismatch' });

  const locationMismatch = buildProjectsMapping({
    auth: { companyId: 'company-a', locationId: 'location-a' },
    ccTaskId: 'task-1',
    target: { locationId: 'location-b', spaceId: 'space-1', homeListId: 'list-1' },
    allowedTaskScopes: ['verified_completion'],
  });
  assert.deepEqual(locationMismatch, { ok: false, reason: 'target_location_mismatch' });
});

test('B20: binding rejects an unbounded scope (wildcard is the export-everything path)', () => {
  const result = buildProjectsMapping({
    auth: { companyId: 'company-a', locationId: 'location-a' },
    ccTaskId: 'task-1',
    target: { spaceId: 'space-1', homeListId: 'list-1' },
    allowedTaskScopes: ['*'],
  });
  assert.deepEqual(result, { ok: false, reason: 'wildcard_task_scope_not_allowed' });
});

test('B20: completion authority is never delegatable in field ownership', () => {
  const built = buildProjectsMapping({
    auth: { companyId: 'company-a', locationId: 'location-a' },
    ccTaskId: 'task-1',
    target: { spaceId: 'space-1', homeListId: 'list-1' },
    allowedTaskScopes: ['verified_completion'],
    fieldOwnership: { verified_completion: 'human', evidence_links: 'human' },
  });
  assert.equal(built.ok, true);
  const mapping = (built as { ok: true; mapping: GhlProjectsMapping }).mapping;
  assert.equal(mapping.field_ownership.verified_completion, 'cc');
  assert.equal(mapping.field_ownership.evidence_links, 'cc');
  assert.equal(DEFAULT_FIELD_OWNERSHIP.due_date, 'human');
  assert.equal(mapping.correlation_marker, correlationMarkerFor('company-a', 'location-a', 'task-1'));
});

// ── create / duplicate / idempotence ────────────────────────────────────────

test('B20: an authorized task is created once, read back, and verified', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();

  const first = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(first.outcome, 'verified');
  assert.equal(first.reason, 'readback_matched');
  assert.deepEqual(adapter.calls, ['create', 'read']);
  assert.equal(adapter.created.length, 1);
  assert.equal(adapter.created[0].dueDate, '2026-11-20');
  assert.equal(adapter.created[0].assigneeId, 'user-approved-owner');
  assert.match(adapter.created[0].notes, /evidence\/B20\/readback\.json/);

  const saved = store.getMapping('company-synthetic', 'location-synthetic', 'task-100');
  assert.ok(saved);
  assert.equal(saved.sync_state, 'in_sync');
  assert.equal(saved.project_task_id, 'remote-task-1');
  assert.equal(saved.last_source_sequence, 1);
  assert.equal(saved.last_source_revision, 'rev-1');
  assert.match(String(saved.last_applied_fingerprint), /^sha256:[0-9a-f]{64}$/);
  assert.match(String(saved.last_provider_readback_ref), /^readback:remote-task-1:1$/);

  const second = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(second.outcome, 'duplicate');
  assert.equal(second.reason, 'already_applied');
  assert.deepEqual(adapter.calls, ['create', 'read'], 'a replayed event performs no second remote write');
  assert.equal(store.mappings.size, 1);
});

test('B20: a reordered older event is ignored and never downgrades the applied revision', async () => {
  const store = memoryStore();
  seedMapping(store, { last_source_sequence: 5, last_source_revision: 'rev-5', sync_state: 'in_sync' });
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(source({ sourceSequence: 4, sourceRevision: 'rev-4' }), deps(store, adapter));
  assert.equal(result.outcome, 'duplicate');
  assert.equal(result.reason, 'reordered_event_ignored');
  assert.deepEqual(adapter.calls, []);
  assert.equal(store.getMapping('company-synthetic', 'location-synthetic', 'task-100')?.last_source_sequence, 5);
});

// ── create preconditions: no guessed date, no chosen owner ──────────────────

test('B20: a task without an approved due date stays pending and is never given a guessed date', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(source({ approvedDueDate: null }), deps(store, adapter));
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'missing_approved_due_date');
  assert.equal(result.retryable, false);
  assert.deepEqual(adapter.calls, []);
  assert.equal(store.getMapping('company-synthetic', 'location-synthetic', 'task-100')?.pending_reason, 'missing_approved_due_date');
});

test('B20: several requested assignees are never silently reduced to one', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(
    source({ approvedAssigneeIds: ['owner-a', 'owner-b'] }),
    deps(store, adapter),
  );
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'multiple_assignees_not_supported');
  assert.deepEqual(adapter.calls, []);
});

test('B20: a missing approved owner leaves the projection pending', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(source({ approvedAssigneeIds: [] }), deps(store, adapter));
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'missing_approved_assignee');
  assert.deepEqual(adapter.calls, []);
});

// ── ambiguous write + reconcile-before-create ───────────────────────────────

test('B20: a lost create response reconciles before any second create', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();

  // The create DID land remotely, then the connection died: the adapter throws.
  adapter.hooks.create = (req) => {
    adapter.makeSnapshot(req);
    throw new Error('socket hang up after submit');
  };

  const first = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(first.outcome, 'unknown_outcome');
  assert.equal(first.reason, 'write_outcome_unknown_reconcile_before_retry');
  assert.equal(adapter.calls.filter((c) => c === 'create').length, 1);
  const afterUnknown = store.getMapping('company-synthetic', 'location-synthetic', 'task-100');
  assert.equal(afterUnknown?.sync_state, 'blocked');
  assert.equal(afterUnknown?.pending_reason, 'unknown_outcome_awaiting_reconcile');
  assert.equal(afterUnknown?.project_task_id, null);

  adapter.hooks.create = undefined;
  const second = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(second.outcome, 'verified');
  assert.equal(
    adapter.calls.filter((c) => c === 'create').length,
    1,
    'the reconciled pass must not issue a duplicate create',
  );
  assert.equal(adapter.calls[1], 'find');
  assert.equal(store.getMapping('company-synthetic', 'location-synthetic', 'task-100')?.project_task_id, 'remote-task-1');
});

// ── outage isolation ────────────────────────────────────────────────────────

test('B20: a Projects outage blocks only the projection and returns (business work unaffected)', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  adapter.hooks.create = () => ({ ok: false, reason: 'projects 503', retryable: true });

  const blocked = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.reason, 'projects_unavailable');
  assert.equal(blocked.retryable, true);
  assert.equal(store.getMapping('company-synthetic', 'location-synthetic', 'task-100')?.sync_state, 'blocked');

  // A later pass after recovery completes without re-deriving anything by hand.
  adapter.hooks.create = undefined;
  const recovered = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(recovered.outcome, 'verified');
  assert.equal(store.getMapping('company-synthetic', 'location-synthetic', 'task-100')?.sync_state, 'in_sync');
});

test('B20: an outage during reconcile leaves the mapping pending, never creates blindly', async () => {
  const store = memoryStore();
  seedMapping(store, { last_attempt_id: 'attempt-lost', sync_state: 'blocked' });
  const adapter = fakeAdapter();
  adapter.hooks.find = () => ({ ok: false, reason: 'projects unreachable', retryable: true });

  const result = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'projects_unavailable_on_reconcile');
  assert.equal(result.retryable, true);
  assert.equal(adapter.calls.includes('create'), false);
});

// ── field ownership ─────────────────────────────────────────────────────────

test('B20: an update sends only CC-owned changed fields; human GHL notes/dates are never overwritten', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  await projectCcTaskEvent(source(), deps(store, adapter));

  // A human edited the remote note and due date after creation.
  const remote = adapter.remote.get('remote-task-1') as GhlProjectTaskSnapshot;
  adapter.remote.set('remote-task-1', {
    ...remote,
    notes: 'Human-edited note in GHL',
    dueDate: '2026-12-24',
  });

  const updated = await projectCcTaskEvent(
    source({ sourceRevision: 'rev-2', sourceSequence: 2, title: 'Build the course landing page v2' }),
    deps(store, adapter),
  );
  assert.equal(updated.outcome, 'verified');
  assert.equal(adapter.updated.length, 1);
  const fields = adapter.updated[0].fields;
  assert.equal(fields.title, 'Build the course landing page v2');
  assert.equal('due_date' in fields, false);
  assert.equal('dueDate' in fields, false);
  assert.equal('notes' in fields, false);
  assert.equal('assignee' in fields, false);
  const after = adapter.remote.get('remote-task-1') as GhlProjectTaskSnapshot;
  assert.equal(after.notes, 'Human-edited note in GHL');
  assert.equal(after.dueDate, '2026-12-24');
});

test('IG-PROJECT-07: a verified task is not promoted to remote completed by a raw CC done', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(
    source({ status: 'done', verifiedCompletion: false, title: 'Unverified completion' }),
    deps(store, adapter),
  );
  assert.equal(result.outcome, 'verified');
  assert.equal(adapter.created[0].status, 'in_progress');
});

test('B20: CC verified completion projects as completed exactly once', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(
    source({ status: 'done', verifiedCompletion: true }),
    deps(store, adapter),
  );
  assert.equal(result.outcome, 'verified');
  assert.equal(adapter.created[0].status, 'completed');
});

// ── IG-PROJECT-07: no remote certification, no echo loop ────────────────────

test('IG-PROJECT-07: a Projects-originated Done event is refused and cannot certify CC', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(
    source({ origin: 'projects', status: 'done', verifiedCompletion: true }),
    deps(store, adapter),
  );
  assert.equal(result.outcome, 'not_requested');
  assert.equal(result.reason, 'remote_projects_event_never_certifies_cc');
  assert.deepEqual(adapter.calls, []);
  const mapping = store.getMapping('company-synthetic', 'location-synthetic', 'task-100');
  assert.equal(mapping?.sync_state, 'unsynced');
});

test('IG-PROJECT-07: an identical replayed event causes no echo write even after a human remote edit', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  await projectCcTaskEvent(source(), deps(store, adapter));
  const before = adapter.calls.length;

  const remote = adapter.remote.get('remote-task-1') as GhlProjectTaskSnapshot;
  adapter.remote.set('remote-task-1', { ...remote, notes: 'human reply in GHL' });

  const replay = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(replay.outcome, 'duplicate');
  assert.equal(replay.reason, 'already_applied');
  assert.equal(adapter.calls.length, before, 'no read and no write on a replay');
});

// ── drift ───────────────────────────────────────────────────────────────────

test('B20: a readback disagreement is reported as drift and never fought with a second write', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  await projectCcTaskEvent(source(), deps(store, adapter));
  const writesBefore = adapter.calls.filter((c) => c === 'update' || c === 'create').length;

  adapter.hooks.update = (req) => {
    const existing = adapter.remote.get(req.ref.projectTaskId) as GhlProjectTaskSnapshot;
    const remainStale = { ...existing }; // remote refuses/mutates the change
    adapter.remote.set(existing.projectTaskId, remainStale);
    return { ok: true, value: remainStale };
  };

  const drift = await projectCcTaskEvent(
    source({ sourceRevision: 'rev-3', sourceSequence: 3, title: 'Renamed task' }),
    deps(store, adapter),
  );
  assert.equal(drift.outcome, 'drift');
  assert.match(drift.reason, /^readback_mismatch:/);
  assert.equal(adapter.calls.filter((c) => c === 'update' || c === 'create').length, writesBefore + 1);
  assert.equal(store.getMapping('company-synthetic', 'location-synthetic', 'task-100')?.sync_state, 'drift');
});

test('B20: a deleted remote target is drift; the projection does not recreate it without approval', async () => {
  const store = memoryStore();
  seedMapping(store);
  const adapter = fakeAdapter();
  await projectCcTaskEvent(source(), deps(store, adapter));
  adapter.remote.delete('remote-task-1');

  const result = await projectCcTaskEvent(
    source({ sourceRevision: 'rev-2', sourceSequence: 2, title: 'Changed after delete' }),
    deps(store, adapter),
  );
  assert.equal(result.outcome, 'drift');
  assert.equal(result.reason, 'remote_target_missing');
  assert.equal(adapter.created.length, 1, 'no unapproved recreation');
  assert.equal(store.getMapping('company-synthetic', 'location-synthetic', 'task-100')?.pending_reason, 'remote_target_missing');
});

// ── policy version ──────────────────────────────────────────────────────────

test('B20: an unsupported sync policy version blocks instead of guessing semantics', async () => {
  const store = memoryStore();
  seedMapping(store, { sync_policy_version: SYNC_POLICY_VERSION + 1 });
  const adapter = fakeAdapter();
  const result = await projectCcTaskEvent(source(), deps(store, adapter));
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.reason, 'sync_policy_version_unsupported');
  assert.deepEqual(adapter.calls, []);
});
