/**
 * ISSUE-12 (CC half) - the podcast/audio SOP sibling fallback.
 *
 * THE DEFECT: `podcast` and `audio` are two SEPARATE canonical departments
 * (canonical-slug.ts CANONICAL_SLUGS lists both, and no alias maps one to the
 * other). FIX-16's owning-department firewall admits only SOPs whose
 * department canonicalizes to the task's, plus department-less SOPs as a
 * floor. So on a box seeded with audio SOPs but no podcast SOPs, a podcast
 * task has an EMPTY candidate pool: getBestSOPForTask returns null, the
 * dispatcher writes `sop_library_gap`, and the card bounces to the human with
 * "Missing: SOP" forever. Nothing on the box can clear it.
 *
 * WHY NOT AN ALIAS: mapping podcast to audio in canonical-slug.ts would
 * collapse the podcast workspace that migrations 113 and 122 seed, and take
 * its Kanban lane with it. Only the SOP lookup widens.
 *
 * THE INVARIANTS UNDER TEST:
 *   1. A podcast task on a box that HAS podcast SOPs still gets a podcast SOP,
 *      with no fallback marker. The widening must be invisible when the owning
 *      department can answer.
 *   2. A podcast task on a box with NO podcast SOP gets the audio SOP, and the
 *      match carries the `sibling-department-fallback` reason.
 *   3. Symmetry: an audio task on a podcast-only box is repaired the same way.
 *   4. An unrelated department NEVER widens. A marketing task with no marketing
 *      SOP resolves to null even when a web-development SOP matches its text
 *      perfectly. This is the FIX-16 firewall, and it must survive intact.
 *   5. A department-less SOP keeps the owning pool non-empty, so the widening
 *      does not fire. The floor FIX-16 preserved still comes first.
 *   6. The sibling credit alone cannot win. An audio SOP with zero textual
 *      relevance to a podcast task still resolves to null, so the fallback
 *      cannot attach an arbitrary SOP just because the departments are kin.
 *
 * FAIL-FIRST: against the pre-fix tree, invariants 2 and 3 fail (both return
 * null, which is the live "Missing: SOP" bounce). 1, 4, 5 and 6 pass on both
 * trees by design: they are the anti-regression half, proving the widening did
 * not loosen the firewall it sits behind.
 *
 * Isolated DB, no network. Same technique as fix16-sop-department-firewall.ts.
 *
 * Run: node --import tsx --test tests/unit/issue12-sop-sibling-department-fallback.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalDeptSlug, CANONICAL_SLUGS } from '../../src/lib/routing/canonical-slug';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-issue12-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;
// No embedding provider: force the keyword path so the pool logic is proven
// without semantics as a confounder.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_AI_STUDIO_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.SOP_EMBEDDING_PROVIDER;

type DbModule = typeof import('../../src/lib/db');
type SopsModule = typeof import('../../src/lib/sops');

let run: DbModule['run'];
let closeDb: DbModule['closeDb'];

let getBestSOPForTask: SopsModule['getBestSOPForTask'];
let suggestSOPsForTaskKeyword: SopsModule['suggestSOPsForTaskKeyword'];
let resolveEligibleSops: SopsModule['resolveEligibleSops'];
let SOP_SIBLING_DEPARTMENTS: SopsModule['SOP_SIBLING_DEPARTMENTS'];
let SOP_SIBLING_FALLBACK_REASON: SopsModule['SOP_SIBLING_FALLBACK_REASON'];

/** Insert a SOP row. department=null inserts a DEPARTMENT-LESS SOP. */
function insertSop(
  id: string,
  name: string,
  slug: string,
  department: string | null,
  taskKeywords: string,
): void {
  const now = new Date().toISOString();
  run(
    `INSERT INTO sops
       (id, name, slug, description, version, department, task_keywords, steps,
        success_criteria, persona_hints, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 1, ?, ?, ?, NULL, '[]', ?, ?)`,
    [
      id, name, slug, department, taskKeywords,
      JSON.stringify([{ name: 'Step 1', checklist: [] }]),
      now, now,
    ],
  );
}

/** Start every scenario from a known-empty SOP library. */
function clearSops(): void {
  run('DELETE FROM sops', []);
}

