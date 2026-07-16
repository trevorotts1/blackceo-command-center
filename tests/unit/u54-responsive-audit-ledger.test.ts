/**
 * Skill-6 U54 (spec crosswalk HL/U69) — stage 2 "Measure" ledger tests.
 *
 * These tests exercise `runAuditForRoutes()`'s PERSISTENCE and RESUMABILITY
 * contract with an INJECTED `invoke` function — they never spawn a real
 * browser, never require a live Next.js server, and never call the real
 * `dev-shots.mjs`. That live wiring (`defaultInvoke`) is the operator-box
 * leg described in scripts/responsive-audit.mjs's header comment; what is
 * tested here is the mechanism around it: does a route's cells actually
 * land on disk, does a second run skip already-ledgered routes, does
 * --force re-shoot them, are unresolved routes skipped without ever being
 * recorded as a fabricated audit cell.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAuditForRoutes } from '../../scripts/responsive-audit.mjs';

function fakeCellsFor(route: string) {
  return [
    { route, bp: 'mobile-375', horizOverflow: 0, wide: [], clipped: [] },
    { route, bp: 'tablet-768', horizOverflow: 0, wide: [], clipped: [] },
    { route, bp: 'desktop-1440', horizOverflow: 0, wide: [], clipped: [] },
  ];
}

function makeInventory(patterns: string[]) {
  return patterns.map((pattern) => ({ pattern, href: pattern, unresolved: false }));
}

test('U54/audit: a resolved route writes one ledger file per breakpoint and one consolidated ledger', () => {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u54-ledger-'));
  const calls: string[] = [];
  const invoke = ({ route }: { route: string }) => {
    calls.push(route);
    return fakeCellsFor(route);
  };

  const summary = runAuditForRoutes(makeInventory(['/kanban']), { invoke, ledgerDir });

  assert.deepEqual(calls, ['/kanban']);
  assert.deepEqual(summary.ran, ['/kanban']);
  assert.equal(summary.cells.length, 3);
  for (const bp of ['mobile-375', 'tablet-768', 'desktop-1440']) {
    assert.ok(fs.existsSync(path.join(ledgerDir, `responsive-kanban-${bp}.json`)), `expected a ledger file for ${bp}`);
  }
  assert.ok(fs.existsSync(path.join(ledgerDir, 'responsive-ledger.json')));

  fs.rmSync(ledgerDir, { recursive: true, force: true });
});

test('U54/audit: an interrupted run resumes — an already-ledgered route is NOT re-invoked', () => {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u54-ledger-'));
  const calls: string[] = [];
  const invoke = ({ route }: { route: string }) => {
    calls.push(route);
    return fakeCellsFor(route);
  };

  runAuditForRoutes(makeInventory(['/kanban']), { invoke, ledgerDir });
  assert.equal(calls.length, 1);

  // Second run over the SAME inventory: the route already has all 3
  // breakpoint ledger files, so it must be skipped, not re-shot.
  const second = runAuditForRoutes(makeInventory(['/kanban']), { invoke, ledgerDir });
  assert.equal(calls.length, 1, 'a fully-ledgered route must not be re-invoked on resume');
  assert.deepEqual(second.skippedAlready, ['/kanban']);
  assert.equal(second.cells.length, 3, 'resumed cells are still returned from disk, not dropped');

  fs.rmSync(ledgerDir, { recursive: true, force: true });
});

test('U54/audit: --force re-invokes an already-ledgered route', () => {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u54-ledger-'));
  const calls: string[] = [];
  const invoke = ({ route }: { route: string }) => {
    calls.push(route);
    return fakeCellsFor(route);
  };

  runAuditForRoutes(makeInventory(['/kanban']), { invoke, ledgerDir });
  runAuditForRoutes(makeInventory(['/kanban']), { invoke, ledgerDir, force: true });
  assert.equal(calls.length, 2, '--force must bypass the resume-skip');

  fs.rmSync(ledgerDir, { recursive: true, force: true });
});

test('U54/audit: an unresolved route is skipped and NEVER produces a fabricated ledger cell', () => {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u54-ledger-'));
  const calls: string[] = [];
  const invoke = ({ route }: { route: string }) => {
    calls.push(route);
    return fakeCellsFor(route);
  };

  const inventory = [{ pattern: '/campaigns/[id]', href: null, unresolved: true, reason: 'no live "campaigns" row found and no static fallback registered' }];
  const summary = runAuditForRoutes(inventory, { invoke, ledgerDir });

  assert.equal(calls.length, 0, 'an unresolved dynamic route must never be requested');
  assert.equal(summary.cells.length, 0);
  assert.deepEqual(summary.skippedUnresolved, [{ pattern: '/campaigns/[id]', reason: inventory[0].reason }]);
  assert.ok(!fs.existsSync(path.join(ledgerDir, 'responsive-campaigns-id-mobile-375.json')));

  fs.rmSync(ledgerDir, { recursive: true, force: true });
});

test('U54/audit: multi-route runs persist independently and a mid-run failure keeps prior routes\' ledgers intact', () => {
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u54-ledger-'));
  const invoke = ({ route }: { route: string }) => {
    if (route === '/kaboom') throw new Error('simulated dev-shots.mjs failure');
    return fakeCellsFor(route);
  };

  assert.throws(() => {
    runAuditForRoutes(makeInventory(['/kanban', '/kaboom', '/personas']), { invoke, ledgerDir });
  }, /simulated dev-shots\.mjs failure/);

  // /kanban ran and persisted BEFORE the failure — its ledger survives the
  // interruption. This is the "partial progress survives interruption"
  // contract from the spec.
  for (const bp of ['mobile-375', 'tablet-768', 'desktop-1440']) {
    assert.ok(fs.existsSync(path.join(ledgerDir, `responsive-kanban-${bp}.json`)));
  }
  assert.ok(!fs.existsSync(path.join(ledgerDir, 'responsive-personas-mobile-375.json')), 'a route after the failure never ran');

  fs.rmSync(ledgerDir, { recursive: true, force: true });
});
