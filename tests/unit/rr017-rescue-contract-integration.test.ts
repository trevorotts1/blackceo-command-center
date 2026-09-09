/**
 * tests/unit/rr017-rescue-contract-integration.test.ts — RR-017 CC side.
 *
 * Proves the Command Center's rescue integration references point at the real
 * published contract and that the retired Relay path can no longer be shipped
 * as a default from this repo:
 *   1. The integration doc exists, is public-safe, and labels the legacy
 *      paths active / compatibility-only / retired.
 *   2. The tombstone is intact (still throws) and no private store code was
 *      restored into this repo.
 *   3. No CC-shipped default points at the retired /webhook/rescue-rangers
 *      path; the canonical rr-v2-intake is the default.
 *   4. The read-only dashboard contract holds: db.ts never writes.
 *
 * Run: npx tsx --test tests/unit/rr017-rescue-contract-integration.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const DOC = path.join(REPO, 'docs', 'RESCUE-INTEGRATION.md');
const TOMBSTONE = path.join(REPO, 'fleet-heartbeat', 'scripts', 'lib', 'rescue-ticket-store.mjs');
const RETIRED = 'webhook/rescue-rangers';
const CANONICAL = 'webhook/rr-v2-intake';

test('integration doc exists, is public-safe, and labels legacy paths correctly', () => {
  const raw = fs.readFileSync(DOC, 'utf8');
  assert.ok(raw.includes('active'), 'active label present');
  assert.ok(raw.toLowerCase().includes('compatibility-only'), 'compatibility-only label present');
  assert.ok(raw.toLowerCase().includes('retired'), 'retired label present');
  // public-safe: no table IDs, no workflow IDs, no credential-value shapes
  assert.ok(!/[0-9a-f]{20,}/.test(raw), 'no hex table/credential shapes');
  assert.ok(!/X-Rescue-Secret:\s*\S/.test(raw.replace('X-Rescue-Secret`', '')), 'no secret header value');
  assert.ok(raw.includes('blackceo-fleet-ops'), 'doc points at the private manifest as authority');
  // the legacy-path table must not contradict the shipped defaults
  assert.ok(!/defaults still name it/.test(raw), 'doc must not claim defaults still name the retired path');
});

test('the tombstone is intact and no private store code was restored', () => {
  const raw = fs.readFileSync(TOMBSTONE, 'utf8');
  assert.ok(raw.includes('DELIBERATELY REMOVED'), 'tombstone header intact');
  assert.ok(
    /throw new Error\(\s*["'`]rescue-ticket-store\.mjs is not published/.test(raw),
    'tombstone throws on import (static check of the load-bearing throw)',
  );
  // the tombstone must NOT carry the real store's exports
  assert.ok(!raw.includes('export function openStore'), 'no real store exports in the tombstone');
  assert.ok(!raw.includes('CREATE TABLE IF NOT EXISTS tickets'), 'no schema DDL in the tombstone');
});

test('no shipped default points at the retired relay path', () => {
  const scripts = path.join(REPO, 'fleet-heartbeat', 'scripts');
  const carriers = [];
  for (const f of fs.readdirSync(scripts)) {
    const p = path.join(scripts, f);
    if (!fs.statSync(p).isFile()) continue;
    if (/\.(mjs|sh|js|cjs)$/.test(f)) {
      // live-code hits only: comment lines that NAME the retired path in an
      // explanatory way (required by the doc) are not carriers
      const live = fs.readFileSync(p, 'utf8').split('\n')
        .filter((l) => l.includes(RETIRED))
        .filter((l) => !l.trim().startsWith('#') && !l.trim().startsWith('//'));
      if (live.length > 0) carriers.push(`${f}: ${live.length}`);
    }
  }
  assert.deepEqual(carriers, [], `files still defaulting to the retired path: ${carriers.join(', ')}`);
  const receiver = fs.readFileSync(path.join(scripts, 'rescue-receiver.mjs'), 'utf8');
  assert.ok(receiver.includes(CANONICAL), 'receiver default is the canonical intake');
});

test('the read-only dashboard contract holds: db.ts never writes', () => {
  const db = fs.readFileSync(path.join(REPO, 'src', 'lib', 'rescue', 'db.ts'), 'utf8');
  assert.ok(db.includes("readonly: true"), 'opens the store read-only');
  assert.ok(!/INSERT INTO|UPDATE tickets|DELETE FROM/.test(db), 'no write SQL in the reader');
  assert.ok(db.includes('fileMustExist: true'), 'never creates the store file');
});