#!/usr/bin/env node
/**
 * Sync the ACTIVE canonical Council chamber into this app's `public/chamber`.
 *
 * The Command Center must open the SAME screen the OpenClaw / claude-nine entry
 * opens. That screen is the dependency-free, same-origin bundle shipped by the
 * active council runtime release (`<release>/public/chamber`). This script
 * copies those exact bytes — it never authors, rewrites or "adapts" them — and
 * writes `PROVENANCE.json` beside them so the tree is provably the canonical
 * artifact rather than a lookalike.
 *
 * Usage:
 *   node scripts/council/sync-chamber.mjs            # from the active release
 *   node scripts/council/sync-chamber.mjs --release <path> --active <path>
 *
 * Exits 0 with `--check` when the checked-in tree still matches the active
 * release byte for byte, 1 when it has drifted.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEST = join(APP_ROOT, 'public', 'chamber');
const DEFAULT_RUNTIME = join(homedir(), '.openclaw', 'council-runtime');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const checkOnly = process.argv.includes('--check');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function activeRelease(activePath) {
  if (!existsSync(activePath)) {
    throw new Error(`No active council runtime at ${activePath}. Pass --active.`);
  }
  const active = readJson(activePath);
  if (!active.releasePath) throw new Error('active.json carries no releasePath.');
  return { active, release: active.releasePath };
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function digestTree(dir) {
  const files = {};
  for (const rel of walk(dir)) files[rel] = sha256(join(dir, rel));
  return files;
}

const runtimeRoot = arg('runtime') ?? DEFAULT_RUNTIME;
const activePath = arg('active') ?? join(runtimeRoot, 'active.json');
const { active, release } = activeRelease(activePath);
const source = arg('release') ?? join(release, 'public', 'chamber');
if (!existsSync(source)) throw new Error(`Canonical chamber bundle is missing at ${source}.`);

const expected = digestTree(source);

if (checkOnly) {
  if (!existsSync(DEST)) {
    console.error(`public/chamber is missing. Run: node scripts/council/sync-chamber.mjs`);
    process.exit(1);
  }
  const actual = digestTree(DEST);
  // PROVENANCE.json is written by this script, not shipped by the release.
  delete actual['PROVENANCE.json'];
  const drift = [];
  for (const rel of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    if (expected[rel] !== actual[rel]) drift.push(rel);
  }
  if (drift.length) {
    console.error(`public/chamber drifted from ${active.releaseId}:\n  ${drift.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`public/chamber matches ${active.releaseId} (${Object.keys(expected).length} files).`);
  process.exit(0);
}

rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });
for (const rel of Object.keys(expected)) {
  const target = join(DEST, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(source, rel), target);
}

const provenance = {
  schema: 'blackceo.command-center.chamber-provenance/v1',
  source: 'council-runtime active release public/chamber',
  releaseId: active.releaseId,
  sourceManifestDigest: active.sourceManifestDigest ?? null,
  artifactDigest: active.artifactDigest ?? null,
  copiedAt: new Date().toISOString(),
  fileCount: Object.keys(expected).length,
  files: expected,
};
writeFileSync(join(DEST, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Copied ${Object.keys(expected).length} canonical chamber files from ${active.releaseId} into public/chamber.`);
