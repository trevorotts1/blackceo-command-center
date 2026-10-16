/**
 * archify-runs.test.ts — Skill 69 archify → board lib
 * (createArchifyRun / moveArchifyPhase / getArchifyRun).
 *
 * Runs against a THROWAWAY DB — './_isolated-db' MUST stay the FIRST import
 * (ES `import` declarations are hoisted and evaluated in order, so anything
 * that pulls in '@/lib/db' before it would freeze DB_PATH from the un-isolated
 * env and write fixtures into the live board). tests/unit/c8-db-isolation-guard.test.ts
 * fails the build if this regresses.
 *
 * The gates this suite has to respect (they are the SAME gates every other
 * board card passes — an archify card is not special):
 *   • FIX 25 — review requires a registered, reachable deliverable.
 *   • T0-01 — done requires the same evidence; operatorOverride cannot skip it.
 * So the fixtures declare a real artifact (the http(s) `artifact_url` the
 * producer sends), exactly as the live producer does.
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '../../src/lib/db';
import {
  createArchifyRun,
  moveArchifyPhase,
  getArchifyRun,
  deriveRunIdFromExternalId,
  resolveRunIdByExternalId,
  ArchifyRunError,
  TransitionError,
  DEFAULT_ARCHIFY_PHASES,
} from '../../src/lib/archify-runs';

/** Temp dir holding the fixture deliverable files (file-artifact path). */
const ARCHIFY_ARTIFACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-archify-deliv-'));

function newRunId(): string {
  return `test-archify-${uuidv4()}`;
}

const ARTIFACT_URL = 'https://example.invalid/renders/architecture.html';

function writeArtifactFile(name: string): string {
  const p = path.join(ARCHIFY_ARTIFACT_DIR, name);
  fs.writeFileSync(p, '<html>archify render</html>\n');
  return p;
}

test('createArchifyRun creates an epic + one card per phase, all backlog', () => {
  const runId = newRunId();

  const first = createArchifyRun({
    run_id: runId,
    title: 'Payments Platform Overview',
    diagram_type: 'architecture',
    source_path: 'examples/web-app.architecture.json',
  });

  assert.equal(first.created, true);
  assert.equal(first.run_id, runId);
  assert.equal(first.campaign_id, runId, 'campaign_id is the same grouping id (board parity)');
  assert.ok(first.parent_id, 'epic parent id present');
  assert.equal(first.phases.length, DEFAULT_ARCHIFY_PHASES.length, '5 non-epic phase cards');
  // The DEFAULT list IS the Skill 69 producer vocabulary, in lifecycle order
  // (cross-language guard: archify-runs-producer-contract.test.ts). Ordering
  // matters here — it is the order cards are created and the order the producer
  // walks — but NOT in the response below: readPhaseRefs() reads cards back
  // `ORDER BY stage_slug`, i.e. alphabetically, which used to coincide with the
  // lifecycle only because the slugs were p1..p5.
  assert.deepEqual(
    DEFAULT_ARCHIFY_PHASES.map((p) => p.slug),
    ['received', 'authoring', 'validate', 'render', 'deliver'],
    'default phase slugs == the producer vocabulary, in lifecycle order',
  );
  assert.deepEqual(
    first.phases.map((p) => p.slug).sort(),
    ['received', 'authoring', 'validate', 'render', 'deliver'].sort(),
    'one card per default phase, addressable by the producer CLI',
  );

  const rows = queryAll<{ status: string }>('SELECT status FROM tasks WHERE campaign_id = ?', [
    runId,
  ]);
  assert.equal(rows.length, DEFAULT_ARCHIFY_PHASES.length + 1, 'epic + 5 phases = 6 cards');
  assert.ok(rows.every((r) => r.status === 'backlog'), 'all cards start in backlog');

  // Cards carry NO assigned agent (FK-safe: external ids never enter the agents FK).
  const assigned = queryAll<{ assigned_agent_id: string | null }>(
    'SELECT assigned_agent_id FROM tasks WHERE campaign_id = ?',
    [runId],
  );
  assert.ok(assigned.every((r) => r.assigned_agent_id === null), 'assigned_agent_id stays NULL');
});

