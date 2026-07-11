/**
 * Unit-prove the three new QC gates (v4.45.0) against the REAL exported code in
 * src/lib/qc-scorer.ts (no reimplementation):
 *
 *   (a) AF-I14 image-path guardrail — runAFI14Guardrail():
 *        - fires=TRUE on a synthetic session trace that uses the native
 *          image_generate tool (VIOLATION-A) and the dead endpoint
 *          /api/v1/image/gpt-image (VIOLATION-B).
 *        - fires=FALSE on a trace that shells out to kie_generate.py / api.kie.ai
 *          (the mandated path).
 *        - fail-closed: image/deck deliverable but NO trace ⇒ VIOLATION-C.
 *
 *   (b) AF-LANG language gate — deriveAcceptanceCriteria() + evaluateCriteria():
 *        - a Chinese/garbled-text image fixture FAILS language_match.
 *        - an English image fixture PASSES language_match.
 *        (Uses the LIVE vision LLM via OPENAI_API_KEY/GOOGLE_API_KEY. If neither
 *         key is present the AF-LANG criterion fails CLOSED — also asserted.)
 *
 *   (c) Independent QC — the builder cannot inject a self-score:
 *        - UpdateTaskSchema (the task PATCH body schema) exposes NO qc_score /
 *          qc_report / score field, so a builder-written self-score is never even
 *          ingested; the independent runQCOnReview pass is the sole authority.
 *
 * AF-I14 is driven via a TEMP $HOME so the filesystem session-scan path is fully
 * deterministic, and a TEMP empty DATABASE_PATH so the openclaw_sessions DB
 * lookup finds no table and falls through to that scan.
 *
 * Run: npm run test:unit  (node --import tsx --test)
 */

// C8 — DB isolation MUST happen in an IMPORTED module, and this MUST stay the
// first import. Assigning process.env.DATABASE_PATH in this file's BODY does not
// work: ES `import` declarations are HOISTED, so any statically-imported project
// module that transitively reaches '@/lib/db' is evaluated FIRST — freezing
// `export const DB_PATH = process.env.DATABASE_PATH || <cwd>/mission-control.db`
// from the un-isolated env. This suite did exactly that and silently opened,
// migrated and wrote the LIVE mission-control.db. Proven by deleting the file and
// re-running this suite alone: it came back.
// Enforced by tests/unit/c8-db-isolation-guard.test.ts.
import './_isolated-db';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB + HOME BEFORE importing the module under test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-gate-test-'));
process.env.DATABASE_PATH = path.join(TMP, 'empty.db'); // no openclaw_sessions table
const FAKE_HOME = path.join(TMP, 'home');
const SESS_DIR = path.join(FAKE_HOME, '.openclaw', 'agents', 'dept-presentations', 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });
process.env.HOME = FAKE_HOME;

import {
  runAFI14Guardrail,
  deriveAcceptanceCriteria,
  evaluateCriteria,
  type DeliverableManifestItem,
} from '../../src/lib/qc-scorer';
import { UpdateTaskSchema } from '../../src/lib/validation';

const FIX = '/tmp/deck-proof/fixtures';

