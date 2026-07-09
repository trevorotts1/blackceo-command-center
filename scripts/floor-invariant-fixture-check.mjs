#!/usr/bin/env node
/**
 * floor-invariant-fixture-check.mjs — dependency-free fixture-arithmetic guard
 * for the Command Center floor invariant, invoked by scripts/qc-cc.sh section 13.
 *
 * The floor invariant is: for the active company, the Kanban board displays
 * EXACTLY the chosen departments.json manifest MINUS any explicitly opted-out
 * department. qc-cc.sh runs WITHOUT node_modules (no tsx / better-sqlite3), so it
 * cannot exercise the TypeScript seed + board query directly. This checker proves
 * the SUBTRACTION contract on committed fixtures:
 *
 *   tests/fixtures/floor-invariant/manifest.json          — a representative chosen manifest
 *   tests/fixtures/floor-invariant/expected-displayed.json — the golden displayed set
 *
 * It asserts expected-displayed == manifest − opt-outs, that the fixture actually
 * exercises an opt-out (else it proves nothing), and that App Development and
 * Engineering both survive as DISTINCT lanes. The AUTHORITATIVE behavioral proof
 * against real product code is tests/unit/floor-department-invariant.test.ts (a
 * vitest suite wired into CI); this guard keeps the golden fixture honest and
 * fails the build if the manifest/golden drift apart.
 *
 * Exit 0 on success; exit 1 with a diagnostic on any drift.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve('tests/fixtures/floor-invariant');
const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const expected = JSON.parse(readFileSync(path.join(dir, 'expected-displayed.json'), 'utf8'));

// Mirror of isDepartmentOptedOut() in src/lib/db/migrations.ts. The vitest suite
// asserts the PRODUCT predicate agrees with this fixture; keep the two in sync.
function isOptedOut(d) {
  if (!d || typeof d !== 'object') return false;
  if (d.optOut === true || d.opted_out === true) return true;
  if (d.enabled === false || d.active === false) return true;
  const s = typeof d.status === 'string' ? d.status.trim().toLowerCase() : '';
  return ['opted-out', 'opted_out', 'declined', 'disabled', 'inactive'].includes(s);
}

const fail = (msg) => {
  console.error(`[floor-invariant] ${msg}`);
  process.exit(1);
};

if (!Array.isArray(manifest) || manifest.length === 0) fail('manifest.json must be a non-empty array');
if (!Array.isArray(expected)) fail('expected-displayed.json must be an array');

const derived = manifest.filter((d) => !isOptedOut(d)).map((d) => String(d.id)).sort();
const want = [...expected].map(String).sort();

const equal = derived.length === want.length && derived.every((v, i) => v === want[i]);
if (!equal) {
  fail(`drift: manifest−opt-outs = [${derived.join(', ')}] but expected-displayed = [${want.join(', ')}]`);
}

// The fixture must exercise at least one opt-out, or the subtraction proves nothing.
if (!manifest.some((d) => isOptedOut(d))) {
  fail('fixture proves nothing — manifest has no explicitly opted-out department');
}

// Distinct-lane invariant: App Development and Engineering must both display.
for (const slug of ['app-development', 'engineering']) {
  if (!want.includes(slug)) fail(`distinct-lane invariant: "${slug}" missing from expected-displayed`);
}

console.log(`[floor-invariant] OK — displayed == manifest − opt-outs (${want.length} depts; opt-outs honored; app-development + engineering distinct)`);
process.exit(0);
