/**
 * U082 — QC artifact content extraction (not byte count).
 *
 * ── WHAT WAS BROKEN ───────────────────────────────────────────────────────────
 * The non-image deliverable validity test was a positive byte count ALONE. The
 * manifest handed to the judge carried title, type, path, validity and byte
 * count, but NO content — so two files with the same name and size received the
 * same verdict regardless of contents. A placeholder or truncated draft scored
 * identically to a finished deliverable.
 *
 * ── WHAT THESE TESTS PIN ──────────────────────────────────────────────────────
 * probeTextFile() reads a BOUNDED content excerpt and computes deterministic
 * structural checks (lines / words / non-empty chars) so the judge scores
 * CONTENT, not just existence:
 *   • plain-text file with content → valid, excerpt + structural checks present;
 *   • empty file → invalid (0 bytes);
 *   • missing file → invalid;
 *   • unsupported format (e.g. .pdf) → valid on existence+size, but excerpt=null
 *     with a "content not extractable" note (honest, not failed);
 *   • unreadable file → invalid (FAIL-CLOSED, never passed on byte count);
 *   • a whitespace-only "placeholder" → valid but nonEmptyChars=0, so the judge
 *     can see it is a stub;
 *   • a large file → excerpt is bounded (never reads the whole file).
 *
 * Each test is written to FAIL against the pre-fix byte-count-only behaviour
 * (which returned no excerpt / no structural checks).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type QCScorerModule = typeof import('../../src/lib/qc-scorer');
let probeTextFile: QCScorerModule['probeTextFile'];

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'u082-probe-'));

test.before(async () => {
  const scorer = await import('../../src/lib/qc-scorer');
  probeTextFile = scorer.probeTextFile;
});

test.after(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function write(name: string, content: string): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('plain-text deliverable: valid, excerpt + structural checks present', () => {
  const body = 'Chapter 1\n\nThe quick brown fox jumps over the lazy dog.\nMore real content here.';
  const p = write('manuscript.md', body);
  const r = probeTextFile(p);
  assert.equal(r.valid, true);
  assert.ok(r.sizeBytes! > 0);
  // The fix: content is extracted, not just counted.
  assert.ok(r.excerpt, 'excerpt must be present for a text deliverable');
  assert.ok(r.excerpt!.includes('quick brown fox'), 'excerpt carries real content');
  assert.ok(r.structuralChecks, 'structural checks must be present');
  assert.equal(r.structuralChecks!.lines, 4);
  assert.ok(r.structuralChecks!.words > 10);
  assert.ok(r.structuralChecks!.nonEmptyChars > 40);
  assert.equal(r.contentNote, undefined, 'no "not extractable" note for a text format');
});

test('empty file is invalid (0 bytes)', () => {
  const p = write('empty.txt', '');
  const r = probeTextFile(p);
  assert.equal(r.valid, false);
  assert.match(r.invalidReason ?? '', /empty|0 bytes/i);
  assert.equal(r.excerpt, null);
});

test('missing file is invalid', () => {
  const r = probeTextFile(path.join(TMP_DIR, 'does-not-exist.md'));
  assert.equal(r.valid, false);
  assert.match(r.invalidReason ?? '', /not found/i);
});

test('unsupported format (binary) stays valid but content is NOT extracted (honest note)', () => {
  const p = path.join(TMP_DIR, 'report.pdf');
  fs.writeFileSync(p, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])); // %PDF-1.4
  const r = probeTextFile(p);
  assert.equal(r.valid, true, 'a binary deliverable is still a real deliverable');
  assert.ok(r.sizeBytes! > 0);
  assert.equal(r.excerpt, null, 'no content extracted for an unsupported format');
  assert.equal(r.structuralChecks, null);
  assert.match(r.contentNote ?? '', /not extractable/i);
});

test('whitespace-only placeholder: valid but nonEmptyChars=0 (judge can see it is a stub)', () => {
  const p = write('placeholder.md', '\n\n   \n\t\n');
  const r = probeTextFile(p);
  assert.equal(r.valid, true, 'a non-empty file is still valid');
  assert.ok(r.structuralChecks, 'structural checks present');
  assert.equal(r.structuralChecks!.nonEmptyChars, 0, 'placeholder has zero non-empty chars');
  assert.equal(r.structuralChecks!.words, 0);
});

test('large file: excerpt is bounded (never reads the whole file)', () => {
  // 100KB of content; the excerpt must be capped well below that.
  const big = 'x'.repeat(100 * 1024);
  const p = write('big.txt', big);
  const r = probeTextFile(p);
  assert.equal(r.valid, true);
  assert.ok(r.excerpt, 'excerpt present');
  assert.ok(r.excerpt!.length <= 2000, `excerpt must be bounded, got ${r.excerpt!.length}`);
  assert.ok(r.sizeBytes! >= 100 * 1024, 'full size still reported');
});

test('unreadable file fails closed (never passed on byte count)', () => {
  // A directory at a .txt path: exists, non-zero size, but cannot be read as a file.
  const dirPath = path.join(TMP_DIR, 'not-a-file.txt');
  fs.mkdirSync(dirPath);
  const r = probeTextFile(dirPath);
  assert.equal(r.valid, false, 'an unreadable deliverable must not be passed on byte count');
  assert.match(r.invalidReason ?? '', /unreadable/i);
  assert.equal(r.excerpt, null);
});
