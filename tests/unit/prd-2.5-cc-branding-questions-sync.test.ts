/**
 * PRD 2.5-cc — Branding Questions Sync Test
 *
 * Verifies:
 *   1. The vendored copy (src/lib/interview-questions.branding-questions.json)
 *      is byte-for-byte parseable and has questions.
 *   2. BRANDING_QUESTIONS in interview-questions.ts is populated from the
 *      vendored JSON (not a hard-coded list in the TS file).
 *   3. The sync test script PASSES when comparing the vendored copy against itself.
 *   4. The sync test script FAILS when a planted divergence is introduced
 *      (wrong prompt on an existing question).
 *   5. The old self-maintained BRANDING_QUESTIONS array is gone: the ts file
 *      no longer contains a literal question object definition for the branding set.
 *
 * Runs via: npm run test:unit
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const VENDORED_PATH = path.join(
  REPO_ROOT,
  'src',
  'lib',
  'interview-questions.branding-questions.json',
);
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-branding-questions-test.ts');
const INTERVIEW_QUESTIONS_TS = path.join(REPO_ROOT, 'src', 'lib', 'interview-questions.ts');

// ── helper: run the sync script via npx tsx ────────────────────────────────

function runSyncScript(
  canonicalPath: string,
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      'npx',
      ['tsx', SYNC_SCRIPT, canonicalPath],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        timeout: 30_000,
      },
    );
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

// ── 1. Vendored file is present and parseable ──────────────────────────────

test('PRD-2.5-cc: vendored branding-questions.json exists and is valid JSON', () => {
  assert.ok(
    fs.existsSync(VENDORED_PATH),
    `Vendored file missing: ${VENDORED_PATH}`,
  );
  const raw = fs.readFileSync(VENDORED_PATH, 'utf-8');
  let parsed: { questions?: unknown[] };
  assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'Must be valid JSON');
  assert.ok(
    Array.isArray((parsed! as { questions?: unknown[] }).questions),
    'Must have a questions array',
  );
  assert.ok(
    (parsed! as { questions?: unknown[] }).questions!.length > 0,
    'questions array must not be empty',
  );
});

// ── 2. BRANDING_QUESTIONS is populated from the vendored JSON ─────────────

test('PRD-2.5-cc: BRANDING_QUESTIONS is sourced from vendored JSON (contains brand_evokes)', async () => {
  // brand_evokes is one of the 6 questions added in the canonical file beyond
  // the original 2-question self-maintained list.  Its presence proves that
  // the TS module reads from the JSON, not a hard-coded 2-item array.
  const { BRANDING_QUESTIONS } = await import('../../src/lib/interview-questions');
  const ids = BRANDING_QUESTIONS.map((q) => q.id);
  assert.ok(
    ids.includes('brand_evokes'),
    `brand_evokes must be in BRANDING_QUESTIONS (ids found: ${ids.join(', ')})`,
  );
  assert.ok(
    ids.includes('ideal_customer'),
    `ideal_customer must be in BRANDING_QUESTIONS (ids found: ${ids.join(', ')})`,
  );
  assert.ok(
    ids.includes('unique_differentiator'),
    `unique_differentiator must be in BRANDING_QUESTIONS`,
  );
});

// ── 3. Sync script PASSES on in-sync copies ───────────────────────────────

test('PRD-2.5-cc: sync script PASSES when vendored == canonical (self-check)', () => {
  // Passing the vendored path as both canonical and vendored is the
  // self-consistency mode — should always pass.
  const result = runSyncScript(VENDORED_PATH);
  assert.equal(
    result.exitCode,
    0,
    `Sync script must exit 0 when files match. stderr: ${result.stderr}\nstdout: ${result.stdout}`,
  );
  assert.ok(
    result.stdout.includes('PASS'),
    `stdout must include "PASS". Got: ${result.stdout}`,
  );
});

// ── 4. Sync script FAILS on planted divergence ────────────────────────────

test('PRD-2.5-cc: sync script FAILS when a planted divergence is introduced', () => {
  // Create a temporary canonical file with one question's prompt mutated.
  const vendored = JSON.parse(fs.readFileSync(VENDORED_PATH, 'utf-8'));
  const diverged = JSON.parse(JSON.stringify(vendored)); // deep copy

  // Mutate the prompt of brand_primary_color so it diverges from the vendored copy.
  const q = (diverged.questions as Array<{ id: string; prompt: string }>).find(
    (x) => x.id === 'brand_primary_color',
  );
  assert.ok(q, 'brand_primary_color question must exist in vendored file');
  q.prompt = 'PLANTED_DIVERGENCE: this prompt is intentionally wrong';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prd-2.5-diverge-'));
  const divergedPath = path.join(tmpDir, 'branding-questions-diverged.json');
  fs.writeFileSync(divergedPath, JSON.stringify(diverged, null, 2), 'utf-8');

  try {
    const result = runSyncScript(divergedPath);
    assert.equal(
      result.exitCode,
      1,
      `Sync script must exit 1 when files diverge. exitCode=${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      combined.includes('FAIL'),
      `Output must include "FAIL". Got stdout: ${result.stdout}`,
    );
    assert.ok(
      combined.includes('brand_primary_color'),
      `Output must name the diverging question id. Got: ${combined}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 5. TS file no longer contains a hand-coded BRANDING_QUESTIONS literal ─

test('PRD-2.5-cc: interview-questions.ts does not contain a self-maintained branding question literal', () => {
  const src = fs.readFileSync(INTERVIEW_QUESTIONS_TS, 'utf-8');
  // If the old self-maintained list is present, it would contain lines like:
  //   id: 'brand_primary_color',
  // as a literal object property in the BRANDING_QUESTIONS array.
  // After this fix, BRANDING_QUESTIONS is populated via JSON import, so
  // those literal declarations must not appear in the TS file itself.
  const hasLiteral = /id:\s*['"]brand_primary_color['"]/m.test(src);
  assert.ok(
    !hasLiteral,
    'interview-questions.ts must not contain a hardcoded brand_primary_color literal — ' +
    'BRANDING_QUESTIONS must be loaded from the vendored JSON.',
  );
});
