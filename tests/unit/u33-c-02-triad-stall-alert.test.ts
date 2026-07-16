/**
 * u33-c-02-triad-stall-alert.test.ts — skill6-v2 U33 / C-02 (part 1).
 *
 * board-hygiene.ts's new Rule 6: a backlog card sitting Triad-incomplete
 * (checkTriad, src/lib/sops.ts:432) for > BOARD_HYGIENE_TRIAD_STALL_HOURS
 * (default 48h) fires exactly ONE `board_hygiene_triad_stalled` operator-lane
 * alert, cooldown-guarded on re-run — closing the day-0→day-21 dead zone
 * before rule 5's 21-day stale-backlog nudge ever fires.
 *
 * Anchored on `created_at` (day 0), NOT `last_progress_at`/`updated_at` —
 * this suite seeds `created_at` explicitly (the shared board-hygiene.test.ts
 * fixture helper does not set it, so it always reads "now"; a dedicated
 * fixture helper here is required to age the row correctly).
 *
 *   node --import tsx --test tests/unit/u33-c-02-triad-stall-alert.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.DISABLE_BOARD_HYGIENE_TRIAD;
delete process.env.BOARD_HYGIENE_TRIAD_STALL_HOURS;
delete process.env.BOARD_HYGIENE_TRIAD_STALL_COOLDOWN_HOURS;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-triad-stall-workspace-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';

getDb(); // apply full migration chain

// ── fixtures ─────────────────────────────────────────────────────────────────

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

interface SeedOpts {
  title: string;
  createdAtHoursAgo: number;
  description?: string | null;
  sopId?: string | null;
  personaId?: string | null;
  status?: string;
}

function seedBacklogTask(opts: SeedOpts): string {
  const id = uuidv4();
  const createdAt = hoursAgo(opts.createdAtHoursAgo);
  run(
    `INSERT INTO tasks
       (id, title, description, status, workspace_id, business_id, sop_id, persona_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
    [
      id,
      opts.title,
      opts.description ?? null,
      opts.status ?? 'backlog',
      opts.sopId ?? null,
      opts.personaId ?? null,
      createdAt,
      createdAt,
    ],
  );
  return id;
}

function seedSop(): string {
  const id = uuidv4();
  run(
    `INSERT INTO sops (id, name, slug, steps, success_criteria, department)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      'Onboarding Email Sequence',
      `onboarding-email-seq-${id.slice(0, 8)}`,
      'Step 1: draft. Step 2: review.',
      'All 5 emails drafted and approved.',
      'marketing',
    ],
  );
  return id;
}

function eventsFor(id: string, type: string) {
  return queryAll<{ message: string; created_at: string }>(
    'SELECT message, created_at FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [id, type],
  );
}

function taskStatus(id: string) {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

// ── the seeded pathological board ───────────────────────────────────────────

let missingSop49h: string; // description + persona real, sop_id NULL, 49h old
let fullyGroomed49h: string; // all three real, 49h old — must NEVER fire
let missingEverything1h: string; // all three missing, only 1h old — under threshold
let missingDescription60d: string; // description NULL, 60 days old

test.before(() => {
  const realSopId = seedSop();

  missingSop49h = seedBacklogTask({
    title: 'Draft the Q4 onboarding email sequence',
    createdAtHoursAgo: 49,
    description: 'Write the 5-email onboarding sequence for new clients.',
    sopId: null,
    personaId: 'ogilvy-on-advertising',
  });

  fullyGroomed49h = seedBacklogTask({
    title: 'Fully groomed control card',
    createdAtHoursAgo: 49,
    description: 'This card has everything the Triad requires.',
    sopId: realSopId,
    personaId: 'hormozi-100m-offers',
  });

  missingEverything1h = seedBacklogTask({
    title: 'Brand new ungroomed card',
    createdAtHoursAgo: 1,
    description: null,
    sopId: null,
    personaId: null,
  });

  missingDescription60d = seedBacklogTask({
    title: 'Ancient ungroomed card',
    createdAtHoursAgo: 24 * 60,
    description: null,
    sopId: null,
    personaId: null,
  });
});

// ── run #1: the pathological Triad-incomplete cards fire, controls do not ──

test('run #1 — Triad-incomplete backlog card past the stall threshold fires exactly once', async () => {
  const result = await runBoardHygiene();

  assert.ok(
    result.triadStalledIds.includes(missingSop49h),
    'a 49h-old backlog card missing only its SOP must be flagged as Triad-stalled',
  );
  const evts = eventsFor(missingSop49h, 'board_hygiene_triad_stalled');
  assert.equal(evts.length, 1, 'exactly one board_hygiene_triad_stalled event must be written');
  assert.match(evts[0].message, /Missing: SOP/, 'the alert names the missing field using the card-pill vocabulary');
  assert.equal(taskStatus(missingSop49h), 'backlog', 'the alert never changes task status');

  assert.ok(
    result.triadStalledIds.includes(missingDescription60d),
    'a 60-day-old backlog card missing everything must also be flagged',
  );
  const evts2 = eventsFor(missingDescription60d, 'board_hygiene_triad_stalled');
  assert.equal(evts2.length, 1);
  assert.match(evts2[0].message, /Missing: description, SOP, persona/, 'names ALL missing fields, in Triad order');
});

test('run #1 — a fully-groomed backlog card is never flagged, regardless of age', async () => {
  // runBoardHygiene() already ran in the previous test; re-run is safe (idempotent
  // for this control row either way).
  const result = await runBoardHygiene();
  assert.ok(
    !result.triadStalledIds.includes(fullyGroomed49h),
    'a Triad-complete card must never be flagged as stalled',
  );
  assert.equal(eventsFor(fullyGroomed49h, 'board_hygiene_triad_stalled').length, 0);
});

test('run #1 — an ungroomed card under the stall threshold is not yet flagged', async () => {
  const result = await runBoardHygiene();
  assert.ok(
    !result.triadStalledIds.includes(missingEverything1h),
    'a 1h-old ungroomed card must not fire before the 48h default threshold',
  );
  assert.equal(eventsFor(missingEverything1h, 'board_hygiene_triad_stalled').length, 0);
});

// ── run #2: cooldown-guarded re-fire suppression ────────────────────────────

test('run #2 (immediate re-run) — cooldown-guarded: already-alerted cards add zero', async () => {
  const before = eventsFor(missingSop49h, 'board_hygiene_triad_stalled').length;
  const result = await runBoardHygiene();
  assert.ok(
    !result.triadStalledIds.includes(missingSop49h),
    'an already-alerted card must not re-fire within the cooldown window',
  );
  const after = eventsFor(missingSop49h, 'board_hygiene_triad_stalled').length;
  assert.equal(after, before, 'no additional event row is written on an immediate re-run');
});

// ── kill switch ──────────────────────────────────────────────────────────────

test('DISABLE_BOARD_HYGIENE_TRIAD=1 disables only the Triad-stall sub-check', async () => {
  const freshCard = seedBacklogTask({
    title: 'A fresh un-alerted stalled card',
    createdAtHoursAgo: 100,
    description: null,
    sopId: null,
    personaId: null,
  });
  process.env.DISABLE_BOARD_HYGIENE_TRIAD = '1';
  try {
    const result = await runBoardHygiene();
    assert.equal(result.triadStalled, 0, 'the sub-check must not run at all while disabled');
    assert.equal(eventsFor(freshCard, 'board_hygiene_triad_stalled').length, 0);
  } finally {
    delete process.env.DISABLE_BOARD_HYGIENE_TRIAD;
  }

  // Re-enabled: the same card now fires normally.
  const result2 = await runBoardHygiene();
  assert.ok(result2.triadStalledIds.includes(freshCard), 're-enabling restores the alert on the next run');
});
