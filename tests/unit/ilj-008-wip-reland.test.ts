/**
 * ILJ-008 WIP reland evidence: one test per relanded behavior.
 *   1. src/lib/platform.ts — detectPlatform short aliases mac -> mac-mini, vps -> vps-docker.
 *   2. src/lib/jobs/interview-nudge-sweep.ts — resumeBase() never yields localhost
 *      while a public base (CC_PUBLIC_URL / MC_TENANT_PUBLIC_URL) exists.
 *   3. src/lib/interview/remote-protocol.ts — attempts>=5 transitions pending
 *      -> dead_letter, keeping the original operation_id.
 * Runs under `npm run test:unit` (node --import tsx --test).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Throwaway DB before any db-backed module loads (dynamic imports below).
process.env.DATABASE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ilj008-db-')),
  'ilj008.test.db',
);

type PlatformMod = typeof import('../../src/lib/platform');
type NudgeMod = typeof import('../../src/lib/jobs/interview-nudge-sweep');
type ProtoMod = typeof import('../../src/lib/interview/remote-protocol');
type DbMod = typeof import('../../src/lib/db');

let detectPlatform: PlatformMod['detectPlatform'];
let buildResumeLink: NudgeMod['buildResumeLink'];
let deliverInterviewOperation: ProtoMod['deliverInterviewOperation'];
let db: DbMod;

test.before(async () => {
  db = await import('../../src/lib/db');
  db.getDb(); // full migration chain so interview_remote_operations exists
  ({ detectPlatform } = await import('../../src/lib/platform'));
  ({ buildResumeLink } = await import('../../src/lib/jobs/interview-nudge-sweep'));
  ({ deliverInterviewOperation } = await import('../../src/lib/interview/remote-protocol'));
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('detectPlatform resolves short aliases mac -> mac-mini, vps -> vps-docker', () => {
  withEnv({ OPENCLAW_PLATFORM: 'mac' }, () => {
    assert.equal(detectPlatform(), 'mac-mini');
  });
  withEnv({ OPENCLAW_PLATFORM: 'vps' }, () => {
    assert.equal(detectPlatform(), 'vps-docker');
  });
  withEnv({ OPENCLAW_PLATFORM: 'mac-mini' }, () => {
    assert.equal(detectPlatform(), 'mac-mini');
  });
  withEnv({ OPENCLAW_PLATFORM: 'vps-docker' }, () => {
    assert.equal(detectPlatform(), 'vps-docker');
  });
  // Unknown values still fall through to marker/default, never echo back raw.
  withEnv({ OPENCLAW_PLATFORM: 'bogus-value' }, () => {
    const got = detectPlatform();
    assert.ok(got === 'mac-mini' || got === 'vps-docker', `fall-through, got ${got}`);
  });
});

test('resumeBase prefers public origin over localhost MISSION_CONTROL_URL', () => {
  // CC_PUBLIC_URL wins; link never contains localhost.
  withEnv(
    {
      OPENCLAW_DASHBOARD_URL: undefined,
      CC_PUBLIC_URL: 'https://box.example.com/',
      MC_TENANT_PUBLIC_URL: undefined,
      MISSION_CONTROL_URL: undefined, // getMissionControlUrl() -> http://localhost:4000
    },
    () => {
      const link = buildResumeLink('sess-1');
      assert.equal(link, 'https://box.example.com/onboarding/resume/sess-1');
      assert.ok(!link.includes('localhost'), 'client resume link must never be localhost');
    },
  );
  // MC_TENANT_PUBLIC_URL is the next fallback when CC_PUBLIC_URL is absent.
  withEnv(
    {
      OPENCLAW_DASHBOARD_URL: undefined,
      CC_PUBLIC_URL: undefined,
      MC_TENANT_PUBLIC_URL: 'https://tenant.example.com',
      MISSION_CONTROL_URL: undefined,
    },
    () => {
      const link = buildResumeLink('sess-2');
      assert.equal(link, 'https://tenant.example.com/onboarding/resume/sess-2');
    },
  );
  // OPENCLAW_DASHBOARD_URL (tenant-public) still has top precedence.
  withEnv(
    {
      OPENCLAW_DASHBOARD_URL: 'https://client.example.com',
      CC_PUBLIC_URL: 'https://box.example.com',
      MC_TENANT_PUBLIC_URL: 'https://tenant.example.com',
      MISSION_CONTROL_URL: undefined,
    },
    () => {
      assert.equal(buildResumeLink('sess-3'), 'https://client.example.com/onboarding/resume/sess-3');
    },
  );
});

test('attempts>=5 moves pending -> dead_letter, keeping operation identity', async () => {
  const opId = `ilj008-op-${Date.now()}`;
  const now = db.timeNow();
  db.run(
    `INSERT INTO interview_remote_operations
       (operation_id, tenant_id, interview_id, operation_type, origin_subject,
        payload, fingerprint, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 5, ?, ?)`,
    [opId, 't-ilj008', 'i-ilj008', 'answer', 'owner', '{}', 'fp-ilj008', now, now],
  );
  const ctx = {
    tenantId: 't-ilj008',
    companyId: 'c-ilj008',
    clientId: null,
    kind: 'self' as const,
    subject: 'owner',
    host: 'localhost',
    installationId: 'inst-ilj008',
  };
  const op = db.queryOne<{ operation_id: string } & Record<string, unknown>>(
    'SELECT * FROM interview_remote_operations WHERE operation_id = ?',
    [opId],
  )!;
  const res = await deliverInterviewOperation(ctx, op as never);
  assert.equal(res.state, 'dead_letter');
  assert.equal(res.reason, 'remote_retry_exhausted');

  // Original identity retained: same row, now dead_letter, terminal on re-entry.
  const row = db.queryOne<{ operation_id: string; state: string; attempts: number }>(
    'SELECT operation_id, state, attempts FROM interview_remote_operations WHERE operation_id = ?',
    [opId],
  )!;
  assert.equal(row.operation_id, opId, 'repair + requeue must never fork the operation');
  assert.equal(row.state, 'dead_letter');
  const again = await deliverInterviewOperation(
    ctx,
    db.queryOne('SELECT * FROM interview_remote_operations WHERE operation_id = ?', [opId])! as never,
  );
  assert.equal(again.state, 'dead_letter', 'dead_letter is terminal for automatic delivery');
});