function writeTrace(name: string, lines: object[]) {
  const file = path.join(SESS_DIR, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'));
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) AF-I14
// ─────────────────────────────────────────────────────────────────────────────

test('AF-I14 (a) FIRES=true on native image_generate tool + dead endpoint trace', () => {
  const taskId = 'task-violation-aaa';
  // The DB-fallback scan matches a .jsonl that CONTAINS the taskId string.
  writeTrace('sess-violation', [
    { role: 'user', content: `Build deck for ${taskId}` },
    // VIOLATION-A: a real native tool_use block named image_generate
    { type: 'tool_use', name: 'image_generate', input: { prompt: 'a blue duck' } },
    // VIOLATION-B: the dead endpoint string appears in a tool result
    { type: 'tool_result', content: 'POST https://api.openai.com/api/v1/image/gpt-image -> 404' },
  ]);

  const res = runAFI14Guardrail(taskId, 'dept-presentations', 'presentations', true);
  assert.equal(res.violated, true, 'expected guardrail to FIRE');
  const blob = res.violations.join(' | ');
  assert.match(blob, /VIOLATION-A/, 'should flag native image_generate (A)');
  assert.match(blob, /VIOLATION-B/, 'should flag dead endpoint (B)');
  // It used the mandated script nowhere ⇒ C also fires.
  assert.match(blob, /VIOLATION-C/, 'should flag missing KIE.ai usage (C)');
  console.log('  [AF-I14 a] violated=%s violations=%d -> %s', res.violated, res.violations.length, blob.slice(0, 160));
});

test('AF-I14 (a) does NOT false-fire when image_generate is only QUOTED in prose (structured parse)', () => {
  const taskId = 'task-prose-quote';
  writeTrace('sess-prose', [
    { role: 'assistant', content: 'I must NOT call the native "image_generate" tool; I will use kie_generate.py instead.' },
    { type: 'tool_use', name: 'exec', input: { command: 'python3 scripts/kie_generate.py prompts.json renders/' } },
    { type: 'tool_result', content: 'submitted to https://api.kie.ai/api/v1/jobs/createTask -> taskId=abc' },
  ]);
  const res = runAFI14Guardrail(taskId, 'dept-presentations', 'presentations', true);
  const blob = res.violations.join(' | ');
  assert.ok(!/VIOLATION-A/.test(blob), 'A must NOT fire on a mere prose mention (structured parser)');
  console.log('  [AF-I14 a2] prose-quote violated=%s (A absent: %s)', res.violated, !/VIOLATION-A/.test(blob));
});

test('AF-I14 (b) FIRES=false on a clean kie_generate.py trace', () => {
  const taskId = 'task-clean-kie';
  writeTrace('sess-clean', [
    { role: 'user', content: `Build deck for ${taskId}` },
    { type: 'tool_use', name: 'exec', input: { command: 'python3 .../scripts/kie_generate.py prompts.json renders/' } },
    { type: 'tool_result', content: 'POST https://api.kie.ai/api/v1/jobs/createTask -> {"code":200,"data":{"taskId":"xyz"}}' },
    { type: 'tool_result', content: 'GET https://api.kie.ai/api/v1/jobs/recordInfo?taskId=xyz -> state=success' },
  ]);
  const res = runAFI14Guardrail(taskId, 'dept-presentations', 'presentations', true);
  assert.equal(res.violated, false, `expected NO violation, got: ${res.violations.join(' | ')}`);
  assert.equal(res.traceFound, true, 'trace should have been found + scanned');
  console.log('  [AF-I14 b] clean kie trace violated=%s traceFound=%s session=%s', res.violated, res.traceFound, res.sessionId);
});

test('AF-I14 (c) FAIL-CLOSED: image/deck deliverable but NO session trace ⇒ VIOLATION-C', () => {
  // taskId that appears in no .jsonl ⇒ no session found.
  const res = runAFI14Guardrail('task-no-trace-zzz', 'dept-presentations', 'presentations', true);
  assert.equal(res.violated, true, 'fail-closed: must FIRE when no trace proves KIE usage');
  assert.match(res.violations.join(' '), /VIOLATION-C \(fail-closed\)/);
  console.log('  [AF-I14 c] no-trace fail-closed violated=%s -> %s', res.violated, res.violations[0]?.slice(0, 120));
});

test('AF-I14 scope: out-of-scope task (no deliverable, non-pres dept) is SKIPPED', () => {
  const res = runAFI14Guardrail('task-marketing-text', 'dept-marketing', 'marketing', false);
  assert.equal(res.violated, false);
  assert.equal(res.traceFound, false);
  console.log('  [AF-I14 scope] non-image marketing task skipped: violated=%s', res.violated);
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) AF-LANG  (live vision)
// ─────────────────────────────────────────────────────────────────────────────

function manifestFor(p: string): DeliverableManifestItem[] {
  const sz = fs.existsSync(p) ? fs.statSync(p).size : null;
  return [{ title: path.basename(p), path: p, type: 'image', sizeBytes: sz, dimensions: null, valid: true }];
}

test('AF-LANG: deriveAcceptanceCriteria emits a language_match criterion for an image task', () => {
  const crit = deriveAcceptanceCriteria('Create a presentation slide image', null);
  const lang = crit.find((c) => c.type === 'language_match');
  assert.ok(lang, 'language_match criterion must be derived for image/deck tasks');
  assert.equal((lang!.params as { expectedLanguage?: string })?.expectedLanguage, 'english');
  console.log('  [AF-LANG derive] criteria types: %s', crit.map((c) => c.type).join(','));
});

test('AF-LANG: ENGLISH fixture PASSES language_match (live vision)', async () => {
  const hasKey = !!(process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  const crit = deriveAcceptanceCriteria('Create a presentation slide image', null);
  const res = await evaluateCriteria(crit, manifestFor(path.join(FIX, 'english-slide.png')));
  const lang = res.results.find((r) => r.id === 'language_match')!;
  console.log('  [AF-LANG english] hasKey=%s pass=%s reason=%s', hasKey, lang.pass, lang.reason);
  if (hasKey) {
    assert.equal(lang.pass, true, `English slide should PASS language_match: ${lang.reason}`);
  } else {
    assert.equal(lang.pass, false, 'no vision key ⇒ AF-LANG fails CLOSED');
  }
});

test('AF-LANG: CHINESE/GARBLED fixture FAILS language_match (live vision)', async () => {
  const hasKey = !!(process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
  const crit = deriveAcceptanceCriteria('Create a presentation slide image', null);
  const res = await evaluateCriteria(crit, manifestFor(path.join(FIX, 'chinese-garbled-slide.png')));
  const lang = res.results.find((r) => r.id === 'language_match')!;
  console.log('  [AF-LANG chinese] hasKey=%s pass=%s reason=%s', hasKey, lang.pass, lang.reason);
  // Either way the criterion must FAIL (live: vision detects CJK/garbled; no key: fail-closed).
  assert.equal(lang.pass, false, `Chinese/garbled slide must FAIL language_match: ${lang.reason}`);
  assert.ok(res.score < 8.5, `overall criteria score must be below the 8.5 gate (got ${res.score})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) Independent QC — builder self-score is never ingested
// ─────────────────────────────────────────────────────────────────────────────

test('Independent QC: UpdateTaskSchema exposes NO self-score field (qc_score/qc_report/score)', () => {
  const shape = (UpdateTaskSchema as unknown as { shape: Record<string, unknown> }).shape;
  const keys = Object.keys(shape);
  for (const banned of ['qc_score', 'qc_report', 'score', 'qcScore', 'self_score', 'grade']) {
    assert.ok(!keys.includes(banned), `PATCH schema must NOT accept a builder self-score field "${banned}"`);
  }
  // And an attempt to smuggle one is stripped (zod object drops unknown keys).
  const parsed = UpdateTaskSchema.parse({ status: 'review', qc_score: 10, score: 9.9 } as unknown);
  assert.ok(!('qc_score' in parsed), 'qc_score must be stripped by the schema');
  assert.ok(!('score' in parsed), 'score must be stripped by the schema');
  console.log('  [independent-QC] schema keys: %s (no self-score field present)', keys.join(','));
});
