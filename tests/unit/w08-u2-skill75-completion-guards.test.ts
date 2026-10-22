/**
 * S75-W08-U2 (D14) — Skill 75 completion guards at the server boundary.
 *
 * Proves the Command Center refuses campaign completion without the full
 * required evidence set while every supported non-Skill-75 campaign keeps its
 * exact behavior through the typed contract/version:
 *
 *   1. required stage completion (an epic marked done can never complete the
 *      campaign while required child stages are incomplete or failed)
 *   2. revision-bound approvals (a changed/revised artifact invalidates its
 *      approval; every required artifact kind must be approved at its CURRENT
 *      revision)
 *   3. independent reviewer evidence (reviewer may never be the actor)
 *   4. final delivery evidence (registered AND reachable — the existing
 *      completion-evidence reachability check, never disabled)
 *   5. the board's self-reported agent rows reconcile to the native workflow
 *      census (missing census is UNKNOWN, never zero)
 *
 * Runs against a THROWAWAY DB (./_isolated-db must stay the FIRST import).
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
  createAdCampaign,
  moveAdStage,
  getAdCampaign,
  resolveCampaignContract,
  checkSkill75Completion,
  reconcileBoardAgentRows,
  AdCampaignError,
  TransitionError,
} from '../../src/lib/ad-campaigns';
import {
  SKILL75_STAGE_SLUGS,
  SKILL75_REQUIRED_APPROVAL_KINDS,
  parseSkill75Envelope,
  type Skill75ApprovalEnvelope,
} from '../../src/lib/validation';

const DELIV_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-w08u2-deliv-'));

function newJobId(): string {
  return `test-s75w08u2-${uuidv4()}`;
}

function skill75Stages(): Array<{ slug: string; title: string }> {
  return SKILL75_STAGE_SLUGS.map((slug) => ({ slug, title: slug }));
}

function cardId(jobId: string, stageSlug: string): string {
  const card = queryOne<{ id: string }>(
    'SELECT id FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, stageSlug],
  );
  assert.ok(card, `card ${stageSlug} must exist`);
  return card.id;
}

/** Register a REAL, reachable deliverable (the transition evidence gates need it). */
function registerDeliverable(jobId: string, stageSlug: string, title = 'stage artifact'): string {
  const id = cardId(jobId, stageSlug);
  const filePath = path.join(DELIV_DIR, `${jobId}-${stageSlug}-${uuidv4().slice(0, 8)}.txt`);
  fs.writeFileSync(filePath, `deliverable for ${stageSlug}\n`);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'file', ?, ?, ?)`,
    [uuidv4(), id, title, filePath, new Date().toISOString()],
  );
  return filePath;
}

/** Record a typed Skill 75 envelope the way the adapter's events land (metadata). */
function recordEnvelope(jobId: string, stageSlug: string, envelope: object): void {
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata, created_at)
     VALUES (?, ?, NULL, 'comment', ?, ?, ?)`,
    [
      uuidv4(),
      cardId(jobId, stageSlug),
      `skill75 envelope: ${(envelope as { kind: string }).kind}`,
      JSON.stringify(envelope),
      new Date().toISOString(),
    ],
  );
}

function recordCensus(jobId: string, agentsTotal: number, extra: Record<string, unknown> = {}): void {
  recordEnvelope(jobId, 'epic', {
    contract: 'skill75',
    version: 1,
    kind: 'native_census',
    observed_at: new Date().toISOString(),
    counts: { running: 1, queued: 0, waiting: 0, blocked: 0, completed: 2, unfinished: 1 },
    agents_total: agentsTotal,
    ...extra,
  });
}

function recordAgentRow(jobId: string, workflowId: string, agentId: string): void {
  recordEnvelope(jobId, 'epic', {
    contract: 'skill75',
    version: 1,
    kind: 'agent_row',
    workflow_id: workflowId,
    agent_id: agentId,
    role: 'builder',
  });
}