test('replay on the same run_id + parameters is idempotent (no duplicate cards)', () => {
  const runId = newRunId();
  const input = { run_id: runId, title: 'Retry Safe', diagram_type: 'workflow' as const };

  const first = createArchifyRun(input);
  const second = createArchifyRun(input);

  assert.equal(second.created, false, 'replay reports created:false');
  assert.equal(second.parent_id, first.parent_id, 'same epic id');
  assert.deepEqual(
    second.phases.map((p) => p.id).sort(),
    first.phases.map((p) => p.id).sort(),
    'same phase card ids',
  );
  const after = queryAll('SELECT id FROM tasks WHERE campaign_id = ?', [runId]);
  assert.equal(after.length, DEFAULT_ARCHIFY_PHASES.length + 1, 'replay did not duplicate cards');
});

test('external_run_id alone derives a deterministic grouping id (retry cannot double-create)', () => {
  const externalId = `archify-job-${uuidv4()}`;
  const derived = deriveRunIdFromExternalId(externalId);

  const first = createArchifyRun({
    external_run_id: externalId,
    title: 'Derived Key Run',
    diagram_type: 'sequence',
  });
  assert.equal(first.run_id, derived, 'run_id derived from the external id');
  assert.equal(first.external_run_id, externalId, 'external id echoed back');

  // A retry that sends the same external id (with no run_id) lands on the SAME grouping.
  const second = createArchifyRun({
    external_run_id: externalId,
    title: 'Derived Key Run',
    diagram_type: 'sequence',
  });
  assert.equal(second.run_id, derived);
  assert.equal(second.created, false);
  const after = queryAll('SELECT id FROM tasks WHERE campaign_id = ?', [derived]);
  assert.equal(after.length, DEFAULT_ARCHIFY_PHASES.length + 1, 'no second grouping created');

  // Lookup by external id resolves through the same derivation, never a guess.
  assert.equal(resolveRunIdByExternalId(externalId), derived);
  assert.equal(resolveRunIdByExternalId('archify-job-never-created'), null);
});

