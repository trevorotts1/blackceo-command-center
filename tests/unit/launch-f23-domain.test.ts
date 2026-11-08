/**
 * F23 — governed launch domain in Command Center and Kanban.
 *
 * One test file per F23 cluster, each mapping to the spec item it proves:
 *
 *   F23.1  registration + admission exist for the governed launch domain
 *   F23.2  run identity is immutable (tenant/workspace/installation/skill/
 *          launch/plan revision/hash): a mismatch is rejected, never rewritten
 *   F23.3  report overall is a projection; a closed stage needs a pass receipt
 *          AND artifact hashes verified against registered deliverables
 *   F23.4  the canonical unit inventory is the producer's; dropped/unknown are
 *          never delivered; stage percentage is labelled separately
 *   F23.5  changed evidence / revoked approval / superseded artifact mint
 *          invalidation events; the old green state stops being current
 *   F23.6  a governed page/launch card needs launch-specific evidence
 *   F23.7  card granularity is explicit; a subtask never closes its parent
 *   F23.8  practical states map through the existing workflow
 *   F23.9  evidence links are local/preview/live and cross-tenant is refused
 *   F23.11 legacy ambiguous runs reconcile conservatively, no fabricated receipt
 *   F23.12 `check` and `checks` BOTH resolve; unknown stages are delivery failures
 *   F23.13 admission runs BEFORE operatorOverride (the ordering test below fails
 *          the moment the call is moved below the bail-out)
 *   F23.14 outbox drain atomicity lives in launch-f23-outbox.test.ts
 *
 * Isolated DB (import _isolated-db FIRST). No network, no secrets.
 */
import './_isolated-db';
process.env.DISABLE_QC_AUTO_SCORER = '1';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { getDb, run } from '@/lib/db';
import {
  LAUNCH_STAGE_VOCABULARY_VERSION,
  getLaunchAbility,
  isLaunchStage,
  launchStageVocabulary,
} from '@/lib/launch-abilities';
import { validateLaunchRunEvent } from '@/lib/launch-run-events';
import { ingestLaunchRunEvent, ensureLaunchSchema, getLaunchRun } from '@/lib/launch-ability-runs';
import { handleLaunchIngest, launchInstallationId } from '@/lib/launch-transport';
import {
  bindLaunchRunIdentity,
  bindLaunchTask,
  classifyEvidenceLink,
  completionIsCurrent,
  deriveInvalidationEvents,
  ensureLaunchDomainSchema,
  evaluateCardCompletion,
  isGovernedLaunchCard,
  launchAdmissionForTransition,
  practicalLaunchState,
  projectCanonicalProgress,
  projectReportOverall,
  reconcileLegacyRun,
  recordInvalidationEvents,
  requiredScopeFor,
  subtaskCompletionClosesParent,
  verifyStageClose,
  type CanonicalUnitEvidence,
} from '@/lib/launch-domain';
import { transition, TransitionError } from '@/lib/task-lifecycle';

const HASH_A = createHash('sha256').update('f23-artifact-a').digest('hex');
const HASH_B = createHash('sha256').update('f23-artifact-b').digest('hex');
const PLAN_HASH = `sha256:${'a'.repeat(64)}`;
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const LAUNCH_ID = 'f23-launch-2026-11';
const TENANT = 'tenant-f23';
const WORKSPACE = 'launch';
const INSTALL = 'f23-installation';
const EID = '44444444-4444-4444-8444-444444444444';

let taskId: string;
let boundTaskId: string;
let runTaskId: string;
let agentId: string;

function nowIso(): string {
  return new Date().toISOString();
}

function seedTask(id: string, source: string, department: string): void {
  getDb().prepare(
    `INSERT INTO tasks (id, title, status, priority, assigned_agent_id, workspace_id, department, source)
     VALUES (?, ?, 'in_progress', 'high', ?, ?, ?, ?)`,
  ).run(id, `F23 ${id}`, agentId, WORKSPACE, department, source);
}

