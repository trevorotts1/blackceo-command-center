/**
 * p4-02-persona-blend-visibility.test.ts — P4-02 (THE DUAL-PERSONA CONTENT
 * SYSTEM) steps 3, 5, 6. DB-backed, fail-first.
 *
 * Covers the REPO-buildable legs of P4-02 part (c):
 *
 *   step 6 — OBSERVABILITY / the silent-regression lock:
 *     • `emitPersonaBlendMissing` writes a queryable `persona_blend_missing` event.
 *     • `resolvePersonaAndPin({blend:true})` emits it when a content task got a
 *       persona but NO bundle back (the D1 "duality dead in prod" per-task signal),
 *       and does NOT emit it when a bundle DID come back.
 *     • board-hygiene's board-wide check flags a 7-day window with content tasks
 *       created but ZERO bundles written, notifies the operator lane, and is
 *       cooldown-guarded (never spams).
 *
 *   step 5 — VISIBILITY of the confirm gate:
 *     • `markAudienceDeadlineFallback` stamps the visible card event AND notifies
 *       the operator lane — the silent neutral-voice release is never silent again
 *       (proven via the durable notification-failures.jsonl operator-notice sink).
 *     • the transition is idempotent (one event, one notice, never per-sweep).
 *
 *   step 3 — BACKFILL:
 *     • the sweep's blend phase re-runs the voice blend for content tasks that
 *       have a persona but no `blend_directive`, stamps `blend_backfilled`, and
 *       (guards) never touches: non-content tasks, tasks with an existing bundle,
 *       terminal tasks, or tasks already attempted — and is idempotent.
 *
 * FAIL-FIRST: every assertion below rests on symbols that do not exist on the
 * pre-P4-02 tree (`emitPersonaBlendMissing`, `EVT_PERSONA_BLEND_MISSING`,
 * `runPersonaBlendBackfill`, the `blendRegressionFlagged` result field, the
 * deadline-fallback operator notice), so the whole file errors to import against
 * origin/main before the fix and passes with it.
 *
 *   node --import tsx --test tests/unit/p4-02-persona-blend-visibility.test.ts
 */

// Route the operator notice to the durable filesystem sink (no gateway / webhook
// in a unit run) and keep it inside a throwaway workspace dir.
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_BOARD_HYGIENE;
delete process.env.PERSONA_FIXTURE_JSON;
// The blend phase re-runs resolvePersonaAndPin; keep the retry backoff instant so
// a fixture-less call (excluded rows never reach it) can't stall the suite.
process.env.PERSONA_BACKFILL_GRACE_SECONDS = '0';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-p4-02-workspace-'));
process.env.OPENCLAW_WORKSPACE_PATH = WORKSPACE;

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run, queryOne, queryAll } from '../../src/lib/db';
import {
  emitPersonaBlendMissing,
  EVT_PERSONA_BLEND_MISSING,
  resolvePersonaAndPin,
  markAudienceDeadlineFallback,
} from '../../src/lib/tasks';
import { runPersonaBlendBackfill } from '../../src/lib/jobs/persona-backfill-sweep';
import { runBoardHygiene } from '../../src/lib/jobs/board-hygiene';

getDb(); // apply the full migration chain (tasks, events, task_persona_bundle).

// ── fixtures ─────────────────────────────────────────────────────────────────

function daysAgo(d: number): string {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
}

interface SeedOpts {
  title: string;
  description?: string | null;
  status?: string;
  personaId?: string | null;
  blendDirective?: string | null;
  department?: string | null;
  createdAt?: string;
  archivedAt?: string | null;
}

function seedTask(opts: SeedOpts): string {
  const id = uuidv4();
  run(
    `INSERT INTO tasks
       (id, title, description, status, department, workspace_id,
        persona_id, blend_directive, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.title,
      opts.description ?? null,
      opts.status ?? 'in_progress',
      opts.department ?? 'marketing',
      opts.personaId ?? null,
      opts.blendDirective ?? null,
      opts.createdAt ?? new Date().toISOString(),
      opts.createdAt ?? new Date().toISOString(),
      opts.archivedAt ?? null,
    ],
  );
  return id;
}

function seedBundle(taskId: string, confirmState: string, createdAt?: string): void {
  run(
    `INSERT INTO task_persona_bundle (id, task_id, bundle_json, catalog_version, confirm_state, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), taskId, '{}', '1.3', confirmState, createdAt ?? new Date().toISOString()],
  );
}

