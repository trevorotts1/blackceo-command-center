/**
 * u064-anti-impersonation-mutation.test.ts — U064 mutation proof.
 *
 * The persona-blend dispatch layer enforces a mandatory style-inspired-NOT-
 * impersonation guardrail (STYLE_INSPIRED_GUARDRAIL in persona-dispatch.ts,
 * commit 12055774): ensureBlendGuardrail appends the clause to any directive
 * that lacks it, and renderBlendDirective wraps every blend directive with it.
 * The agents/ tree on origin/main carries ZERO "Act AS IF you ARE" directives.
 * The existing fdn3-persona-dispatch-injection test proves the injection
 * behavior but carries no mutation proof — this file supplies it (AC#3).
 *
 * The load-bearing line is ensureBlendGuardrail's injection
 * (`return base ? `${base}\n\n${STYLE_INSPIRED_GUARDRAIL}` : STYLE_INSPIRED_GUARDRAIL;`).
 * Replacing it with `return base;` lets a directive pass through with NO
 * anti-impersonation clause — the exact vulnerability U064 closes.
 *
 *   T1  baseline: a directive without the guardrail gets it appended
 *   T2  baseline: a directive already carrying the guardrail is unchanged
 *   T3  baseline: renderBlendDirective always includes the guardrail
 *   T4  MUTATION (RED): with the injection line replaced by `return base;`,
 *       a directive passes through UNPROTECTED (no guardrail) — vulnerability
 *       exposed
 *   T5  GREEN: the real module still appends the guardrail (mutation reverted)
 *
 * Pure functions — no DB, no fs-mutation-of-source, no network.
 * Run: node --import tsx --test tests/unit/u064-anti-impersonation-mutation.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ensureBlendGuardrail,
  renderBlendDirective,
  STYLE_INSPIRED_GUARDRAIL,
} from '../../src/lib/persona-dispatch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE = path.join(REPO_ROOT, 'src', 'lib', 'persona-dispatch.ts');

const DIRECTIVE = 'Write in Ogilvy voice, carry SaaS-pricing expertise.';

function hasGuardrail(s: string): boolean {
  return /style-inspired/i.test(s) && /impersonation/i.test(s);
}

test('T1: baseline — a directive without the guardrail gets it appended', () => {
  const out = ensureBlendGuardrail(DIRECTIVE);
  assert.ok(hasGuardrail(out), 'the guardrail must be appended');
  assert.ok(out.includes(DIRECTIVE), 'the original directive is preserved');
  assert.ok(out.includes(STYLE_INSPIRED_GUARDRAIL), 'the exact guardrail constant is appended');
});

test('T2: baseline — a directive already carrying the guardrail is unchanged', () => {
  const alreadyGuarded = `${DIRECTIVE}\n\n${STYLE_INSPIRED_GUARDRAIL}`;
  const out = ensureBlendGuardrail(alreadyGuarded);
  assert.equal(out, alreadyGuarded, 'an already-guarded directive is returned verbatim (no double-append)');
});

test('T3: baseline — renderBlendDirective always includes the guardrail', () => {
  assert.ok(hasGuardrail(renderBlendDirective(DIRECTIVE)), 'rendered directive carries the guardrail');
  assert.ok(hasGuardrail(renderBlendDirective('')), 'empty directive still yields the guardrail');
  assert.ok(hasGuardrail(renderBlendDirective(null)), 'null directive still yields the guardrail');
});

test('T4: MUTATION (RED) — replacing the injection with `return base;` leaves a directive UNPROTECTED', async () => {
  const src = fs.readFileSync(SOURCE, 'utf-8');
  const needle = '  return base ? `${base}\\n\\n${STYLE_INSPIRED_GUARDRAIL}` : STYLE_INSPIRED_GUARDRAIL;';
  assert.ok(src.includes(needle), 'the load-bearing injection line must exist');

  // MUTATION: return the directive with NO guardrail appended.
  const mutated = src.replace(needle, '  return base; // MUTATION: guardrail injection removed');
  assert.notEqual(mutated, src, 'mutation must change the source');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u064-mut-'));
  const mutFile = path.join(tmp, 'persona-dispatch.mutated.ts');
  fs.writeFileSync(mutFile, mutated);

  try {
    const mod = await import(pathToFileURL(mutFile).href);
    const out = mod.ensureBlendGuardrail(DIRECTIVE);
    // RED: the directive passes through with NO anti-impersonation clause —
    // the exact vulnerability U064 closes.
    assert.ok(!hasGuardrail(out), 'MUTATION must leave the directive UNPROTECTED (no guardrail) — RED');
    assert.equal(out, DIRECTIVE, 'MUTATION returns the bare directive');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T5: GREEN — the real module still appends the guardrail (mutation reverted)', () => {
  const out = ensureBlendGuardrail(DIRECTIVE);
  assert.ok(hasGuardrail(out), 'the real module must still append the guardrail — GREEN');
});
