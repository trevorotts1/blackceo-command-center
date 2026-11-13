#!/usr/bin/env npx tsx
/**
 * scripts/sync-interview-registry-test.ts
 *
 * Byte-for-byte sync test for the vendored interview registry.
 *
 * The Command Center vendors src/lib/interview-questions.v2.json so the browser
 * bundle can render the deck without reaching the box. The SOURCE OF TRUTH is
 * the onboarding copy installed with the skill:
 *
 *   23-ai-workforce-blueprint/interview/questions.v2.json
 *
 * PASS: the two files are identical in every byte.
 * FAIL: any difference at all (one changed byte, a reordered key, a trailing
 *       newline) — exit 1.
 *
 * Usage (two modes, same shape as scripts/sync-branding-questions-test.ts):
 *
 *   Mode A — self-consistency (CI default when the onboarding repo is not
 *            checked out alongside):
 *     npx tsx scripts/sync-interview-registry-test.ts
 *
 *   Mode B — live two-repo mode (developer workflow):
 *     npx tsx scripts/sync-interview-registry-test.ts \
 *       ../openclaw-onboarding/23-ai-workforce-blueprint/interview/questions.v2.json
 *
 * The canonical path may also come from the CANONICAL_INTERVIEW_REGISTRY
 * environment variable. A CLI argument wins over the environment variable.
 *
 * This unit's source of truth for the first copy is the onboarding tree at the
 * BU-10 branch tip (the commit that created interview/questions.v2.json); later
 * registry edits are re-vendored with the same command and this test catches a
 * forgotten re-vendor before it ships.
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
  'interview-questions.v2.json',
);

// ── helpers ──────────────────────────────────────────────────────────────────

function readBytes(filePath: string): Buffer | null {
  if (!fs.existsSync(filePath)) {
    console.error(`[sync-interview-registry] FAIL: file not found: ${filePath}`);
    return null;
  }
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    console.error(`[sync-interview-registry] FAIL: could not read ${filePath}: ${err}`);
    return null;
  }
}

/** First byte offset where two buffers differ, or -1 when they are identical. */
function firstDifferingByte(a: Buffer, b: Buffer): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : shared;
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  // Resolve the canonical source.
  // Priority: CLI argument → CANONICAL_INTERVIEW_REGISTRY → vendored copy.
  const cliArg = process.argv[2];
  const envPath = process.env.CANONICAL_INTERVIEW_REGISTRY;
  const canonicalPath = cliArg
    ? path.resolve(cliArg)
    : envPath
      ? path.resolve(envPath)
      : VENDORED_PATH;

  const canonicalLabel = path.relative(REPO_ROOT, canonicalPath) || VENDORED_PATH;
  const vendoredLabel = path.relative(REPO_ROOT, VENDORED_PATH);

  console.log('[sync-interview-registry] Checking sync...');
  console.log(`  canonical : ${canonicalLabel}`);
  console.log(`  vendored  : ${vendoredLabel}`);

  const canonical = readBytes(canonicalPath);
  const vendored = readBytes(VENDORED_PATH);
  if (!canonical || !vendored) process.exit(1);

  const at = firstDifferingByte(canonical, vendored);
  if (at === -1) {
    console.log(
      `[sync-interview-registry] PASS — ${vendored.length} bytes identical`,
    );
    process.exit(0);
  }

  console.error(
    `[sync-interview-registry] FAIL — first difference at byte ${at} ` +
      `(canonical ${canonical.length} bytes, vendored ${vendored.length} bytes)`,
  );
  console.error(
    '\nTo fix: copy the canonical questions.v2.json over',
    '\nsrc/lib/interview-questions.v2.json and re-run:',
    '\nnpx tsx scripts/sync-interview-registry-test.ts <canonical path>',
  );
  process.exit(1);
}

main();