function eventCount(taskId: string, type: string): number {
  return (
    queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = ?', [
      taskId,
      type,
    ])?.n ?? 0
  );
}

/** Read the durable operator-notice sink notifySystem falls back to in a unit run. */
function operatorNotices(): string[] {
  const f = path.join(WORKSPACE, 'notification-failures.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).message as string);
}

// A bundle-shaped fixture: pins a persona AND yields a real blend bundle so
// persistPersonaBundle writes the row + blend_directive mirror column.
const BUNDLE_FIXTURE = JSON.stringify({
  persona_id: 'shonda-rhimes',
  persona_name: 'Shonda Rhimes',
  score: 0.9,
  interaction_mode: 'leadership',
  mode: 'blend',
  content_task: true,
  topic: 'email marketing',
  blend_directive: "Write in Shonda Rhimes's VOICE while carrying Russell Brunson's EXPERTISE.",
  confirm_required: false,
  voice: {
    audience_persona: { id: 'shonda-rhimes', why: 'audience voice' },
    topic_persona: { id: 'russell-brunson', why: 'topic expertise' },
    collapsed: false,
    collapsed_persona_id: null,
  },
  resolved_audience: { source: 'onboarding_icp', confidence: 'high', candidates: ['black women'] },
  catalog_version: '1.3',
});

// A persona-only fixture: pins a persona but yields NO bundle superset.
const NO_BUNDLE_FIXTURE = JSON.stringify({
  persona_id: 'covey-7-habits',
  persona_name: 'Covey',
  score: 0.5,
  interaction_mode: 'leadership',
});

// ── step 6: persona_blend_missing (per-task signal) ─────────────────────────

test('step6: emitPersonaBlendMissing writes a queryable persona_blend_missing event', () => {
  const id = seedTask({ title: 'write a blog post', personaId: 'covey-7-habits' });
  emitPersonaBlendMissing(id, 'covey-7-habits');
  assert.equal(eventCount(id, EVT_PERSONA_BLEND_MISSING), 1);
  assert.equal(EVT_PERSONA_BLEND_MISSING, 'persona_blend_missing');
  const evt = queryOne<{ message: string }>(
    'SELECT message FROM events WHERE task_id = ? AND type = ?',
    [id, EVT_PERSONA_BLEND_MISSING],
  );
  assert.match(evt!.message, /requested --blend/);
});

test('step6: resolvePersonaAndPin(blend) emits persona_blend_missing on a no-bundle result', async () => {
  const id = seedTask({ title: 'write a marketing email', description: 'q3 launch' });
  process.env.PERSONA_FIXTURE_JSON = NO_BUNDLE_FIXTURE;
  try {
    const pinned = await resolvePersonaAndPin(id, 'write a marketing email', 'marketing', undefined, {
      blend: true,
    });
    assert.equal(pinned, 'covey-7-habits'); // a persona WAS pinned
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }
  // ...but no bundle came back → the silent-regression signal fired.
  assert.equal(eventCount(id, EVT_PERSONA_BLEND_MISSING), 1);
  const row = queryOne<{ blend_directive: string | null }>(
    'SELECT blend_directive FROM tasks WHERE id = ?',
    [id],
  );
  assert.equal(row!.blend_directive, null);
});

test('step6: resolvePersonaAndPin(blend) does NOT emit the signal when a bundle IS produced', async () => {
  const id = seedTask({ title: 'write a marketing email', description: 'q3 launch' });
  process.env.PERSONA_FIXTURE_JSON = BUNDLE_FIXTURE;
  try {
    await resolvePersonaAndPin(id, 'write a marketing email', 'marketing', undefined, { blend: true });
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }
  assert.equal(eventCount(id, EVT_PERSONA_BLEND_MISSING), 0);
  const row = queryOne<{ blend_directive: string | null }>(
    'SELECT blend_directive FROM tasks WHERE id = ?',
    [id],
  );
  assert.ok(row!.blend_directive && row!.blend_directive.length > 0); // directive landed
});

// ── step 5: deadline fallback is VISIBLE (event + operator notice) ───────────

test('step5: markAudienceDeadlineFallback stamps the card event AND notifies the operator lane', () => {
  const id = seedTask({ title: 'draft launch email', personaId: 'shonda-rhimes' });
  seedBundle(id, 'pending');

  markAudienceDeadlineFallback(id);

  // (a) the bundle transitioned pending → deadline_fallback
  const bundle = queryOne<{ confirm_state: string }>(
    'SELECT confirm_state FROM task_persona_bundle WHERE task_id = ?',
    [id],
  );
  assert.equal(bundle!.confirm_state, 'deadline_fallback');

  // (b) the visible card event was stamped
  assert.equal(eventCount(id, 'audience_confirm_deadline_fallback'), 1);

  // (c) THE FIX — the operator lane was notified (never silent again). The
  // durable sink carries a notice naming this task and the house-voice release.
  const notices = operatorNotices().filter((m) => m.includes(id));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /NEUTRAL HOUSE VOICE/);
});

