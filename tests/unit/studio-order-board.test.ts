/**
 * studio-order-board.test.ts — the board contract for a DRAMA STUDIO order.
 *
 * SPEC §6: a studio run reaches the board through the one door that already
 * exists — `cc_sync.py` → POST /api/ad-campaigns + PATCH …/[id], i.e.
 * createAdCampaign / moveAdStage. The Command Center needs no new code; what it
 * needed was this pin. Without a test, a future board change can silently break
 * studio runs and nothing fails until a client's order stops moving.
 *
 * The board contract this suite pins (SPEC §6):
 *   - the campaign is created with skill 75's OWN 12 stage slugs
 *     (batch_mode/batch.py STAGES) — never a new list, never the Skill 48
 *     7-stage default;
 *   - a stage card walks backlog → in_progress → review → done;
 *   - an approval wait parks the card on `blocked` with
 *     blocked_reason=approval, blocked_on_human=owner, ask=<the question>, and
 *     leaving blocked clears those columns;
 *   - a `url` deliverable is registered on the card BEFORE review (the FIX 25
 *   evidence gate refuses review — and done — without it);
 *   - the epic card walks in_progress → review → done, and epic-done flips the
 *     campaign row to `complete` ONLY with the Skill 75 completion evidence set
 *     (D14 — see the closing test).
 *
 * Throwaway DB — enforced HERE, in the file itself, exactly as
 * ad-campaigns.test.ts does (see its C8 note): `_isolated-db` MUST stay the
 * FIRST import, because ES imports are hoisted and evaluated in order, so
 * anything that pulls in '@/lib/db' first would freeze DATABASE_PATH from the
 * un-isolated env. tests/unit/c8-db-isolation-guard.test.ts fails the build if
 * this regresses. Never point this at mission-control.db.
 *
 * No src/ change in the unit that wrote this pin. One pin WAS updated later by
 * S75-W08-U2 (D14): the old closing test asserted "epic done completes the run"
 * with every child stage still in backlog — which the repair spec names as the
 * defect ("an epic marked done can never complete the campaign while required
 * child stages are incomplete or failed"). The closing test now pins the
 * repaired contract instead; everything else here is byte-for-byte the
 * original pin.
 */

import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { queryAll, queryOne, run } from '../../src/lib/db';
import {
  createAdCampaign,
  moveAdStage,
  getAdCampaign,
  AdCampaignError,
  TransitionError,
} from '../../src/lib/ad-campaigns';
import { CreateAdCampaignSchema, UpdateAdCampaignStageSchema } from '../../src/lib/validation';

/**
 * Skill 75's stage board, transcribed verbatim from
 * openclaw-onboarding `75-drama-song-ad-factory/scripts/core/batch_mode/batch.py`
 * STAGES (plan 10.3 board). This is the list a studio order sends; the contract
 * is that the Command Center accepts it unchanged.
 */
const STUDIO_STAGES: Array<{ slug: string; title: string }> = [
  { slug: 'research', title: 'Research' },
  { slug: 'creative-strategy', title: 'Creative Strategy' },
  { slug: 'script-lyrics', title: 'Script/Lyrics' },
  { slug: 'music', title: 'Music' },
  { slug: 'continuity-bible', title: 'Continuity Bible' },
  { slug: 'storyboard', title: 'Storyboard' },
  { slug: 'image-keyframes', title: 'Image/Keyframes' },
  { slug: 'video-generation', title: 'Video Generation' },
  { slug: 'qc-retakes', title: 'QC/Retakes' },
  { slug: 'assembly', title: 'Assembly' },
  { slug: 'final-qc', title: 'Final QC' },
  { slug: 'delivery', title: 'Delivery' },
];

/** The stage a studio order's first approval stop lands on. */
const APPROVAL_STAGE = 'script-lyrics';

function newJobId(): string {
  return `test-dsf-studio-${uuidv4()}`;
}

function createStudioOrder(showName: string) {
  // Mirrors cc_sync.enqueue_create's payload: job_id, show_name, the 12 stage
  // slugs + titles, and the optional title_prefix (CC renders
  // "<title_prefix> — <show_name>" on the epic card).
  return createAdCampaign({
    job_id: newJobId(),
    show_name: showName,
    title_prefix: 'Drama Studio',
    stages: STUDIO_STAGES,
  });
}

