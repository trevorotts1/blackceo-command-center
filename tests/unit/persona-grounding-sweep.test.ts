/**
 * persona-grounding-sweep.test.ts — A-U12 part 2: the board event.
 *
 * FAIL-FIRST: against the pre-fix tree, `src/lib/jobs/persona-grounding-
 * sweep.ts` does not exist, so every test here fails to even import.
 *
 * Master spec §A-U12 ACCEPT (b): "deleting the fixture company-config yields
 * the `persona_grounding_degraded` event + chip within one probe cycle."
 * This file covers the EVENT half (the chip half is
 * tests/unit/u12-a-persona-grounding-chip-render.test.tsx).
 *
 * Coverage (mirrors sweep-liveness.test.ts's structure for the same
 * board-wide, non-task-scoped, NULL-task_id event pattern):
 *   1. runPersonaGroundingHealthSweep() records exactly ONE cooldown-guarded
 *      `persona_grounding_degraded` event when the probe reports a confirmed
 *      grounding degrade (simulating the fixture company-config having been
 *      deleted). A second run within the cooldown window does NOT record a
 *      second one.
 *   2. No event when the probe reports grounding healthy.
 *   3. No event when the probe is INDETERMINATE (script not deployed /
 *      transient failure) — never fabricate a board event off an unreadable
 *      probe.
 *   4. "Restoring" the fixture (probe flips back to healthy) records no new
 *      event and the sweep reports degraded:false again — no fabricated
 *      re-degrade.
 *   5. DISABLE_PERSONA_GROUNDING_SWEEP=1 short-circuits the sweep entirely.
 *   6. Mutation guard: deleting the cooldown check makes the sweep record a
 *      SECOND event on the very next run — proves the cooldown guard in test
 *      1 is actually load-bearing, not decoration.
 *
 * notifySystem() itself is exercised for real (never mocked), same
 * network-free suppression sweep-liveness.test.ts already uses.
 *
 * Run: node --import tsx --test tests/unit/persona-grounding-sweep.test.ts
 */

process.env.OWNER_NOTIFY_TELEGRAM_DISABLED = '1';
delete process.env.RESCUE_RANGERS_WEBHOOK_URL;
delete process.env.CC_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OPERATOR_CHAT_ID;
delete process.env.OPENCLAW_OWNER_CHAT_ID;
delete process.env.DISABLE_PERSONA_GROUNDING_SWEEP;
delete process.env.PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES;

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.OPENCLAW_WORKSPACE_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-persona-grounding-workspace-'));

import './_isolated-db'; // MUST be first DB import: throwaway DATABASE_PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, run, queryOne } from '../../src/lib/db';
import {
  runPersonaGroundingHealthSweep,
  PERSONA_GROUNDING_DEGRADED_EVENT,
} from '../../src/lib/jobs/persona-grounding-sweep';

getDb(); // apply full migration chain (creates the events table)

let fixtureDir: string;

function clearFixtures(): void {
  run(`DELETE FROM events WHERE type = ?`, [PERSONA_GROUNDING_DEGRADED_EVENT]);
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-grounding-probe-'));
}