beforeAll(() => {
  ensureLaunchSchema();
  ensureLaunchDomainSchema();
  const db = getDb();
  if (!db.prepare('SELECT id FROM companies WHERE id = ?').get('default')) {
    db.prepare('INSERT INTO companies (id, name, slug) VALUES (?, ?, ?)')
      .run('default', 'Default Company', 'default');
  }
  if (!db.prepare('SELECT id FROM workspaces WHERE id = ?').get(WORKSPACE)) {
    db.prepare('INSERT INTO workspaces (id, name, slug, icon, sort_order) VALUES (?,?,?,?,?)')
      .run(WORKSPACE, 'Launch', 'launch', 'Rocket', 20);
  }
  agentId = '00000000-0000-4000-8000-0000000f2323';
  db.prepare(`INSERT INTO agents (id, name, role, status, workspace_id) VALUES (?, ?, ?, ?, ?)`)
    .run(agentId, 'F23 Builder', 'builder', 'working', WORKSPACE);

  taskId = `f23-unbound-${Date.now()}`;
  boundTaskId = `f23-bound-${Date.now()}`;
  runTaskId = `f23-run-${Date.now()}`;
  seedTask(taskId, 'signature-funnel', 'launch');
  seedTask(boundTaskId, 'signature-funnel', 'launch');
  seedTask(runTaskId, 'signature-funnel', 'launch');

  // FIX 25 evidence control: a reachable url deliverable, so the transition
  // reaches the launch gate instead of failing on the generic evidence gate.
  db.prepare(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path)
     VALUES (?, ?, 'url', 'Decision link', 'https://example.com/f23')`,
  ).run(`f23-url-${Date.now()}`, taskId);

  // Bound page card with a verified launch artifact.
  bindLaunchRunIdentity({
    runId: RUN_ID,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    installationId: INSTALL,
    skill: 49,
    launchId: LAUNCH_ID,
    planRevision: 1,
    planHash: PLAN_HASH,
  });
  run(
    `INSERT INTO launch_runs (run_id, skill, ability_slug, launch_id, client_slug, host_shape,
       installation_id, overall, started_at, last_event_at, created_at, updated_at)
     VALUES (?, 49, 'signature-funnel', ?, 'client-f23', 'fleet-mac', ?, 'incomplete', ?, ?, ?, ?)`,
    [RUN_ID, LAUNCH_ID, INSTALL, nowIso(), nowIso(), nowIso(), nowIso()],
  );
  run(
    `INSERT INTO launch_run_stages
       (run_id, stage, status, receipt_status, closed_at, artifact_hashes_json, updated_at)
     VALUES (?, 'page_results', 'closed', 'pass', ?, ?, ?)`,
    [RUN_ID, nowIso(), JSON.stringify({ page: HASH_A }), nowIso()],
  );
  bindLaunchTask({
    taskId: boundTaskId,
    launchId: LAUNCH_ID,
    runId: RUN_ID,
    cardLevel: 'page',
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    installationId: INSTALL,
  });
  const pageFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'f23-page-')),
    'landing.html',
  );
  fs.writeFileSync(pageFile, '<html>F23 landing page</html>', 'utf8');
  db.prepare(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, sha256)
     VALUES (?, ?, 'artifact', 'Landing page', ?, ?)`,
  ).run(`f23-page-${Date.now()}`, boundTaskId, pageFile, HASH_A);
});

afterAll(() => {
  const db = getDb();
  for (const id of [taskId, boundTaskId, runTaskId]) {
    db.prepare('DELETE FROM task_deliverables WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM task_events WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM events WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM launch_task_bindings WHERE task_id = ?').run(id);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }
  db.prepare('DELETE FROM launch_run_stages WHERE run_id = ?').run(RUN_ID);
  db.prepare('DELETE FROM launch_run_identity WHERE run_id = ?').run(RUN_ID);
  db.prepare('DELETE FROM launch_runs WHERE run_id = ?').run(RUN_ID);
  db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
});