function approval(
  kind: (typeof SKILL75_REQUIRED_APPROVAL_KINDS)[number],
  revision: number,
  decision: 'approved' | 'revised' = 'approved',
): Skill75ApprovalEnvelope {
  return {
    contract: 'skill75',
    version: 1,
    kind: 'approval',
    artifact_kind: kind,
    revision,
    sha256: shaFor(kind, revision),
    decision,
    approver: 'requester-001',
    decided_at: new Date().toISOString(),
  };
}

function shaFor(kind: string, revision: number): string {
  return (kind.length.toString(16).padStart(2, '0') + revision.toString(16).padStart(2, '0'))
    .repeat(16)
    .slice(0, 64);
}

/** Drive ONE stage card backlog → in_progress → review → done (legal path). */
async function driveStageToDone(
  jobId: string,
  slug: string,
  opts: {
    actor?: string;
    reviewer?: string | null;
    evidence?: string | null;
    approval?: Skill75ApprovalEnvelope | null;
    registerDeliverable?: boolean;
  } = {},
): Promise<void> {
  const actor = opts.actor ?? 'builder-bot';
  const evidence = opts.evidence === undefined ? `work landed for ${slug}` : opts.evidence;
  await moveAdStage(jobId, { stage_slug: slug, status: 'in_progress', actor });
  if (opts.registerDeliverable !== false) registerDeliverable(jobId, slug);
  await moveAdStage(jobId, {
    stage_slug: slug,
    status: 'review',
    actor,
    evidence,
    approval: opts.approval ?? null,
  });
  await moveAdStage(jobId, {
    stage_slug: slug,
    status: 'done',
    actor,
    evidence,
    reviewer: opts.reviewer === undefined ? 'qc-bot' : opts.reviewer,
  });
}

/**
 * Drive a whole Skill 75 campaign to the brink of completion: every required
 * stage done (with per-stage evidence + reviewer), approvals for all six
 * required artifact kinds, a final deliverable on the epic, and a reconciled
 * native census. Returns the job id; the caller closes the epic.
 */
async function driveSkill75ToBrink(
  jobId: string,
  opts: {
    approvals?: boolean;
    census?: boolean;
    epicDeliverable?: boolean;
    stageActor?: string;
    stageReviewer?: string | null;
  } = {},
): Promise<void> {
  createAdCampaign({ job_id: jobId, show_name: 'W08-U2 Show', stages: skill75Stages() });

  // Six of the twelve stage moves carry the six required approval decisions.
  const approvalKinds = [...SKILL75_REQUIRED_APPROVAL_KINDS];
  let kindIdx = 0;
  for (const slug of SKILL75_STAGE_SLUGS) {
    const withApproval = opts.approvals !== false && kindIdx < approvalKinds.length;
    await driveStageToDone(jobId, slug, {
      approval: withApproval ? approval(approvalKinds[kindIdx], 1) : null,
      actor: opts.stageActor,
      reviewer: opts.stageReviewer === undefined ? 'qc-bot' : opts.stageReviewer,
    });
    if (withApproval) kindIdx += 1;
  }

  if (opts.epicDeliverable !== false) registerDeliverable(jobId, 'epic', 'final production');
  if (opts.census !== false) {
    recordAgentRow(jobId, 'wf-001', 'agent-01');
    recordAgentRow(jobId, 'wf-001', 'agent-02');
    recordCensus(jobId, 2);
  }
}

/** epic backlog → in_progress → review (deliverable required by the FIX 25 gate). */
async function openEpic(jobId: string, opts: { deliverable?: boolean; evidence?: string } = {}): Promise<void> {
  await moveAdStage(jobId, { stage_slug: 'epic', status: 'in_progress', actor: 'builder-bot' });
  if (opts.deliverable !== false) registerDeliverable(jobId, 'epic', 'final production');
  await moveAdStage(jobId, {
    stage_slug: 'epic',
    status: 'review',
    actor: 'builder-bot',
    evidence: opts.evidence ?? 'final assembly landed',
    reviewer: 'qc-bot',
  });
}