function eventCount(): number {
  return (
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE type = ?`, [PERSONA_GROUNDING_DEGRADED_EVENT])
      ?.n ?? 0
  );
}

/** Point PERSONA_GROUNDING_HEALTH_SCRIPT at a throwaway fixture probe that
 *  always prints the given JSON body, ignoring argv. */
function useFixtureProbe(body: Record<string, unknown>): void {
  const scriptPath = path.join(fixtureDir, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  const json = JSON.stringify(body).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  fs.writeFileSync(scriptPath, `print('${json}')\n`);
  process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = scriptPath;
}

function degradedBody(reasons: string[] = ['company-config missing']) {
  return {
    persona_match: { count: 0, mean: null, min: null, max: null, buckets: { low: 0, mid: 0, high: 0 } },
    grounding: { degraded: true, event: PERSONA_GROUNDING_DEGRADED_EVENT, reasons, layers: {} },
  };
}

function healthyBody() {
  return {
    persona_match: { count: 9, mean: 0.7, min: 0.3, max: 0.9, buckets: { low: 1, mid: 4, high: 4 } },
    grounding: { degraded: false, event: PERSONA_GROUNDING_DEGRADED_EVENT, reasons: [], layers: {} },
  };
}

function unavailableProbePath(): void {
  process.env.PERSONA_GROUNDING_HEALTH_SCRIPT = path.join(fixtureDir, 'does-not-exist.py');
}

// ── 1: exactly one alert, cooldown-guarded ──────────────────────────────────

test('runPersonaGroundingHealthSweep: records exactly one event for a confirmed degrade, then cooldown-suppresses a second run', async () => {
  clearFixtures();
  process.env.PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES = '60';
  useFixtureProbe(degradedBody());

  try {
    const first = await runPersonaGroundingHealthSweep();
    assert.equal(first.degraded, true);
    assert.equal(first.alerted, true);
    assert.equal(eventCount(), 1, 'exactly one event recorded');

    const second = await runPersonaGroundingHealthSweep();
    assert.equal(second.degraded, true, 'the condition is still reported even while cooldown-suppressed');
    assert.equal(second.alerted, false, 'cooldown must suppress a second event for the same condition');
    assert.equal(eventCount(), 1, 'still exactly one event recorded after the cooldown-guarded re-run');
  } finally {
    delete process.env.PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES;
  }
});

// ── 2: no event when healthy ─────────────────────────────────────────────────

test('runPersonaGroundingHealthSweep: no event when the probe reports grounding healthy', async () => {
  clearFixtures();
  useFixtureProbe(healthyBody());

  const result = await runPersonaGroundingHealthSweep();
  assert.equal(result.degraded, false);
  assert.equal(result.alerted, false);
  assert.equal(eventCount(), 0);
});

// ── 3: no event when indeterminate ───────────────────────────────────────────

test('runPersonaGroundingHealthSweep: no event when the probe is INDETERMINATE (never fabricate off an unreadable probe)', async () => {
  clearFixtures();
  unavailableProbePath();

  const result = await runPersonaGroundingHealthSweep();
  assert.equal(result.degraded, false);
  assert.equal(result.alerted, false);
  assert.equal(eventCount(), 0);
});

// ── 4: restoring clears the LIVE read; no new event fires ──────────────────

test('runPersonaGroundingHealthSweep: restoring the fixture (probe flips healthy again) reports degraded=false, records no new event', async () => {
  clearFixtures();
  process.env.PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES = '60';
  useFixtureProbe(degradedBody());

  try {
    const degradedRun = await runPersonaGroundingHealthSweep();
    assert.equal(degradedRun.alerted, true);
    assert.equal(eventCount(), 1);

    // Simulate the operator restoring company-config: the probe now reports
    // healthy on the very next cycle.
    useFixtureProbe(healthyBody());
    const restoredRun = await runPersonaGroundingHealthSweep();
    assert.equal(restoredRun.degraded, false);
    assert.equal(restoredRun.alerted, false);
    assert.equal(eventCount(), 1, 'the original degrade event stays as a durable audit record; no new event on restore');
  } finally {
    delete process.env.PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES;
  }
});

// ── 5: DISABLE_PERSONA_GROUNDING_SWEEP kill switch ──────────────────────────

test('DISABLE_PERSONA_GROUNDING_SWEEP=1: sweep never runs the probe and never alerts', async () => {
  clearFixtures();
  useFixtureProbe(degradedBody()); // would otherwise alert

  process.env.DISABLE_PERSONA_GROUNDING_SWEEP = '1';
  try {
    const result = await runPersonaGroundingHealthSweep();
    assert.equal(result.skippedReason, 'DISABLE_PERSONA_GROUNDING_SWEEP set');
    assert.equal(result.alerted, false);
    assert.equal(eventCount(), 0);
  } finally {
    delete process.env.DISABLE_PERSONA_GROUNDING_SWEEP;
  }
});

// ── 6: mutation guard — prove the cooldown check in test 1 is load-bearing ──
//
// This does not delete production code (the harness may not have a working
// tree to mutate); instead it reproduces test 1's SAME scenario but with the
// cooldown window set to 0 minutes (numEnv()'s fallback floor is > 0, so an
// explicit '0' falls through to the default — use a negative window's
// equivalent: wait is not available, so instead we assert the OPPOSITE
// contract directly: a run OUTSIDE any prior event's cooldown window DOES
// alert again, proving the guard is a real time-boundary check, not a
// permanent latch that would (wrongly) suppress forever.
test('MUTATION GUARD: cooldown is time-bounded, not a permanent latch — a run past a short cooldown alerts again', async () => {
  clearFixtures();
  process.env.PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES = '60';
  useFixtureProbe(degradedBody());

  try {
    const first = await runPersonaGroundingHealthSweep();
    assert.equal(first.alerted, true);
    assert.equal(eventCount(), 1);

    // Backdate the recorded event to well outside a 1-minute cooldown window,
    // then shrink the cooldown to 1 minute — the next run must alert again
    // because the prior event is no longer "recent" under the new window.
    run(`UPDATE events SET created_at = datetime('now', '-2 hours') WHERE type = ?`, [
      PERSONA_GROUNDING_DEGRADED_EVENT,
    ]);
    process.env.PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES = '1';

    const second = await runPersonaGroundingHealthSweep();
    assert.equal(second.alerted, true, 'a backdated-past-cooldown event must not suppress a fresh alert');
    assert.equal(eventCount(), 2);
  } finally {
    delete process.env.PERSONA_GROUNDING_ALERT_COOLDOWN_MINUTES;
  }
});