test('step5: the deadline transition is idempotent — no second event or notice', () => {
  const id = seedTask({ title: 'draft second email', personaId: 'shonda-rhimes' });
  seedBundle(id, 'pending');

  markAudienceDeadlineFallback(id);
  markAudienceDeadlineFallback(id); // already deadline_fallback — must no-op

  assert.equal(eventCount(id, 'audience_confirm_deadline_fallback'), 1);
  assert.equal(operatorNotices().filter((m) => m.includes(id)).length, 1);
});

// ── step 3: backfill blend phase (guards + heal) ────────────────────────────

test('step3: blend backfill heals blend-less content tasks and respects every guard', async () => {
  // Isolate from earlier tests' rows: archive everything so the blend pool sees
  // only THIS test's fixtures (the sweep excludes archived_at IS NOT NULL).
  run(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL`, [new Date().toISOString()]);
  const graceCutoff = new Date().toISOString(); // everything already aged in

  // ELIGIBLE: content task, persona set, no directive, no bundle, not attempted.
  const eligible = seedTask({
    title: 'write 2 marketing emails for the launch',
    personaId: 'covey-7-habits',
    createdAt: daysAgo(1),
  });
  // EXCLUDED — non-content (mechanical): should never be attempted.
  const nonContent = seedTask({
    title: 'restart the pm2 process',
    personaId: 'covey-7-habits',
    createdAt: daysAgo(1),
  });
  // EXCLUDED — already has a bundle (never overwrite a non-null bundle).
  const hasBundle = seedTask({
    title: 'write a blog post about leadership',
    personaId: 'covey-7-habits',
    createdAt: daysAgo(1),
  });
  seedBundle(hasBundle, 'confirmed');
  // EXCLUDED — terminal status.
  const terminal = seedTask({
    title: 'write a sales email sequence',
    personaId: 'covey-7-habits',
    status: 'done',
    createdAt: daysAgo(1),
  });
  // EXCLUDED — already attempted once (idempotency guard).
  const attempted = seedTask({
    title: 'write an email newsletter',
    personaId: 'covey-7-habits',
    createdAt: daysAgo(1),
  });
  run(`INSERT INTO events (id, type, task_id, message, created_at) VALUES (?, 'blend_backfilled', ?, 'prior', ?)`, [
    uuidv4(),
    attempted,
    daysAgo(1),
  ]);

  process.env.PERSONA_FIXTURE_JSON = BUNDLE_FIXTURE;
  let result;
  try {
    result = await runPersonaBlendBackfill(10, graceCutoff);
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }

  // Only the one eligible content task was scanned + healed.
  assert.equal(result.blendScanned, 1, 'only the eligible content task is in the pool');
  assert.equal(result.blendBackfilled, 1, 'the eligible task acquired a blend directive');

  // The eligible task now has a directive + a bundle + exactly one attempt marker.
  const healed = queryOne<{ blend_directive: string | null }>(
    'SELECT blend_directive FROM tasks WHERE id = ?',
    [eligible],
  );
  assert.ok(healed!.blend_directive && healed!.blend_directive.length > 0);
  assert.equal(eventCount(eligible, 'blend_backfilled'), 1);

  // Every excluded task was never attempted (no blend_backfilled stamped).
  assert.equal(eventCount(nonContent, 'blend_backfilled'), 0, 'non-content excluded');
  assert.equal(eventCount(hasBundle, 'blend_backfilled'), 0, 'existing-bundle excluded');
  assert.equal(eventCount(terminal, 'blend_backfilled'), 0, 'terminal excluded');
  // The pre-existing attempt marker is not duplicated.
  assert.equal(eventCount(attempted, 'blend_backfilled'), 1, 'already-attempted not re-stamped');
});

test('step3: a second backfill run is a no-op (the healed task dropped out of the pool)', async () => {
  run(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL`, [new Date().toISOString()]);
  const graceCutoff = new Date().toISOString();
  const id = seedTask({
    title: 'write a promotional email blast',
    personaId: 'covey-7-habits',
    createdAt: daysAgo(1),
  });

  process.env.PERSONA_FIXTURE_JSON = BUNDLE_FIXTURE;
  try {
    const first = await runPersonaBlendBackfill(10, graceCutoff);
    assert.ok(first.blendScanned >= 1);
    const second = await runPersonaBlendBackfill(10, graceCutoff);
    // The task now has a bundle + a directive + an attempt marker → excluded.
    assert.equal(second.blendScanned, 0);
  } finally {
    delete process.env.PERSONA_FIXTURE_JSON;
  }
  assert.equal(eventCount(id, 'blend_backfilled'), 1);
});

