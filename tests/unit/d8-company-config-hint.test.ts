/**
 * D8 — OPENCLAW_COMPANY_CONFIG ignored; operator config has no ICP.
 *
 * The CC-repo side of this finding: `resolveCompanyConfigHint()` (persona-selector.ts)
 * already forwarded OPENCLAW_COMPANY_CONFIG as an env hint to the Python selector
 * ("forward-compatible" — the spec's own evidence). The live defect is entirely on
 * the Python/ONB side (skill 23 `detect_platform.py` never reads it;
 * `verify-v2.1-installation.sh` never asserts `ideal_customer` presence in the fleet
 * fan-out) — OUT OF SCOPE for this CC-repo dispatch.
 *
 * What WAS a genuine CC-side gap: the hint was only existence-checked
 * (`fs.existsSync`), so a path that exists but is empty/corrupt/mid-write would
 * still be forwarded. This suite proves the hardened VALIDATED check
 * (`isValidJsonFile` — exists AND parses as JSON) — a corrupt/malformed
 * OPENCLAW_COMPANY_CONFIG override is never forwarded; the resolver instead falls
 * through to its next candidate (or `undefined`), exactly like the "no file" case
 * behaved before this fix.
 *
 * Node built-in test runner under tsx (`npm run test:unit`). No DB required — pure
 * filesystem logic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type SelectorModule = typeof import('../../src/lib/persona-selector');
let isValidJsonFile: SelectorModule['isValidJsonFile'];
let resolveCompanyConfigHint: SelectorModule['resolveCompanyConfigHint'];

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-d8-cfg-'));
const originalEnv = process.env.OPENCLAW_COMPANY_CONFIG;

function writeTmp(name: string, content: string): string {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

test.before(async () => {
  const sel = await import('../../src/lib/persona-selector') as SelectorModule;
  isValidJsonFile = sel.isValidJsonFile;
  resolveCompanyConfigHint = sel.resolveCompanyConfigHint;
});

test.after(() => {
  if (originalEnv === undefined) delete process.env.OPENCLAW_COMPANY_CONFIG;
  else process.env.OPENCLAW_COMPANY_CONFIG = originalEnv;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── isValidJsonFile ──────────────────────────────────────────────────────────

test('[D8] isValidJsonFile: true for a real, valid JSON file', () => {
  const p = writeTmp('valid.json', JSON.stringify({ ideal_customer: 'Founders' }));
  assert.equal(isValidJsonFile(p), true);
});

test('[D8] isValidJsonFile: false for a nonexistent path', () => {
  assert.equal(isValidJsonFile(path.join(TMP_DIR, 'does-not-exist.json')), false);
});

test('[D8] isValidJsonFile: false for a file that exists but is NOT valid JSON (corrupt / mid-write)', () => {
  const p = writeTmp('corrupt.json', '{ "companyName": "Acme", oops this is not json');
  assert.equal(isValidJsonFile(p), false);
});

test('[D8] isValidJsonFile: false for an empty file', () => {
  const p = writeTmp('empty.json', '');
  assert.equal(isValidJsonFile(p), false);
});

// ── resolveCompanyConfigHint ─────────────────────────────────────────────────

test('[D8] resolveCompanyConfigHint: forwards the explicit OPENCLAW_COMPANY_CONFIG override when it is valid JSON', () => {
  const p = writeTmp('override-valid.json', JSON.stringify({ ideal_customer: 'RevOps leads' }));
  process.env.OPENCLAW_COMPANY_CONFIG = p;
  assert.equal(resolveCompanyConfigHint(), p);
});

test('[D8] resolveCompanyConfigHint: a CORRUPT override is never forwarded (validated, not just existence-checked)', () => {
  const p = writeTmp('override-corrupt.json', 'not json at all {{{');
  process.env.OPENCLAW_COMPANY_CONFIG = p;
  const result = resolveCompanyConfigHint();
  assert.notEqual(result, p, 'D8: the corrupt override path must never be forwarded to the Python selector');
});

test('[D8] resolveCompanyConfigHint: a nonexistent override path is never forwarded', () => {
  process.env.OPENCLAW_COMPANY_CONFIG = path.join(TMP_DIR, 'nonexistent-override.json');
  const result = resolveCompanyConfigHint();
  assert.notEqual(result, process.env.OPENCLAW_COMPANY_CONFIG);
});

test('[D8] resolveCompanyConfigHint: no override → falls through to cwd config/company-config.json (or undefined) — never throws', () => {
  delete process.env.OPENCLAW_COMPANY_CONFIG;
  assert.doesNotThrow(() => resolveCompanyConfigHint());
  const result = resolveCompanyConfigHint();
  assert.ok(result === undefined || typeof result === 'string');
});
