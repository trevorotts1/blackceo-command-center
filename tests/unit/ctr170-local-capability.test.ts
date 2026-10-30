/**
 * CTR-170 — host-local capability capture is bound to THIS installation
 * (unexecuted here; Trevor owns the test run).
 *
 * The capture gate must accept exactly one case: the verified principal is a
 * `self` tenant AND its resolved installation id equals this process's
 * declared `MC_INSTALLATION_ID`. Anything else — a client box, a different
 * installation registered on the same host, or no declared installation id —
 * must refuse local capture so this box's inventory is never stored under
 * another installation's scope.
 *
 * Run: node --import tsx --test tests/unit/ctr170-local-capability.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isHostLocalInstallation } from '../../src/lib/council/capability-snapshot-service';

function principal(tenantKind: 'self' | 'client', installationId: string) {
  return {
    tenantKind,
    scope: {
      tenant_id: 'tenant-a',
      company_id: 'company-a',
      installation_id: installationId,
      owner_subject: null,
    },
  } as const;
}

function withInstallationId<T>(value: string | undefined, run: () => T): T {
  const saved = process.env.MC_INSTALLATION_ID;
  try {
    if (value === undefined) delete process.env.MC_INSTALLATION_ID;
    else process.env.MC_INSTALLATION_ID = value;
    return run();
  } finally {
    if (saved === undefined) delete process.env.MC_INSTALLATION_ID;
    else process.env.MC_INSTALLATION_ID = saved;
  }
}

test('captures only the exact self installation declared by this host', () => {
  withInstallationId('install-this-box', () => {
    assert.equal(isHostLocalInstallation(principal('self', 'install-this-box')), true);
  });
});

test('refuses a self registration that names a different installation', () => {
  withInstallationId('install-this-box', () => {
    assert.equal(isHostLocalInstallation(principal('self', 'install-other-box')), false);
  });
});

test('refuses a client installation even when the ids happen to match', () => {
  withInstallationId('install-this-box', () => {
    assert.equal(isHostLocalInstallation(principal('client', 'install-this-box')), false);
  });
});

test('refuses when this host declares no installation id', () => {
  withInstallationId(undefined, () => {
    assert.equal(isHostLocalInstallation(principal('self', 'local')), false);
  });
  withInstallationId('   ', () => {
    assert.equal(isHostLocalInstallation(principal('self', '   ')), false);
  });
});
