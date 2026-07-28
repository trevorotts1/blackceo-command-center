/**
 * U038 (audit E8) — Board department label coverage test.
 *
 * Stage 1 (warn) of Rule 3.5 staging. This test imports the REAL exported maps
 * from MissionQueue.tsx, applies canonicalDeptSlug the same way the two render
 * sites do, and reports the remaining coverage gap to CANONICAL_SLUGS as a
 * console.warn.  It asserts a CEILING (<=), never equality and never zero, so
 * stage 2 can fix the gap without this test going red.
 *
 * Run: node --import tsx --import ./tests/setup/no-owner-telegram.ts --test tests/unit/u038-board-department-label-coverage.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDeptSlug, CANONICAL_SLUGS } from '../../src/lib/routing/canonical-slug';

describe('U038 — board department label coverage (warn-mode)', () => {
  /** @type {Record<string, string>} */
  let departmentEmojis: Record<string, string>;
  /** @type {Record<string, string>} */
  let departmentNames: Record<string, string>;

  it('imports the real exported maps from MissionQueue', async () => {
    // Item 12, measured: under `node --import tsx --test` this namespace's
    // ONLY key is `default`, and a direct `ns.departmentEmojis` is `undefined`
    // whether or not the export keyword is present — which would make QC-6's
    // mutation B red on both legs and therefore undecidable. Unwrap once, here.
    const ns = await import('../../src/components/MissionQueue') as Record<string, unknown>;
    const mq = ((ns.default ?? ns) as Record<string, unknown>);
    departmentEmojis = mq.departmentEmojis as Record<string, string>;
    departmentNames  = mq.departmentNames  as Record<string, string>;

    assert.ok(departmentEmojis, 'MissionQueue must export departmentEmojis for this to be a real, non-reimplemented guard (cf. u44:341-344 — the assertion, not the import shape)');
    assert.ok(departmentNames, 'MissionQueue must export departmentNames for this to be a real, non-reimplemented guard');
  });

  it('the three engine labels exist and are the sanctioned strings', () => {
    assert.equal(departmentEmojis['presentations'], '🖥️', 'presentations emoji');
    assert.equal(departmentNames['presentations'], 'Presentations', 'presentations name');
    assert.equal(departmentEmojis['podcast'], '🎙️', 'podcast emoji');
    assert.equal(departmentNames['podcast'], 'Podcast', 'podcast name');
    assert.equal(departmentEmojis['anthology'], '📚', 'anthology emoji');
    assert.equal(departmentNames['anthology'], 'Anthology', 'anthology name');
  });

  it('the chip resolves the live value through the real canonicalDeptSlug', () => {
    assert.equal(
      departmentNames[canonicalDeptSlug('Presentations')],
      'Presentations',
      'live Presentations string -> canonicalized -> label',
    );
    assert.equal(
      departmentEmojis[canonicalDeptSlug('Presentations')],
      '🖥️',
      'live Presentations string -> canonicalized -> emoji',
    );
  });

  it('the alias labels that worked before still work (two-arm lookup regression guard)', () => {
    // For each alias spelling, the two-arm form
    //   departmentNames[canonicalDeptSlug(raw)] ?? departmentNames[raw.toLowerCase()]
    // must return a non-fallback label.  This is the regression case for step 3's
    // most damaging mistake — a canonical-only lookup would miss these three
    // because canonicalDeptSlug('video-production') → 'video', which is NOT a key
    // in departmentNames.

    const lookup = (raw: string): string =>
      departmentNames[canonicalDeptSlug(raw)] ?? departmentNames[raw.toLowerCase()] ?? '<<FALLBACK>>';

    assert.equal(lookup('video-production'), 'Video Production', 'video-production alias still resolves');
    assert.equal(lookup('audio-production'), 'Audio Production', 'audio-production alias still resolves');
    assert.equal(lookup('legal-compliance'), 'Legal / Compliance', 'legal-compliance alias still resolves');
    assert.equal(lookup('ceo-com'), 'CEO / COM', 'ceo-com alias still resolves');
    assert.equal(lookup('billing'), 'Billing', 'billing alias still resolves');
  });

  it("'dept-presentations' resolves (board indifferent to U037 rename)", () => {
    assert.equal(
      departmentNames[canonicalDeptSlug('dept-presentations')],
      'Presentations',
      "dept-presentations -> canonicalized -> Presentations",
    );
  });

  it('an unknown department still renders as itself (not blank, not a wrong label)', () => {
    const result = departmentNames[canonicalDeptSlug('not-a-department')] ?? departmentNames['not-a-department'.toLowerCase()] ?? 'not-a-department';
    assert.equal(result, 'not-a-department', 'unknown slug falls back to itself');
  });

  it('COVERAGE GAP — warn-mode ceiling assertion (stage 1 of Rule 3.5)', () => {
    const canon = Array.from(CANONICAL_SLUGS);
    const ek = Object.keys(departmentEmojis);
    const nk = Object.keys(departmentNames);

    const missE = canon.filter((c) => !ek.includes(c));
    const missN = canon.filter((c) => !nk.includes(c));

    console.warn(
      `U038 COVERAGE GAP — departmentEmojis: ${missE.length} canonical ids missing of ${CANONICAL_SLUGS.size} (${missE.join(', ')})`,
    );
    console.warn(
      `U038 COVERAGE GAP — departmentNames: ${missN.length} canonical ids missing of ${CANONICAL_SLUGS.size} (${missN.join(', ')})`,
    );

    // Checksum: 8 + 6 + 5 + … must close against CANONICAL_SLUGS.size.
    const emojisPresent = canon.filter((c) => ek.includes(c)).length;
    const namesPresent  = canon.filter((c) => nk.includes(c)).length;
    assert.equal(emojisPresent + missE.length, CANONICAL_SLUGS.size, 'emojis checksum must close');
    assert.equal(namesPresent + missN.length, CANONICAL_SLUGS.size, 'names checksum must close');

    // Stage 1 (warn): assert a CEILING, never equality and never zero.
    // Stage 2 drives the count down; an equality assertion would turn a fix
    // into a failure, which is how a ratchet becomes an obstacle.
    // Stage 3 (not this unit) flips to fail-closed.
    // The ceilings are 8 / 11: the pre-change 10 / 13 MINUS the two canonical
    // ids this unit adds (presentations, podcast). anthology is a third key
    // added but is NOT canonical — it does not move either missing count.
    assert.ok(
      missE.length <= 8,
      `departmentEmojis missing CANONICAL_SLUGS count grew: ${missE.length} > 8 (${missE.join(', ')})`,
    );
    assert.ok(
      missN.length <= 11,
      `departmentNames missing CANONICAL_SLUGS count grew: ${missN.length} > 11 (${missN.join(', ')})`,
    );
  });

  it("anthology is NOT asserted against CANONICAL_SLUGS — registry gap deliberately left open", () => {
    assert.equal(
      CANONICAL_SLUGS.has('anthology'),
      false,
      "anthology is in NEITHER CANONICAL_SLUGS nor DEFAULT_DEPARTMENTS — it has a live workspace row but adding it to the department registry is a separate decision this unit does not make",
    );
  });
});