test('same run_id with different parameters is a 409 idempotency conflict', () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'Original Title', diagram_type: 'dataflow' });

  assert.throws(
    () => createArchifyRun({ run_id: runId, title: 'Different Title', diagram_type: 'dataflow' }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 409 && err.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.throws(
    () => createArchifyRun({ run_id: runId, title: 'Original Title', diagram_type: 'lifecycle' }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 409,
    'a different diagram type on the same id is also a conflict',
  );
});

test('a run_id owned by a NON-archify grouping is refused with 409 (never adopted)', () => {
  const runId = newRunId();
  // Simulate a foreign grouping created by another producer (e.g. Skill 48).
  run(
    `INSERT INTO campaigns (id, name, description, status, created_at, updated_at)
     VALUES (?, 'FB Ad Run — foreign', 'Skill 48 Facebook ad run.', 'active', ?, ?)`,
    [runId, new Date().toISOString(), new Date().toISOString()],
  );

  assert.throws(
    () => createArchifyRun({ run_id: runId, title: 'Collides', diagram_type: 'architecture' }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 409 && err.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('phase lifecycle: backlog -> in_progress -> review -> done with an artifact', async () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'Lifecycle Run', diagram_type: 'architecture' });

  const started = await moveArchifyPhase(runId, { phase_slug: 'authoring', status: 'in_progress' });
  assert.equal(started.status, 'in_progress');

  // FIX 25: review needs registered, reachable evidence — the producer's
  // artifact_url is that evidence (and it is registered, not merely recorded).
  const inReview = await moveArchifyPhase(runId, {
    phase_slug: 'authoring',
    status: 'review',
    note: 'diagram validated against the style guide',
    artifact_url: ARTIFACT_URL,
  });
  assert.equal(inReview.status, 'review');

  const deliverables = queryAll<{ deliverable_type: string; path: string }>(
    'SELECT deliverable_type, path FROM task_deliverables WHERE task_id = ?',
    [inReview.id],
  );
  assert.equal(deliverables.length, 1, 'artifact registered exactly once');
  assert.equal(deliverables[0].deliverable_type, 'url');
  assert.equal(deliverables[0].path, ARTIFACT_URL);

  // A re-sent artifact on the same card must not multiply evidence rows.
  await moveArchifyPhase(runId, {
    phase_slug: 'authoring',
    status: 'done',
    artifact_url: ARTIFACT_URL,
  });
  const after = queryAll('SELECT id FROM task_deliverables WHERE task_id = ?', [inReview.id]);
  assert.equal(after.length, 1, 'artifact registration is idempotent');

  // The note is appended to the card's provenance block, never overwriting it.
  const row = queryOne<{ description: string; completed_at: string | null }>(
    'SELECT description, completed_at FROM tasks WHERE id = ?',
    [inReview.id],
  );
  assert.match(row!.description, /\[archify-run\] phase=authoring/);
  assert.match(row!.description, /diagram validated against the style guide/);
  assert.ok(row!.completed_at, 'trg_tasks_completed_at populated completed_at');

  // task_events audit rows were written by transition().
  const events = queryAll('SELECT id FROM task_events WHERE task_id = ?', [inReview.id]);
  assert.ok(events.length >= 3, 'task_events recorded for each transition');
});

test('a local file artifact is accepted as evidence; an unreal one is refused (400)', async () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'File Artifact Run', diagram_type: 'lifecycle' });

  const filePath = writeArtifactFile('architecture.html');
  const done = await moveArchifyPhase(runId, {
    phase_slug: 'render',
    status: 'in_progress',
  });
  const reviewed = await moveArchifyPhase(runId, {
    phase_slug: 'render',
    status: 'review',
    artifact_url: filePath,
  });
  assert.equal(reviewed.status, 'review');
  const fileRow = queryAll<{ deliverable_type: string }>(
    'SELECT deliverable_type FROM task_deliverables WHERE task_id = ?',
    [done.id],
  );
  assert.equal(fileRow[0].deliverable_type, 'file');

  // Evidence that does not exist is refused rather than recorded — a gate that
  // accepts a fabricated path is not a gate.
  await assert.rejects(
    () =>
      moveArchifyPhase(runId, {
        phase_slug: 'deliver',
        status: 'in_progress',
        artifact_url: 'not-a-url-and-not-a-path',
      }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 400 && err.code === 'INVALID_ARTIFACT_URL',
  );
  await assert.rejects(
    () =>
      moveArchifyPhase(runId, {
        phase_slug: 'deliver',
        status: 'in_progress',
        artifact_url: '/nonexistent/archify/never-rendered.html',
      }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 400,
  );
});

test('a bundle-SHAPED file that fails the byte probe is refused at registration (422)', async () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'Bundle Gate Run', diagram_type: 'architecture' });

  // 'infographic.png' is a bundle-managed name (FIX 54). A 20-byte stub is far
  // under the PNG floor, so registering it here must fail exactly as it would
  // through POST /api/tasks/{id}/deliverables — no row is written and the
  // refusal names the probe's status.
  const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-archify-bundle-'));
  const stub = path.join(stubDir, 'infographic.png');
  fs.writeFileSync(stub, '\x89PNG\r\n\x1a\nstub');

  await assert.rejects(
    () =>
      moveArchifyPhase(runId, {
        phase_slug: 'render',
        status: 'in_progress',
        artifact_url: stub,
      }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 422 && err.code === 'BUNDLE_REJECTED',
  );

  const card = queryOne<{ id: string }>(
    'SELECT id FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [runId, 'render'],
  );
  const rows = queryAll('SELECT id FROM task_deliverables WHERE task_id = ?', [card!.id]);
  assert.equal(rows.length, 0, 'a refused artifact leaves no row behind');
});

test('review without evidence is refused by the canonical gate (422-class, not waived)', async () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'No Evidence Run', diagram_type: 'workflow' });

  await moveArchifyPhase(runId, { phase_slug: 'validate', status: 'in_progress' });
  await assert.rejects(
    () => moveArchifyPhase(runId, { phase_slug: 'validate', status: 'review' }),
    (err: unknown) => err instanceof TransitionError && err.code === 'PRECONDITION_EVIDENCE',
    'operatorOverride must NOT waive the evidence gate',
  );
});

