/**
 * Unit tests for zhcLibraryBaseDirs() — the resolver that bridges Skill 23's
 * Zero-Human-Company library layout to the Command Center's read routes
 * (/api/org-chart, /api/persona-matrix, /api/departments/[id]/personas).
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Regression guard for the path mismatch that hid a fully built workforce:
 * Skill 23 (build-workforce.py >= v9.6.0) writes the library to
 *   <root>/zero-human-company/<slug>/ORG-CHART.md
 *   <root>/zero-human-company/<slug>/departments/persona-matrix.md
 *   <root>/zero-human-company/<slug>/departments/<dept-id>/governing-personas.md
 * but the dashboard routes previously only probed the flat pre-v9.6.0 layout
 * (<root>/ORG-CHART.md and <root>/departments/<id>-dept/...), so a real build
 * surfaced as "not built yet".
 *
 * Strategy: set HOME to a throwaway temp dir BEFORE importing the helper (the
 * helper reads process.env.HOME at call time, so we can also re-point per test),
 * lay down a fake ZHC tree, and assert the canonical files resolve first.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type PlatformModule = typeof import('../../src/lib/platform');

let mod: PlatformModule;

function makeTree(): { home: string; companyDir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zhc-lib-'));
  const companyDir = path.join(home, 'clawd', 'zero-human-company', 'acme-corp');
  fs.mkdirSync(path.join(companyDir, 'departments', 'customer-support'), { recursive: true });
  fs.writeFileSync(path.join(companyDir, 'ORG-CHART.md'), '# Acme Org Chart\n');
  fs.writeFileSync(path.join(companyDir, 'departments', 'persona-matrix.md'), '# Persona Matrix\n');
  fs.writeFileSync(
    path.join(companyDir, 'departments', 'customer-support', 'governing-personas.md'),
    '- **Seth Godin** - Purple Cow\n'
  );
  return { home, companyDir };
}

function cleanEnv() {
  delete process.env.WORKSPACE_BASE_PATH;
  delete process.env.OPENCLAW_COMPANY_ROOT;
  delete process.env.OPENCLAW_PLATFORM;
}

test.before(async () => {
  // Force mac-mini so the resolver does not key off a real /data/.openclaw.
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  mod = await import('../../src/lib/platform');
});

test('zhcLibraryBaseDirs resolves the v9.6.0+ canonical per-company files', () => {
  cleanEnv();
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  const { home, companyDir } = makeTree();
  process.env.HOME = home;

  const bases = mod.zhcLibraryBaseDirs();

  // Canonical per-company folder must come BEFORE the flat legacy root.
  assert.ok(bases.includes(companyDir), 'per-company ZHC folder must be a base dir');
  const flatRoot = path.join(home, 'clawd');
  assert.ok(
    bases.indexOf(companyDir) < bases.indexOf(flatRoot),
    'canonical per-company folder must rank above the legacy flat root'
  );

  // ORG-CHART.md
  const org = bases.map((b) => path.join(b, 'ORG-CHART.md')).find((p) => fs.existsSync(p));
  assert.equal(org, path.join(companyDir, 'ORG-CHART.md'));

  // persona-matrix.md (under the per-company departments/ subfolder)
  const pm = bases
    .flatMap((b) => [path.join(b, 'departments', 'persona-matrix.md'), path.join(b, 'persona-matrix.md')])
    .find((p) => fs.existsSync(p));
  assert.equal(pm, path.join(companyDir, 'departments', 'persona-matrix.md'));

  // governing-personas.md for a bare-id department folder (NO -dept suffix).
  const gp = bases
    .flatMap((b) =>
      ['customer-support', 'dept-customer-support', 'customer-support-dept'].map((f) =>
        path.join(b, 'departments', f, 'governing-personas.md')
      )
    )
    .find((p) => fs.existsSync(p));
  assert.equal(gp, path.join(companyDir, 'departments', 'customer-support', 'governing-personas.md'));

  fs.rmSync(home, { recursive: true, force: true });
});

test('OPENCLAW_COMPANY_ROOT override takes top precedence', () => {
  cleanEnv();
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  const { home, companyDir } = makeTree();
  process.env.HOME = home;
  process.env.OPENCLAW_COMPANY_ROOT = companyDir;

  const bases = mod.zhcLibraryBaseDirs();
  assert.equal(bases[0], companyDir, 'explicit company-root override must rank first');

  delete process.env.OPENCLAW_COMPANY_ROOT;
  fs.rmSync(home, { recursive: true, force: true });
});

test('legacy flat layout still resolves when no zero-human-company folder exists', () => {
  cleanEnv();
  process.env.OPENCLAW_PLATFORM = 'mac-mini';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zhc-lib-legacy-'));
  process.env.HOME = home;
  const flatRoot = path.join(home, 'clawd');
  fs.mkdirSync(path.join(flatRoot, 'departments', 'marketing-dept'), { recursive: true });
  fs.writeFileSync(path.join(flatRoot, 'ORG-CHART.md'), '# Legacy Org Chart\n');

  const bases = mod.zhcLibraryBaseDirs();
  const org = bases.map((b) => path.join(b, 'ORG-CHART.md')).find((p) => fs.existsSync(p));
  assert.equal(org, path.join(flatRoot, 'ORG-CHART.md'), 'pre-v9.6.0 flat ORG-CHART.md must still resolve');

  fs.rmSync(home, { recursive: true, force: true });
});
