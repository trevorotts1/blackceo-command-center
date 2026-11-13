/**
 * interview-id-matching.test.ts — registry v2 answer matching (BU-11).
 *
 * THE BUG THIS PREVENTS: every answered question was matched back to the deck by
 * its WORDING alone. The moment the registry changed a prompt — or an owner's
 * transcript predated the change — an answer the owner had already given stopped
 * counting, and the interview re-asked it. A wording match is a guess; the id is
 * the fact.
 *
 * Proves, against the vendored v2 registry:
 *   1. a block written with the OLD wording and no QID line is still answered
 *      (the wording is kept as an alias in `legacyPrompts`);
 *   2. a block carrying `**QID:** <id>` is answered for that id whatever the
 *      question text says — and a QID the deck does not know is NOT guessed at
 *      by text;
 *   3. the registry sync test fails on a single changed byte.
 *
 * No DB, no network. Only temp files, cleaned up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAnswerBlocks } from '../../src/lib/interview/seam';
import { computeAnsweredIds } from '../../src/lib/interview/structured-progress';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const VENDORED_REGISTRY = path.join(REPO_ROOT, 'src', 'lib', 'interview-questions.v2.json');
const SYNC_TEST = path.join(REPO_ROOT, 'scripts', 'sync-interview-registry-test.ts');

interface RegistryQuestion {
  id: string;
  prompt: string;
  legacyPrompts?: string[];
  section: string;
  required?: boolean;
  order?: number;
}

const registry = JSON.parse(fs.readFileSync(VENDORED_REGISTRY, 'utf-8')) as {
  version: string;
  questions: RegistryQuestion[];
};

const QUESTIONS = [...registry.questions].sort(
  (a, b) => (a.order ?? 0) - (b.order ?? 0),
);

/* ───────────────────────── 1. old wording, no QID line ─────────────────────── */

test('a block with the OLD prompt and no QID line is answered under the v2 registry', () => {
  const text = ['**Q:** What is your company name?', '**A:** Bright Path Coaching'].join('\n');

  const blocks = parseAnswerBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].qid, null, 'a block with no **QID:** line carries no id');

  assert.deepEqual(computeAnsweredIds(blocks, QUESTIONS), ['company_name']);
});

/* ─────────────────────── 2. the id wins over any wording ───────────────────── */

test('a block with **QID:** industry is answered for industry whatever the text says', () => {
  const text = [
    '**QID:** industry',
    '**Q:** Something the deck never asked, in different words',
    '**A:** aerospace',
  ].join('\n');

  const blocks = parseAnswerBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].qid, 'industry');

  assert.deepEqual(computeAnsweredIds(blocks, QUESTIONS), ['industry']);
});

test('an unknown QID is ignored, never re-matched by wording', () => {
  const industry = QUESTIONS.find((q) => q.id === 'industry');
  assert.ok(industry, 'the vendored registry carries the industry question');

  const text = [
    '**QID:** a_question_this_deck_does_not_have',
    `**Q:** ${industry.prompt}`,
    '**A:** aerospace',
  ].join('\n');

  assert.deepEqual(computeAnsweredIds(parseAnswerBlocks(text), QUESTIONS), []);
});

/* ───────────────────── 3. one changed byte fails the sync test ─────────────── */

function runSyncTest(canonicalPath: string): { status: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', SYNC_TEST, canonicalPath],
      { cwd: REPO_ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { status: 0, output };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}`,
    };
  }
}

test('the sync test passes on an identical copy and fails on one changed byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ivreg-'));
  try {
    const vendored = fs.readFileSync(VENDORED_REGISTRY);

    const identical = path.join(dir, 'questions.v2.json');
    fs.writeFileSync(identical, vendored);
    const ok = runSyncTest(identical);
    assert.equal(ok.status, 0, `identical copies must pass:\n${ok.output}`);

    const changed = Buffer.from(vendored);
    const at = changed.indexOf(Buffer.from('company_name'));
    assert.ok(at > 0, 'the registry contains the company_name id');
    changed[at] = 'C'.charCodeAt(0); // company_name → Company_name

    const mangled = path.join(dir, 'questions.v2.changed.json');
    fs.writeFileSync(mangled, changed);
    const bad = runSyncTest(mangled);
    assert.equal(bad.status, 1, `one changed byte must fail:\n${bad.output}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
