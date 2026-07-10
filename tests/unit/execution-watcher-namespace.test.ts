/**
 * execution-watcher-namespace.test.ts — THE NAMESPACE FIX.
 *
 * The execution reconcile must probe the DEPARTMENT session namespace
 * (`agent:dept-<slug>:<session>`) BEFORE the legacy `agent:main:<session>`, so a
 * dept agent's late `TASK_COMPLETE:` is actually found instead of missed — the
 * miss is what let a finished dept task get swept to `blocked`. candidateSessionKeys()
 * resolves the dept key EXACTLY as dispatch does (from the on-disk runtime dir)
 * and always falls back to `agent:main:` so a completion reconciles either way.
 *
 *   node --import tsx --test tests/unit/execution-watcher-namespace.test.ts
 */

import { mkdtempSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';

// resolveSpecialistSessionKey derives AGENTS_ROOT from HOME — point it at a temp
// dir so we can materialize a dept runtime and prove the dept key is probed first.
const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'cc-watcher-home-'));
process.env.HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, '.openclaw', 'agents', 'dept-presentations'), { recursive: true });

import './_isolated-db'; // MUST be first (after env setup).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run } from '../../src/lib/db';
import { candidateSessionKeys } from '../../src/lib/jobs/execution-watcher';

// A workspace whose slug maps to the dept-presentations runtime dir created above.
const WS_ID = `ws-${uuidv4()}`;
run('INSERT INTO workspaces (id, name, slug, sort_order) VALUES (?, ?, ?, 1000)', [WS_ID, 'Presentations', 'presentations']);

test('dept runtime present → probes agent:dept-<slug>: FIRST, then falls back to agent:main:', () => {
  const session = 'sess-abc';
  const keys = candidateSessionKeys({
    id: 't1', title: 'Deck', status: 'in_progress',
    assigned_agent_id: 'a1', assigned_agent_name: 'Deck Designer',
    assigned_agent_role: 'Department Head', workspace_id: WS_ID,
    openclaw_session_id: session,
  });
  assert.deepEqual(
    keys,
    [`agent:dept-presentations:${session}`, `agent:main:${session}`],
    'dept key first, agent:main fallback second',
  );
});

test('no dept runtime resolvable → falls back to agent:main: (still reconciles)', () => {
  const session = 'sess-xyz';
  const keys = candidateSessionKeys({
    id: 't2', title: 'Unknown', status: 'in_progress',
    assigned_agent_id: 'a2', assigned_agent_name: 'Nobody',
    assigned_agent_role: 'Nothing', workspace_id: 'ws-does-not-exist',
    openclaw_session_id: session,
  });
  assert.deepEqual(keys, [`agent:main:${session}`], 'legacy key is always tried');
});

test('no session id → no keys (nothing to probe)', () => {
  const keys = candidateSessionKeys({
    id: 't3', title: 'x', status: 'in_progress',
    assigned_agent_id: null, assigned_agent_name: null,
    assigned_agent_role: null, workspace_id: null, openclaw_session_id: null,
  });
  assert.deepEqual(keys, []);
});
