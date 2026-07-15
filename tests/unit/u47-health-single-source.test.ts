/**
 * tests/unit/u47-health-single-source.test.ts
 *
 * U47 — ONE <HealthIndicator/>, operator/client variants, mobile-visible;
 * retire the five incidental store writers.
 *
 * Source-scan proofs for the binary acceptance criteria that are inherently
 * about the SHAPE of the codebase (what no longer exists, what calls what)
 * rather than runtime rendering (covered separately by the real-render
 * suite tests/unit/u47-health-indicator.test.tsx, run under
 * vitest.component.config.ts). These are read-only `fs` scans of the actual
 * shipped source, not a restatement of it — a regression that reintroduces
 * a retired string or writer turns one of these tests red.
 *
 * Runs via the Node built-in test runner under tsx (`npm run test:unit`).
 *
 * Binary acceptance covered (spec H+L.1.2 / U47):
 *   (a) exactly ONE health affordance in the workspace header — Header.tsx
 *       renders <HealthIndicator/> exactly once, and no longer contains the
 *       retired SystemStatusPill import/usage or the "Gateway Online" /
 *       "Gateway Offline" strings; SystemStatusPill.tsx no longer exists as
 *       a file at all (retired, not merely unused).
 *   (d) `grep -c setIsOnline` across every file under src/app returns 0,
 *       with the store field renamed (`isFeedConnected`) and its setter
 *       (`setIsFeedConnected`) called ONLY from src/hooks/useSSE.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(REPO_ROOT, 'src');

/** Recursively list files under `dir` matching `exts`, skipping node_modules. */
function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

test('U47 (a): SystemStatusPill.tsx is retired — the file no longer exists', () => {
  const retiredPath = path.join(SRC, 'components', 'SystemStatusPill.tsx');
  assert.equal(
    fs.existsSync(retiredPath),
    false,
    'SystemStatusPill.tsx must be deleted, not merely unused — U47 requires a single-commit-revertible retirement of the whole old pill.'
  );
});

test('U47 (a): HealthIndicator.tsx exists and exports HealthIndicator', () => {
  const p = path.join(SRC, 'components', 'HealthIndicator.tsx');
  assert.equal(fs.existsSync(p), true);
  const content = fs.readFileSync(p, 'utf8');
  assert.match(content, /export function HealthIndicator/);
  // Contract: three states, two viewer roles — named directly in the spec.
  assert.match(content, /viewerRole/);
  assert.match(content, /'operator' \| 'client'|HealthIndicatorViewerRole/);
});

test('U47 (a): Header.tsx renders <HealthIndicator/> exactly once and carries no trace of the retired pills', () => {
  const headerPath = path.join(SRC, 'components', 'Header.tsx');
  const content = fs.readFileSync(headerPath, 'utf8');

  const usageMatches = content.match(/<HealthIndicator\b/g) || [];
  assert.equal(
    usageMatches.length,
    1,
    `Header.tsx must render exactly ONE <HealthIndicator/> — found ${usageMatches.length}`
  );

  assert.doesNotMatch(content, /SystemStatusPill/, 'Header.tsx must not reference the retired SystemStatusPill');
  assert.doesNotMatch(content, /Gateway Online/, 'The old "Gateway Online" string must be gone');
  assert.doesNotMatch(content, /Gateway Offline/, 'The old "Gateway Offline" string must be gone');
});

test('U47 (d): grep-equivalent — zero occurrences of the literal string "setIsOnline" anywhere under src/app', () => {
  const appDir = path.join(SRC, 'app');
  const files = listFiles(appDir, ['.ts', '.tsx']);
  assert.ok(files.length > 10, 'sanity: expected to scan more than 10 files under src/app');

  const offenders: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('setIsOnline')) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `Found the retired "setIsOnline" string in: ${offenders.join(', ')}`
  );
});

test('U47 (d): grep-equivalent — zero occurrences of "setIsOnline" anywhere under src (not just src/app)', () => {
  const files = listFiles(SRC, ['.ts', '.tsx']);
  const offenders: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('setIsOnline')) {
      offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test('U47 (d): the store field is isFeedConnected (not isOnline), written only via setIsFeedConnected', () => {
  const storePath = path.join(SRC, 'lib', 'store.ts');
  const content = fs.readFileSync(storePath, 'utf8');
  assert.match(content, /isFeedConnected: boolean/);
  assert.match(content, /setIsFeedConnected: \(connected: boolean\) => void/);
  // A historical comment noting the rename is fine; the retired field/setter
  // DECLARATIONS themselves must be gone.
  assert.doesNotMatch(content, /\bisOnline: boolean/, 'store.ts must not redeclare the retired isOnline field');
  assert.doesNotMatch(content, /\bsetIsOnline\b/, 'store.ts must not carry the retired setIsOnline setter at all');
});

test('U47 (d): setIsFeedConnected(...) is called ONLY from src/hooks/useSSE.ts', () => {
  const files = listFiles(SRC, ['.ts', '.tsx']);
  const callers: string[] = [];
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('setIsFeedConnected(')) {
      callers.push(path.relative(REPO_ROOT, file));
    }
  }
  const unique = Array.from(new Set(callers));
  assert.deepEqual(
    unique,
    ['src/hooks/useSSE.ts'],
    `setIsFeedConnected(...) must be called only from src/hooks/useSSE.ts — found call sites in: ${unique.join(', ')}`
  );
});

test('U47: the five previously-incidental writer files no longer call any store online/offline setter directly', () => {
  const retiredWriterFiles = [
    path.join(SRC, 'app', 'page.tsx'),
    path.join(SRC, 'app', 'tasks', 'all', 'page.tsx'),
    path.join(SRC, 'app', 'workspace', '[slug]', 'page.tsx'),
    path.join(SRC, 'app', 'overview', 'page.tsx'),
  ];
  for (const file of retiredWriterFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      content,
      /setIsFeedConnected\(/,
      `${path.relative(REPO_ROOT, file)} must not call the store's setIsFeedConnected — it never wrote the real feed-connection signal`
    );
    assert.doesNotMatch(
      content,
      /setIsOnline\(/,
      `${path.relative(REPO_ROOT, file)} must not call the retired setIsOnline`
    );
  }
});

test('U47: SystemStatusDrawer groups rows by the U46 tier field, not a hand-maintained component-id allowlist', () => {
  const drawerPath = path.join(SRC, 'components', 'SystemStatusDrawer.tsx');
  const content = fs.readFileSync(drawerPath, 'utf8');
  assert.match(content, /c\.tier === 'critical'/);
  assert.match(content, /c\.tier === 'auxiliary'/);
  assert.doesNotMatch(
    content,
    /\['database', 'openclaw_gateway', 'memory', 'jobs', 'disk', 'agents', 'telegram'\]/,
    'the old hand-maintained "Core" component-id allowlist must be gone'
  );
  // Responsive width — the old fixed w-96 overflowed a 375px viewport.
  assert.match(content, /w-full sm:w-96/);
});

test('U47: "Re-run bootstrap" admin action is still present, unmodified in its own logic', () => {
  const drawerPath = path.join(SRC, 'components', 'SystemStatusDrawer.tsx');
  const content = fs.readFileSync(drawerPath, 'utf8');
  assert.match(content, /Re-run bootstrap/);
  assert.match(content, /\/api\/system\/bootstrap/);
});
