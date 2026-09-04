/**
 * fix7-engine-deck-done-path.test.ts — FIX 7 "make done reachable from the
 * engine", board side: the engine-owned deck PARENT card is promoted to done
 * by the QC scorer on the DETERMINISTIC artifact checklist — no LLM judge, no
 * human PATCH.
 *
 * The full path this suite proves (the fix's PROOF leg, in-process):
 *
 *   engine close()  →  PATCH {status:'review', process_certificate_sha}
 *                      (cert registered by evaluatePresentationsDoneGate's
 *                      FIX 7 review-registration leg at the PATCH route)
 *                  →  runQCOnReview(parent)
 *                      →  FIX 7 engine-owned deck lane:
 *                          deterministic artifact checklist (existence /
 *                          valid_image / pipeline_complete / coverage —
 *                          vision gates skip without a key)
 *                      →  PASS + registered certificate
 *                      →  transition review→done, actor 'qc-scorer'
 *
 * Sibling legs this suite also pins:
 *   - cert NOT registered  → checklist PASS but card HELD in review
 *     (no silent promotion, no throw)
 *   - no reachable artifact registered → FAIL + reroute (2.0), card leaves
 *     review toward backlog (the engine's own registration failure is loud)
 *   - a junk (non-sha) presented cert on a review PATCH is NOT registered
 *     (U033 fail-closed at review, same as at done)
 *   - a DIFFERENT valid cert against a stored one is a MISMATCH on the
 *     review move (anti-spoof applies from review onward)
 *   - a valid cert presented on the review move IS registered
 *     (persistCert) — the leg the engine PATCH depends on
 *   - build_deck_phase CHILD cards are still skipped before this lane
 *     (FIX 39 untouched)
 *
 * Runs via the Node built-in test runner under tsx, DB-backed on a throwaway
 * DATABASE_PATH (same pattern as maria-pattern-harness.test.ts):
 *
 *   node --import tsx --import ./tests/setup/no-owner-telegram.ts \
 *        --test tests/unit/fix7-engine-deck-done-path.test.ts
 */

// ── env: no notify, no live judge, no fixture vars leaking in ────────────────
process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.QC_JUDGE_MODEL;
delete process.env.OLLAMA_CLOUD_API_KEY;
delete process.env.OLLAMA_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
delete process.env.QC_FIXTURE_JSON_PATH;
delete process.env.QC_SIMULATE_PROVIDER_DOWN;
delete process.env.MC_API_TOKEN;
delete process.env.WEBHOOK_SECRET;
delete process.env.PRESENTATION_RUNS_DIRS;
delete process.env.PRESENTATION_REVIEW_EVIDENCE_GATE;
delete process.env.PRESENTATION_BUNDLE_REVERIFY;
if (process.env.NODE_ENV === 'production') process.env.NODE_ENV = 'test';

import './_isolated-db'; // MUST be first DB-touching import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run, queryOne, queryAll, getDb } from '../../src/lib/db';
import { runQCOnReview } from '../../src/lib/qc-scorer';
import { evaluatePresentationsDoneGate } from '../../src/lib/presentations-cert-gate';

const db = getDb(); // applies the full migration chain on the throwaway DB

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function taskStatus(id: string): string | undefined {
  return queryOne<{ status: string }>('SELECT status FROM tasks WHERE id = ?', [id])?.status;
}

function storedCert(id: string): string | null {
  return (
    queryOne<{ process_certificate_sha: string | null }>(
      'SELECT process_certificate_sha FROM tasks WHERE id = ?',
      [id],
    )?.process_certificate_sha ?? null
  );
}

function eventsFor(taskId: string, type: string) {
  return queryAll<{ message: string }>(
    'SELECT message FROM events WHERE task_id = ? AND type = ? ORDER BY created_at',
    [taskId, type],
  );
}

function seedWorkspace(): string {
  const id = `pres-fix7-${uuidv4().slice(0, 8)}`;
  run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [id, id, id]);
  return id;
}

/**
 * Seed an engine-owned deck PARENT card exactly the way the engine leaves it:
 * source='build_deck', department presentations, status review, an optional
 * registered process certificate.
 */
