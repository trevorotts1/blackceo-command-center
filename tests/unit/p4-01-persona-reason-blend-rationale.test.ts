/**
 * P4-01 step 2 — "store persona_reason (P2-02) at selection time" for the
 * BLEND path specifically.
 *
 * GAP THIS CLOSES: `buildPersonaReason` (src/lib/persona-selector.ts) has a
 * documented THREE-tier precedence:
 *   1. the scorer's own `message`;
 *   2. else the blend voice decision's `why`
 *      (result.bundle?.voice?.audience_persona?.why ||
 *       result.bundle?.voice?.topic_persona?.why);
 *   3. else a synthesized sentence.
 * Every existing test (p2-02-task-modal-fields.test.ts,
 * p2-02-persona-reason-persistence.test.ts) exercises tier 1 (scorer
 * message present) and tier 3 (no message, no bundle). NEITHER existing
 * suite ever constructs a `bundle` with `voice.audience_persona.why` or
 * `voice.topic_persona.why` populated — tier 2, the entire reason P4-01/
 * P4-02's persona-BLEND feature exists, was UNTESTED. A regression that
 * broke the bundle-rationale reuse (e.g. a rename of `voice` ->
 * `voice_decision`, or reading `.rationale` instead of `.why`) would ship
 * silently: buildPersonaReason would just fall through to the tier-3
 * synthesized sentence and no existing test would notice the fallback fired
 * for the wrong reason.
 *
 * FAIL-FIRST: these assertions target the EXACT precedence contract in the
 * buildPersonaReason docstring. A regression that breaks tier-2 lookup makes
 * test_prefers_audience_persona_why / test_falls_back_to_topic_persona_why
 * fail (they'd instead observe the synthesized tier-3 sentence, which does
 * not match the tier-2 assertions below word-for-word).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPersonaReason, type PersonaSelectionResult } from '../../src/lib/persona-selector';
import type { PersonaBundle } from '../../src/lib/types';

function baseResult(over: Partial<PersonaSelectionResult>): PersonaSelectionResult {
  return {
    persona_id: 'russell-brunson',
    persona_name: 'Russell Brunson',
    score: 0.82,
    interaction_mode: 'leadership',
    ...over,
  };
}

function baseBundle(over: Partial<PersonaBundle>): PersonaBundle {
  return {
    confirm_required: false,
    voice: { collapsed: false },
    blend_directive: 'STYLE-INSPIRED, NEVER IMPERSONATION (mandatory, non-removable): ...',
    task_personas: [],
    ...over,
  };
}

// ── tier 2: the blend voice decision's `why` ──────────────────────────────────

test('buildPersonaReason PREFERS the bundle audience_persona.why when the scorer wrote no message', () => {
  const result = baseResult({
    message: undefined,
    bundle: baseBundle({
      voice: {
        collapsed: false,
        audience_persona: {
          id: 'brown-atlas-of-heart',
          why: "Audience voice for 'leaders doing emotional work': its audiences[] match on ['leaders'] (1 signal(s)); usable_as includes 'audience'.",
        },
        topic_persona: { id: 'hormozi-100m-offers', why: 'Topic expertise: its topics[] match the job on [\'offers\'] (1 signal(s)).' },
      },
    }),
  });
  const reason = buildPersonaReason(result);
  assert.ok(reason, 'a bundle with an audience_persona.why must yield a reason');
  assert.match(reason!, /Audience voice for 'leaders doing emotional work'/,
    'must reuse the bundle audience rationale VERBATIM (as a tidied sentence), not synthesize a generic one');
  assert.doesNotMatch(reason!, /was matched to this task/,
    'must NOT fall through to the tier-3 synthesized sentence when a tier-2 rationale exists');
});

test('buildPersonaReason FALLS BACK to topic_persona.why when audience_persona is absent', () => {
  const result = baseResult({
    message: undefined,
    bundle: baseBundle({
      voice: {
        collapsed: true,
        collapsed_persona_id: 'hormozi-100m-offers',
        audience_persona: null,
        topic_persona: {
          id: 'hormozi-100m-offers',
          why: "Topic expertise: its topics[] match the job on ['offer-creation', 'pricing'] (2 signal(s)).",
        },
      },
    }),
  });
  const reason = buildPersonaReason(result);
  assert.ok(reason);
  assert.match(reason!, /Topic expertise: its topics\[\] match the job/,
    'must reuse the topic rationale when no audience rationale is present (tier-2, second half)');
});

test('buildPersonaReason still PREFERS the scorer message over a present bundle rationale (precedence order 1 > 2)', () => {
  const result = baseResult({
    message: 'Chosen for direct-response funnel expertise on this landing-page task',
    bundle: baseBundle({
      voice: {
        collapsed: false,
        audience_persona: { id: 'brown-atlas-of-heart', why: 'Audience voice for X.' },
        topic_persona: { id: 'hormozi-100m-offers', why: 'Topic expertise for Y.' },
      },
    }),
  });
  const reason = buildPersonaReason(result);
  assert.match(reason!, /direct-response funnel expertise/,
    'the scorer message (tier 1) must win over the bundle rationale (tier 2) when both are present');
  assert.doesNotMatch(reason!, /Audience voice for X/);
});

test('buildPersonaReason falls all the way to the tier-3 synthesis when the bundle carries NO why on either dimension', () => {
  const result = baseResult({
    message: undefined,
    bundle: baseBundle({
      voice: { collapsed: false, audience_persona: null, topic_persona: null },
    }),
  });
  const reason = buildPersonaReason(result);
  assert.ok(reason, 'must still produce an honest synthesized reason, never null, when persona_id is present');
  assert.match(reason!, /Russell Brunson/);
  assert.match(reason!, /leadership/i);
});

test('buildPersonaReason single-sentence contract holds for a tier-2 (bundle) reason too', () => {
  const result = baseResult({
    message: undefined,
    bundle: baseBundle({
      voice: {
        collapsed: false,
        audience_persona: { id: 'brown-atlas-of-heart', why: 'Line one.\nLine two.\n\nLine three.   ' },
      },
    }),
  });
  const reason = buildPersonaReason(result);
  assert.ok(reason);
  assert.ok(!reason!.includes('\n'), 'a multi-line bundle rationale must still collapse to one line');
  assert.ok(reason!.endsWith('.'), 'must still read as a terminated sentence');
});
