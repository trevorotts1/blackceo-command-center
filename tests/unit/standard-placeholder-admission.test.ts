// STD001: the standard placeholder admits the dashboard; a bare standardPrebuild never does.
import test from 'node:test';
import assert from 'node:assert/strict';
import { standardPlaceholderActive } from '../../src/lib/interview/build-verification';
import { checkInterviewCompleteViaFallback } from '../../src/lib/interview/gate-fallback';

const active = { companyMode: 'standard-placeholder', standardPlaceholder: { status: 'active' }, interviewComplete: false };

test('standardPlaceholderActive is true only for an active placeholder', () => {
  assert.equal(standardPlaceholderActive(active), true);
  assert.equal(standardPlaceholderActive({ ...active, standardPlaceholder: { status: 'superseded' } }), false);
  assert.equal(standardPlaceholderActive({ companyMode: 'standard-placeholder' }), false);
  assert.equal(standardPlaceholderActive({ ...active, companyMode: 'interview' }), false);
  assert.equal(standardPlaceholderActive({ standardPrebuild: { status: 'done' } }), false);
  assert.equal(standardPlaceholderActive(null), false);
});

test('gate-fallback admits standardPlaceholder:true and refuses a bare standardReady', async () => {
  const real = globalThis.fetch;
  try {
    for (const [body, want] of [
      [{ interviewComplete: false, standardPlaceholder: true }, true],
      [{ interviewComplete: false, standardReady: true }, false],
    ] as const) {
      globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
      assert.equal(await checkInterviewCompleteViaFallback(), want);
    }
  } finally { globalThis.fetch = real; }
});