function cardRow(jobId: string, stageSlug: string) {
  return queryOne<{ id: string; status: string; blocked_reason: string | null; ask: string | null }>(
    'SELECT id, status, blocked_reason, ask FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, stageSlug],
  );
}

/**
 * Register the `url` deliverable a studio card carries — the delivery link the
 * client is handed. The FIX 25 evidence gate accepts a `url` deliverable whose
 * path is a parseable http(s) URL (completion-evidence.ts isUsableUrl), which is
 * exactly what a studio run has: the work lives at a URL, not in a local file.
 */
function registerDeliveryUrl(jobId: string, stageSlug: string, url: string): void {
  const card = cardRow(jobId, stageSlug);
  assert.ok(card, `fixture card for stage ${stageSlug} must exist`);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?, ?, 'url', ?, ?, ?)`,
    [uuidv4(), card.id, `${stageSlug} delivery link`, url, new Date().toISOString()],
  );
}

// ---------------------------------------------------------------------------
// 1. Creation — the 12 stage slugs land as cards.
// ---------------------------------------------------------------------------

test('a studio order creates the campaign with skill 75 stage slugs (SPEC 6)', () => {
  const res = createStudioOrder('Midnight Confession — ep 12');
  assert.equal(res.created, true);
  assert.ok(res.parent_id, 'epic parent card id present');

  // 12 stage cards + 1 epic = 13 cards, all starting in backlog.
  const rows = queryAll<{ status: string; stage_slug: string }>(
    'SELECT status, stage_slug FROM tasks WHERE campaign_id = ?',
    [res.campaign_id],
  );
  assert.equal(rows.length, 13, 'epic + 12 studio stage cards');
  assert.ok(rows.every((r) => r.status === 'backlog'), 'every card starts in backlog');

  // Exactly skill 75's 12 slugs — not the Skill 48 7-stage default, not a new
  // list. (readStageRefs orders by stage_slug, so compare as sets.)
  assert.deepEqual(
    res.stages.map((s) => s.slug).sort(),
    STUDIO_STAGES.map((s) => s.slug).sort(),
    'the 12 studio stage slugs',
  );
  assert.equal(res.stages.length, 12, '12 non-epic stage cards');

  // Card titles are the ones the phone renders (batch.py's own titles).
  for (const stage of STUDIO_STAGES) {
    const row = queryOne<{ title: string }>(
      'SELECT title FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
      [res.campaign_id, stage.slug],
    );
    assert.equal(row!.title, stage.title, `title for ${stage.slug}`);
  }

  // Epic card carries the prefixed title; the campaign row exists and is active.
  const epic = queryOne<{ title: string }>('SELECT title FROM tasks WHERE id = ?', [res.parent_id!]);
  assert.equal(epic!.title, 'Drama Studio — Midnight Confession — ep 12');
  const campaign = queryOne<{ status: string }>('SELECT status FROM campaigns WHERE id = ?', [
    res.campaign_id,
  ]);
  assert.equal(campaign!.status, 'active');

  // Idempotent re-create: same order arriving twice must not duplicate cards.
  const again = createAdCampaign({
    job_id: res.campaign_id,
    show_name: 'Midnight Confession — ep 12',
    title_prefix: 'Drama Studio',
    stages: STUDIO_STAGES,
  });
  assert.equal(again.created, false, 'second create is a no-op');
  assert.equal(
    queryAll('SELECT id FROM tasks WHERE campaign_id = ?', [res.campaign_id]).length,
    13,
    're-create did not duplicate cards',
  );
});

test('the create payload cc_sync sends passes CreateAdCampaignSchema', () => {
  // cc_sync.enqueue_create enforces the same bounds client-side (job_id 1-128,
  // show_name 1-500, <= 50 stages, slug 1-64, title_prefix <= 60). Pin the
  // server-side schema so the two stay in step.
  const ok = CreateAdCampaignSchema.safeParse({
    job_id: 'order-20261013-0001',
    show_name: 'Midnight Confession — ep 12',
    title_prefix: 'Drama Studio',
    stages: STUDIO_STAGES,
  });
  assert.equal(ok.success, true, 'a real studio order is schema-valid');

  // 51 stages is over the server max 50 — the client check alone is not a gate.
  const tooMany = CreateAdCampaignSchema.safeParse({
    job_id: 'order-20261013-0002',
    show_name: 'Oversize order',
    stages: Array.from({ length: 51 }, (_, i) => ({ slug: `stage-${i}` })),
  });
  assert.equal(tooMany.success, false, 'more than 50 stages is refused');

  const longSlug = CreateAdCampaignSchema.safeParse({
    job_id: 'order-20261013-0003',
    show_name: 'Long slug order',
    stages: [{ slug: 'x'.repeat(65) }],
  });
  assert.equal(longSlug.success, false, 'a stage slug over 64 chars is refused');
});

// ---------------------------------------------------------------------------
// 2. A stage card's lifecycle, including the approval wait.
// ---------------------------------------------------------------------------

test('a studio stage card walks backlog -> in_progress -> blocked(approval) -> in_progress -> review -> done', async () => {
  const res = createStudioOrder('Approval flow order');
  const jobId = res.campaign_id;

  // backlog → in_progress: the box claims the stage.
  const started = await moveAdStage(jobId, {
    stage_slug: APPROVAL_STAGE,
    status: 'in_progress',
    actor: 'studio-bridge',
  });
  assert.equal(started.status, 'in_progress');

  // The approval wait: parked on the client with the question that must be
  // answered (SPEC 6). blocked_reason=approval, blocked_on_human=owner, ask set.
  const blocked = await moveAdStage(jobId, {
    stage_slug: APPROVAL_STAGE,
    status: 'blocked',
    blocked_reason: 'approval',
    blocked_on_human: 'owner',
    ask: 'Does this script look right? Tap Approve on the studio page.',
    actor: 'studio-bridge',
  });
  assert.equal(blocked.status, 'blocked');
  const blockedRow = cardRow(jobId, APPROVAL_STAGE)!;
  assert.equal(blockedRow.blocked_reason, 'approval', 'approval wait is recorded as such');
  assert.ok(blockedRow.ask && blockedRow.ask.length > 0, 'the ask survives on the card');

  // The answer lands → the card resumes. Leaving blocked clears the block
  // metadata, so the board never shows a phantom permanent stop.
  const resumed = await moveAdStage(jobId, {
    stage_slug: APPROVAL_STAGE,
    status: 'in_progress',
    actor: 'studio-bridge',
    reason: 'client approved the script',
  });
  assert.equal(resumed.status, 'in_progress');
  const clearedRow = cardRow(jobId, APPROVAL_STAGE)!;
  assert.equal(clearedRow.blocked_reason, null, 'approval block cleared on resume');
  assert.equal(clearedRow.ask, null, 'ask cleared on resume');

  // The card reaches review only with a registered deliverable (FIX 25): the
  // delivery url is registered first, then the move.
  registerDeliveryUrl(jobId, APPROVAL_STAGE, 'https://studio.example.com/clients/cl-1/orders/ord-1/script.mp4');
  const inReview = await moveAdStage(jobId, { stage_slug: APPROVAL_STAGE, status: 'review' });
  assert.equal(inReview.status, 'review', 'human QC pause: sits at review, not auto-done');

  // QC passes → done, with completed_at stamped by the DB trigger.
  const done = await moveAdStage(jobId, { stage_slug: APPROVAL_STAGE, status: 'done' });
  assert.equal(done.status, 'done');
  const doneRow = queryOne<{ completed_at: string | null }>(
    'SELECT completed_at FROM tasks WHERE campaign_id = ? AND stage_slug = ?',
    [jobId, APPROVAL_STAGE],
  );
  assert.ok(doneRow!.completed_at, 'trg_tasks_completed_at stamped completed_at');

  // Every move is auditable — a studio run's board history is the replay log.
  const card = cardRow(jobId, APPROVAL_STAGE)!;
  const events = queryAll('SELECT id FROM task_events WHERE task_id = ?', [card.id]);
  assert.ok(events.length >= 4, 'task_events recorded each transition');
});

test('review with no registered deliverable is refused (FIX 25 evidence gate)', async () => {
  const res = createStudioOrder('No evidence order');
  await moveAdStage(res.campaign_id, { stage_slug: 'music', status: 'in_progress' });
  await assert.rejects(
    () => moveAdStage(res.campaign_id, { stage_slug: 'music', status: 'review' }),
    (err: unknown) => err instanceof TransitionError && err.code === 'PRECONDITION_EVIDENCE',
    'a card with no deliverable cannot enter review',
  );
});

test('an approval wait without a real ask is refused (400-class)', async () => {
  const res = createStudioOrder('Poison block order');
  await moveAdStage(res.campaign_id, { stage_slug: 'storyboard', status: 'in_progress' });

  // No ask at all.
  await assert.rejects(
    () =>
      moveAdStage(res.campaign_id, {
        stage_slug: 'storyboard',
        status: 'blocked',
        blocked_reason: 'approval',
      }),
    (err: unknown) => err instanceof AdCampaignError && err.status === 400,
  );

  // No structured reason — a blocked card with no reason is unanswerable.
  await assert.rejects(
    () =>
      moveAdStage(res.campaign_id, {
        stage_slug: 'storyboard',
        status: 'blocked',
        ask: 'Approve this storyboard?',
      }),
    (err: unknown) => err instanceof AdCampaignError && err.status === 400,
  );

  // The studio blocked payload itself is schema-valid (the phone sends exactly
  // this shape through PATCH /api/ad-campaigns/[id]).
  const ok = UpdateAdCampaignStageSchema.safeParse({
    stage_slug: 'storyboard',
    status: 'blocked',
    blocked_reason: 'approval',
    blocked_on_human: 'owner',
    ask: 'Pick a song from the three on the page.',
  });
  assert.equal(ok.success, true, 'the studio approval-wait payload is schema-valid');
});

test('illegal epic backlog -> done throws ILLEGAL_TRANSITION', async () => {
  const res = createStudioOrder('Illegal jump order');
  await assert.rejects(
    () => moveAdStage(res.campaign_id, { stage_slug: 'epic', status: 'done' }),
    (err: unknown) => err instanceof TransitionError && err.code === 'ILLEGAL_TRANSITION',
  );
});

// ---------------------------------------------------------------------------
// 3. The epic card closes the order.
// ---------------------------------------------------------------------------

test('the epic walks in_progress -> review -> done; the campaign completes only with the Skill 75 evidence set (D14)', async () => {
  const res = createStudioOrder('Full order close');
  const jobId = res.campaign_id;

  await moveAdStage(jobId, { stage_slug: 'epic', status: 'in_progress' });
  // The whole-run deliverable is the final delivery url; the epic cannot reach
  // review without it (same gate as a stage card).
  registerDeliveryUrl(jobId, 'epic', 'https://studio.example.com/clients/cl-1/orders/ord-2/final.mp4');
  await moveAdStage(jobId, { stage_slug: 'epic', status: 'review' });

  // D14 REPAIR (Skill_75_Universal_Repair_Spec_v1.1 §13 / finding D14): the
  // previous pin here — "epic done completes the run" with every child stage
  // still in backlog and no approval/reviewer/delivery evidence — WAS the
  // defect ("can mark a campaign complete when its epic is marked done without
  // proving every required child"). The repaired contract: an epic marked done
  // can never COMPLETE THE CAMPAIGN while the required evidence set is
  // missing. The completing move is refused loudly (422, every missing item
  // named) and the campaign row must not read complete. The full evidence path
  // that DOES complete the campaign is pinned in
  // tests/unit/w08-u2-skill75-completion-guards.test.ts.
  await assert.rejects(
    () => moveAdStage(jobId, { stage_slug: 'epic', status: 'done' }),
    (err: unknown) => {
      assert.ok(err instanceof AdCampaignError, `expected AdCampaignError, got ${String(err)}`);
      assert.equal(err.code, 'SKILL75_COMPLETION_INCOMPLETE');
      assert.equal(err.status, 422);
      return true;
    },
  );

  const { campaign } = getAdCampaign(jobId);
  assert.equal(
    (campaign as { status: string }).status,
    'active',
    'a refused completion never claims the run is complete',
  );

  // The refusal is durable on the card — the board shows WHY (the board is a
  // view of the run, never the only copy of the decision).
  const epic = cardRow(jobId, 'epic')!;
  const refusal = queryOne<{ message: string }>(
    `SELECT message FROM task_activities WHERE task_id = ? AND activity_type = 'error' ORDER BY created_at DESC LIMIT 1`,
    [epic.id],
  );
  assert.ok(refusal && refusal.message.includes('campaign completion refused'), 'refusal recorded on the epic card');
});
