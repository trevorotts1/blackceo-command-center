/**
 * FDN-3 / F4.1 — dispatch delivers the TASK's matched persona to the doer.
 *
 * Before this fix both dispatch builders rendered `settings.persona` and, when it
 * was `'auto'`, a block of prose telling the doer to "AUTO-SELECT. Run the 5-Layer
 * Persona Matching Protocol" — so the persona the selector matched onto the task
 * row (`tasks.persona_id`) never reached the executing agent.
 *
 * `buildPersonaBlock` is the ONE renderer both dispatch paths
 * (`src/lib/task-dispatcher.ts` + `src/app/api/tasks/[id]/dispatch/route.ts`)
 * call, so proving it here proves BOTH paths.
 *
 * Contract asserted (the F4.1 QC-review checklist):
 *   - the persona in the message == the persona on the DB row;
 *   - the Section-4 (A–D) + §7B load instruction + [+APPENDIX] pointer is present;
 *   - ZERO occurrences of "AUTO-SELECT" or the 5-Layer self-selection prose;
 *   - hybrid tasks render the secondary persona;
 *   - mechanical tasks carry a governance oversight pointer, not a full load;
 *   - an operator lock (agent_settings) overrides the matched persona;
 *   - no branch is ever naked (empty) and none ever emits `'auto'`.
 *
 * Pure function, no DB — the message text is the contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPersonaBlock,
  personaBlueprintPath,
  GOVERNANCE_PERSONA_FALLBACK,
  type PersonaDispatchTask,
} from '../../src/lib/persona-dispatch';

type Settings = Parameters<typeof buildPersonaBlock>[1];

const AUTO_SELECT_MARKERS = [
  'AUTO-SELECT',
  '5-Layer Persona Matching Protocol',
  'Layer 1 (Company Mission)',
  'Run the 5-Layer',
];

/** No dispatch block may ever tell the doer to self-select or leave it naked. */
function assertNoSelfSelection(block: string) {
  assert.ok(block.trim().length > 0, 'persona block must never be empty (naked dispatch)');
  for (const marker of AUTO_SELECT_MARKERS) {
    assert.ok(
      !block.includes(marker),
      `persona block must not contain self-selection prose: "${marker}"`,
    );
  }
  // `'auto'` must never leak into the doer-facing text as an instruction.
  assert.ok(!/\bAUTO-SELECT\b/i.test(block), 'no AUTO-SELECT anywhere');
}

const RESOLVER_TASK_PINNED: Settings = {
  persona: 'Alex Hormozi',
  personaSource: 'task_pinned',
  personaMode: 'leadership',
};

test('F4.1 — assigned persona (single) is delivered, not self-selected', () => {
  const task: PersonaDispatchTask = {
    persona_id: 'hormozi-100m-offers',
    persona_name: 'Alex Hormozi',
    persona_mode: 'leadership',
  };
  const block = buildPersonaBlock(task, RESOLVER_TASK_PINNED);

  assertNoSelfSelection(block);
  // Persona in the message == persona on the DB row.
  assert.ok(block.includes('hormozi-100m-offers'), 'renders the task.persona_id');
  assert.ok(block.includes('Alex Hormozi'), 'renders the task.persona_name');
  assert.ok(/\(assigned\)/.test(block), 'labelled as assigned, not auto');
  // Section-4 (A–D) + §7B load contract + [+APPENDIX] pointer + blueprint path.
  assert.ok(block.includes(personaBlueprintPath('hormozi-100m-offers')), 'blueprint path present');
  assert.ok(block.includes('Section 4 (A–D)'), 'Section 4 A–D load instruction present');
  assert.ok(block.includes('§7B'), '§7B load instruction present');
  assert.ok(block.includes('[+APPENDIX]'), '[+APPENDIX] pointer present');
});

test('F4.1 — task.persona_id wins even when settings.persona disagrees', () => {
  // Simulates the pre-fix bug surface: settings carried a stale/other value.
  const task: PersonaDispatchTask = {
    persona_id: 'godin-purple-cow',
    persona_name: 'Seth Godin',
    persona_mode: 'coaching',
  };
  const staleSettings: Settings = {
    persona: 'auto',
    personaSource: 'hardcoded_default',
    personaMode: null,
  };
  const block = buildPersonaBlock(task, staleSettings);
  assertNoSelfSelection(block);
  assert.ok(block.includes('godin-purple-cow'), 'delivers the DB row persona, not settings');
  assert.ok(block.includes('coaching mode'), 'carries the task persona_mode');
});

