/**
 * CWE-005 council store adapter tests (directive Sections 11.1, 16.2,
 * 16.6, 17).
 *
 * The adapter is exercised through the REAL host lifecycle: the isolated
 * DATABASE_PATH helper points at a throwaway file, getDb() runs the base
 * schema plus the full migration chain (council migration included), and
 * openCouncilStore() binds to that handle.
 *
 * Covers:
 *   1. The council schema is present after getDb() (the migration ran
 *      through the real runner, under its pending integration id).
 *   2. Scoped session reads: same-scope company session is visible;
 *      private session is visible only to its owner; a session id from
 *      another scope resolves to nothing (a UUID is not authorization).
 *   3. Event append: sequences allocate 1, 2, 3 atomically per session.
 *   4. Diagnostic grants (Section 16.6 + CWE-003 policy): a disabled
 *      policy records nothing; a policy naming another session records
 *      nothing; a valid owner policy records the grant with the policy
 *      bounds; payload accessibility honors TTL expiry and revocation
 *      (the storage-shape foundation of T133/T134, owned by CWE-006).
 *   5. Request keys (Section 17): first claim wins, same-fingerprint
 *      replay returns the claim, different fingerprint conflicts (409 at
 *      the host) and records nothing new.
 */

import './_isolated-db';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import type { CouncilStore } from '../../src/lib/council/persistence/council-store';
import type { DiagnosticRetentionPolicy } from '../../src/lib/council/contracts';

const NOW = '2026-10-14T12:00:00.000Z';
const SCOPE = { tenantId: 'tenant-a', companyId: 'company-a' };

let store: CouncilStore;
let closeDb: () => void;

function insertSession(over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id: 'sess-1',
    tenant_id: 'tenant-a',
    company_id: 'company-a',
    installation_id: 'inst-a',
    owner_subject: 'owner-1',
    created_by_subject: 'owner-1',
    mode: 'full',
    visibility: 'private',
    state: 'DRAFT',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
  const cols = Object.keys(row);
  store
    .handle()
    .prepare(
      `INSERT INTO council_sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    )
    .run(...cols.map((c) => row[c]));
}

const ENABLED_POLICY: DiagnosticRetentionPolicy = {
  schema_version: 'wise-elders.diagnostic-retention-policy/v1',
  enabled: true,
  authorized_by_principal: 'owner-1',
  authorization_kind: 'owner',
  session_id: 'sess-1',
  capture_window_minutes: 60,
  payload_ttl_hours: 24,
  max_bytes_per_operation: 5 * 1024 * 1024,
  max_bytes_per_session: 25 * 1024 * 1024,
};

before(async () => {
  const storeModule = await import('../../src/lib/council/persistence/council-store');
  const dbModule = await import('../../src/lib/db');
  store = storeModule.openCouncilStore();
  closeDb = dbModule.closeDb;
});

after(() => {
  closeDb();
});

test('getDb() applied the council schema through the real migration runner', () => {
  const ledger = store
    .handle()
    .prepare(`SELECT id FROM _migrations WHERE name = 'council_scoped_storage_schema'`)
    .all() as { id: string }[];
  assert.deepEqual(
    ledger.map((r) => r.id),
    ['172'],
  );
  const tables = store
    .handle()
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'council%'`)
    .all() as { name: string }[];
  // 18 Section 16.2 tables + council_kanban_links (the council schema script)
  // + council_capability_snapshots, which CTR-165's migration 176 adds on the
  // same chain this real runner applied.
  assert.equal(tables.length, 20);
  assert.ok(
    tables.some((table) => table.name === 'council_capability_snapshots'),
    'the chain also applied CTR-165 migration 176 (council_capability_snapshots)',
  );
});

test('scoped session reads enforce scope and Section 11.1 visibility', () => {
  insertSession();
  insertSession({ id: 'sess-company', visibility: 'company', owner_subject: null });
  insertSession({ id: 'sess-foreign', tenant_id: 'tenant-b', company_id: 'company-b' });

  const own = store.getSession(SCOPE, 'sess-1', 'owner-1');
  assert.ok(own);
  assert.equal(own.state, 'DRAFT');
  // Private session, different viewer: not visible, indistinguishable from absent.
  assert.equal(store.getSession(SCOPE, 'sess-1', 'someone-else'), null);
  // Company session: visible to any in-scope viewer.
  assert.ok(store.getSession(SCOPE, 'sess-company', 'someone-else'));
  // The foreign session's id gains the caller nothing (Section 16.2).
  assert.equal(store.getSession(SCOPE, 'sess-foreign', 'owner-1'), null);
  assert.equal(store.getSession(SCOPE, 'sess-missing', 'owner-1'), null);
});

test('event append allocates per-session sequences atomically', () => {
  const base = {
    scope: SCOPE,
    sessionId: 'sess-1',
    type: 'session_state_changed',
    fromState: 'DRAFT',
    toState: 'READY',
    actorSubject: 'owner-1',
    payloadJson: '{}',
    prevHash: '',
    createdAt: NOW,
  };
  assert.equal(store.appendEvent({ ...base, id: 'ev-1', eventHash: 'h1' }), 1);
  assert.equal(store.appendEvent({ ...base, id: 'ev-2', eventHash: 'h2', prevHash: 'h1' }), 2);
  assert.equal(store.appendEvent({ ...base, id: 'ev-3', eventHash: 'h3', prevHash: 'h2' }), 3);
  const rows = store
    .handle()
    .prepare(
      `SELECT sequence FROM council_events WHERE session_id = 'sess-1' ORDER BY sequence`,
    )
    .all() as { sequence: number }[];
  assert.deepEqual(rows.map((r) => r.sequence), [1, 2, 3]);
});

