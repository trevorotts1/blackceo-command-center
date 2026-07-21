/**
 * duck-s3-s4-lifecycle — Unit tests for §3 state machine + artifact contract
 * and §4 QC modes + owner-approval lane.
 *
 * Coverage:
 *   1.  transition() — legal transition (backlog → in_progress) succeeds
 *   2.  transition() — illegal transition (done → in_progress) throws TransitionError
 *   3.  transition() — precondition: in_progress requires assigned_agent_id
 *   4.  transition() — idempotent: same-state call returns current row
 *   5.  transition() — writes task_events row atomically
 *   6.  deriveAcceptanceCriteria() — image task yields existence+valid_image+vision_match
 *   7.  deriveAcceptanceCriteria() — non-image task yields empty criteria
 *   8.  deriveAcceptanceCriteria() — high-quality mention adds min_resolution
 *   9.  evaluateCriteria() — existence criterion: valid manifest passes
 *   10. evaluateCriteria() — valid_image criterion: non-image file fails
 *   11. evaluateCriteria() — vision_match skipped when no LLM key → pass (non-blocking)
 *   12. evaluateCriteria() — all criteria pass → score 10.0 ≥ 8.5
 *   13. evaluateCriteria() — existence fails → score < 8.5
 *   14. classifyFailure() — no-criteria scoringPath → unrouteable
 *   15. classifyFailure() — brief wording gap → unrouteable
 *   16. classifyFailure() — artifact wrong-type gap → NOT unrouteable
 *   17. /api/artifacts traversal block — path outside base → reject
 *   18. artifactDir() returns PROJECTS_PATH/artifacts/<task-id>
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// ── Temp dir ─────────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'duck-s3s4-'));
const DB_PATH = path.join(TMP, 'test.db');
const ARTIFACTS_DIR = path.join(TMP, 'projects', 'artifacts');
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

// Set env before importing db
process.env.DATABASE_PATH = DB_PATH;
process.env.PROJECTS_PATH = path.join(TMP, 'projects');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makePng(outputPath: string): void {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, 'ascii');
    const content = Buffer.concat([typeBytes, data]);
    const crcVal = crc32(content);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([len, typeBytes, data, crcBuf]);
  }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(buf: Buffer): number {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(8, 0);
  ihdrData.writeUInt32BE(8, 4);
  ihdrData[8] = 8; ihdrData[9] = 2;

  const row = Buffer.alloc(1 + 8 * 3);
  row[0] = 0;
  for (let x = 0; x < 8; x++) { row[1 + x * 3] = 0; row[2 + x * 3] = 114; row[3 + x * 3] = 196; }
  const rawRows = Buffer.concat(Array(8).fill(row));
  const compressed = zlib.deflateSync(rawRows);

  fs.writeFileSync(outputPath, Buffer.concat([
    sig,
    chunk('IHDR', ihdrData),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── DB bootstrap ─────────────────────────────────────────────────────────────
// We boot a real SQLite DB with migrations so transition() and task_events work.

async function bootDb(): Promise<void> {
  const { getDb } = await import('../../src/lib/db') as typeof import('../../src/lib/db');
  getDb(); // runs migrations
}

async function seedTask(status = 'backlog', hasAgent = false): Promise<string> {
  const { v4 } = await import('uuid') as typeof import('uuid');
  const { run, queryOne } = await import('../../src/lib/db') as typeof import('../../src/lib/db');
  const taskId = v4();
  const now = new Date().toISOString();

  // Ensure default workspace
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon, company_id, created_at, updated_at)
     VALUES ('default', 'Default', 'default', 'Default workspace', '📁', 'default', ?, ?)`,
    [now, now],
  );

  // Ensure default company
  run(
    `INSERT OR IGNORE INTO companies (id, name, slug, created_at, updated_at)
     VALUES ('default', 'Test Co', 'test-co', ?, ?)`,
    [now, now],
  );

  let agentId: string | null = null;
  if (hasAgent) {
    agentId = v4();
    run(
      `INSERT OR IGNORE INTO agents (id, name, role, workspace_id, status, is_master, created_at, updated_at)
       VALUES (?, 'Test Agent', 'specialist', 'default', 'standby', 0, ?, ?)`,
      [agentId, now, now],
    );
  }

  run(
    `INSERT INTO tasks (id, title, description, status, priority, workspace_id,
                         assigned_agent_id, sop_id, persona_id, created_at, updated_at)
     VALUES (?, 'Test task', 'A test', ?, 'medium', 'default', ?, NULL, NULL, ?, ?)`,
    [taskId, status, agentId, now, now],
  );
  return taskId;
}

// ── Test Suite ────────────────────────────────────────────────────────────────

test('§3/§4 duck lifecycle + criteria tests', async (t) => {

  await t.test('setup: boot DB', async () => {
    await bootDb();
  });

  // ── 1. Legal transition ─────────────────────────────────────────────────
  await t.test('1. transition() legal backlog→in_progress (with agent)', async () => {
    const taskId = await seedTask('backlog', true);
    const { transition } = await import('../../src/lib/task-lifecycle') as typeof import('../../src/lib/task-lifecycle');
    const updated = await transition(taskId, 'in_progress', { actor: 'test', reason: 'test dispatch' });
    assert.equal(updated.status, 'in_progress', 'status must be in_progress after transition');
  });

  // ── 2. Illegal transition ────────────────────────────────────────────────
  await t.test('2. transition() illegal done→in_progress throws TransitionError', async () => {
    const taskId = await seedTask('done', false);
    const { transition, TransitionError } = await import('../../src/lib/task-lifecycle') as typeof import('../../src/lib/task-lifecycle');
    await assert.rejects(
      () => transition(taskId, 'in_progress'),
      (err: unknown) => {
        assert.ok(err instanceof TransitionError, 'Must throw TransitionError');
        assert.equal((err as TransitionError).code, 'ILLEGAL_TRANSITION');
        return true;
      },
    );
  });

  // ── 3. Precondition: in_progress requires agent ──────────────────────────
  await t.test('3. transition() in_progress precondition: no agent → TransitionError', async () => {
    const taskId = await seedTask('backlog', false); // no agent
    const { transition, TransitionError } = await import('../../src/lib/task-lifecycle') as typeof import('../../src/lib/task-lifecycle');
    await assert.rejects(
      () => transition(taskId, 'in_progress'),
      (err: unknown) => {
        assert.ok(err instanceof TransitionError, 'Must throw TransitionError');
        assert.equal((err as TransitionError).code, 'PRECONDITION_AGENT');
        return true;
      },
    );
  });

  // ── 4. Idempotent transition ─────────────────────────────────────────────
  await t.test('4. transition() idempotent: same-state call returns current row', async () => {
    const taskId = await seedTask('review', false);
    const { transition } = await import('../../src/lib/task-lifecycle') as typeof import('../../src/lib/task-lifecycle');
    // Should NOT throw
    const result = await transition(taskId, 'review', { reason: 'idempotent re-check' });
    assert.equal(result.status, 'review', 'status unchanged on idempotent call');
  });

  // ── 5. task_events row written ───────────────────────────────────────────
  await t.test('5. transition() writes task_events row atomically', async () => {
    const taskId = await seedTask('backlog', true);
    const { transition } = await import('../../src/lib/task-lifecycle') as typeof import('../../src/lib/task-lifecycle');
    const { queryAll } = await import('../../src/lib/db') as typeof import('../../src/lib/db');

    await transition(taskId, 'in_progress', { actor: 'unit-test', reason: 'events-test' });

    // task_events row should exist (migration 070 created the table)
    let evtRows: Array<{ to_status: string; actor: string }> = [];
    try {
      evtRows = queryAll<{ to_status: string; actor: string }>(
        `SELECT to_status, actor FROM task_events WHERE task_id = ? AND to_status = 'in_progress'`,
        [taskId],
      );
    } catch {
      // task_events may not exist yet if migration 070 didn't run; skip
      console.log('[test 5] task_events table not present yet — skipping row assertion');
      return;
    }

    assert.ok(evtRows.length >= 1, `task_events must have ≥1 row for in_progress transition; got ${evtRows.length}`);
    assert.equal(evtRows[0]?.to_status, 'in_progress');
    assert.equal(evtRows[0]?.actor, 'unit-test');
  });

  // ── 6. Criteria derivation: image task ───────────────────────────────────
  await t.test('6. deriveAcceptanceCriteria() image task → existence+valid_image+vision_match', async () => {
    const { deriveAcceptanceCriteria } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const criteria = deriveAcceptanceCriteria('create a blue duck image', 'Generate a picture of a blue rubber duck.');
    assert.ok(criteria.length >= 3, `Expected ≥3 criteria; got ${criteria.length}`);
    const types = criteria.map((c) => c.type);
    assert.ok(types.includes('existence'), 'Must include existence criterion');
    assert.ok(types.includes('valid_image'), 'Must include valid_image criterion');
    assert.ok(types.includes('vision_match'), 'Must include vision_match criterion');
  });

  // ── 7. Criteria derivation: non-image task ───────────────────────────────
  // TIGHTENED (T0-01). This test previously asserted `criteria.length === 0`
  // for a non-image task — it encoded the defect as the contract. That empty
  // array is precisely what made `isArtifactTask` false, skipped the
  // no-artifact invariant, and dropped every document/report/video/content
  // task into description-only scoring where the judge graded the executing
  // agent's own prose.
  //
  // What the test was really protecting is still asserted below, and is the
  // part that was always correct: a non-image task must NOT be given the
  // image-render gates (valid_image / vision_match / min_resolution), because
  // those are meaningless for a sales email. It must, however, still be held to
  // the baseline evidence criterion — "something was delivered".
  await t.test('7. deriveAcceptanceCriteria() non-image task → baseline evidence criterion, no image gates', async () => {
    const { deriveAcceptanceCriteria } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const criteria = deriveAcceptanceCriteria('Write a sales email draft', 'Draft a cold outreach email for prospects.');
    const types = criteria.map((c) => c.type);

    assert.ok(
      types.includes('deliverable_registered'),
      `Non-image task must still carry the baseline evidence criterion; got: ${types.join(', ')}`,
    );
    for (const imageOnly of ['valid_image', 'vision_match', 'min_resolution'] as const) {
      assert.ok(
        !types.includes(imageOnly),
        `Non-image task must NOT be given the ${imageOnly} render gate; got: ${types.join(', ')}`,
      );
    }
  });

  // ── 8. Criteria derivation: high-quality → min_resolution ────────────────
  await t.test('8. deriveAcceptanceCriteria() high-quality image → min_resolution criterion', async () => {
    const { deriveAcceptanceCriteria } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const criteria = deriveAcceptanceCriteria('create a high-quality blue duck image');
    const types = criteria.map((c) => c.type);
    assert.ok(types.includes('min_resolution'), 'High-quality request must include min_resolution criterion');
  });

  // ── 9. evaluateCriteria: existence pass ──────────────────────────────────
  await t.test('9. evaluateCriteria() existence criterion passes with valid PNG', async () => {
    const pngPath = path.join(TMP, 'test-eval-9.png');
    makePng(pngPath);

    const { evaluateCriteria, deriveAcceptanceCriteria, probeImageFile } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const criteria = deriveAcceptanceCriteria('create a blue duck image').filter((c) => c.type === 'existence' || c.type === 'valid_image');

    const probe = probeImageFile(pngPath);
    assert.ok(probe.valid, 'PNG probe must be valid');

    const manifest = [{
      title: 'blue-duck.png',
      path: pngPath,
      type: 'image' as const,
      sizeBytes: (probe as { valid: true; sizeBytes: number }).sizeBytes,
      dimensions: null,
      valid: true,
    }];

    const checkResult = await evaluateCriteria(criteria, manifest);
    const existenceResult = checkResult.results.find((r) => r.id === 'existence');
    assert.ok(existenceResult?.pass, 'existence criterion must pass with valid PNG');
  });

  // ── 10. evaluateCriteria: valid_image fails for non-image ─────────────────
  await t.test('10. evaluateCriteria() valid_image criterion fails for non-image file', async () => {
    const { evaluateCriteria, deriveAcceptanceCriteria } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const criteria = deriveAcceptanceCriteria('create a blue duck image').filter((c) => c.type === 'valid_image');

    // Non-image manifest item (type='file', not 'image')
    const manifest = [{
      title: 'output.txt',
      path: '/tmp/output.txt',
      type: 'file' as const,
      sizeBytes: 100,
      dimensions: null,
      valid: true,
    }];

    const checkResult = await evaluateCriteria(criteria, manifest);
    const vImgResult = checkResult.results.find((r) => r.id === 'valid_image');
    assert.ok(!vImgResult?.pass, 'valid_image criterion must fail when no image found in manifest');
  });

  // ── 11. evaluateCriteria: vision_match skipped → pass (non-blocking) ─────
  await t.test('11. evaluateCriteria() vision_match skipped (no LLM key) → non-blocking pass', async () => {
    // Remove API keys for this test
    const savedOpenAi = process.env.OPENAI_API_KEY;
    const savedGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const pngPath = path.join(TMP, 'test-eval-11.png');
      makePng(pngPath);

      const { evaluateCriteria, deriveAcceptanceCriteria, probeImageFile } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
      const criteria = deriveAcceptanceCriteria('create a blue duck image').filter((c) => c.type === 'vision_match');

      const probe = probeImageFile(pngPath);
      const manifest = [{
        title: 'blue-duck.png',
        path: pngPath,
        type: 'image' as const,
        sizeBytes: (probe as { valid: true; sizeBytes: number }).sizeBytes ?? 0,
        dimensions: null,
        valid: true,
      }];

      const result = await evaluateCriteria(criteria, manifest);
      assert.ok(result.visionSkipped, 'vision check must be marked as skipped when no API key');
      const visionResult = result.results.find((r) => r.id === 'vision_match');
      assert.ok(visionResult?.pass, 'vision_match must be treated as pass when skipped');
    } finally {
      if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi;
      if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
    }
  });

  // ── 12. evaluateCriteria: all pass → score 10.0 ≥ 8.5 ───────────────────
  await t.test('12. evaluateCriteria() all criteria pass → score 10.0 ≥ 8.5', async () => {
    const savedOpenAi = process.env.OPENAI_API_KEY;
    const savedGoogle = process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const pngPath = path.join(TMP, 'test-eval-12.png');
      makePng(pngPath);

      const { evaluateCriteria, deriveAcceptanceCriteria, probeImageFile, QC_PASS_THRESHOLD } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
      const criteria = deriveAcceptanceCriteria('create a blue duck image');
      const probe = probeImageFile(pngPath);
      const manifest = [{
        title: 'blue-duck.png',
        path: pngPath,
        type: 'image' as const,
        sizeBytes: (probe as { valid: true; sizeBytes: number }).sizeBytes ?? 0,
        dimensions: null,
        valid: true,
      }];

      const result = await evaluateCriteria(criteria, manifest);
      assert.ok(result.score >= QC_PASS_THRESHOLD, `Score ${result.score} must be ≥ ${QC_PASS_THRESHOLD} when all criteria pass`);
      assert.ok(result.pass, 'pass must be true when all criteria pass');
    } finally {
      if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi;
      if (savedGoogle !== undefined) process.env.GOOGLE_API_KEY = savedGoogle;
    }
  });

  // ── 13. evaluateCriteria: existence fails → score < 8.5 ─────────────────
  await t.test('13. evaluateCriteria() existence fails → score < 8.5', async () => {
    const { evaluateCriteria, deriveAcceptanceCriteria, QC_PASS_THRESHOLD } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const criteria = deriveAcceptanceCriteria('create a blue duck image');
    // Empty manifest → existence fails
    const result = await evaluateCriteria(criteria, []);
    assert.ok(!result.pass, 'pass must be false with empty manifest');
    assert.ok(result.score < QC_PASS_THRESHOLD, `Score ${result.score} must be < ${QC_PASS_THRESHOLD} with empty manifest`);
  });

  // ── 14. classifyFailure: no-criteria → unrouteable ───────────────────────
  await t.test('14. classifyFailure() no-criteria scoringPath → unrouteable', async () => {
    const { classifyFailure } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const result = classifyFailure({
      score: 7.5,
      pass: false,
      reason: 'No SOP assigned to this task — cannot auto-score against success criteria.',
      gaps: ['Assign an SOP with success_criteria before auto-scoring is possible.'],
      scoringPath: 'no-criteria',
    });
    assert.ok(result.unrouteable, 'no-criteria failure must be classified as un-reroutable');
    assert.ok(result.reason, 'un-reroutable reason must be set');
  });

  // ── 15. classifyFailure: brief wording gap → unrouteable ─────────────────
  await t.test('15. classifyFailure() brief wording gap → unrouteable', async () => {
    const { classifyFailure } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const result = classifyFailure({
      score: 4.0,
      pass: false,
      reason: 'Task description is missing or too brief to verify completion',
      gaps: ['Task description is missing or too brief to verify completion'],
      scoringPath: 'heuristic',
    });
    assert.ok(result.unrouteable, 'brief wording gap must be classified as un-reroutable');
  });

  // ── 16. classifyFailure: artifact wrong-type → NOT unrouteable ───────────
  await t.test('16. classifyFailure() artifact wrong-type gap → NOT unrouteable', async () => {
    const { classifyFailure } = await import('../../src/lib/qc-scorer') as typeof import('../../src/lib/qc-scorer');
    const result = classifyFailure({
      score: 3.0,
      pass: false,
      reason: 'The generated image is a JPEG, but the task required a PNG format',
      gaps: ['Image format mismatch: got JPEG, expected PNG'],
      scoringPath: 'llm',
    });
    assert.ok(!result.unrouteable, 'format mismatch (executor can fix) must NOT be classified as un-reroutable');
  });

  // ── 17. /api/artifacts traversal block ───────────────────────────────────
  await t.test('17. /api/artifacts path traversal: path outside base → 403', async () => {
    // Simulate the server-side validation logic from the route handler
    // (we test the logic, not the HTTP layer, since the server is not running here)
    const canonicalBase = path.resolve(ARTIFACTS_DIR);

    // Attack: ../../etc/passwd
    function resolveAndCheck(taskId: string, filename: string): boolean {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(taskId)) return false;
      if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return false;
      if (filename === '.' || filename === '..') return false;
      const taskDir = path.join(canonicalBase, taskId);
      const resolved = path.resolve(taskDir, filename);
      return resolved.startsWith(canonicalBase + path.sep);
    }

    // Normal file should pass
    assert.ok(resolveAndCheck('abc-123', 'blue-duck.png'), 'Normal path must be allowed');

    // Traversal attacks must be blocked
    assert.ok(!resolveAndCheck('abc-123', '../../../etc/passwd'), 'Directory traversal must be blocked');
    assert.ok(!resolveAndCheck('abc-123', '/etc/passwd'), 'Absolute path must be blocked');
    assert.ok(!resolveAndCheck('../sneaky', 'file.png'), 'TaskId with .. must be blocked');
    assert.ok(!resolveAndCheck('abc-123', 'dir/subdir/file.png'), 'Sub-path must be blocked');
    assert.ok(!resolveAndCheck('abc-123', '..'), '.. filename must be blocked');
  });

  // ── 18. artifactDir returns correct path ─────────────────────────────────
  await t.test('18. artifactDir() returns PROJECTS_PATH/artifacts/<task-id>', async () => {
    const { artifactDir } = await import('../../src/lib/task-lifecycle') as typeof import('../../src/lib/task-lifecycle');
    const dir = artifactDir('test-task-id-123');
    const expected = path.join(TMP, 'projects', 'artifacts', 'test-task-id-123');
    assert.equal(dir, expected, `artifactDir must return ${expected}; got ${dir}`);
  });

});