function seedDeckParent(opts: { cert?: string | null; status?: string }): string {
  const wsId = seedWorkspace();
  const id = uuidv4();
  run(
    `INSERT INTO tasks (id, title, description, status, department, source, workspace_id,
                        process_certificate_sha, updated_at, last_progress_at)
     VALUES (?, ?, ?, ?, 'presentations', 'build_deck', ?, ?, ?, ?)`,
    [
      id,
      'Deck parent (FIX 7 fixture): 12-slide client deck',
      'Deck deliverable for the FIX 7 board-side lane: presentation deck slides webinar.',
      opts.status ?? 'review',
      wsId,
      opts.cert ?? null,
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );
  return id;
}

/**
 * Build a canonical engine run dir on disk with ALL deterministic gates
 * satisfied and register its artifacts as the card's deliverables.
 *
 * Deterministic-path contents (no vision key needed):
 *   - working/research/brief-*.md  with research_complete: true
 *   - working/qc/copy_qc_report.json
 *   - working/checkpoints/media_library.json with a real ghl_folder_id
 *   - intake.json with slide_count_target + client_requested_slide_cap
 *   - the deck .pptx + slide PNG images so countDeckSlides() can count them
 *     (each valid slide image = 1 slide; coverage needs actual ≥ 90% of target
 *     or a client cap)
 */
function seedRunDirWithArtifacts(taskId: string, slides: number): { cleanup: () => void } {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-fix7-deck-run-'));
  const working = path.join(runDir, 'working');
  fs.mkdirSync(path.join(working, 'research'), { recursive: true });
  fs.mkdirSync(path.join(working, 'qc'), { recursive: true });
  fs.mkdirSync(path.join(working, 'checkpoints'), { recursive: true });

  fs.writeFileSync(
    path.join(working, 'research', 'brief-deck.md'),
    '# Research brief\n\nresearch_complete: true\n',
  );
  fs.writeFileSync(
    path.join(working, 'qc', 'copy_qc_report.json'),
    JSON.stringify({ gate: 'Phase 1Q', average: 9.2 }),
  );
  fs.writeFileSync(
    path.join(working, 'checkpoints', 'media_library.json'),
    JSON.stringify({ version_number: 1, ghl_folder_id: 'fold_fix7' }),
  );
  fs.writeFileSync(
    path.join(runDir, 'intake.json'),
    JSON.stringify({
      slide_count_target: slides,
      client_requested_slide_cap: slides,
      source_line_count: 120,
    }),
  );

  const delivDir = path.join(runDir, 'deliverables');
  fs.mkdirSync(delivDir, { recursive: true });

  // The deck .pptx (deck-shaped, bundle path so probe coverage is honest —
  // floors are enforced by bundle re-verification only under a size floor of
  // 1 MiB for pptx, so write a real PK-headered file of sufficient size).
  const pptxBytes = Buffer.concat([
    Buffer.from('PK', 'binary'),
    Buffer.alloc(1_100_000, 0x41),
  ]);
  fs.writeFileSync(path.join(delivDir, 'DECK-FINAL.pptx'), pptxBytes);

  // Slide renders: N valid PNGs — countDeckSlides counts valid images.
  const png = Buffer.concat([
    Buffer.from('\x89PNG', 'binary'),
    Buffer.alloc(2048, 0x42),
  ]);
  for (let i = 0; i < slides; i++) {
    fs.writeFileSync(path.join(delivDir, `slide-${String(i + 1).padStart(2, '0')}.png`), png);
  }

  // Register EVERY artifact as a file deliverable on the card (the engine's
  // close() does one POST per file; the manifest builder reads them all).
  const register = (file: string) => {
    run(
      `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
       VALUES (?, ?, 'file', ?, ?, ?)`,
      [uuidv4(), taskId, file, path.join(delivDir, file), new Date().toISOString()],
    );
  };
  register('DECK-FINAL.pptx');
  for (let i = 0; i < slides; i++) {
    register(`slide-${String(i + 1).padStart(2, '0')}.png`);
  }

  return { cleanup: () => fs.rmSync(runDir, { recursive: true, force: true }) };
}

// ============================================================================
// (1) FULL PATH — checklist PASS + registered certificate → done, actor
//     qc-scorer. The fix's headline: a completed run's parent card reaches
//     done without a human PATCH.
// ============================================================================
test('FIX 7 full path: engine parent card reaches done via runQCOnReview with registered cert, no human PATCH', async () => {
  const id = seedDeckParent({ cert: SHA_A });
  const { cleanup } = seedRunDirWithArtifacts(id, 12);
  try {
    assert.equal(taskStatus(id), 'review', 'fixture: card starts in review (engine close landed)');

    const result = await runQCOnReview(id);
    assert.ok(result, 'FIX 7: runQCOnReview must return a verdict for the deck parent');
    assert.equal(result?.pass, true, `checklist must PASS on a fully-populated run: ${result?.reason}`);

    assert.equal(
      taskStatus(id),
      'done',
      'FIX 7 headline: the parent card reached done WITHOUT a human PATCH',
    );

    // Actor: qc-scorer (the fix's HOW names the actor).
    const audit = queryOne<{ from_status: string; to_status: string; actor: string }>(
      'SELECT from_status, to_status, actor FROM task_events WHERE task_id = ? ORDER BY created_at DESC LIMIT 1',
      [id],
    );
    assert.equal(audit?.from_status, 'review', 'audit origin is review');
    assert.equal(audit?.to_status, 'done', 'audit destination is done');
    assert.equal(audit?.actor, 'qc-scorer', 'FIX 7: promotion actor is qc-scorer');

    // task_qc_results row written and passed (the proof's second SQL leg).
    const qcRow = queryOne<{ passed: number }>(
      'SELECT passed FROM task_qc_results WHERE task_id = ? ORDER BY scored_at DESC LIMIT 1',
      [id],
    );
    assert.equal(qcRow?.passed, 1, 'a passing task_qc_results row exists (passed=1)');

    // Audit event names the deterministic lane.
    const qcEvents = eventsFor(id, 'qc_review').map((e) => e.message).join('\n');
    assert.match(qcEvents, /FIX 7 deterministic artifact checklist PASS/);
    assert.match(qcEvents, /path:llm/);
  } finally {
    cleanup();
  }
});

// ============================================================================
// (2) PASS but NO registered certificate → HELD in review (fail-closed).
// ============================================================================
test('FIX 7 hold: checklist PASS without a registered certificate HOLDS the card in review', async () => {
  const id = seedDeckParent({ cert: null });
  const { cleanup } = seedRunDirWithArtifacts(id, 12);
  try {
    const result = await runQCOnReview(id);
    assert.ok(result?.pass, 'the checklist itself passes (artifact path is sound)');
    assert.equal(
      taskStatus(id),
      'review',
      'no registered certificate ⇒ the card is HELD in review, never silently promoted',
    );
    const qcEvents = eventsFor(id, 'qc_review').map((e) => e.message).join('\n');
    assert.match(
      qcEvents,
      /PASS but held in review.*requires a registered process_certificate_sha/,
      'the hold event names the missing registered certificate',
    );
  } finally {
    cleanup();
  }
});

// ============================================================================
// (3) FAIL — nothing reachable registered → reroute/blocked, loud event.
// ============================================================================
test('FIX 7 no-evidence: a parent card with no reachable artifact fails and reroutes (2.0)', async () => {
  const id = seedDeckParent({ cert: SHA_A });
  try {
    const result = await runQCOnReview(id);
    assert.ok(result);
    assert.equal(result?.pass, false, 'no reachable artifact ⇒ FAIL');
    assert.equal(result?.score, 2.0, 'the no-evidence verdict scores 2.0');
    const qcEvents = eventsFor(id, 'qc_review').map((e) => e.message).join('\n');
    assert.match(qcEvents, /\[QC-DECK-NO-EVIDENCE\]/);
    // rerouteOrBlock moved it out of review (attempts < cap ⇒ backlog), or
    // blocked it at cap. Either way review is NOT a parking spot for this lane.
    assert.notEqual(taskStatus(id), 'review', 'a no-evidence parent never stays parked in review');
  } finally {
    // nothing to clean
  }
});

// ============================================================================
// (4) Review-move certificate registration semantics (the engine PATCH leg).
// ============================================================================
test('FIX 7 review-registration: a VALID cert presented on a review move is registered (persistCert)', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'in_progress',
    targetStatus: 'review',
    storedCert: null,
    providedCert: SHA_A,
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, true);
  assert.equal(r.persistCert, SHA_A, 'the engine PATCH registers the run certificate at review');
});

