/**
 * JEV-224 (A37) — auto/manual dispatch persona-section parity.
 *
 * Both dispatch doors MUST render the same committed snapshot through the same
 * shared renderer (`renderDispatchPersonaSection` in src/lib/persona-dispatch.ts):
 * the full bundle contract (primary block + multi-persona plan) is byte-identical
 * whichever door sends it, and neither path tells the worker to re-select.
 *
 * Pure function test, no DB (mirrors the FDN-3 convention).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPersonaBlock,
  buildPersonaPlanBlock,
  renderDispatchPersonaSection,
  personaBlueprintPath,
  type PersonaDispatchTask,
  type PersonaPlanSubtask,
} from '../../src/lib/persona-dispatch';

type Settings = Parameters<typeof buildPersonaBlock>[1];

const SETTINGS: Settings = {
  persona: 'Alex Hormozi',
  personaSource: 'task_pinned',
  personaMode: 'leadership',
};

function assertNoSelfSelection(block: string) {
  assert.ok(block.trim().length > 0, 'persona section must never be empty (naked dispatch)');
  for (const marker of ['AUTO-SELECT', '5-Layer Persona Matching Protocol', 'Run the 5-Layer']) {
    assert.ok(!block.includes(marker), `must not contain self-selection prose: "${marker}"`);
  }
  assert.ok(!/\bAUTO-SELECT\b/i.test(block), 'no AUTO-SELECT anywhere');
}

test('JEV-224 A37 — shared renderer equals single-task buildPersonaBlock output', () => {
  const task: PersonaDispatchTask = {
    persona_id: 'hormozi-100m-offers',
    persona_name: 'Alex Hormozi',
    persona_mode: 'leadership',
  };
  const expected = buildPersonaBlock(task, SETTINGS);
  assert.equal(renderDispatchPersonaSection(task, SETTINGS, []), expected);
  assert.equal(renderDispatchPersonaSection(task, SETTINGS, null), expected);
  assert.equal(renderDispatchPersonaSection(task, SETTINGS), expected);
  assertNoSelfSelection(renderDispatchPersonaSection(task, SETTINGS, []));
});

test('JEV-224 A37 — shared renderer composes block + plan exactly once each', () => {
  const task: PersonaDispatchTask = {
    persona_id: 'ogilvy-on-advertising',
    persona_name: 'David Ogilvy',
    persona_mode: 'hybrid',
    secondary_persona_id: 'bly-copywriters-handbook',
    secondary_persona_name: 'Robert Bly',
  };
  const plan: PersonaPlanSubtask[] = [
    { seq: 1, slot: 'content', subtask_text: 'Write the copy', persona_id: 'ogilvy-on-advertising', persona_name: 'David Ogilvy' },
    { seq: 2, slot: 'image', subtask_text: 'Design the hero images', persona_id: 'godin-purple-cow', persona_name: 'Seth Godin' },
  ];
  const section = renderDispatchPersonaSection(task, SETTINGS, plan);
  const expected = `${buildPersonaBlock(task, SETTINGS)}\n${buildPersonaPlanBlock(plan, SETTINGS)}`;
  assert.equal(section, expected);
  assert.ok(section.includes('ogilvy-on-advertising'), 'primary persona present');
  assert.ok(section.includes(personaBlueprintPath('godin-purple-cow')), 'plan persona blueprint present');
  assertNoSelfSelection(section);
});

test('JEV-224 A37 — mechanical task stays a governance pointer, never naked', () => {
  const task: PersonaDispatchTask = {
    persona_id: null,
    persona_name: null,
    persona_mode: null,
    no_persona_required: true,
  };
  const section = renderDispatchPersonaSection(task, SETTINGS, []);
  assertNoSelfSelection(section);
  assert.ok(section.includes('Governance oversight'), 'mechanical task carries a governance pointer');
});

test('JEV-224 A37 — both dispatch paths call the shared renderer (no inline compose)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const rel of ['src/lib/task-dispatcher.ts', 'src/app/api/tasks/[id]/dispatch/route.ts']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
    assert.ok(src.includes('renderDispatchPersonaSection'), `${rel} must call the shared renderer`);
    assert.ok(!src.includes('buildPersonaPlanBlock('), `${rel} must not compose the plan block inline`);
  }
});