async function expectCompletionRefusal(
  jobId: string,
  needle: string,
  code = 'SKILL75_COMPLETION_INCOMPLETE',
): Promise<void> {
  await assert.rejects(
    () =>
      moveAdStage(jobId, {
        stage_slug: 'epic',
        status: 'done',
        actor: 'builder-bot',
        reviewer: 'qc-bot',
        evidence: 'final delivery recorded',
      }),
    (err: unknown) => {
      assert.ok(err instanceof AdCampaignError, `expected AdCampaignError, got ${String(err)}`);
      assert.equal(err.status, 422);
      assert.equal(err.code, code);
      assert.ok(err.message.includes(needle), `message must name "${needle}": ${err.message}`);
      return true;
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Typed contract/version resolution
// ─────────────────────────────────────────────────────────────────────────────

test('explicit skill75 contract persists its marker and resolves as skill75', () => {
  const jobId = newJobId();
  createAdCampaign({
    job_id: jobId,
    show_name: 'Explicit Contract Show',
    contract: { kind: 'skill75', version: 1 },
    stages: [{ slug: 'a', title: 'A' }, { slug: 'b', title: 'B' }],
  });
  const campaign = queryOne<{ description: string }>('SELECT description FROM campaigns WHERE id = ?', [jobId]);
  assert.ok(campaign!.description.includes('contract=skill75 v1'), 'marker persisted');
  const resolved = resolveCampaignContract(jobId);
  assert.equal(resolved.contract.kind, 'skill75');
  assert.equal(resolved.markerError, undefined);
});

test('canonical 12-stage set infers skill75; every other stage set stays legacy', () => {
  const inferred = newJobId();
  createAdCampaign({ job_id: inferred, show_name: 'Inferred Show', stages: skill75Stages() });
  assert.equal(resolveCampaignContract(inferred).contract.kind, 'skill75');

  const legacy = newJobId();
  createAdCampaign({ job_id: legacy, show_name: 'Skill 48 Show' });
  assert.equal(resolveCampaignContract(legacy).contract.kind, 'legacy');

  const explicitLegacy = newJobId();
  createAdCampaign({
    job_id: explicitLegacy,
    show_name: 'Legacy Over Canonical',
    contract: { kind: 'legacy', version: 1 },
    stages: skill75Stages(),
  });
  assert.equal(resolveCampaignContract(explicitLegacy).contract.kind, 'legacy', 'explicit legacy wins');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Non-Skill-75 behavior preserved (the regression that must NOT change)
// ─────────────────────────────────────────────────────────────────────────────

test('legacy campaign: epic done still completes without Skill 75 evidence', async () => {
  const jobId = newJobId();
  createAdCampaign({ job_id: jobId, show_name: 'Legacy Behavior Show' });

  await moveAdStage(jobId, { stage_slug: 's7-deliver', status: 'in_progress' });
  registerDeliverable(jobId, 's7-deliver');
  await moveAdStage(jobId, { stage_slug: 's7-deliver', status: 'review' });
  await moveAdStage(jobId, { stage_slug: 's7-deliver', status: 'done' });

  // Children mostly incomplete, NO approvals, NO reviewer, NO census — and the
  // epic can still complete the campaign exactly as before D14.
  registerDeliverable(jobId, 'epic');
  await moveAdStage(jobId, { stage_slug: 'epic', status: 'in_progress' });
  await moveAdStage(jobId, { stage_slug: 'epic', status: 'review' });
  await moveAdStage(jobId, { stage_slug: 'epic', status: 'done' });

  const { campaign } = getAdCampaign(jobId);
  assert.equal((campaign as { status: string }).status, 'complete');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Completion refusals (each evidence class, named in the refusal)
// ─────────────────────────────────────────────────────────────────────────────

test('skill75 epic done is refused while required child stages are incomplete or failed', async () => {
  const jobId = newJobId();
  await driveSkill75ToBrink(jobId);
  // Re-open one stage: the run now has an incomplete required child.
  await moveAdStage(jobId, { stage_slug: 'music', status: 'backlog', actor: 'qc-bot' });

  await openEpic(jobId, { deliverable: false });
  await expectCompletionRefusal(jobId, 'required stage(s) incomplete or failed: music=backlog');

  // The campaign row must NOT be complete while children are incomplete.
  const { campaign } = getAdCampaign(jobId);
  assert.notEqual((campaign as { status: string }).status, 'complete');
});

test('skill75 completion is refused without revision-bound approvals for every required kind', async () => {
  const jobId = newJobId();
  await driveSkill75ToBrink(jobId, { approvals: false });
  await openEpic(jobId, { deliverable: false });

  // checkSkill75Completion names every missing kind; the move refusal carries them.
  const report = checkSkill75Completion(jobId, { actor: 'builder-bot', reviewer: 'qc-bot' });
  assert.equal(report.ok, false);
  for (const kind of SKILL75_REQUIRED_APPROVAL_KINDS) {
    assert.ok(
      report.missing.some((m) => m.includes(`revision-bound approval missing for artifact kind '${kind}'`)),
      `must name missing approval for ${kind}`,
    );
  }
  await expectCompletionRefusal(jobId, "revision-bound approval missing for artifact kind 'script'");
});

test('a changed artifact invalidates its approval (approval must cover the CURRENT revision)', async () => {
  const jobId = newJobId();
  await driveSkill75ToBrink(jobId, { approvals: false });

  // All six approved at revision 1…
  for (const kind of SKILL75_REQUIRED_APPROVAL_KINDS) {
    recordEnvelope(jobId, 'epic', approval(kind, 1, 'approved'));
  }
  // …then music is revised to revision 2: the rev-1 approval no longer binds.
  recordEnvelope(jobId, 'epic', approval('music', 2, 'revised'));

  await openEpic(jobId, { deliverable: false });
  await expectCompletionRefusal(jobId, "artifact 'music' revision 2 is 'revised', not approved");

  // Approving the CURRENT revision clears exactly that refusal.
  recordEnvelope(jobId, 'epic', approval('music', 2, 'approved'));
  const report = checkSkill75Completion(jobId, { actor: 'builder-bot', reviewer: 'qc-bot' });
  assert.equal(
    report.missing.some((m) => m.includes("artifact 'music'")),
    false,
    'music rev 2 approved — the stale-approval refusal is gone',
  );
});

test('self-approval is rejected at the completion boundary and never counts as reviewer evidence', async () => {
  const jobId = newJobId();
  // Every stage done SELF-APPROVED (reviewer === actor) — mirroring the
  // producer's client-side SelfApprovalError, now enforced server-side at the
  // only claim that matters: the campaign completion.
  await driveSkill75ToBrink(jobId, { stageActor: 'builder-bot', stageReviewer: 'builder-bot' });

  const report = checkSkill75Completion(jobId, { actor: 'builder-bot', reviewer: 'Builder-Bot' });
  assert.ok(
    report.missing.some((m) => m.includes('actor may not approve own done (self-approval rejected)')),
    `self-approval named in the refusal: ${report.missing.join(' | ')}`,
  );
  assert.ok(
    report.missing.some((m) => m.includes('independent reviewer evidence missing')),
    'a self-approved run never carries independent reviewer evidence',
  );

  await openEpic(jobId, { deliverable: false });
  // The COMPLETING move itself is self-approved → refused, named.
  await assert.rejects(
    () =>
      moveAdStage(jobId, {
        stage_slug: 'epic',
        status: 'done',
        actor: 'builder-bot',
        reviewer: 'Builder-Bot',
        evidence: 'final delivery recorded',
      }),
    (err: unknown) => {
      assert.ok(err instanceof AdCampaignError);
      assert.equal(err.code, 'SKILL75_COMPLETION_INCOMPLETE');
      assert.ok(err.message.includes('actor may not approve own done'));
      return true;
    },
  );

  // An INDEPENDENT completing reviewer clears both reviewer refusals.
  const ok = checkSkill75Completion(jobId, { actor: 'builder-bot', reviewer: 'qc-bot' });
  assert.equal(
    ok.missing.some((m) => m.includes('reviewer') || m.includes('self-approval')),
    false,
    `independent reviewer satisfies the contract: ${ok.missing.join(' | ')}`,
  );
});

test('final delivery evidence must be registered and reachable — the reachability gate stays ON', async () => {
  // (a) The contract check itself names the missing final delivery evidence.
  const bare = newJobId();
  await driveSkill75ToBrink(bare, { epicDeliverable: false });
  const report = checkSkill75Completion(bare, { actor: 'builder-bot', reviewer: 'qc-bot' });
  assert.ok(report.missing.some((m) => m.includes('final delivery evidence missing or unreachable')));

  // (b) The EXISTING reachability gate (completion-evidence.ts, T0-01) is never
  //     disabled: an epic whose registered deliverable becomes unreachable is
  //     refused at the done transition itself, and the campaign stays open.
  const jobId = newJobId();
  await driveSkill75ToBrink(jobId, { epicDeliverable: false });
  await openEpic(jobId); // registers THE epic deliverable, then moves it to review
  const row = queryOne<{ path: string }>(
    `SELECT d.path FROM task_deliverables d JOIN tasks t ON t.id = d.task_id
      WHERE t.campaign_id = ? AND t.stage_slug = 'epic'`,
    [jobId],
  );
  assert.ok(row, 'epic deliverable row exists');
  fs.rmSync(row.path, { force: true });

  await assert.rejects(
    () =>
      moveAdStage(jobId, {
        stage_slug: 'epic',
        status: 'done',
        actor: 'builder-bot',
        reviewer: 'qc-bot',
        evidence: 'final delivery recorded',
      }),
    (err: unknown) => err instanceof TransitionError && err.code === 'PRECONDITION_EVIDENCE',
  );
  const { campaign } = getAdCampaign(jobId);
  assert.notEqual((campaign as { status: string }).status, 'complete');
});

test('replay-safe: re-sending epic done completes the campaign once the evidence lands', async () => {
  const jobId = newJobId();
  await driveSkill75ToBrink(jobId, { approvals: false });
  await openEpic(jobId, { deliverable: false });

  await expectCompletionRefusal(jobId, 'revision-bound approval missing');

  // The missing approvals arrive (recorded as durable evidence — no manual
  // database edits, the board is never the only copy)…
  for (const kind of SKILL75_REQUIRED_APPROVAL_KINDS) {
    recordEnvelope(jobId, 'epic', approval(kind, 1, 'approved'));
  }

  // …and the IDENTICAL completing move replays: the same-state transition is a
  // no-op, the completion gate re-runs, and the campaign completes.
  const done = await moveAdStage(jobId, {
    stage_slug: 'epic',
    status: 'done',
    actor: 'builder-bot',
    reviewer: 'qc-bot',
    evidence: 'final delivery recorded',
  });
  assert.equal(done.status, 'done');
  const { campaign } = getAdCampaign(jobId);
  assert.equal((campaign as { status: string }).status, 'complete');
});

test('board counts reconcile to the native workflow census — unknown is NOT zero', async () => {
  const jobId = newJobId();
  await driveSkill75ToBrink(jobId, { census: false });

  // Self-reported rows exist, no native census: UNKNOWN, and never a zero claim.
  recordAgentRow(jobId, 'wf-001', 'agent-01');
  recordAgentRow(jobId, 'wf-001', 'agent-02');
  const unknown = reconcileBoardAgentRows(jobId);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.boardAgentRows, 2, 'raw self-reported rows reported');
  assert.equal(unknown.native, null);
  assert.ok(unknown.differences.some((d) => d.includes('unknown, not zero')));

  await openEpic(jobId, { deliverable: false });
  await expectCompletionRefusal(jobId, 'native workflow census unknown');

  // Mismatch: board claims 2 agents, native census says 1 — refused with both
  // raw numbers (never clamped).
  recordCensus(jobId, 1);
  const mismatch = reconcileBoardAgentRows(jobId);
  assert.equal(mismatch.status, 'mismatch');
  assert.ok(mismatch.differences.some((d) => d.includes('board self-reported agent rows: 2') && d.includes('agents_total: 1')));
  await expectCompletionRefusal(jobId, 'board/native counts disagree');

  // Agreement: census reports the same raw count — reconciled.
  recordCensus(jobId, 2);
  const ok = reconcileBoardAgentRows(jobId);
  assert.equal(ok.status, 'reconciled');
  assert.equal(ok.boardAgentRows, 2);
  assert.equal(ok.native!.agents_total, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Fail-closed edges
// ─────────────────────────────────────────────────────────────────────────────

test('a malformed contract marker refuses completion instead of downgrading to legacy', async () => {
  const jobId = newJobId();
  await driveSkill75ToBrink(jobId);
  await openEpic(jobId, { deliverable: false });

  run('UPDATE campaigns SET description = description || ? WHERE id = ?', [
    '\ncontract=skill75 vX',
    jobId,
  ]);
  await expectCompletionRefusal(jobId, 'unparseable contract marker', 'CONTRACT_MARKER_INVALID');
});

test('malformed evidence metadata reads as MISSING evidence (parseSkill75Envelope is fail-closed)', () => {
  assert.equal(parseSkill75Envelope('not json at all'), null);
  assert.equal(parseSkill75Envelope('{"contract":"skill75","version":1,"kind":"approval"}'), null, 'incomplete envelope rejected');
  assert.equal(parseSkill75Envelope({ contract: 'other', version: 1, kind: 'approval' }), null, 'foreign contract rejected');
  const ok = parseSkill75Envelope(JSON.stringify(approval('script', 1)));
  assert.ok(ok && ok.kind === 'approval');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The happy path: full evidence completes the campaign
// ─────────────────────────────────────────────────────────────────────────────

test('skill75 campaign completes ONLY with the full evidence set present', async () => {
  const jobId = newJobId();
  await driveSkill75ToBrink(jobId);
  await openEpic(jobId, { deliverable: false });

  const before = checkSkill75Completion(jobId, { actor: 'builder-bot', reviewer: 'qc-bot' });
  assert.equal(before.ok, true, `expected a clean report, got: ${before.missing.join(' | ')}`);

  await moveAdStage(jobId, {
    stage_slug: 'epic',
    status: 'done',
    actor: 'builder-bot',
    reviewer: 'qc-bot',
    evidence: 'final production delivered and receipted',
  });

  const { campaign } = getAdCampaign(jobId);
  assert.equal((campaign as { status: string }).status, 'complete');

  // The decision is durably recorded on the run, not only on the board row.
  const reviews = queryAll<{ metadata: string | null }>(
    `SELECT ta.metadata FROM task_activities ta JOIN tasks t ON t.id = ta.task_id
      WHERE t.campaign_id = ? AND ta.metadata IS NOT NULL`,
    [jobId],
  );
  const kinds = new Set(
    reviews
      .map((r) => parseSkill75Envelope(r.metadata))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => e.kind),
  );
  assert.ok(kinds.has('approval'), 'approval decisions durably recorded');
  assert.ok(kinds.has('review'), 'independent review durably recorded');
  assert.ok(kinds.has('native_census'), 'native census durably recorded');
  assert.ok(kinds.has('agent_row'), 'self-reported rows durably recorded (reconciled, never proof)');
});
