import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { visibleRange, thumbMetrics, trackClickToScrollLeft, hasOverflow } from '../../src/lib/board/kanban-scroll';

// 6 columns, 300px wide, 16px gap -> content 1880px wide.
const cols = Array.from({ length: 6 }, (_, i) => ({ left: i * 316, width: 300 }));

describe('kanban scroll math', () => {
  it('at scroll start, 1500px viewport: 5 columns in view; 2 cut off right (one partly, one fully)', () => {
    const r = visibleRange(cols, 0, 1500);
    assert.deepEqual(r.visible, [true, true, true, true, true, false]);
    assert.equal(r.hiddenLeft, 0);
    assert.equal(r.hiddenRight, 2);
  });
  it('scrolled to end: two columns cut off left, none right', () => {
    const r = visibleRange(cols, 380, 1500);
    assert.equal(r.hiddenLeft, 2);
    assert.equal(r.hiddenRight, 0);
    assert.equal(r.visible[0], false);
  });
  it('everything fits: nothing hidden, no overflow', () => {
    assert.equal(visibleRange(cols, 0, 2000).hiddenRight, 0);
    assert.equal(hasOverflow(2000, 1880), false);
    assert.equal(hasOverflow(1500, 1880), true);
  });
  it('thumb width/position track the window; click centres it', () => {
    assert.deepEqual(thumbMetrics(0, 940, 1880), { left: 0, width: 50 });
    assert.deepEqual(thumbMetrics(940, 940, 1880), { left: 50, width: 50 });
    assert.equal(trackClickToScrollLeft(1, 940, 1880), 940); // clamped to max
    assert.equal(trackClickToScrollLeft(0.5, 940, 1880), 470);
  });
});