/** The episode task used throughout: real podcast language, no audio jargon. */
const EPISODE_TASK = {
  title: 'Produce episode 14 of the show',
  description: 'Record the episode, edit the show, publish the podcast episode to the feed.',
  department: 'podcast',
};

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  closeDb = db.closeDb;
  db.getDb(); // run the migration chain (seeds starter SOPs too)

  const sops = await import('../../src/lib/sops');
  getBestSOPForTask = sops.getBestSOPForTask;
  suggestSOPsForTaskKeyword = sops.suggestSOPsForTaskKeyword;
  resolveEligibleSops = sops.resolveEligibleSops;
  SOP_SIBLING_DEPARTMENTS = sops.SOP_SIBLING_DEPARTMENTS;
  SOP_SIBLING_FALLBACK_REASON = sops.SOP_SIBLING_FALLBACK_REASON;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── 0. The premise this whole unit rests on ──────────────────────────────────
test('[ISSUE-12] podcast and audio really are two distinct canonical departments', () => {
  assert.ok(CANONICAL_SLUGS.has('podcast'), 'podcast must be canonical');
  assert.ok(CANONICAL_SLUGS.has('audio'), 'audio must be canonical');
  assert.equal(canonicalDeptSlug('podcast'), 'podcast', 'podcast must not alias away');
  assert.equal(canonicalDeptSlug('audio'), 'audio', 'audio must not alias away');
  assert.notEqual(
    canonicalDeptSlug('podcast'),
    canonicalDeptSlug('audio'),
    'if these ever collapse, the podcast workspace seeded by migrations 113/122 loses its lane',
  );
});

// ── 1. Owning department answers: the widening stays invisible ───────────────
test('[ISSUE-12] podcast task WITH podcast SOPs picks the podcast SOP, no fallback marker', async () => {
  clearSops();
  insertSop(
    'issue12-podcast-own',
    'Podcast: Episode Production',
    'issue12-podcast-episode',
    'podcast',
    'episode,podcast,show,record,publish,feed',
  );
  insertSop(
    'issue12-audio-sibling',
    'Audio: Session Production',
    'issue12-audio-session',
    'audio',
    'episode,audio,show,record,publish,mix',
  );

  const best = await getBestSOPForTask(EPISODE_TASK);
  assert.ok(best !== null, 'a podcast task with a podcast SOP must resolve one');
  assert.equal(best.id, 'issue12-podcast-own', `expected the podcast SOP, got "${best.name}"`);

  const suggestions = suggestSOPsForTaskKeyword(EPISODE_TASK, 5);
  assert.equal(suggestions[0].sop.id, 'issue12-podcast-own');
  for (const suggestion of suggestions) {
    assert.ok(
      !suggestion.reasons.some((r) => r.startsWith(SOP_SIBLING_FALLBACK_REASON)),
      'no fallback marker may appear while the owning department can answer',
    );
  }

  const pool = resolveEligibleSops(suggestions.map((s) => s.sop), EPISODE_TASK);
  assert.equal(pool.widened, false, 'the pool must not widen when the owning department has a SOP');
});

// ── 2. The live defect: podcast task, audio-only library ─────────────────────
test('[ISSUE-12] podcast task with NO podcast SOP picks the audio SOP and records the fallback reason', async () => {
  clearSops();
  insertSop(
    'issue12-audio-only',
    'Audio: Session Production',
    'issue12-audio-only-slug',
    'audio',
    'episode,show,record,publish,edit',
  );

  const suggestions = suggestSOPsForTaskKeyword(EPISODE_TASK, 5);
  assert.ok(suggestions.length > 0, 'the widened pool must produce a candidate, not an empty list');
  assert.equal(suggestions[0].sop.id, 'issue12-audio-only');
  assert.ok(
    suggestions[0].reasons.some((r) => r.startsWith(SOP_SIBLING_FALLBACK_REASON)),
    `the match must carry the ${SOP_SIBLING_FALLBACK_REASON} reason, got: ${suggestions[0].reasons.join(' | ')}`,
  );
  assert.ok(
    suggestions[0].reasons.some((r) => r.includes('podcast -> audio')),
    'the reason must name the direction of the widening',
  );

  const best = await getBestSOPForTask(EPISODE_TASK);
  assert.ok(best !== null, 'this is the defect: pre-fix this returned null and the card bounced forever');
  assert.equal(best.id, 'issue12-audio-only');
});

