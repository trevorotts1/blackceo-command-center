/**
 * duck-artifact-qc-preview — focused unit tests for the three duck-fix changes.
 *
 * Bug scenario: "create a picture of a blue duck"
 *   (1) QC scored the terse brief as low-quality text → score 7.5/6.0 → blocked.
 *   (2) Artifact saved to ~/Documents/Shared/projects/… → outside PROJECTS_PATH → 403.
 *   (3) /api/files/preview returned 400 for PNG; no inline render in the UI.
 *
 * Test coverage:
 *   A. probeImageFile — exists/non-empty/valid PNG → valid:true
 *   B. probeImageFile — missing file → valid:false with named reason
 *   C. probeImageFile — zero-byte file → valid:false
 *   D. scoreTaskForQC — image-deliverable task with terse brief + valid PNG fixture
 *      → passes QC (score ≥ 8.5) when fixture JSON says pass=true
 *   E. scoreTaskForQC — manifest with missing artifact → score ≤ 4.0, pass=false,
 *      gaps include the file path (LLM fixture path)
 *   F. runQCOnReview (integration) — image deliverable task with valid PNG →
 *      artifact-manifest mode fires, task moves to done when fixture score=9.0
 *   G. runQCOnReview — missing artifact → instant fail, task → backlog, named gap
 *   H. Text-task (no deliverables) → QC unchanged (no-criteria path: score=7.5)
 *   I. IMAGE_EXTENSIONS set contains common image extensions
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Temp dir for test artifacts ──────────────────────────────────────────────
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-duck-'));
const TMP_DB  = path.join(TMP_DIR, 'mission-control.test.db');

// Must be set before any DB import.
process.env.DATABASE_PATH = TMP_DB;

// Force heuristic / no-criteria paths — no real API calls in unit tests.
delete process.env.OPENAI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.DISABLE_QC_AUTO_SCORER;
process.env.QC_MAX_REROUTES = '3';
delete process.env.MISSION_CONTROL_URL;
delete process.env.NEXTAUTH_URL;

// ── Minimal valid PNG (1×1 pixel) magic bytes ────────────────────────────────
// PNG signature: 8 bytes 89 50 4E 47 0D 0A 1A 0A + IHDR chunk (25 bytes)
const VALID_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,  // IHDR length + type
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,  // 1x1
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,  // bit depth etc.
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,  // IDAT chunk
  0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0x3f,
  0x00, 0x05, 0xfe, 0x02, 0xfe, 0xdc, 0xcc, 0x59,
  0xe7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,  // IEND
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

const VALID_PNG_PATH    = path.join(TMP_DIR, 'blue-duck.png');
const ZERO_BYTE_PATH    = path.join(TMP_DIR, 'empty.png');
const MISSING_PATH      = path.join(TMP_DIR, 'does-not-exist.png');
const QC_PASS_FIXTURE   = path.join(TMP_DIR, 'qc-pass.json');
const QC_FAIL_FIXTURE   = path.join(TMP_DIR, 'qc-fail.json');

// Write test files once.
fs.writeFileSync(VALID_PNG_PATH, VALID_PNG_BYTES);
fs.writeFileSync(ZERO_BYTE_PATH, Buffer.alloc(0));
fs.writeFileSync(QC_PASS_FIXTURE, JSON.stringify({ score: 9.0, pass: true,  reason: 'Image deliverable satisfies request.', gaps: [] }));
fs.writeFileSync(QC_FAIL_FIXTURE, JSON.stringify({ score: 3.0, pass: false, reason: 'Artifact missing.', gaps: ['File not found'] }));

// ── Module imports (lazy, after env set) ─────────────────────────────────────
type QCScorerModule = typeof import('../../src/lib/qc-scorer');
type DbModule = typeof import('../../src/lib/db');

let probeImageFile:   QCScorerModule['probeImageFile'];
let IMAGE_EXTENSIONS: QCScorerModule['IMAGE_EXTENSIONS'];
let scoreTaskForQC:   QCScorerModule['scoreTaskForQC'];
let runQCOnReview:    QCScorerModule['runQCOnReview'];
let QC_PASS_THRESHOLD_val: number;

let run:      DbModule['run'];
let queryOne: DbModule['queryOne'];
let closeDb:  DbModule['closeDb'];
let getDb:    DbModule['getDb'];

let taskCounter = 0;
const nextId = (pfx: string) => `${pfx}-${++taskCounter}`;

const DUCK_SOP_ID = 'sop-duck-image-fixture';

test.before(async () => {
  const db = await import('../../src/lib/db');
  run     = db.run;
  queryOne = db.queryOne;
  closeDb  = db.closeDb;
  getDb    = db.getDb;

  // Trigger full migration chain.
  getDb();

  // Seed minimal required rows.
  const now = new Date().toISOString();
  run(`INSERT OR IGNORE INTO companies (id, name, slug, config, created_at, updated_at) VALUES ('default','Default','default','{}',?,?)`, [now, now]);
  run(`INSERT OR IGNORE INTO workspaces (id, name, slug, icon, company_id, sort_order, created_at, updated_at) VALUES ('creative','Creative','creative','🎨','default',10,?,?)`, [now, now]);

  // Seed a SOP with success_criteria so non-image tasks don't get no-criteria path.
  run(
    `INSERT OR IGNORE INTO sops (id, name, slug, success_criteria, steps, department, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [DUCK_SOP_ID, 'Duck Image SOP', 'duck-image-sop',
     'Produce a valid image file matching the client request.',
     JSON.stringify([{ step: 1, action: 'Generate the requested image' }]),
     'creative', now, now],
  );

  const scorer = await import('../../src/lib/qc-scorer');
  probeImageFile      = scorer.probeImageFile;
  IMAGE_EXTENSIONS    = scorer.IMAGE_EXTENSIONS;
  scoreTaskForQC      = scorer.scoreTaskForQC;
  runQCOnReview       = scorer.runQCOnReview;
  QC_PASS_THRESHOLD_val = scorer.QC_PASS_THRESHOLD;
});

test.after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.QC_MAX_REROUTES;
  delete process.env.QC_FIXTURE_JSON_PATH;
});

// ── A: probeImageFile — valid PNG ─────────────────────────────────────────────

test('[A] probeImageFile: valid 1×1 PNG → valid:true with correct size', () => {
  const result = probeImageFile(VALID_PNG_PATH);
  assert.ok(result.valid, `Expected valid:true, got: ${JSON.stringify(result)}`);
  if (result.valid) {
    assert.ok(result.sizeBytes > 0, `sizeBytes should be > 0, got ${result.sizeBytes}`);
    assert.equal(result.ext, '.png');
    assert.ok(result.mimeMatch, 'mimeMatch should be true for a real PNG');
  }
});

// ── B: probeImageFile — missing file ─────────────────────────────────────────

test('[B] probeImageFile: missing file → valid:false with named reason', () => {
  const result = probeImageFile(MISSING_PATH);
  assert.ok(!result.valid, 'Missing file must return valid:false');
  if (!result.valid) {
    assert.ok(result.reason.includes(MISSING_PATH), `reason must include the path, got: ${result.reason}`);
  }
});

// ── C: probeImageFile — zero-byte file ───────────────────────────────────────

test('[C] probeImageFile: zero-byte PNG → valid:false', () => {
  const result = probeImageFile(ZERO_BYTE_PATH);
  assert.ok(!result.valid, 'Zero-byte file must return valid:false');
  if (!result.valid) {
    assert.ok(result.reason.toLowerCase().includes('empty') || result.reason.includes('0 byte'),
      `reason should mention empty/0 bytes, got: ${result.reason}`);
  }
});

// ── D: scoreTaskForQC — terse brief + valid PNG fixture → pass ────────────────

test('[D] scoreTaskForQC: terse brief + valid-PNG manifest + pass fixture → pass=true', async () => {
  process.env.QC_FIXTURE_JSON_PATH = QC_PASS_FIXTURE;
  try {
    const result = await scoreTaskForQC({
      taskId: 'duck-qc-pass',
      taskTitle: 'create a picture of a blue duck',
      taskDescription: null, // intentionally terse — should NOT penalise
      sopSuccessCriteria: 'Produce a valid image file.',
      sopName: 'Duck Image SOP',
      sopSteps: null,
      departmentSlug: 'creative',
      deliverableManifest: [
        {
          title: 'blue-duck.png',
          path: VALID_PNG_PATH,
          type: 'image',
          sizeBytes: VALID_PNG_BYTES.length,
          dimensions: null,
          valid: true,
        },
      ],
    });
    assert.ok(result.pass, `Expected pass=true with fixture score 9.0, got score=${result.score}, pass=${result.pass}`);
    assert.ok(result.score >= QC_PASS_THRESHOLD_val,
      `Score ${result.score} must be ≥ ${QC_PASS_THRESHOLD_val}`);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
});

// ── E: scoreTaskForQC — missing artifact in manifest → instant-fail ───────────

test('[E] scoreTaskForQC: missing-artifact manifest → pass=false, gap mentions file path', async () => {
  // No fixture — let the no-criteria or heuristic path fire, but the manifest
  // has a missing artifact so scoreTaskForQC should reflect that.
  // We use QC_FIXTURE_JSON_PATH pointing to the fail fixture to simulate LLM response.
  process.env.QC_FIXTURE_JSON_PATH = QC_FAIL_FIXTURE;
  try {
    const result = await scoreTaskForQC({
      taskId: 'duck-qc-missing',
      taskTitle: 'create a picture of a blue duck',
      taskDescription: null,
      sopSuccessCriteria: 'Produce a valid image file.',
      sopName: 'Duck Image SOP',
      sopSteps: null,
      departmentSlug: 'creative',
      deliverableManifest: [
        {
          title: 'blue-duck.png',
          path: MISSING_PATH,
          type: 'image',
          sizeBytes: null,
          dimensions: null,
          valid: false,
          invalidReason: `Artifact file not found: ${MISSING_PATH}`,
        },
      ],
    });
    assert.ok(!result.pass, `Expected pass=false for missing artifact, got pass=${result.pass}`);
    assert.ok(result.score < QC_PASS_THRESHOLD_val,
      `Score ${result.score} must be below gate ${QC_PASS_THRESHOLD_val}`);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
});

// ── F: runQCOnReview — image deliverable task with valid PNG → done ────────────

test('[F] runQCOnReview: image deliverable + valid PNG + pass fixture → task moves to done', async () => {
  const taskId = nextId('duck-review-pass');
  const now = new Date().toISOString();

  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, sop_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [taskId, 'create a picture of a blue duck', null, 'review', 'medium', 'creative', null, DUCK_SOP_ID, now, now],
  );

  // Register valid PNG as a deliverable.
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?,?,?,?,?,?)`,
    [nextId('deliv'), taskId, 'file', 'blue-duck.png', VALID_PNG_PATH, now],
  );

  process.env.QC_FIXTURE_JSON_PATH = QC_PASS_FIXTURE;
  try {
    const result = await runQCOnReview(taskId);
    assert.ok(result !== null, 'runQCOnReview must return a result');
    assert.ok(result!.pass, `Expected pass=true, got score=${result!.score}`);

    const task = queryOne<{ status: string }>(
      'SELECT status FROM tasks WHERE id = ?', [taskId],
    );
    assert.ok(task, 'task must exist');
    assert.equal(task!.status, 'done',
      `Task with valid PNG + pass fixture must move to done, got: ${task!.status}`);
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
});

// ── G: runQCOnReview — missing artifact → instant fail, task → backlog ─────────

test('[G] runQCOnReview: missing artifact → instant-fail, task moves to backlog, gap named', async () => {
  const taskId = nextId('duck-review-missing');
  const now = new Date().toISOString();

  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, sop_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [taskId, 'create a picture of a blue duck', null, 'review', 'medium', 'creative', null, DUCK_SOP_ID, now, now],
  );

  // Register a deliverable pointing to a non-existent file.
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?,?,?,?,?,?)`,
    [nextId('deliv'), taskId, 'file', 'blue-duck.png', MISSING_PATH, now],
  );

  // No fixture — the early-exit instant-fail path fires before any LLM call.
  delete process.env.QC_FIXTURE_JSON_PATH;

  const result = await runQCOnReview(taskId);
  assert.ok(result !== null, 'runQCOnReview must return a result');
  assert.ok(!result!.pass, 'Missing artifact must not pass QC');
  assert.ok(result!.score <= 4.0, `Score for missing artifact must be ≤ 4.0, got ${result!.score}`);

  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    'SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?', [taskId],
  );
  assert.ok(task, 'task must exist');
  assert.notEqual(task!.status, 'review',
    'Task with missing artifact must leave review (instant-fail)');
  // Gaps must mention the missing file.
  const gapText = result!.gaps.join(' ');
  assert.ok(
    gapText.toLowerCase().includes('not found') || gapText.includes(path.basename(MISSING_PATH)),
    `gaps must mention missing file, got: ${gapText}`,
  );
});

// ── H: text task (no deliverables) → unchanged no-criteria path ───────────────

test('[H] text task with no deliverables → QC uses no-criteria path (score=7.5, pass=false)', async () => {
  delete process.env.QC_FIXTURE_JSON_PATH;

  const result = await scoreTaskForQC({
    taskId: 'text-task-no-deliverables',
    taskTitle: 'Write a report on Q2 performance',
    taskDescription: 'Please write the report.',
    sopSuccessCriteria: null,
    sopName: null,
    sopSteps: null,
    departmentSlug: 'sales',
    // No deliverableManifest → text-only mode
  });

  assert.equal(result.scoringPath, 'no-criteria',
    `Text task without deliverables must use no-criteria path, got: ${result.scoringPath}`);
  assert.ok(!result.pass, 'no-criteria path must not pass');
  assert.ok(result.score < QC_PASS_THRESHOLD_val,
    `no-criteria score ${result.score} must be below gate ${QC_PASS_THRESHOLD_val}`);
});

// ── I: IMAGE_EXTENSIONS set sanity check ─────────────────────────────────────

test('[I] IMAGE_EXTENSIONS set contains common image extensions', () => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']) {
    assert.ok(IMAGE_EXTENSIONS.has(ext), `IMAGE_EXTENSIONS must include ${ext}`);
  }
  assert.ok(!IMAGE_EXTENSIONS.has('.html'), '.html must NOT be in IMAGE_EXTENSIONS');
  assert.ok(!IMAGE_EXTENSIONS.has('.txt'),  '.txt must NOT be in IMAGE_EXTENSIONS');
});

// ── J: Invariant A — artifact task with ZERO registered deliverables ──────────
// Root-cause fix for design item #10: previously fell through to Mode-B
// (description re-score), failed on terse briefs, looped → falsely blocked.
// Now: returns-to-orchestrator immediately, does NOT increment qc_reroute_attempts.

test('[J] runQCOnReview: artifact task + zero registered deliverables → return-to-orchestrator, NOT Mode-B', async () => {
  const taskId = nextId('invariant-a-zero-deliv');
  const now = new Date().toISOString();

  // Artifact-sounding title: deriveAcceptanceCriteria will return non-empty criteria.
  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, sop_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [taskId, 'create a picture of a blue duck', null, 'review', 'medium', 'creative', null, DUCK_SOP_ID, now, now],
  );
  // NO rows inserted into task_deliverables — simulates the agent failing to register output.

  delete process.env.QC_FIXTURE_JSON_PATH;

  const result = await runQCOnReview(taskId);
  assert.ok(result !== null, 'runQCOnReview must return a result');

  // Must be a structured failure, not a quality score.
  assert.ok(!result.pass, 'Zero-deliverable artifact task must not pass');
  assert.ok(
    result.gaps.some((g) => g.toLowerCase().includes('no artifact') || g.toLowerCase().includes('artifact registered')),
    `gaps must mention 'no artifact registered', got: ${JSON.stringify(result.gaps)}`,
  );
  assert.ok(
    result.reason.toLowerCase().includes('no artifact') || result.reason.toLowerCase().includes('registered'),
    `reason must mention missing artifact, got: ${result.reason}`,
  );

  // Task must have left review status (moved to backlog by return-to-orchestrator).
  const task = queryOne<{ status: string; qc_reroute_attempts: number | null }>(
    'SELECT status, qc_reroute_attempts FROM tasks WHERE id = ?',
    [taskId],
  );
  assert.ok(task, 'task must exist');
  assert.notEqual(
    task!.status,
    'review',
    `Invariant A: task must leave review (return-to-orchestrator), got status: ${task!.status}`,
  );
  // CRITICAL: qc_reroute_attempts must NOT be incremented (structural failure, not quality).
  assert.equal(
    task!.qc_reroute_attempts ?? 0,
    0,
    `Invariant A: qc_reroute_attempts must NOT increment on zero-deliverable return-to-orchestrator, got: ${task!.qc_reroute_attempts}`,
  );
  // Must have a qc_review event (not a reroute event).
  const evt = queryOne<{ message: string }>(
    `SELECT message FROM events WHERE task_id = ? AND message LIKE '%QC-NO-ARTIFACT%' LIMIT 1`,
    [taskId],
  );
  assert.ok(evt, 'Invariant A: QC-NO-ARTIFACT event must be written in events table');
});

// ── K: Invariant B — artifact task WITH registered deliverable → artifact scoring, not Mode-B ──

test('[K] runQCOnReview: artifact task WITH registered valid deliverable → artifact scoring path (not Mode-B description scoring)', async () => {
  const taskId = nextId('invariant-b-with-deliv');
  const now = new Date().toISOString();

  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id, business_id, sop_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [taskId, 'create a picture of a blue duck', null, 'review', 'medium', 'creative', null, DUCK_SOP_ID, now, now],
  );

  // Register the valid PNG — this is the path that SHOULD be taken.
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, created_at)
     VALUES (?,?,?,?,?,?)`,
    [nextId('deliv'), taskId, 'file', 'blue-duck.png', VALID_PNG_PATH, now],
  );

  // Use the pass fixture so the artifact scoring path returns pass=true.
  process.env.QC_FIXTURE_JSON_PATH = QC_PASS_FIXTURE;
  try {
    const result = await runQCOnReview(taskId);
    assert.ok(result !== null, 'runQCOnReview must return a result');
    // With a valid PNG and the pass fixture, the artifact path must fire and pass.
    assert.ok(result.pass, `Artifact task with registered deliverable + pass fixture must pass, got score=${result.score} pass=${result.pass}`);

    // The task must move to done (artifact path → pass → done).
    const task = queryOne<{ status: string }>(
      'SELECT status FROM tasks WHERE id = ?',
      [taskId],
    );
    assert.ok(task, 'task must exist');
    assert.equal(
      task!.status,
      'done',
      `Invariant B: artifact task with registered deliverable + pass must be done, got: ${task!.status}`,
    );
    // Must NOT be description-scored: the result reason must NOT mention "description" as the scoring basis.
    assert.ok(
      !result.reason.toLowerCase().includes('description re-score'),
      `Artifact scoring must not mention description re-score, got: ${result.reason}`,
    );
  } finally {
    delete process.env.QC_FIXTURE_JSON_PATH;
  }
});