// ---------------------------------------------------------------------------
describe('F23.1 / F23.12 — registration and the versioned stage vocabulary', () => {
  it('registers the governed launch abilities and a versioned vocabulary', () => {
    expect(getLaunchAbility(49)?.slug).toBe('signature-funnel');
    expect(LAUNCH_STAGE_VOCABULARY_VERSION).toBeGreaterThan(1);
    const rows = launchStageVocabulary();
    expect(rows.some((r) => r.skill === 83 && r.stage === 'checks' && r.alias_of === null)).toBe(true);
    expect(rows.some((r) => r.skill === 83 && r.stage === 'check' && r.alias_of === 'checks')).toBe(true);
  });

  it('BOTH `check` and `checks` resolve for Skill 83; an unknown stage stays visible', () => {
    const ability = getLaunchAbility(83)!;
    expect(isLaunchStage(ability, 'checks')).toBe(true);
    // The live producer spelling (launcher_core/cmd_check writes `check`).
    expect(isLaunchStage(ability, 'check')).toBe(true);

    const aliasEvent = validateLaunchRunEvent({
      skill: 83,
      launch_id: LAUNCH_ID,
      event_id: EID,
      run_id: RUN_ID,
      event_type: 'stage_closed',
      schema_version: '1.0',
      emitted_at: '2026-11-01T12:00:00.000Z',
      stage: 'check',
      receipt_status: 'pass',
      closed_at: '2026-11-01T12:00:00.000Z',
      artifact_hashes: { package: HASH_A },
    });
    expect(aliasEvent.ok).toBe(true);
    if (aliasEvent.ok) expect(aliasEvent.event.stage).toBe('checks');

    const unknown = validateLaunchRunEvent({
      skill: 83,
      launch_id: LAUNCH_ID,
      event_id: EID,
      run_id: RUN_ID,
      event_type: 'stage_closed',
      schema_version: '1.0',
      emitted_at: '2026-11-01T12:00:00.000Z',
      stage: 'not_a_stage',
      receipt_status: 'pass',
      closed_at: '2026-11-01T12:00:00.000Z',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.codes).toContain('unknown_stage');
  });

  it('reports a rejected stage as a DELIVERY FAILURE, not a successful sync', () => {
    run(`CREATE TABLE IF NOT EXISTS skill71_ingest_tokens (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          client_slug TEXT NOT NULL, host_shape TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')), revoked_at TEXT)`);
    const token = 'synthetic-f23-token-not-a-credential';
    run(
      `INSERT OR IGNORE INTO skill71_ingest_tokens (id, token_hash, client_slug, host_shape)
       VALUES (?, ?, ?, ?)`,
      ['tok-f23', createHash('sha256').update(token).digest('hex'), 'client-f23', 'fleet-mac'],
    );
    const response = handleLaunchIngest({
      authorization: `Bearer ${token}`,
      body: JSON.stringify({
        events: [{
          skill: 83,
          launch_id: LAUNCH_ID,
          installation_id: launchInstallationId(),
          event_id: EID,
          run_id: RUN_ID,
          event_type: 'stage_closed',
          schema_version: '1.0',
          emitted_at: '2026-11-01T12:00:00.000Z',
          stage: 'not_a_stage',
          receipt_status: 'pass',
          closed_at: '2026-11-01T12:00:00.000Z',
        }],
      }),
    });
    expect(response.payload.accepted).toBe(0);
    expect(response.payload.rejected).toBe(1);
    expect(response.payload.delivery_failures).toHaveLength(1);
    expect(response.payload.delivery_failures[0].codes).toContain('unknown_stage');
  });
});

// ---------------------------------------------------------------------------
describe('F23.2 — run identity is immutable', () => {
  it('binds once and returns unchanged for the same tuple', () => {
    const identity = {
      runId: '55555555-5555-4555-8555-555555555555',
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      installationId: INSTALL,
      skill: 49,
      launchId: LAUNCH_ID,
      planRevision: 1,
      planHash: PLAN_HASH,
    };
    expect(bindLaunchRunIdentity(identity).status).toBe('bound');
    expect(bindLaunchRunIdentity(identity).status).toBe('unchanged');
  });

  it('rejects a mismatch on any identity field and never overwrites the stored row', () => {
    const identity = {
      runId: RUN_ID,
      tenantId: TENANT,
      workspaceId: WORKSPACE,
      installationId: INSTALL,
      skill: 49,
      launchId: LAUNCH_ID,
      planRevision: 1,
      planHash: PLAN_HASH,
    };
    const mismatch = bindLaunchRunIdentity({ ...identity, tenantId: 'other-tenant' });
    expect(mismatch.status).toBe('rejected');
    if (mismatch.status === 'rejected') {
      expect(mismatch.mismatches.map((m) => m.field)).toContain('tenant_id');
    }
    // The stored row is untouched.
    const stored = bindLaunchRunIdentity(identity);
    expect(stored.status).toBe('unchanged');
  });

  it('rejects an ingest that rebinds a run to another skill', () => {
    const ability49 = getLaunchAbility(49)!;
    const ability50 = getLaunchAbility(50)!;
    const event = {
      skill: 49,
      launch_id: 'f23-rebind-2026-11',
      event_id: '66666666-6666-4666-8666-666666666666',
      run_id: '77777777-7777-4777-8777-777777777777',
      event_type: 'run_initialized' as const,
      schema_version: '1.0',
      emitted_at: '2026-11-01T12:00:00.000Z',
      host_shape: 'fleet-mac' as const,
    };
    ingestLaunchRunEvent(event, ability49, { source: 'test', installation_id: INSTALL });
    expect(() =>
      ingestLaunchRunEvent({ ...event, event_id: '88888888-8888-4888-8888-888888888888' }, ability50, {
        source: 'test',
        installation_id: INSTALL,
      }),
    ).toThrow(/already bound to skill 49/);
  });
});

// ---------------------------------------------------------------------------
describe('F23.3 / F23.4 — canonical projection, never the producer report', () => {
  const units: CanonicalUnitEvidence[] = [
    { id: 'page_a', kind: 'page', required: true, state: 'complete' },
    { id: 'page_b', kind: 'page', required: true, state: 'pending' },
    { id: 'email_a', kind: 'email', required: true, state: 'dropped' },
  ];

  it('ignores an agent-supplied `complete` when a unit is still pending', () => {
    expect(projectReportOverall({ units, reportedOverall: 'complete' })).toBe('incomplete');
    expect(projectReportOverall({ units: units.map((u) => ({ ...u, state: 'complete' as const })) })).toBe('complete');
  });

  it('never counts dropped or unknown units as delivered; stage percentage is separate', () => {
    const projection = projectCanonicalProgress(units, 40);
    expect(projection.totalUnits).toBe(3);
    expect(projection.doneUnits).toBe(1);
    expect(projection.droppedUnits).toBe(1);
    expect(projection.complete).toBe(false);
    expect(projection.stagePercentage).toBe(40);
    expect(projection.stagePercentageLabel).toMatch(/stages, not units/);
    const empty = projectCanonicalProgress([]);
    expect(empty.percentage).toBe(0);
    expect(empty.complete).toBe(false);
  });

  it('accepts a closed stage only with a pass receipt AND verified artifact hashes', () => {
    const good = verifyStageClose({
      receiptStatus: 'pass',
      artifactHashes: { page: HASH_A },
      verifiedArtifactHashes: [HASH_A],
      closedAt: '2026-11-01T12:00:00.000Z',
      now: Date.parse('2026-11-02T12:00:00.000Z'),
    });
    expect(good.ok).toBe(true);

    const unverified = verifyStageClose({
      receiptStatus: 'pass',
      artifactHashes: { page: HASH_B },
      verifiedArtifactHashes: [HASH_A],
      closedAt: '2026-11-01T12:00:00.000Z',
    });
    expect(unverified.ok).toBe(false);
    expect(unverified.errors.join(' ')).toMatch(/not registered against this card/);

    const noReceipt = verifyStageClose({
      receiptStatus: 'not_authorized',
      artifactHashes: { page: HASH_A },
      verifiedArtifactHashes: [HASH_A],
      closedAt: '2026-11-01T12:00:00.000Z',
    });
    expect(noReceipt.ok).toBe(false);
  });

  it('a report_generated event cannot mark an incomplete run complete', () => {
    const ability = getLaunchAbility(49)!;
    const runId = '99999999-9999-4999-8999-999999999999';
    ingestLaunchRunEvent({
      skill: 49,
      launch_id: 'f23-report-2026-11',
      event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      run_id: runId,
      event_type: 'run_initialized',
      schema_version: '1.0',
      emitted_at: '2026-11-01T12:00:00.000Z',
      host_shape: 'fleet-mac',
    }, ability, { source: 'test', installation_id: INSTALL });
    ingestLaunchRunEvent({
      skill: 49,
      launch_id: 'f23-report-2026-11',
      event_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      run_id: runId,
      event_type: 'report_generated',
      schema_version: '1.0',
      emitted_at: '2026-11-01T12:05:00.000Z',
      overall: 'complete',
      review_mode: 'INDEPENDENT',
      report_json_path: '/tmp/report.json',
    }, ability, { source: 'test', installation_id: INSTALL });
    expect(getLaunchRun(runId)?.run.overall).toBe('incomplete');
  });
});

// ---------------------------------------------------------------------------
describe('F23.5 — explicit invalidation / revision events', () => {
  it('mints one event per changed artifact, revoked approval and superseded artifact', () => {
    const events = deriveInvalidationEvents({
      launchId: LAUNCH_ID,
      runId: RUN_ID,
      previousUnits: [{ id: 'page_a', kind: 'page', required: true, state: 'complete', artifactHash: HASH_A }],
      currentUnits: [{ id: 'page_a', kind: 'page', required: true, state: 'complete', artifactHash: HASH_B }],
      approvalsBefore: [{ approvalId: 'ap-1', revoked: false }],
      approvalsAfter: [{ approvalId: 'ap-1', revoked: true }],
      artifactsBefore: [HASH_A, HASH_B],
      artifactsAfter: [HASH_B],
    });
    expect(events.map((e) => e.kind).sort()).toEqual([
      'approval_revoked',
      'artifact_superseded',
      'evidence_changed',
    ]);
  });

  it('records history and makes a completion after the change not current', () => {
    const invalidationLaunch = 'f23-invalidation-2026-11';
    const closeAt = '2020-01-01T00:00:00.000Z';
    expect(completionIsCurrent(invalidationLaunch, closeAt)).toBe(true);
    recordInvalidationEvents([{
      kind: 'evidence_changed',
      launchId: invalidationLaunch,
      runId: RUN_ID,
      subject: 'page_a',
      previousState: HASH_A,
      newState: 'stale',
      reason: 'artifact hash changed',
    }]);
    expect(completionIsCurrent(invalidationLaunch, closeAt)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('F23.6 / F23.13 — governed launch admission, before any override', () => {
  it('refuses review on a governed card with no launch binding, even with operatorOverride', async () => {
    await expect(
      transition(taskId, 'review', { actor: agentId, operatorOverride: true }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_LAUNCH_EVIDENCE' });
    // The card did not move: admission is a gate, not a warning.
    const row = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('in_progress');
  });

  it('allows a bound page card whose launch artifact is verified', async () => {
    const verdict = launchAdmissionForTransition(
      { id: boundTaskId, source: 'signature-funnel', department: 'launch', status: 'in_progress' },
      'review',
    );
    expect(verdict.governed).toBe(true);
    expect(verdict.reason).toBe('');
    expect(verdict.allow).toBe(true);
    await expect(
      transition(boundTaskId, 'review', { actor: agentId, operatorOverride: true }),
    ).resolves.toBeTruthy();
  });

  it('does not govern unrelated tasks', () => {
    expect(isGovernedLaunchCard({ id: 'x', source: 'funnel', department: 'marketing' })).toBe(false);
    expect(launchAdmissionForTransition({ id: 'x', source: 'funnel', department: 'marketing', status: 'in_progress' }, 'done').allow).toBe(true);
  });

  it('the same-status shortcut cannot preserve stale completion', async () => {
    // Move the bound card to done through the real gate, then invalidate its
    // governing evidence and ask for done again (a no-op on the parent).
    getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(boundTaskId);
    recordInvalidationEvents([{
      kind: 'evidence_changed',
      launchId: LAUNCH_ID,
      runId: RUN_ID,
      subject: 'page',
      previousState: HASH_A,
      newState: 'stale',
      reason: 'artifact changed after completion',
    }]);
    await expect(
      transition(boundTaskId, 'done', { actor: agentId, operatorOverride: true }),
    ).rejects.toMatchObject({ code: 'LAUNCH_COMPLETION_STALE' });
  });
});

// ---------------------------------------------------------------------------
describe('F23.7 — card granularity is explicit', () => {
  it('a wireframe completes as a wireframe; a page does not', () => {
    expect(requiredScopeFor('wireframe').requiredEvidence).toEqual(['wireframe']);
    expect(evaluateCardCompletion({
      level: 'wireframe',
      presentEvidence: ['wireframe'],
      approvedScope: false,
      canonicalInventoryComplete: false,
    }).ok).toBe(true);
    const page = evaluateCardCompletion({
      level: 'page',
      presentEvidence: ['wireframe'],
      approvedScope: false,
      canonicalInventoryComplete: false,
    });
    expect(page.ok).toBe(false);
    expect(page.missing).toContain('page');
  });

  it('an entire launch needs the approved scope and a complete inventory', () => {
    const withoutScope = evaluateCardCompletion({
      level: 'launch',
      presentEvidence: ['approved_launch_scope', 'unit_inventory'],
      approvedScope: false,
      canonicalInventoryComplete: true,
    });
    expect(withoutScope.ok).toBe(false);
    expect(withoutScope.missing).toContain('approved_scope');
    expect(evaluateCardCompletion({
      level: 'launch',
      presentEvidence: ['approved_launch_scope', 'unit_inventory'],
      approvedScope: true,
      canonicalInventoryComplete: true,
    }).ok).toBe(true);
  });

  it('a completed subtask never closes its parent', () => {
    expect(subtaskCompletionClosesParent().closes).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('F23.8 / F23.9 / F23.11 — states, evidence links, legacy reconciliation', () => {
  it('maps the practical states through the existing workflow', () => {
    expect(practicalLaunchState({ openGates: ['design_choice'] }).state).toBe('awaiting_design_choice');
    expect(practicalLaunchState({ openGates: ['brand'] }).state).toBe('awaiting_brand');
    expect(practicalLaunchState({ openGates: ['wireframes'] }).state).toBe('awaiting_wireframes');
    expect(practicalLaunchState({ awaitingApproval: true }).state).toBe('awaiting_scoped_approval');
    expect(practicalLaunchState({ installedDraft: true }).state).toBe('installed_draft');
    expect(practicalLaunchState({ publishedObserved: true }).state).toBe('published_observed');
    expect(practicalLaunchState({ boardStatus: 'blocked' }).state).toBe('blocked');
    expect(practicalLaunchState({ stale: true }).state).toBe('stale');
    expect(practicalLaunchState({}).state).toBe('incomplete');
  });

  it('labels a local path local, an unverified URL preview, a verified URL live', () => {
    expect(classifyEvidenceLink({ href: '/tmp/deck.pdf' }).kind).toBe('local');
    expect(classifyEvidenceLink({ href: 'file:///tmp/deck.pdf' }).kind).toBe('local');
    expect(classifyEvidenceLink({ href: 'https://example.com/preview' }).kind).toBe('preview');
    expect(classifyEvidenceLink({ href: 'https://example.com/live', verifiedLive: true }).kind).toBe('live');
  });

  it('refuses evidence links across tenants', () => {
    const refused = classifyEvidenceLink({
      href: 'https://example.com/live',
      verifiedLive: true,
      viewerTenantId: 'tenant-b',
      ownerTenantId: 'tenant-a',
    });
    expect(refused.kind).toBe('refused');
    expect(refused.href).toBeNull();
  });

  it('reconciles a complete legacy claim and leaves an ambiguous one unverified', () => {
    const reconciled = reconcileLegacyRun({
      runId: 'legacy-1',
      launchId: LAUNCH_ID,
      planHash: PLAN_HASH,
      status: 'incomplete',
    });
    expect(reconciled.status).toBe('reconciled');
    expect(reconciled.fabricatedReceipt).toBe(false);

    const ambiguous = reconcileLegacyRun({ runId: 'legacy-2', launchId: null, planHash: null });
    expect(ambiguous.status).toBe('unverified');
    expect(ambiguous.fabricatedReceipt).toBe(false);

    const contradictory = reconcileLegacyRun({
      runId: 'legacy-3',
      launchId: LAUNCH_ID,
      planHash: PLAN_HASH,
      status: 'complete',
      overall: 'blocked',
    });
    expect(contradictory.status).toBe('quarantined');
  });
});
