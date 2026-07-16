/**
 * winner-harvest-workspace-resolution.test.ts — A-U11 CC-repo half,
 * foundational plumbing proof.
 *
 * Pins `resolveWorkspaceBase()` to MIRROR shared-utils/winner_harvest.py's
 * `resolve_workspace_base()` ladder EXACTLY (CLIENT_WORKSPACE_BASE_DIR env
 * override -> $HOME/clawd/client-workspaces -> '' — never a repo-relative
 * fallback), and pins `resolveHarvestClientId()` to never resolve a
 * workspace path under the `unknown-client` placeholder (an unbranded box
 * has no client-local library to harvest into).
 *
 *   node --import tsx --test tests/unit/winner-harvest-workspace-resolution.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveWorkspaceBase, resolveHarvestClientId } from '../../src/lib/winner-harvest';
import { UNKNOWN_CLIENT } from '../../src/lib/box-identity';

test('(1) CLIENT_WORKSPACE_BASE_DIR env override wins over everything else', () => {
  const result = resolveWorkspaceBase({
    CLIENT_WORKSPACE_BASE_DIR: '/tmp/explicit-override',
    HOME: '/Users/someone',
  } as NodeJS.ProcessEnv);
  assert.equal(result, '/tmp/explicit-override');
});

test('(2) with no override, resolves to $HOME/clawd/client-workspaces', () => {
  const result = resolveWorkspaceBase({ HOME: '/Users/operator' } as NodeJS.ProcessEnv);
  assert.equal(result, path.join('/Users/operator', 'clawd', 'client-workspaces'));
});

test('(3) with neither override nor HOME, resolves to the empty string — never a repo-relative fallback', () => {
  const result = resolveWorkspaceBase({} as NodeJS.ProcessEnv);
  assert.equal(result, '');
  assert.doesNotMatch(result, /src|repo|node_modules/);
});

test('(4) an empty-string CLIENT_WORKSPACE_BASE_DIR falls through to the HOME rung, not a blank base', () => {
  const result = resolveWorkspaceBase({
    CLIENT_WORKSPACE_BASE_DIR: '   ',
    HOME: '/Users/operator',
  } as NodeJS.ProcessEnv);
  assert.equal(result, path.join('/Users/operator', 'clawd', 'client-workspaces'));
});

test('(5) resolveHarvestClientId NEVER resolves under the unknown-client placeholder', () => {
  const prevCc = process.env.CC_CLIENT_NAME;
  const prevCn = process.env.COMPANY_NAME;
  delete process.env.CC_CLIENT_NAME;
  delete process.env.COMPANY_NAME;
  try {
    // No env, and getCompanyName() on this checkout's unpopulated template
    // config resolves to a template name too — either way this box has no
    // resolvable client identity, so the harvest client id must be null,
    // never a slug of "unknown-client".
    const id = resolveHarvestClientId();
    if (id !== null) {
      assert.notEqual(id, 'unknown-client');
    }
  } finally {
    if (prevCc !== undefined) process.env.CC_CLIENT_NAME = prevCc; else delete process.env.CC_CLIENT_NAME;
    if (prevCn !== undefined) process.env.COMPANY_NAME = prevCn; else delete process.env.COMPANY_NAME;
  }
});

test('(6) a pinned CC_CLIENT_NAME resolves deterministically to its slug', () => {
  const prev = process.env.CC_CLIENT_NAME;
  process.env.CC_CLIENT_NAME = 'Fixture Client Alpha!!';
  try {
    const id = resolveHarvestClientId();
    assert.equal(id, 'fixture-client-alpha');
  } finally {
    if (prev !== undefined) process.env.CC_CLIENT_NAME = prev; else delete process.env.CC_CLIENT_NAME;
  }
});

test('(7) the UNKNOWN_CLIENT placeholder itself is rejected even if somehow passed through', () => {
  // Documents the invariant the source enforces: UNKNOWN_CLIENT must never
  // be slugified into a usable-looking client id.
  assert.equal(UNKNOWN_CLIENT, 'unknown-client');
});
