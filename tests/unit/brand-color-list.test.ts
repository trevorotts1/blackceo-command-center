import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrandColor } from '../../src/lib/branding';

test('several hex codes in one answer use the first code', () => {
  assert.equal(resolveBrandColor('#C9A227, #2E1A47').hex, '#c9a227');
  assert.equal(resolveBrandColor('c9a227 and 2e1a47').hex, '#c9a227');
  assert.equal(resolveBrandColor('primary #39f secondary #000').hex, '#3399ff');
});

test('plain words are still not colors', () => {
  assert.equal(resolveBrandColor('decade add').hex, null);
  assert.equal(resolveBrandColor('my colors are gold').hex, null);
});