// ── 3. Symmetry ──────────────────────────────────────────────────────────────
test('[ISSUE-12] the fallback is symmetric: an audio task on a podcast-only box resolves too', async () => {
  clearSops();
  insertSop(
    'issue12-podcast-only',
    'Podcast: Episode Production',
    'issue12-podcast-only-slug',
    'podcast',
    'session,record,edit,master,mix,publish',
  );

  const audioTask = {
    title: 'Master the recorded session',
    description: 'Edit and master the recorded session, then publish the mix.',
    department: 'audio',
  };
  assert.deepEqual(SOP_SIBLING_DEPARTMENTS.audio, ['podcast'], 'audio must declare podcast as its sibling');

  const best = await getBestSOPForTask(audioTask);
  assert.ok(best !== null, 'an audio task on a podcast-only box must resolve a SOP');
  assert.equal(best.id, 'issue12-podcast-only');
});

// ── 4. The FIX-16 firewall survives: unrelated departments never widen ───────
test('[ISSUE-12] an unrelated department NEVER widens (FIX-16 firewall intact)', async () => {
  clearSops();
  insertSop(
    'issue12-webdev-trap',
    'Web Development: New Web Property or Major Feature Launch',
    'issue12-webdev-trap-slug',
    'web-development',
    'web,property,launch,feature,site,new,build,deploy,frontend,website',
  );

  const marketingTask = {
    title: 'New web property launch',
    description: 'Launch a brand-new web property. Build the new site, deploy the feature, go live.',
    department: 'marketing',
  };

  assert.equal(SOP_SIBLING_DEPARTMENTS.marketing, undefined, 'marketing must declare no siblings');
  const suggestions = suggestSOPsForTaskKeyword(marketingTask, 5);
  assert.deepEqual(suggestions, [], 'a marketing task must see an EMPTY pool, not a web-development SOP');

  const best = await getBestSOPForTask(marketingTask);
  assert.equal(best, null, 'no sibling craft exists for marketing, so null is the correct answer');
});

// ── 5. The department-less floor still comes first ───────────────────────────
test('[ISSUE-12] a department-less SOP keeps the pool non-empty, so the widening does not fire', async () => {
  clearSops();
  insertSop(
    'issue12-generic',
    'General: Production Checklist',
    'issue12-generic-slug',
    null,
    'episode,show,record,publish',
  );
  insertSop(
    'issue12-audio-present',
    'Audio: Session Production',
    'issue12-audio-present-slug',
    'audio',
    'episode,show,record,publish,edit,mix',
  );

  const suggestions = suggestSOPsForTaskKeyword(EPISODE_TASK, 5);
  const ids = suggestions.map((s) => s.sop.id);
  assert.ok(ids.includes('issue12-generic'), 'the department-less floor must still be reachable');
  assert.ok(
    !ids.includes('issue12-audio-present'),
    'the sibling must NOT be admitted while the owning pool has the department-less floor in it',
  );
});

// ── 6. The sibling credit alone cannot attach an irrelevant SOP ──────────────
test('[ISSUE-12] a sibling SOP with no textual relevance still resolves to null', async () => {
  clearSops();
  insertSop(
    'issue12-audio-irrelevant',
    'Audio: Studio Hardware Inventory',
    'issue12-audio-irrelevant-slug',
    'audio',
    'preamp,cable,microphone,stand,inventory',
  );

  const suggestions = suggestSOPsForTaskKeyword(EPISODE_TASK, 5);
  if (suggestions.length > 0) {
    assert.ok(
      suggestions[0].score < 0.5,
      `a sibling with zero keyword overlap must score below the 0.5 threshold, got ${suggestions[0].score}`,
    );
  }
  const best = await getBestSOPForTask(EPISODE_TASK);
  assert.equal(
    best,
    null,
    'kinship between departments is not a reason to attach an unrelated SOP',
  );
});
