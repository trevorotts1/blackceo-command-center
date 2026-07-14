/**
 * U55 acceptance (3) — automated, not one-time-manual: "grep of
 * `src/components/ceo-board/**` finds zero remaining `status === 'active'`
 * comparisons" for the AGENT status enum specifically.
 *
 * `agents.status` (migrations.ts migration 034 CHECK constraint) accepts
 * ONLY 'standby' | 'working' | 'busy' | 'degraded' | 'offline' — 'active'
 * never matches a real agent row. Four components in this tree already had
 * the dead `=== 'active'` disjunct removed (ActiveAgentsStrip.tsx,
 * SystemPulseSection.tsx, MonthlyActivityChart.tsx, KPIStatCards.tsx — each
 * carries a comment recording the fix). AgentPerformanceSection.tsx line 167
 * was the one QC caught still carrying it (`(agent.status as string) ===
 * 'active'`).
 *
 * `department.status`, `env.status` and `d.status` (department/environment
 * status enums — DepartmentCard.tsx, DepartmentPerformanceSection.tsx,
 * EnvironmentStatusSection.tsx) DO legitimately include 'active' as a real
 * value and are correctly left alone; a literal string grep for `status ===
 * 'active'` across the whole directory would false-positive on those. This
 * test instead extracts every `<receiver>.status === 'active'` (or
 * `<receiver>.status as string) === 'active'`) occurrence and asserts the
 * receiver is on the department/environment allowlist — so it fails loudly
 * both when the AgentPerformanceSection-class bug reappears AND when a new,
 * un-reviewed receiver shows up that nobody has vetted as legitimate.
 *
 * Node built-in runner: node --import tsx --test tests/unit/u55-agent-status-dead-code.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const CEO_BOARD_DIR = path.join(__dirname, '..', '..', 'src', 'components', 'ceo-board');

// Receivers with a status enum that legitimately includes 'active'
// (department status, environment status). Anything else matching
// `<receiver>.status === 'active'` is presumed to be the agent-status class
// of dead code and must be justified by adding it here explicitly.
const ALLOWLISTED_RECEIVERS = new Set(['department', 'd', 'env']);

// Matches both `x.status === 'active'` and `(x.status as string) === 'active'`.
const ACTIVE_STATUS_COMPARISON = /(\w+)\.status(?:\s+as\s+string)?\)?\s*===\s*['"]active['"]/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("acceptance (3): every `<receiver>.status === 'active'` under src/components/ceo-board/** has an allowlisted (department/environment) receiver — no agent-status dead code", () => {
  const offenders: string[] = [];

  for (const file of walk(CEO_BOARD_DIR)) {
    const contents = fs.readFileSync(file, 'utf8');
    const lines = contents.split('\n');
    lines.forEach((line, idx) => {
      for (const match of line.matchAll(ACTIVE_STATUS_COMPARISON)) {
        const receiver = match[1];
        if (!ALLOWLISTED_RECEIVERS.has(receiver)) {
          offenders.push(`${path.relative(CEO_BOARD_DIR, file)}:${idx + 1}: ${line.trim()}`);
        }
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `found non-allowlisted \`<receiver>.status === 'active'\` comparisons (agent-status dead code):\n${offenders.join('\n')}`,
  );
});

test('sanity: the allowlisted department/environment receivers are actually present (proves the regex + allowlist are not vacuously passing)', () => {
  let allowlistedHits = 0;
  for (const file of walk(CEO_BOARD_DIR)) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const match of contents.matchAll(ACTIVE_STATUS_COMPARISON)) {
      if (ALLOWLISTED_RECEIVERS.has(match[1])) allowlistedHits += 1;
    }
  }
  assert.ok(
    allowlistedHits >= 3,
    `expected at least 3 legitimate department/environment 'active' comparisons to still exist (DepartmentCard.tsx, DepartmentPerformanceSection.tsx, EnvironmentStatusSection.tsx), found ${allowlistedHits} — regex or allowlist may be broken`,
  );
});

test('regression proof: AgentPerformanceSection.tsx no longer contains an agent-status `=== \'active\'` disjunct', () => {
  const filePath = path.join(CEO_BOARD_DIR, 'AgentPerformanceSection.tsx');
  const contents = fs.readFileSync(filePath, 'utf8');
  assert.doesNotMatch(
    contents,
    /agent\.status(?:\s+as\s+string)?\)?\s*===\s*['"]active['"]/,
    'AgentPerformanceSection.tsx must count agent.status === "working" only (agents.status enum never includes "active" — migrations.ts migration 034)',
  );
  assert.match(
    contents,
    /const isActive = \(agent\.status as string\) === 'working';/,
    'expected the exact single-clause working-only check to be present',
  );
});
