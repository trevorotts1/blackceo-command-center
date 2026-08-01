/**
 * MR-14 (fix2) — agent-sync emoji + specialist_type regression lock.
 *
 * The original MR-14 fix ingests Skill-23 specialists from the OpenClaw gateway
 * via `agents.list`. Haiku flagged two concerns in that ingest:
 *
 *   1. specialist_type is hardcoded to 'permanent' — intentional (a synced
 *      specialist is the operator's configured workforce, not a transient
 *      on-call subagent), but it must stay 'permanent' and be documented.
 *   2. emoji overwrite semantics — on re-sync, if the operator CLEARED the emoji
 *      on the gateway (empty string / null), the old code re-inferred an emoji
 *      and overwrote the CC's existing avatar. The fix keeps the existing avatar
 *      in that case (COALESCE(NULLIF(excluded,''), agents.avatar_emoji)) while
 *      still letting a real gateway emoji win and still inferring on first insert.
 *
 * This suite mocks the gateway client (no network) and drives the real
 * syncSpecialistAgentsFromOpenClaw() against an isolated, fully-migrated DB.
 */
import './_isolated-db';
import { describe, it, expect, beforeAll, vi } from 'vitest';

// The roster the mocked gateway returns; each test mutates `agents` before
// calling the sync so we can exercise insert vs re-sync emoji precedence.
const roster = {
  current: [] as Array<Record<string, unknown>>,
};

vi.mock('@/lib/openclaw/client', () => ({
  getOpenClawClient: () => ({
    isConnected: () => true,
    connect: async () => {},
    listAgents: async () => ({
      defaultId: 'main',
      mainKey: 'main',
      scope: 'all',
      agents: roster.current,
    }),
  }),
}));

import { getDb } from '../../src/lib/db';
import { syncSpecialistAgentsFromOpenClaw } from '../../src/lib/openclaw/agent-sync';

function getAgent(id: string): { avatar_emoji: string; specialist_type: string } {
  return getDb()
    .prepare('SELECT avatar_emoji, specialist_type FROM agents WHERE id = ?')
    .get(id) as { avatar_emoji: string; specialist_type: string };
}

beforeAll(() => {
  // agents.workspace_id REFERENCES workspaces(id) and defaults to 'default'.
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO workspaces (id, name, slug, sort_order)
       VALUES ('default', 'Default', 'default', 0)`,
    )
    .run();
});

describe('MR-14 agent-sync emoji + specialist_type', () => {
  it('inserts a new specialist with the gateway emoji and specialist_type=permanent', async () => {
    roster.current = [{ id: 'spec-writer', name: 'Copywriter Pro', identity: { name: 'Copywriter Pro', emoji: '✍️' } }];
    const res = await syncSpecialistAgentsFromOpenClaw();
    expect(res.inserted).toBe(1);
    const row = getAgent('spec-writer');
    expect(row.avatar_emoji).toBe('✍️');
    expect(row.specialist_type).toBe('permanent');
  });

  it('preserves the existing avatar when the operator cleared the emoji on the gateway (empty string)', async () => {
    // Re-sync the same id, but the operator cleared the emoji → ''.
    roster.current = [{ id: 'spec-writer', name: 'Copywriter Pro', identity: { name: 'Copywriter Pro', emoji: '' } }];
    const res = await syncSpecialistAgentsFromOpenClaw();
    expect(res.updated).toBe(1);
    // The cleared emoji must NOT be overwritten by an inferred one.
    expect(getAgent('spec-writer').avatar_emoji).toBe('✍️');
  });

  it('preserves the existing avatar when the operator cleared the emoji on the gateway (null)', async () => {
    roster.current = [{ id: 'spec-writer', name: 'Copywriter Pro', identity: { name: 'Copywriter Pro', emoji: null } }];
    await syncSpecialistAgentsFromOpenClaw();
    expect(getAgent('spec-writer').avatar_emoji).toBe('✍️');
  });

  it('overwrites the avatar when the operator changed the emoji on the gateway', async () => {
    roster.current = [{ id: 'spec-writer', name: 'Copywriter Pro', identity: { name: 'Copywriter Pro', emoji: '🚀' } }];
    await syncSpecialistAgentsFromOpenClaw();
    expect(getAgent('spec-writer').avatar_emoji).toBe('🚀');
  });

  it('infers an emoji on first insert when the gateway provides none', async () => {
    // No identity.emoji at all → inferEmoji('Graphic Designer') → '🎨'.
    roster.current = [{ id: 'spec-designer', name: 'Graphic Designer', identity: { name: 'Graphic Designer' } }];
    const res = await syncSpecialistAgentsFromOpenClaw();
    expect(res.inserted).toBe(1);
    const row = getAgent('spec-designer');
    expect(row.avatar_emoji).toBe('🎨');
    expect(row.avatar_emoji).not.toBe('');
    expect(row.specialist_type).toBe('permanent');
  });
});