test('diagnostic grants record only a valid, enabled, session-bound policy', () => {
  const grantInput = {
    scope: SCOPE,
    sessionId: 'sess-1',
    policy: ENABLED_POLICY,
    windowStartedAt: NOW,
    windowEndsAt: '2026-10-14T13:00:00.000Z',
    createdAt: NOW,
  };
  // Disabled by default: records nothing.
  assert.equal(
    store.recordDiagnosticGrant({
      ...grantInput,
      grantId: 'g-disabled',
      policy: { ...ENABLED_POLICY, enabled: false },
    }),
    null,
  );
  // Authorized for a different named session: records nothing.
  assert.equal(
    store.recordDiagnosticGrant({
      ...grantInput,
      grantId: 'g-other',
      policy: { ...ENABLED_POLICY, session_id: 'sess-other' },
    }),
    null,
  );
  // No authorizing principal: the CWE-003 contract itself refuses it.
  assert.equal(
    store.recordDiagnosticGrant({
      ...grantInput,
      grantId: 'g-noauth',
      policy: { ...ENABLED_POLICY, authorized_by_principal: null },
    }),
    null,
  );
  assert.equal(store.recordDiagnosticGrant({ ...grantInput, grantId: 'g1' }), 'g1');
  const grant = store.getDiagnosticGrant(SCOPE, 'sess-1', 'g1');
  assert.ok(grant);
  assert.equal(grant.capture_window_minutes, 60);
  assert.equal(grant.payload_ttl_hours, 24);
  assert.equal(grant.max_bytes_per_operation, 5 * 1024 * 1024);
  assert.equal(grant.max_bytes_per_session, 25 * 1024 * 1024);
  assert.equal(grant.revoked_at, null);
  assert.equal(store.diagnosticSessionBytes(SCOPE, 'sess-1', 'g1'), 0);
});

test('diagnostic payload accessibility honors TTL expiry and revocation', () => {
  store
    .handle()
    .prepare(
      `INSERT INTO council_diagnostic_capture
         (tenant_id, company_id, session_id, id, record_kind, grant_id, operation_id, data_class,
          byte_count, redaction_status, payload_protected_ref, payload_deadline_at, captured_at, created_at)
       VALUES ('tenant-a', 'company-a', 'sess-1', 'p1', 'payload', 'g1', 'op-1', 'provider_body',
               2048, 'redacted', 'protected-store:ref-1', '2026-10-15T12:05:00.000Z',
               '2026-10-14T12:05:00.000Z', '2026-10-14T12:05:00.000Z')`,
    )
    .run();
  assert.equal(store.diagnosticSessionBytes(SCOPE, 'sess-1', 'g1'), 2048);
  // Inside the TTL: accessible.
  assert.equal(store.diagnosticPayloadAccessible(SCOPE, 'sess-1', 'p1', '2026-10-14T13:00:00.000Z'), true);
  // At/after the payload deadline: inaccessible immediately, even though
  // the row still physically exists (no cleanup has run).
  assert.equal(store.diagnosticPayloadAccessible(SCOPE, 'sess-1', 'p1', '2026-10-15T12:05:00.000Z'), false);
  assert.equal(store.diagnosticPayloadAccessible(SCOPE, 'sess-1', 'p1', '2026-10-16T00:00:00.000Z'), false);
  // Revocation hides payloads at once (T134 storage foundation).
  store
    .handle()
    .prepare(
      `UPDATE council_diagnostic_capture SET revoked_at = '2026-10-14T12:30:00.000Z', revoked_by = 'owner-1'
        WHERE id = 'g1' AND record_kind = 'grant'`,
    )
    .run();
  assert.equal(store.diagnosticPayloadAccessible(SCOPE, 'sess-1', 'p1', '2026-10-14T12:31:00.000Z'), false);
});

test('request keys: claim, replay, and different-fingerprint conflict (Section 17)', () => {
  const claim = {
    tenantId: 'tenant-a',
    source: 'command-center',
    operation: 'create_session',
    requestKey: 'key-1',
    payloadFingerprint: 'fp-1',
    sessionId: 'sess-1',
    createdAt: NOW,
  };
  assert.deepEqual(store.claimRequestKey(claim), { outcome: 'claimed', payloadFingerprint: 'fp-1' });
  assert.deepEqual(store.claimRequestKey(claim), { outcome: 'replay', payloadFingerprint: 'fp-1' });
  // Same key, different payload: conflict; the host maps this to 409 and
  // no second row is recorded.
  assert.deepEqual(store.claimRequestKey({ ...claim, payloadFingerprint: 'fp-2' }), {
    outcome: 'conflict',
    payloadFingerprint: 'fp-1',
  });
  const rows = store
    .handle()
    .prepare(`SELECT count(*) AS n FROM council_request_keys WHERE request_key = 'key-1'`)
    .get() as { n: number };
  assert.equal(rows.n, 1);
});