test('F4.1 — hybrid task renders the secondary persona blend', () => {
  const task: PersonaDispatchTask = {
    persona_id: 'ogilvy-on-advertising',
    persona_name: 'David Ogilvy',
    persona_mode: 'hybrid',
    secondary_persona_id: 'bly-copywriters-handbook',
    secondary_persona_name: 'Robert Bly',
  };
  const block = buildPersonaBlock(task, RESOLVER_TASK_PINNED);
  assertNoSelfSelection(block);
  assert.ok(block.includes('ogilvy-on-advertising'), 'primary persona present');
  assert.ok(block.includes('Secondary persona (hybrid blend)'), 'secondary block present');
  assert.ok(block.includes('bly-copywriters-handbook'), 'secondary persona id present');
  assert.ok(block.includes('David Ogilvy'), 'primary leads');
});

test('F4.1 — mechanical task carries a governance pointer, not a persona load', () => {
  const task: PersonaDispatchTask = {
    persona_id: null,
    persona_name: null,
    no_persona_required: true,
    governance_persona_id: 'covey-7-habits',
  };
  const block = buildPersonaBlock(task, RESOLVER_TASK_PINNED);
  assertNoSelfSelection(block);
  assert.ok(/none required/i.test(block), 'declares no persona required (truthful)');
  assert.ok(block.includes('Governance oversight'), 'governance oversight pointer present');
  assert.ok(block.includes('covey-7-habits'), 'names the governance persona');
  assert.ok(!block.includes('persona-blueprint.md'), 'does NOT emit a full Section-4 load for a chmod');
});

test('F4.1 — mechanical task with no governance id falls back to the pinned constant', () => {
  const task: PersonaDispatchTask = { no_persona_required: 1 };
  const block = buildPersonaBlock(task, RESOLVER_TASK_PINNED);
  assertNoSelfSelection(block);
  assert.ok(block.includes(GOVERNANCE_PERSONA_FALLBACK), 'uses GOVERNANCE_PERSONA_FALLBACK');
});

test('F4.1 — operator lock (agent_settings) overrides the matched persona', () => {
  const task: PersonaDispatchTask = {
    persona_id: 'hormozi-100m-offers',
    persona_name: 'Alex Hormozi',
    persona_mode: 'leadership',
  };
  const lockedSettings: Settings = {
    persona: 'voss-never-split-difference',
    personaSource: 'role_override',
    personaMode: 'leadership',
  };
  const block = buildPersonaBlock(task, lockedSettings);
  assertNoSelfSelection(block);
  assert.ok(block.includes('voss-never-split-difference'), 'operator lock wins');
  assert.ok(/operator-locked/.test(block), 'labelled operator-locked');
  assert.ok(!block.includes('hormozi-100m-offers'), 'matched persona is overridden by the lock');
});

test('F4.1 — unresolved persona is never naked and never AUTO-SELECT', () => {
  const task: PersonaDispatchTask = { persona_id: null, persona_name: null };
  const autoSettings: Settings = {
    persona: 'auto',
    personaSource: 'hardcoded_default',
    personaMode: null,
  };
  const block = buildPersonaBlock(task, autoSettings);
  assertNoSelfSelection(block);
  assert.ok(block.includes('Governance oversight'), 'governs under a fallback pointer');
  assert.ok(block.includes(GOVERNANCE_PERSONA_FALLBACK), 'house governance fallback used');
});

test('F4.1 — resolver sticky persona (no task id) still renders a real persona', () => {
  const task: PersonaDispatchTask = { persona_id: null };
  const stickySettings: Settings = {
    persona: 'sinek-start-with-why',
    personaSource: 'sticky_assignment',
    personaMode: 'coaching',
  };
  const block = buildPersonaBlock(task, stickySettings);
  assertNoSelfSelection(block);
  assert.ok(block.includes('sinek-start-with-why'), 'renders the sticky persona');
  assert.ok(block.includes('Section 4 (A–D)'), 'still carries the load contract');
});
