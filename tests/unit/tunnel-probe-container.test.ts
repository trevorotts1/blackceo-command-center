/**
 * CC-003: inside a container the cloudflared tunnel runs on the HOST, so the
 * tunnel probe reporting "unknown" with `configured: false` is "nothing to
 * check here" — not a fault, and it must not turn the header Degraded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNotApplicable } from '../../src/lib/probes/types';

test('a container tunnel row that is unknown and not configured is not applicable', () => {
  assert.equal(
    isNotApplicable({ component: 'cloudflare_tunnel', status: 'unknown', detail: { configured: false } }),
    true
  );
});

test('the exemption is specific: equal inputs that are configured stay applicable', () => {
  assert.equal(
    isNotApplicable({ component: 'cloudflare_tunnel', status: 'unknown', detail: { configured: true } }),
    false
  );
  assert.equal(isNotApplicable({ component: 'cloudflare_tunnel', status: 'offline', detail: { configured: false } }), false);
});