test('epic done completes the grouping; unknown phase/run are 404-class', async () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'Completion Run', diagram_type: 'architecture' });

  await moveArchifyPhase(runId, { phase_slug: 'deliver', status: 'in_progress' });
  await moveArchifyPhase(runId, {
    phase_slug: 'deliver',
    status: 'review',
    artifact_url: ARTIFACT_URL,
  });
  await moveArchifyPhase(runId, { phase_slug: 'deliver', status: 'done' });

  await moveArchifyPhase(runId, { phase_slug: 'epic', status: 'in_progress' });
  await moveArchifyPhase(runId, {
    phase_slug: 'epic',
    status: 'review',
    artifact_url: ARTIFACT_URL,
  });
  await moveArchifyPhase(runId, { phase_slug: 'epic', status: 'done' });

  const { campaign, phases } = getArchifyRun(runId);
  assert.equal((campaign as { status: string }).status, 'complete');
  assert.equal(phases.length, DEFAULT_ARCHIFY_PHASES.length);

  await assert.rejects(
    () => moveArchifyPhase(runId, { phase_slug: 'does-not-exist', status: 'in_progress' }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 404 && err.code === 'PHASE_NOT_FOUND',
  );
  await assert.rejects(
    () => moveArchifyPhase('no-such-run', { phase_slug: 'received', status: 'in_progress' }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 404 && err.code === 'RUN_NOT_FOUND',
  );
});

test('illegal transitions are refused by the canonical legal map', async () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'Illegal Run', diagram_type: 'architecture' });

  // backlog -> done is not a legal edge in LEGAL_TRANSITIONS.
  await assert.rejects(
    () => moveArchifyPhase(runId, { phase_slug: 'epic', status: 'done' }),
    (err: unknown) => err instanceof TransitionError && err.code === 'ILLEGAL_TRANSITION',
  );
});

test('blocked path sets the blocked columns; leaving blocked nulls all six', async () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'Blocked Run', diagram_type: 'dataflow' });

  await moveArchifyPhase(runId, { phase_slug: 'received', status: 'in_progress' });
  const blocked = await moveArchifyPhase(runId, {
    phase_slug: 'received',
    status: 'blocked',
    blocked_reason: 'credential',
    blocked_on_human: 'operator',
    ask: 'Provide the Kie.ai key so the diagram render can run.',
  });
  assert.equal(blocked.status, 'blocked');

  const blockedRow = queryOne<{
    blocked_reason: string | null;
    blocked_on_human: string | null;
    ask: string | null;
  }>(
    'SELECT blocked_reason, blocked_on_human, ask FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [runId, 'received'],
  );
  assert.equal(blockedRow!.blocked_reason, 'credential');
  assert.equal(blockedRow!.blocked_on_human, 'operator');
  assert.ok(blockedRow!.ask && blockedRow!.ask.length > 0);

  const resumed = await moveArchifyPhase(runId, { phase_slug: 'received', status: 'in_progress' });
  assert.equal(resumed.status, 'in_progress');
  const cleared = queryOne<{ blocked_reason: string | null; ask: string | null }>(
    'SELECT blocked_reason, ask FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [runId, 'received'],
  );
  assert.equal(cleared!.blocked_reason, null);
  assert.equal(cleared!.ask, null);
});

test('blocked without a structured reason or ask is rejected (400-class)', async () => {
  const runId = newRunId();
  createArchifyRun({ run_id: runId, title: 'Gate Run', diagram_type: 'sequence' });
  await moveArchifyPhase(runId, { phase_slug: 'authoring', status: 'in_progress' });

  await assert.rejects(
    () => moveArchifyPhase(runId, { phase_slug: 'authoring', status: 'blocked', ask: 'do the thing' }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 400 && err.code === 'BLOCKED_REASON_REQUIRED',
  );
  await assert.rejects(
    () =>
      moveArchifyPhase(runId, {
        phase_slug: 'authoring',
        status: 'blocked',
        blocked_reason: 'decision',
      }),
    (err: unknown) => err instanceof ArchifyRunError && err.status === 400 && err.code === 'ASK_REQUIRED',
  );
});