test('FIX 7 review-registration: junk cert on a review move is NOT registered (U033 fail-closed)', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'in_progress',
    targetStatus: 'review',
    storedCert: null,
    providedCert: 'not-a-sha',
  });
  assert.equal(r.applies, false, 'junk is not a registration attempt — nothing happens');
  assert.equal(r.persistCert ?? null, null);
});

test('FIX 7 review-registration: a DIFFERENT valid cert against a stored one is a MISMATCH (anti-spoof at review)', () => {
  const r = evaluatePresentationsDoneGate({
    department: 'presentations',
    currentStatus: 'in_progress',
    targetStatus: 'review',
    storedCert: SHA_A,
    providedCert: SHA_B,
  });
  assert.equal(r.applies, true);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'process_certificate_mismatch');
});

// ============================================================================
// (5) FIX 39 child skip is untouched: build_deck_phase cards never enter the
//     FIX 7 lane (they are skipped BEFORE it, with one [QC-ENGINE-OWNED]
//     event and no status change).
// ============================================================================
test('FIX 7 coexists with FIX 39: build_deck_phase child stays skipped, status unchanged', async () => {
  const id = uuidv4();
  const wsId = seedWorkspace();
  run(
    `INSERT INTO tasks (id, title, status, department, source, workspace_id, updated_at, last_progress_at)
     VALUES (?, ?, 'review', 'presentations', 'build_deck_phase', ?, ?, ?)`,
    [id, 'Phase child (FIX 39 fixture)', wsId, new Date().toISOString(), new Date().toISOString()],
  );
  try {
    const result = await runQCOnReview(id);
    assert.equal(result, null, 'FIX 39 skip returns null — no verdict, no scoring');
    assert.equal(taskStatus(id), 'review', 'child status untouched');
    const qcEvents = eventsFor(id, 'qc_review').map((e) => e.message).join('\n');
    assert.match(qcEvents, /\[QC-ENGINE-OWNED\]/, 'the loud engine-owned skip event is written');
  } finally {
    // nothing to clean
  }
});
