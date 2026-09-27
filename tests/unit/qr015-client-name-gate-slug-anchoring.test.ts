/**
 * QR-015 — the HOSTNAME/SLUG tier of scripts/qc-assert-no-client-names.sh must
 * anchor EACH slug alternative separately, not the whole alternation once.
 *
 * DEFECT (five-lens wave REVL-026 FAIL; tip df1a614797cab0af6c9a40a3f4c206565a9525c3).
 * The tier joined its derived slugs with `|` and then wrapped the WHOLE string
 * in one pair of word boundaries:
 *
 *   SLUG_PATTERN="\b${SLUG_PATTERN}\b"
 *
 * In ERE a `\b` binds only the FIRST and LAST alternative, so with three or
 * more slugs every MIDDLE alternative lost BOTH boundaries and degraded to a
 * bare substring. Runtime capture at the parent revision (`bash -x`):
 *
 *   + SLUG_PATTERN='\b<slug-1>|<slug-2>|<slug-3>\b'    # middle: NO \b at all
 * (real slugs redacted to placeholders; measured live on the operator box)
 *
 * The name tier 20 lines above had always done it correctly, via
 * `printf '\b%s\b\n'` per entry; the slug tier did not. Consequence: a glued
 * identifier that merely CONTAINS a middle slug — "Xbeth-jones" or
 * "beth-jonesY" — was reported as a client-name leak (false positive that
 * blocks unrelated pushes), while the boundary contract the tier documents
 * ("\b-anchored, mirroring the name tier") was not the one enforced.
 *
 * This suite drives the REAL gate script as a subprocess against a synthetic,
 * obviously-fake roster and a synthetic temp repo-root — no real client name,
 * hostname, slug, chat ID or operator path appears here as a literal, and the
 * gate's own real roster is never consulted (OPENCLAW_CLIENT_ROSTER overrides
 * the resolve path). Deterministic and offline.
 *
 * Discrimination: the same fixture was run against the parent revision, where
 * the two glued lines ARE flagged (see the unit evidence ledger). After the
 * fix the glued lines are clean and the hostname / path / standalone slugs
 * still bite, so this suite FAILS at the parent construction and PASSES here.
 *
 * Run: node --import tsx --test tests/unit/qr015-client-name-gate-slug-anchoring.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = path.join(REPO_ROOT, 'scripts', 'qc-assert-no-client-names.sh');

// Three entries, all obviously fake. THREE is load-bearing: with fewer than
// three alternatives the single \b pair happens to cover every position and
// the defect is invisible.
const ROSTER_ENTRIES = ['Test Alpha', 'Test Beta', 'Test Gamma'];
const SLUGS = ['test-alpha', 'test-beta', 'test-gamma'];
// The MIDDLE alternative of the joined pattern — the one the old single \b
// pair left unanchored on BOTH sides.
const MIDDLE_SLUG = SLUGS[1];

interface GateRun {
  rc: number;
  out: string;
}

/** Run the real gate against `root`, with `rosterPath` as its denylist. */
function runGate(root: string, rosterPath: string): GateRun {
  try {
    const out = execFileSync('bash', [GATE, '--repo-root', root], {
      encoding: 'utf8',
      env: { ...process.env, OPENCLAW_CLIENT_ROSTER: rosterPath, CI: '', GITHUB_ACTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { rc: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { rc: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** A throwaway git repo whose TRACKED content is exactly `files`. */
function makeTree(label: string, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ltrn-qr015-${label}-`));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'qr015@example.invalid');
  git('config', 'user.name', 'qr015');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return dir;
}

function writeRoster(entries: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ltrn-qr015-roster-'));
  const file = path.join(dir, 'roster.txt');
  fs.writeFileSync(file, `${entries.join('\n')}\n`);
  return file;
}

/** Which of `lines` the gate's report actually names. */
function flagged(out: string, line: string): boolean {
  return out.includes(line);
}

test('QR-015: glued slug strings are NOT reported; real leaks still are', () => {
  const roster = writeRoster(ROSTER_ENTRIES);
  const gluedLines = [
    `const a = "X${MIDDLE_SLUG}";`,
    `const b = "${MIDDLE_SLUG}Y";`,
    `const c = "X${SLUGS[0]}";`,
    `const d = "${SLUGS[2]}Y";`,
  ];
  const leakLines = [
    `const host = "${MIDDLE_SLUG}.zerohumanworkforce.com";`,
    `const p = "/path/${MIDDLE_SLUG}";`,
    `const bare = "${MIDDLE_SLUG}";`,
  ];
  const cleanLines = ['const ok = "nothing identifying here";'];
  const tree = makeTree('glued', {
    'glued.txt': `${gluedLines.join('\n')}\n`,
    'leaked.txt': `${leakLines.join('\n')}\n`,
    'clean.txt': `${cleanLines.join('\n')}\n`,
  });

  try {
    const { rc, out } = runGate(tree, roster);
    assert.equal(rc, 1, `leak tree must still fail closed; rc=${rc}\n${out}`);

    for (const line of gluedLines) {
      assert.equal(
        flagged(out, line),
        false,
        `glued string must NOT be flagged (word boundary must bind each alternative): ${line}\n${out}`
      );
    }
    for (const line of leakLines) {
      assert.equal(
        flagged(out, line),
        true,
        `real leak must still be flagged: ${line}\n${out}`
      );
    }
    assert.equal(flagged(out, cleanLines[0]), false, 'clean line must never be flagged');
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(path.dirname(roster), { recursive: true, force: true });
  }
});

test('QR-015: a clean tree with glued slugs exits 0', () => {
  const roster = writeRoster(ROSTER_ENTRIES);
  const tree = makeTree('clean', {
    'glued.txt': [`X${MIDDLE_SLUG}`, `${MIDDLE_SLUG}Y`].map((s, i) => `const v${i} = "${s}";`).join('\n') + '\n',
  });
  try {
    const { rc, out } = runGate(tree, roster);
    assert.equal(rc, 0, `clean tree must PASS; rc=${rc}\n${out}`);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(path.dirname(roster), { recursive: true, force: true });
  }
});

test('QR-015: a single-entry roster is unchanged by the anchoring fix', () => {
  // A one-alternative pattern is already fully anchored by one \b pair, so the
  // fix must not alter it in either direction: glued clean, bare slug flagged.
  const roster = writeRoster([ROSTER_ENTRIES[0]]);
  const glued = `const a = "X${SLUGS[0]}";`;
  const bare = `const b = "${SLUGS[0]}";`;
  const tree = makeTree('single', { 'f.txt': `${glued}\n${bare}\n` });
  try {
    const { rc, out } = runGate(tree, roster);
    assert.equal(rc, 1, `bare single-entry slug must still fail closed; rc=${rc}\n${out}`);
    assert.equal(flagged(out, glued), false, `glued single-entry slug must not be flagged\n${out}`);
    assert.equal(flagged(out, bare), true, `bare single-entry slug must be flagged\n${out}`);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(path.dirname(roster), { recursive: true, force: true });
  }
});
