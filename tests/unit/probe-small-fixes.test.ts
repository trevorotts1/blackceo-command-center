/**
 * probe-small-fixes.test.ts — U-04b (CC-008 memory site, CC-029, CC-030).
 *
 * Three probe faults, each with a FAIL-FIRST assertion:
 *
 *  1. src/lib/probes/agents.ts — a fleet where EVERY agent is `offline` read
 *     `live` (no degraded/busy/working row matched, so it fell through to the
 *     default). It now reads `degraded`; a mixed standby+offline fleet stays
 *     `live`.
 *
 *  2. src/lib/probes/memory.ts — `new Date(latestAt + 'Z')` was applied to
 *     every stored timestamp. For a full ISO-8601 value already ending in 'Z'
 *     (what every Node writer stores) that produced '...ZZ' → Invalid Date →
 *     NaN age → the finite check failed → a ledger 48 hours old still read
 *     `live`.
 *
 *  3. src/lib/probes/db.ts — `expectedCount` was set to `appliedCount`, so the
 *     expected-vs-applied gap was always zero and pending migrations could
 *     never show up. (Covered by the probe reading the real registry; the
 *     acceptance rows above are the two named in the unit section.)
 *
 * Run: node --import tsx --test tests/unit/probe-small-fixes.test.ts
 */

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.

import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { getDb, run } from '../../src/lib/db';
import { probeAgents } from '../../src/lib/probes/agents';
import { probeMemory } from '../../src/lib/probes/memory';

getDb(); // apply full migration chain

/** Empty the agents table (agent_memory_logs cascades with it). */
function resetAgents(): void {
  run('DELETE FROM agents');
}

function seedAgent(status: string): string {
  const id = uuidv4();
  // workspace_id explicitly NULL: this isolated DB has no 'default' workspace
  // row and workspace_id carries a REFERENCES workspaces(id) foreign key.
  run(
    `INSERT INTO agents (id, name, role, status, workspace_id)
     VALUES (?, ?, ?, ?, NULL)`,
    [id, `probe fixture ${id.slice(0, 8)}`, 'fixture', status],
  );
  return id;
}

test('probeAgents: a fleet of only offline agents reads degraded, not live', async () => {
  resetAgents();
  seedAgent('offline');
  seedAgent('offline');

  const result = await probeAgents();

  assert.equal(result.component, 'agents');
  assert.equal(
    result.status,
    'degraded',
    'FAIL-FIRST: before the fix an all-offline fleet fell through every branch to the default `live`',
  );
  const detail = result.detail as { total: number } | undefined;
  assert.equal(detail?.total, 2);
});

test('probeAgents: one standby and one offline stays live (offline !== total)', async () => {
  resetAgents();
  seedAgent('standby');
  seedAgent('offline');

  const result = await probeAgents();

  assert.equal(
    result.status,
    'live',
    'a partially offline fleet is still live — only an ALL-offline fleet is degraded',
  );
});

test('probeAgents: no agents at all stays live (an empty roster is not a fault)', async () => {
  resetAgents();

  const result = await probeAgents();

  assert.equal(result.status, 'live');
});

test('probeMemory: newest row 48 hours old as full ISO ending in Z reads degraded', async () => {
  resetAgents();
  const agentId = seedAgent('standby');

  const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  assert.ok(fortyEightHoursAgo.endsWith('Z'), 'fixture must be the ISO-Z dialect');

  const logId = uuidv4();
  run(
    `INSERT INTO agent_memory_logs (id, agent_id, log_date, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [logId, agentId, fortyEightHoursAgo.slice(0, 10), 'fixture', fortyEightHoursAgo],
  );

  const result = await probeMemory();

  assert.equal(result.component, 'memory');
  const detail = result.detail as { entries: number; latestAt: string | null } | undefined;
  assert.equal(detail?.entries, 1);
  assert.equal(detail?.latestAt, fortyEightHoursAgo);
  assert.equal(
    result.status,
    'degraded',
    'FAIL-FIRST: appending Z to an already-Z ISO string made an Invalid Date, so a 48-hour-old ledger read `live`',
  );
  assert.equal(result.error, 'no memory writes in the last 24h');
});

test('probeMemory: 48 hours old in the SQLite space dialect also reads degraded', async () => {
  resetAgents();
  const agentId = seedAgent('standby');

  // datetime('now','-48 hours') — the dialect SQLite itself writes.
  const spaceForm = new Date(Date.now() - 48 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
  assert.ok(!spaceForm.includes('T') && spaceForm.includes(' '), 'fixture must be the space dialect');

  const logId = uuidv4();
  run(
    `INSERT INTO agent_memory_logs (id, agent_id, log_date, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [logId, agentId, spaceForm.slice(0, 10), 'fixture', spaceForm],
  );

  const result = await probeMemory();

  assert.equal(result.status, 'degraded', 'the space dialect must still be normalized and compared');
});
