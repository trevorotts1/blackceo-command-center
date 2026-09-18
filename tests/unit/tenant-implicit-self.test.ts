/**
 * Implicit self registration (2026-09-18). A production box with NO tenant
 * registry configured is a single-tenant installation: loopback and the
 * hostname of its own configured public URL resolve to the self identity.
 * Every other host still has no tenant, and a box WITH a registry keeps the
 * strict behaviour (loopback included) unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

async function load() {
  return await import('../../src/lib/auth/tenant-context');
}
function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]!; }
  try { fn(); } finally { for (const k of Object.keys(vars)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
}

test('no registry, production: loopback resolves to the implicit self identity', async () => {
  const { tenantRegistration } = await load();
  withEnv({ NODE_ENV: 'production', MC_TENANT_REGISTRY_JSON: undefined, CC_PUBLIC_URL: undefined, MC_TENANT_PUBLIC_URL: undefined, MC_COMPANY_ID: undefined, MC_INSTALLATION_ID: 'box-1' }, () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const reg = tenantRegistration(host);
      assert.equal(reg.kind, 'self'); assert.equal(reg.tenantId, 'self'); assert.equal(reg.companyId, 'default'); assert.equal(reg.installationId, 'box-1');
    }
  });
});

test('no registry, production: the hostname of CC_PUBLIC_URL resolves; any other host is refused', async () => {
  const { tenantRegistration, TenantAccessError } = await load();
  withEnv({ NODE_ENV: 'production', MC_TENANT_REGISTRY_JSON: undefined, CC_PUBLIC_URL: 'https://Angela.example.com', MC_COMPANY_ID: 'acme' }, () => {
    const reg = tenantRegistration('angela.example.com');
    assert.equal(reg.companyId, 'acme');
    assert.throws(() => tenantRegistration('evil.example.com'), TenantAccessError);
    assert.throws(() => tenantRegistration('angela.example.com.evil.net'), TenantAccessError);
  });
  withEnv({ NODE_ENV: 'production', MC_TENANT_REGISTRY_JSON: undefined, CC_PUBLIC_URL: undefined, MC_TENANT_PUBLIC_URL: 'https://box.example.org/' }, () => {
    assert.equal(tenantRegistration('box.example.org').kind, 'self');
  });
});

test('a configured registry stays strict: unregistered loopback and own host are still refused', async () => {
  const { tenantRegistration, TenantAccessError } = await load();
  const registry = JSON.stringify({ 'client.example.com': { tenantId: 't1', companyId: 'c1', kind: 'self', installationId: 'i1' } });
  withEnv({ NODE_ENV: 'production', MC_TENANT_REGISTRY_JSON: registry, CC_PUBLIC_URL: 'https://client.example.com' }, () => {
    assert.equal(tenantRegistration('client.example.com').tenantId, 't1');
    assert.throws(() => tenantRegistration('127.0.0.1'), TenantAccessError, 'loopback is not implicitly registered when a registry exists');
    assert.throws(() => tenantRegistration('other.example.com'), TenantAccessError);
  });
});

test('an empty registry object counts as no registry', async () => {
  const { tenantRegistration } = await load();
  withEnv({ NODE_ENV: 'production', MC_TENANT_REGISTRY_JSON: '{}', CC_PUBLIC_URL: undefined }, () => {
    assert.equal(tenantRegistration('127.0.0.1').kind, 'self');
  });
});
