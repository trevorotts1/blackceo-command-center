/**
 * board-slas-config.test.ts — U101 config loader (fail-closed contract).
 *
 * Points BOARD_SLAS_CONFIG_PATH at a throwaway file per test so this never
 * touches the repo's own config/board-slas.json, then exercises every
 * fail-closed branch named in src/lib/board-slas.ts's module header:
 * missing file, unparseable JSON, wrong top-level shape, a malformed
 * department entry, a malformed field, and the env-var-wins precedence rule.
 *
 *   node --import tsx --test tests/unit/board-slas-config.test.ts
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-board-slas-'));

function withConfig<T>(content: string | null, fn: () => T): T {
  const p = path.join(tmpDir, `board-slas-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  if (content !== null) fs.writeFileSync(p, content, 'utf-8');
  const prev = process.env.BOARD_SLAS_CONFIG_PATH;
  process.env.BOARD_SLAS_CONFIG_PATH = p;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.BOARD_SLAS_CONFIG_PATH;
    else process.env.BOARD_SLAS_CONFIG_PATH = prev;
  }
}

test('absent file: empty config, sourcePresent=false, zero warnings, resolves to the global default', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache, resolveSlaThreshold } = await import('../../src/lib/board-slas');
  await withConfig(null, () => {
    invalidateBoardSlaConfigCache();
    const result = loadBoardSlaConfig();
    assert.equal(result.sourcePresent, false);
    assert.deepEqual(result.config, {});
    assert.equal(result.warnings.length, 0);
    assert.equal(resolveSlaThreshold('finance-accounting', 'blockedOperatorEscalateHours', 168), 168);
  });
});

test('unparseable JSON: fails closed to an empty table + a warning, never throws', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache } = await import('../../src/lib/board-slas');
  await withConfig('{ this is not json', () => {
    invalidateBoardSlaConfigCache();
    const result = loadBoardSlaConfig();
    assert.deepEqual(result.config, {});
    assert.ok(result.warnings.length >= 1);
    assert.match(result.warnings[0], /failed to read\/parse/i);
  });
});

test('wrong top-level shape (array, not object): fails closed to an empty table + a warning', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache } = await import('../../src/lib/board-slas');
  await withConfig('[1,2,3]', () => {
    invalidateBoardSlaConfigCache();
    const result = loadBoardSlaConfig();
    assert.deepEqual(result.config, {});
    assert.ok(result.warnings.some((w) => /top level must be a JSON object/i.test(w)));
  });
});

test('a malformed department entry (not an object) is dropped, but sibling valid departments survive', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache } = await import('../../src/lib/board-slas');
  const raw = JSON.stringify({
    'finance-accounting': 'not an object',
    'client-success': { blockedOperatorEscalateHours: 24 },
  });
  await withConfig(raw, () => {
    invalidateBoardSlaConfigCache();
    const result = loadBoardSlaConfig();
    assert.equal(result.config['finance-accounting'], undefined);
    assert.deepEqual(result.config['client-success'], { blockedOperatorEscalateHours: 24 });
    assert.ok(result.warnings.some((w) => /finance-accounting.*not an object/i.test(w)));
  });
});

test('a malformed field (negative, zero, NaN, non-number) is dropped; valid sibling fields on the same department survive', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache } = await import('../../src/lib/board-slas');
  const raw = JSON.stringify({
    'finance-accounting': {
      blockedOperatorEscalateHours: 24,
      reviewUnscoredHours: -5,
      doneArchiveDays: 0,
      staleBacklogNudgeDays: 'twenty-one',
      staleInProgressHours: NaN,
    },
  });
  await withConfig(raw, () => {
    invalidateBoardSlaConfigCache();
    const result = loadBoardSlaConfig();
    assert.deepEqual(result.config['finance-accounting'], { blockedOperatorEscalateHours: 24 });
    assert.ok(result.warnings.length >= 4, `expected >=4 field warnings, got ${result.warnings.length}`);
  });
});

test('an unknown field name is dropped with a warning, never silently applied', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache } = await import('../../src/lib/board-slas');
  const raw = JSON.stringify({ 'finance-accounting': { totallyMadeUpKey: 5, blockedOwnerRepingHours: 12 } });
  await withConfig(raw, () => {
    invalidateBoardSlaConfigCache();
    const result = loadBoardSlaConfig();
    assert.deepEqual(result.config['finance-accounting'], { blockedOwnerRepingHours: 12 });
    assert.ok(result.warnings.some((w) => /unknown field "totallyMadeUpKey"/i.test(w)));
  });
});

test('resolveSlaThreshold precedence: explicit env var wins over a valid department override', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache, resolveSlaThreshold } = await import('../../src/lib/board-slas');
  const raw = JSON.stringify({ 'finance-accounting': { blockedOperatorEscalateHours: 6 } });
  await withConfig(raw, () => {
    invalidateBoardSlaConfigCache();
    loadBoardSlaConfig();
    process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS = '999';
    try {
      const v = resolveSlaThreshold('finance-accounting', 'blockedOperatorEscalateHours', 168);
      assert.equal(v, 999, 'explicit env var must win over the department override, globally');
    } finally {
      delete process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS;
    }
  });
});

test('resolveSlaThreshold precedence: valid department override wins over the hardcoded default when env is unset', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache, resolveSlaThreshold } = await import('../../src/lib/board-slas');
  const raw = JSON.stringify({ 'finance-accounting': { blockedOperatorEscalateHours: 6 } });
  await withConfig(raw, () => {
    invalidateBoardSlaConfigCache();
    loadBoardSlaConfig();
    delete process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS;
    assert.equal(resolveSlaThreshold('finance-accounting', 'blockedOperatorEscalateHours', 168), 6);
    // A department with no entry at all falls through to the hardcoded default.
    assert.equal(resolveSlaThreshold('client-success', 'blockedOperatorEscalateHours', 168), 168);
    // No department (null) always falls through to the hardcoded default.
    assert.equal(resolveSlaThreshold(null, 'blockedOperatorEscalateHours', 168), 168);
  });
});

test('minPossibleSlaThreshold reflects the tightest configured department override', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache, minPossibleSlaThreshold } = await import('../../src/lib/board-slas');
  const raw = JSON.stringify({
    'finance-accounting': { blockedOperatorEscalateHours: 6 },
    'client-success': { blockedOperatorEscalateHours: 12 },
  });
  await withConfig(raw, () => {
    invalidateBoardSlaConfigCache();
    loadBoardSlaConfig();
    delete process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS;
    assert.equal(minPossibleSlaThreshold('blockedOperatorEscalateHours', 168), 6);
  });
});

test('minPossibleSlaThreshold returns the explicit env value directly when set (no department can widen past it)', async () => {
  const { loadBoardSlaConfig, invalidateBoardSlaConfigCache, minPossibleSlaThreshold } = await import('../../src/lib/board-slas');
  const raw = JSON.stringify({ 'finance-accounting': { blockedOperatorEscalateHours: 6 } });
  await withConfig(raw, () => {
    invalidateBoardSlaConfigCache();
    loadBoardSlaConfig();
    process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS = '3';
    try {
      assert.equal(minPossibleSlaThreshold('blockedOperatorEscalateHours', 168), 3);
    } finally {
      delete process.env.BOARD_HYGIENE_BLOCKED_ESCALATE_HOURS;
    }
  });
});
