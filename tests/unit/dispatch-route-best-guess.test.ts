/** Manual dispatch must use the best-guess fail-safe; house voice only when both tiers fail. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync('src/app/api/tasks/[id]/dispatch/route.ts', 'utf-8');

test('manual dispatch tries bestGuessAudienceForTask before markAudienceDeadlineFallback', () => {
  const guess = src.indexOf('bestGuessAudienceForTask(task.id');
  const fallback = src.indexOf('if (!guess) markAudienceDeadlineFallback(task.id)');
  assert.ok(guess > 0 && fallback > guess);
  assert.equal(src.match(/markAudienceDeadlineFallback\(task\.id\)/g)?.length, 1);
});
