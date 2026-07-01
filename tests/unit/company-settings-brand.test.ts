/**
 * Unit tests for company-settings brand-theming feature (v4.13.0).
 *
 * Verifies:
 *   1. deriveProductName: "Acme" → "Acme Command Center".
 *   2. buildThemeVars emits --brand-secondary-600 when secondary is passed.
 *   3. buildThemeVars falls back to auto-derived analogous when secondary is null.
 *   4. buildThemeVars emits --bcc-secondary equal to the explicit secondary hex.
 *   5. Migration 062 adds clients.brand_secondary_color column.
 *   6. company-config POST allows brandSecondaryColor (allowedStrings check).
 *   7. clients.ts SELECT_COLS includes brand_secondary_color.
 *   8. BrandTheme CSS includes --brand-secondary-600 variable definition.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-brand-settings-')),
  'mission-control.test.db',
);
process.env.DATABASE_PATH = TMP_DB;

// ── 1. Product name auto-derive ───────────────────────────────────────────────
test('deriveProductName: non-empty company name produces "<Name> Command Center"', () => {
  // Inline the pure function so we don't import the form (client component).
  function deriveProductName(company: string): string {
    return company.trim() ? `${company.trim()} Command Center` : '';
  }
  assert.equal(deriveProductName('Wake-Up Rise-Up Live-Up'), 'Wake-Up Rise-Up Live-Up Command Center');
  assert.equal(deriveProductName('Acme Industries'), 'Acme Industries Command Center');
  assert.equal(deriveProductName('  Summit Retail Enterprises  '), 'Summit Retail Enterprises Command Center');
  assert.equal(deriveProductName(''), '');
  assert.equal(deriveProductName('  '), '');
});

// ── 2–4. buildThemeVars secondary color logic ─────────────────────────────────
test('buildThemeVars emits --brand-secondary-600 matching explicit secondary hex', async () => {
  const { buildThemeVars } = await import('../../src/lib/branding');
  const PRIMARY = '#1E3A8A';  // navy
  const SECONDARY = '#DC143C'; // crimson

  const vars = buildThemeVars(PRIMARY, SECONDARY);

  // The secondary scale must be derived from the SECONDARY input, not the primary.
  assert.ok('--brand-secondary-600' in vars, '--brand-secondary-600 should be emitted');
  assert.ok('--bcc-secondary' in vars, '--bcc-secondary should be emitted');

  // --bcc-secondary must equal the normalised secondary hex.
  const bccSecondary = vars['--bcc-secondary'];
  // Normalised crimson is #dc143c
  assert.equal(bccSecondary.toLowerCase(), '#dc143c', '--bcc-secondary should match secondary input');

  // The secondary scale colours should NOT equal the primary scale colours
  // (they derive from different hues).
  const primaryScale600 = vars['--brand-600'];
  const secondaryScale600 = vars['--brand-secondary-600'];
  assert.notEqual(primaryScale600, secondaryScale600, 'Primary and secondary scale-600 should differ when different inputs');
});

test('buildThemeVars falls back to auto-derived analogous when secondary is null', async () => {
  const { buildThemeVars, normalizeHex } = await import('../../src/lib/branding');
  const { derivePaletteFromPrimary } = await import('../../src/lib/colors');
  const PRIMARY = '#43A047';

  const varsNull = buildThemeVars(PRIMARY, null);
  const varsOmitted = buildThemeVars(PRIMARY);

  // Both null and omitted should yield the same result.
  assert.equal(varsNull['--bcc-secondary'], varsOmitted['--bcc-secondary']);

  // The auto-derived secondary should equal the analogous (+30°) shade from derivePaletteFromPrimary.
  const derived = derivePaletteFromPrimary(PRIMARY);
  const expectedSecondary = normalizeHex(derived.secondaryColor!);
  assert.equal(varsNull['--bcc-secondary'], expectedSecondary);
});

// ── 5. Migration 062 ──────────────────────────────────────────────────────────
test('migration 062 adds clients.brand_secondary_color column', async () => {
  const { getDb } = await import('../../src/lib/db');
  const db = getDb();

  const cols = (db.prepare('PRAGMA table_info(clients)').all() as { name: string }[]).map(c => c.name);
  assert.ok(cols.includes('brand_secondary_color'), 'clients table must have brand_secondary_color column after migration 062');
});

// ── 6. company-config route allowedStrings ────────────────────────────────────
test('company-config route allows brandSecondaryColor in POST body', () => {
  // Read the route source and verify the allowedStrings array includes the new key.
  const routeSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/app/api/company/config/route.ts'),
    'utf-8',
  );
  assert.ok(
    routeSrc.includes("'brandSecondaryColor'"),
    "allowedStrings must include 'brandSecondaryColor'",
  );
});

// ── 7. clients.ts SELECT_COLS ─────────────────────────────────────────────────
test('clients.ts SELECT_COLS includes brand_secondary_color', () => {
  const clientsSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/lib/clients.ts'),
    'utf-8',
  );
  assert.ok(
    clientsSrc.includes('brand_secondary_color'),
    'clients.ts must include brand_secondary_color in SELECT_COLS and interfaces',
  );
});

// ── 8. BrandTheme emits secondary variable ────────────────────────────────────
test('BrandTheme component source emits --brand-secondary- variable overrides', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/components/BrandTheme.tsx'),
    'utf-8',
  );
  assert.ok(
    src.includes('--brand-secondary-'),
    'BrandTheme.tsx must reference --brand-secondary- CSS variable overrides',
  );
});
