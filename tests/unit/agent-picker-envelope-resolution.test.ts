/**
 * U56 follow-up (rebase onto current main, E.2 / JM-U52) — AgentPicker's
 * `GET /api/agents` resolution.
 *
 * `GET /api/agents` now returns the enveloped `{ agents: [...] }` shape
 * (U56). AgentPicker (U60 / JM-U63f) used to read the payload as a bare
 * array (`Array.isArray(rows)` guard) and would silently bail — never
 * calling `onResolved` at all — the moment the route enveloped. This proves
 * the fix: `resolveMasterAgent()` (the pure function AgentPicker now calls,
 * same extraction precedent as `filterModels.ts`) resolves correctly against
 * the new envelope, the legacy bare-array shape, and a malformed/empty
 * payload — never throwing, always returning a definite result so the
 * component's `onResolved` callback still fires.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMasterAgent } from '../../src/components/ceo-chat/resolveMasterAgent';
import type { AgentOption } from '../../src/components/ceo-chat/types';

function agent(id: string, is_master = false): AgentOption {
  return { id, name: `Agent ${id}`, avatar_emoji: '🤖', is_master, status: 'standby' };
}

test('[AgentPicker] enveloped { agents: [...] } payload resolves the master agent', () => {
  const payload = { agents: [agent('a1'), agent('a2', true), agent('a3')] };
  const resolved = resolveMasterAgent(payload);
  assert.equal(resolved?.id, 'a2');
});

test('[AgentPicker] enveloped payload with no master falls back to the first row', () => {
  const payload = { agents: [agent('a1'), agent('a2')] };
  const resolved = resolveMasterAgent(payload);
  assert.equal(resolved?.id, 'a1');
});

test('[AgentPicker] legacy bare-array payload still resolves (defensive backward-compat)', () => {
  const payload = [agent('a1'), agent('a2', true)];
  const resolved = resolveMasterAgent(payload);
  assert.equal(resolved?.id, 'a2');
});

test('[AgentPicker] empty envelope resolves to null, never throws (onResolved still fires)', () => {
  const resolved = resolveMasterAgent({ agents: [] });
  assert.equal(resolved, null);
});

test('[AgentPicker] malformed/unexpected payload resolves to null, never throws', () => {
  assert.equal(resolveMasterAgent(null), null);
  assert.equal(resolveMasterAgent(undefined), null);
  assert.equal(resolveMasterAgent({}), null);
  assert.equal(resolveMasterAgent('not json'), null);
});
