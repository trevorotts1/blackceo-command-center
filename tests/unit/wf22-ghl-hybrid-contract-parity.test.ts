/**
 * WF22 cross-repository contract parity (Command Center side).
 *
 * The CC keeps a versioned, hash-checked copy of the shared contract shapes so
 * its build/runtime never needs GitHub access. This test proves the copy is
 * internally consistent and byte-identical to the onboarding copy when that
 * checkout is available. Absence of the other checkout is reported honestly,
 * never treated as parity.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONTRACTS = path.join(process.cwd(), 'tests', 'fixtures', 'ghl-hybrid', 'contracts');
const ONBOARDING_CONTRACTS = path.join('06-ghl-install-pages', 'tests', 'ghl_hybrid_fixtures', 'contracts');

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function manifest(dir = CONTRACTS): any {
  return JSON.parse(fs.readFileSync(path.join(dir, 'contract-manifest.json'), 'utf8'));
}

function schemaFiles(dir = CONTRACTS): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.schema.json')).sort();
}

function hashes(dir = CONTRACTS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of schemaFiles(dir)) out[name] = sha256(path.join(dir, name));
  return out;
}

function contractSetDigest(dir = CONTRACTS): string {
  const hash = crypto.createHash('sha256');
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name === 'contract-manifest.json') continue;
    hash.update(name);
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(path.join(dir, name)));
    hash.update(Buffer.from([0]));
  }
  return hash.digest('hex');
}

test('contract manifest hashes match the copied schema files', () => {
  const declared = manifest().files;
  assert.deepEqual(declared, hashes());
  assert.deepEqual(Object.keys(declared).sort(), schemaFiles());
});

test('contract manifest names its assumption instead of claiming authority', () => {
  const record = manifest();
  assert.equal(record.authority, 'fixture-snapshot');
  assert.equal(record.assumed_checkpoint, 'WF00-CP01');
  assert.match(record.assumed_checkpoint_status, /^pending/);
  assert.match(record.authoritative_source, /^shared-utils\/ghl\/contracts\//);
});

test('onboarding copy is byte-identical when the checkout is available', () => {
  const repo = process.env.GHL_HYBRID_ONBOARDING_REPO;
  if (!repo) {
    assert.ok(manifest().contract_set);
    return;
  }
  const dir = path.join(repo, ONBOARDING_CONTRACTS);
  assert.ok(fs.existsSync(dir), `onboarding fixture copy missing: ${dir}`);
  assert.deepEqual(hashes(dir), hashes());
  assert.equal(contractSetDigest(dir), contractSetDigest());
  assert.deepEqual(manifest(dir).files, manifest().files);
  assert.equal(manifest(dir).contract_set, manifest().contract_set);
});

test('authoritative shared contracts converge when the owner publishes them', () => {
  const repo = process.env.GHL_HYBRID_ONBOARDING_REPO;
  if (!repo) {
    assert.ok(manifest().contract_set);
    return;
  }
  const authoritative = path.join(repo, 'shared-utils', 'ghl', 'contracts');
  if (!fs.existsSync(authoritative)) {
    assert.match(manifest().assumed_checkpoint_status, /^pending/);
    return;
  }
  assert.deepEqual(hashes(authoritative), hashes());
});
