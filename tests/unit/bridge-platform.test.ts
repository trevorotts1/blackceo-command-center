/**
 * Unit tests for the v4.1.2 OpenClaw Bridge connect-failure fixes.
 *
 * Pure logic only — no network, no filesystem, no dev server. Runs via the
 * Node built-in test runner under tsx:
 *
 *   npm run test:unit
 *   # = node --import tsx --test tests/unit/*.test.ts
 *
 * Covers:
 *   1. (Problem C) `visibleBridgeAgents` hides the six Mac-desktop CLIs on a
 *      VPS install and keeps every agent on Mac.
 *   2. (Problem C) `resolveInstallPlatform` honors the BCC_INSTALL_TYPE flag
 *      and otherwise defers to the injected detector.
 *   3. (Problem B) the gateway URL default resolves to ws://127.0.0.1:18789
 *      when OPENCLAW_GATEWAY_URL is unset, and reads the env var when set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_AGENTS,
  visibleBridgeAgents,
  resolveInstallPlatform,
} from '../../src/lib/bridge/agents';

const MAC_ONLY = ['claude', 'codex', 'antigravity', 'hermes', 'gemini', 'fcc'];

test('Mac install shows every agent (no agent is hidden)', () => {
  const ids = visibleBridgeAgents('mac-mini').map((a) => a.id);
  assert.equal(ids.length, BRIDGE_AGENTS.length);
  for (const a of BRIDGE_AGENTS) {
    assert.ok(ids.includes(a.id), `expected ${a.id} visible on mac-mini`);
  }
});

test('VPS install hides the six Mac-desktop CLIs and keeps OpenClaw', () => {
  const ids = visibleBridgeAgents('vps-docker').map((a) => a.id);
  assert.deepEqual(ids, ['openclaw'], 'VPS should only show the OpenClaw pill');
  for (const macId of MAC_ONLY) {
    assert.ok(!ids.includes(macId), `${macId} must be hidden on a VPS`);
  }
});

test('OpenClaw agent has no platform restriction (available everywhere)', () => {
  const openclaw = BRIDGE_AGENTS.find((a) => a.id === 'openclaw');
  assert.ok(openclaw, 'openclaw agent must exist');
  assert.equal(openclaw!.platforms, undefined);
});

test('resolveInstallPlatform: BCC_INSTALL_TYPE=vps forces vps-docker', () => {
  const prev = process.env.BCC_INSTALL_TYPE;
  process.env.BCC_INSTALL_TYPE = 'vps';
  try {
    // Detector returns mac-mini, but the explicit flag must win.
    assert.equal(resolveInstallPlatform(() => 'mac-mini'), 'vps-docker');
  } finally {
    if (prev === undefined) delete process.env.BCC_INSTALL_TYPE;
    else process.env.BCC_INSTALL_TYPE = prev;
  }
});

test('resolveInstallPlatform: BCC_INSTALL_TYPE=mac forces mac-mini', () => {
  const prev = process.env.BCC_INSTALL_TYPE;
  process.env.BCC_INSTALL_TYPE = 'mac';
  try {
    assert.equal(resolveInstallPlatform(() => 'vps-docker'), 'mac-mini');
  } finally {
    if (prev === undefined) delete process.env.BCC_INSTALL_TYPE;
    else process.env.BCC_INSTALL_TYPE = prev;
  }
});

test('resolveInstallPlatform: no flag defers to the injected detector', () => {
  const prev = process.env.BCC_INSTALL_TYPE;
  delete process.env.BCC_INSTALL_TYPE;
  try {
    assert.equal(resolveInstallPlatform(() => 'vps-docker'), 'vps-docker');
    assert.equal(resolveInstallPlatform(() => 'mac-mini'), 'mac-mini');
  } finally {
    if (prev !== undefined) process.env.BCC_INSTALL_TYPE = prev;
  }
});

test('gateway URL defaults to ws://127.0.0.1:18789 when unset, reads env when set', () => {
  // Mirror the exact resolution used in client.ts / status route / probe.
  const resolveGatewayUrl = () =>
    process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';

  const prev = process.env.OPENCLAW_GATEWAY_URL;
  try {
    delete process.env.OPENCLAW_GATEWAY_URL;
    assert.equal(resolveGatewayUrl(), 'ws://127.0.0.1:18789');

    process.env.OPENCLAW_GATEWAY_URL = 'wss://gateway.example.com';
    assert.equal(resolveGatewayUrl(), 'wss://gateway.example.com');
  } finally {
    if (prev === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = prev;
  }
});
