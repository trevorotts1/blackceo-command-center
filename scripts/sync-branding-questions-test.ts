#!/usr/bin/env npx tsx
/**
 * scripts/sync-branding-questions-test.ts
 *
 * Sync test for PRD 2.5-cc: verifies that the vendored branding questions
 * in the Command Center are in sync with the canonical source in the
 * onboarding repo.
 *
 * PASS: vendored copy matches canonical on every question's id, prompt,
 *       storeOn, and kind.
 * FAIL: any divergence on any of those four fields — exit 1.
 *
 * Usage (two modes):
 *
 *   Mode A — fixture mode (CI / unit test harness):
 *     The test is run by the Node built-in test runner via the
 *     test:sync:branding npm script. It loads BOTH files from this repo:
 *     the vendored copy (src/lib/interview-questions.branding-questions.json)
 *     and a "canonical fixture" passed via CANONICAL_BRANDING_JSON env var
 *     or, when absent, uses the vendored copy as both sides (self-consistency
 *     check that always passes).
 *
 *   Mode B — live two-repo mode (developer workflow):
 *     Pass the path to the canonical file as the first CLI argument:
 *       npx tsx scripts/sync-branding-questions-test.ts \
 *         ../openclaw-onboarding/23-ai-workforce-blueprint/interview/branding-questions.json
 *     The script compares that file against the vendored copy and exits
 *     non-zero on any divergence.
 *
 * The FIELDS_CHECKED constant below defines exactly which fields are
 * compared. All other fields (interviewGuidance, resolverHint, phase, …)
 * are informational and allowed to diverge without failing the sync.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── paths ────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const VENDORED_PATH = path.join(
  REPO_ROOT,
  'src',
  'lib',
  'interview-questions.branding-questions.json',
);

/** Fields on each question object that MUST be identical between the two copies. */
const FIELDS_CHECKED: ReadonlyArray<string> = ['id', 'prompt', 'storeOn', 'kind'];

// ── question shape ────────────────────────────────────────────────────────────

interface QuestionEntry {
  id: string;
  prompt: string;
  storeOn: string;
  kind: string;
  [key: string]: unknown;
}

interface BrandingQuestionsFile {
  questions: QuestionEntry[];
  [key: string]: unknown;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function loadFile(filePath: string): BrandingQuestionsFile {
  if (!fs.existsSync(filePath)) {
    console.error(`[sync-branding-questions] FAIL: file not found: ${filePath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BrandingQuestionsFile;
  } catch (err) {
    console.error(`[sync-branding-questions] FAIL: could not parse JSON at ${filePath}: ${err}`);
    process.exit(1);
  }
}

function compareQuestions(
  canonical: BrandingQuestionsFile,
  vendored: BrandingQuestionsFile,
  canonicalLabel: string,
  vendoredLabel: string,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  const cqs: QuestionEntry[] = canonical.questions ?? [];
  const vqs: QuestionEntry[] = vendored.questions ?? [];

  // Question count must match.
  if (cqs.length !== vqs.length) {
    failures.push(
      `Question count mismatch: canonical=${cqs.length} vendored=${vqs.length}`,
    );
    // Still check individual questions up to the shorter length.
  }

  // Build index by id for canonical.
  const canonicalById = new Map(cqs.map((q) => [q.id, q]));
  const vendoredById = new Map(vqs.map((q) => [q.id, q]));

  // Check every canonical question exists in vendored with matching fields.
  for (const cq of cqs) {
    const vq = vendoredById.get(cq.id);
    if (!vq) {
      failures.push(`Question id="${cq.id}" present in canonical but missing from vendored.`);
      continue;
    }
    for (const field of FIELDS_CHECKED) {
      if (cq[field] !== vq[field]) {
        failures.push(
          `Question id="${cq.id}" field "${field}" diverges:\n` +
          `  canonical (${canonicalLabel}): ${JSON.stringify(cq[field])}\n` +
          `  vendored  (${vendoredLabel}): ${JSON.stringify(vq[field])}`,
        );
      }
    }
  }

  // Check vendored has no questions not in canonical.
  for (const vq of vqs) {
    if (!canonicalById.has(vq.id)) {
      failures.push(
        `Question id="${vq.id}" present in vendored but missing from canonical.`,
      );
    }
  }

  return { pass: failures.length === 0, failures };
}

// ── main ──────────────────────────────────────────────────────────────────────

function main() {
  // Resolve the canonical source.
  // Priority: CLI arg → CANONICAL_BRANDING_JSON env var → vendored copy (self-check).
  let canonicalPath: string;
  const cliArg = process.argv[2];
  const envPath = process.env.CANONICAL_BRANDING_JSON;

  if (cliArg) {
    canonicalPath = path.resolve(cliArg);
  } else if (envPath) {
    canonicalPath = path.resolve(envPath);
  } else {
    // Self-consistency mode: use the vendored copy as both sides.
    // This is the CI default when the onboarding repo is not checked out alongside.
    canonicalPath = VENDORED_PATH;
  }

  const canonicalLabel = path.relative(REPO_ROOT, canonicalPath);
  const vendoredLabel = path.relative(REPO_ROOT, VENDORED_PATH);

  console.log('[sync-branding-questions] Checking sync...');
  console.log(`  canonical : ${canonicalLabel}`);
  console.log(`  vendored  : ${vendoredLabel}`);

  const canonical = loadFile(canonicalPath);
  const vendored = loadFile(VENDORED_PATH);

  const { pass, failures } = compareQuestions(canonical, vendored, canonicalLabel, vendoredLabel);

  if (pass) {
    const n = (canonical.questions ?? []).length;
    console.log(
      `[sync-branding-questions] PASS — ${n} questions in sync on fields: ${FIELDS_CHECKED.join(', ')}`,
    );
    process.exit(0);
  } else {
    console.error(`[sync-branding-questions] FAIL — ${failures.length} divergence(s) found:`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    console.error(
      '\nTo fix: copy the canonical file into src/lib/interview-questions.branding-questions.json',
      '\nand re-run: npm run test:sync:branding',
    );
    process.exit(1);
  }
}

main();