// ── step 6: board-hygiene board-wide regression check ───────────────────────

test('step6: board-hygiene flags a window with content tasks but zero bundles + notices once', async () => {
  // Fresh DB slate for a clean window count: archive everything already seeded so
  // the window sees only THIS test's content tasks and no stray bundles.
  run(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL`, [new Date().toISOString()]);
  run(`DELETE FROM task_persona_bundle`, []);
  run(`DELETE FROM events WHERE type = 'persona_blend_regression'`, []);

  // Two content tasks created in-window, ZERO bundles anywhere.
  seedTask({ title: 'write a marketing email for the fall campaign', createdAt: daysAgo(1) });
  seedTask({ title: 'draft a blog post on delegation', createdAt: daysAgo(2) });
  // A non-content control (must not, alone, trip the check).
  seedTask({ title: 'reboot the staging box', createdAt: daysAgo(1) });

  // Isolate the check: disable the other lanes so this asserts only the new rule.
  process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '1';
  process.env.DISABLE_BOARD_HYGIENE_REVIEW = '1';
  process.env.DISABLE_BOARD_HYGIENE_DONE = '1';
  process.env.DISABLE_BOARD_HYGIENE_STALE = '1';

  const before = operatorNotices().length;
  const r1 = await runBoardHygiene();

  assert.equal(r1.blendRegressionFlagged, true);
  assert.equal(r1.blendWindowContentTasks, 2);
  assert.equal(r1.blendWindowBundles, 0);

  const notice = operatorNotices().slice(before).find((m) => m.includes('PERSONA-BLEND REGRESSION'));
  assert.ok(notice, 'operator lane received the regression notice');
  assert.equal(
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'persona_blend_regression'", [])?.n,
    1,
  );

  // Cooldown: a second run inside the window flags again but does NOT re-notify.
  const before2 = operatorNotices().length;
  const r2 = await runBoardHygiene();
  assert.equal(r2.blendRegressionFlagged, true);
  assert.equal(
    operatorNotices().slice(before2).filter((m) => m.includes('PERSONA-BLEND REGRESSION')).length,
    0,
    'cooldown suppresses a repeat operator notice',
  );

  process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '';
  process.env.DISABLE_BOARD_HYGIENE_REVIEW = '';
  process.env.DISABLE_BOARD_HYGIENE_DONE = '';
  process.env.DISABLE_BOARD_HYGIENE_STALE = '';
});

test('step6: no regression flag when the window HAS a bundle (healthy board)', async () => {
  run(`UPDATE tasks SET archived_at = ? WHERE archived_at IS NULL`, [new Date().toISOString()]);
  run(`DELETE FROM task_persona_bundle`, []);
  run(`DELETE FROM events WHERE type = 'persona_blend_regression'`, []);

  const t = seedTask({ title: 'write a marketing email for spring', createdAt: daysAgo(1) });
  seedBundle(t, 'confirmed', daysAgo(1)); // a real blend WAS produced

  process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '1';
  process.env.DISABLE_BOARD_HYGIENE_REVIEW = '1';
  process.env.DISABLE_BOARD_HYGIENE_DONE = '1';
  process.env.DISABLE_BOARD_HYGIENE_STALE = '1';

  const r = await runBoardHygiene();
  assert.equal(r.blendRegressionFlagged, false);
  assert.equal(r.blendWindowBundles, 1);

  process.env.DISABLE_BOARD_HYGIENE_BLOCKED = '';
  process.env.DISABLE_BOARD_HYGIENE_REVIEW = '';
  process.env.DISABLE_BOARD_HYGIENE_DONE = '';
  process.env.DISABLE_BOARD_HYGIENE_STALE = '';
});
