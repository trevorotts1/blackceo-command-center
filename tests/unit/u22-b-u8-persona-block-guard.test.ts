/**
 * U22 / B-U8 — Guards + fixtures + ONE end-to-end operator-box proof run for
 * the whole Skill-6 persona-unification block (master spec crosswalk B/B-U8).
 *
 * This is the Command-Center-side HALF of the cross-repo block proof. Its
 * companion, `openclaw-onboarding/06-ghl-install-pages/scripts/
 * prove_skill6_block_u22.py`, threads the SAME bundle voice persona id
 * (`hormozi-100m-offers`, see BUNDLE_VOICE_PERSONA_ID below) through the
 * producer side (B-U1 bundle ladder -> B-U2 per-page directives -> B-U3
 * copy-stage log -> B-U5 FAB-QC D4 grounding). This file proves the SAME
 * literal, threaded declared-vs-used through the comparator
 * (`src/lib/persona-mismatch.ts`, B-U6/U20) yields ZERO `persona_mismatch`
 * events on agreement — closing the loop end-to-end across both repos.
 *
 * This is a REGRESSION GUARD (mirrors openclaw-onboarding's
 * `scripts/guard-fab-qc-gate.sh` in spirit): it pins the comparator's
 * discriminator contract and its agreement/divergence invariant so a future
 * change to `persona-mismatch.ts` cannot silently start firing false
 * mismatches (or silently stop firing real ones) without failing CI. It is
 * a companion to — not a duplicate of — the full HTTP-route contract test
 * `tests/unit/u20-b-u6-persona-mismatch-contract.test.ts`, which already
 * covers the POST/GET route pair, the CreateActivitySchema object-metadata
 * fix, and 3x-repeat idempotency in detail.
 *
 * Keep BUNDLE_VOICE_PERSONA_ID in lockstep with the ONB script's own
 * `BUNDLE_VOICE_PERSONA_ID` constant if either ever changes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-u22-persona-block-guard-'));
const TMP_DB = path.join(TMP_DIR, 'mission-control.test.db');
process.env.DATABASE_PATH = TMP_DB;

type DbModule = typeof import('../../src/lib/db');
let run: DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb: DbModule['closeDb'];
let getDb: DbModule['getDb'];

type PersonaMismatchModule = typeof import('../../src/lib/persona-mismatch');
let recordPersonaUsedAndCompare: PersonaMismatchModule['recordPersonaUsedAndCompare'];
let getOpenPersonaMismatch: PersonaMismatchModule['getOpenPersonaMismatch'];
let isPersonaUsedReport: PersonaMismatchModule['isPersonaUsedReport'];

// The ONE bundle voice id the ONB producer-side proof
// (prove_skill6_block_u22.py) threads through B-U1/B-U2/B-U3/B-U5. Proving
// the comparator agrees on THIS SAME value is what makes the two proofs one
// end-to-end block proof rather than two unrelated fixtures.
const BUNDLE_VOICE_PERSONA_ID = 'hormozi-100m-offers';

let taskCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++taskCounter}-${Date.now()}`;
}

function insertBlendedTask(id: string, voicePersonaId: string) {
  const now = new Date().toISOString();
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, voice_persona_id, created_at, updated_at)
     VALUES (?, ?, 'in_progress', 'medium', NULL, NULL, ?, ?, ?)`,
    [id, `U22 block-proof task ${id}`, voicePersonaId, now, now],
  );
}

function countMismatchEvents(taskId: string): number {
  const row = queryOne<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events WHERE type = 'persona_mismatch' AND task_id = ?`,
    [taskId],
  );
  return row?.c ?? 0;
}

test.before(async () => {
  const db = await import('../../src/lib/db');
  run = db.run;
  queryOne = db.queryOne;
  closeDb = db.closeDb;
  getDb = db.getDb;
  getDb(); // trigger full migration chain against the isolated temp DB

  const pm = await import('../../src/lib/persona-mismatch');
  recordPersonaUsedAndCompare = pm.recordPersonaUsedAndCompare;
  getOpenPersonaMismatch = pm.getOpenPersonaMismatch;
  isPersonaUsedReport = pm.isPersonaUsedReport;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('[U22/B-U8] isPersonaUsedReport discriminator contract is stable', () => {
  assert.equal(isPersonaUsedReport({ kind: 'persona_used', voice_persona_id: 'x' }), true);
  assert.equal(isPersonaUsedReport({ kind: 'something_else' }), false);
  assert.equal(isPersonaUsedReport(null), false);
  assert.equal(isPersonaUsedReport('persona_used'), false);
});

test('[U22/B-U8] the block-proof bundle voice id: declared == used -> ZERO persona_mismatch events (agreement)', () => {
  const taskId = nextId('u22-agree');
  insertBlendedTask(taskId, BUNDLE_VOICE_PERSONA_ID);

  const result = recordPersonaUsedAndCompare(taskId, {
    kind: 'persona_used',
    page: 'optin',
    voice_persona_id: BUNDLE_VOICE_PERSONA_ID,
    topic_persona_id: 'miller-building-storybrand',
    task_persona_id: BUNDLE_VOICE_PERSONA_ID,
    blend_directive_sha: 'u22-block-proof-sha',
    goal: 'book-a-call',
  });

  assert.equal(result, null, 'agreement must render nothing (no PersonaMismatchInfo returned)');
  assert.equal(countMismatchEvents(taskId), 0, 'agreement must write ZERO persona_mismatch events');
  assert.equal(
    getOpenPersonaMismatch(taskId), null,
    'the kanban-card chip must show no open mismatch on agreement',
  );
});

test('[U22/B-U8] mutation self-test — a REAL divergence must still fire exactly ONE event (the guard bites)', () => {
  // Proves the agreement test above is actually exercising the comparator's
  // real logic, not a stub that always returns null — the same discipline
  // this repo's other guards (e.g. the ceo-chat-color-gate mutation
  // self-test) apply before trusting a clean verdict.
  const taskId = nextId('u22-diverge');
  insertBlendedTask(taskId, BUNDLE_VOICE_PERSONA_ID);

  const divergentVoice = 'wiebe-copy-hackers';
  assert.notEqual(divergentVoice, BUNDLE_VOICE_PERSONA_ID);

  const result = recordPersonaUsedAndCompare(taskId, {
    kind: 'persona_used',
    page: 'optin',
    voice_persona_id: divergentVoice,
  });

  assert.ok(result, 'a real divergence must return a PersonaMismatchInfo');
  assert.equal(result?.declared_voice_persona_id, BUNDLE_VOICE_PERSONA_ID);
  assert.equal(result?.used_voice_persona_id, divergentVoice);
  assert.equal(countMismatchEvents(taskId), 1, 'exactly ONE persona_mismatch event, never silent, never duplicated');

  const chip = getOpenPersonaMismatch(taskId);
  assert.ok(chip, 'the kanban-card chip must surface the open mismatch');
  assert.equal(chip?.declared_voice_persona_id, BUNDLE_VOICE_PERSONA_ID);
  assert.equal(chip?.used_voice_persona_id, divergentVoice);
});
