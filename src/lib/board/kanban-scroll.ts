// Pure scroll math for the Task Board's horizontal-scroll affordances
// (column navigator, scroll track, chevron "N more" badges). Kept free of DOM
// access so the visible-range / hidden-count logic is unit-testable.

export interface ColRect {
  /** Left edge relative to the scroll content (not the viewport). */
  left: number;
  width: number;
}

// Sub-pixel / rounding slack so a column cut off by a couple of px is not
// reported as "hidden".
const EDGE_SLACK_PX = 4;
// Overflow below this is treated as "fits" (matches the old chevron threshold).
export const OVERFLOW_SLACK_PX = 8;

export function hasOverflow(clientWidth: number, scrollWidth: number): boolean {
  return scrollWidth - clientWidth > OVERFLOW_SLACK_PX;
}

/** A column counts as "in view" when at least half of it is on screen. */
export function visibleRange(cols: ColRect[], scrollLeft: number, clientWidth: number) {
  const viewRight = scrollLeft + clientWidth;
  const visible = cols.map((c) => {
    const overlap = Math.min(c.left + c.width, viewRight) - Math.max(c.left, scrollLeft);
    return overlap >= c.width * 0.5;
  });
  // Hidden = fully or partly cut off on that side.
  const hiddenLeft = cols.filter((c) => c.left < scrollLeft - EDGE_SLACK_PX).length;
  const hiddenRight = cols.filter((c) => c.left + c.width > viewRight + EDGE_SLACK_PX).length;
  return { visible, hiddenLeft, hiddenRight };
}

/** Scroll-track thumb position/size as percentages of the track. */
export function thumbMetrics(scrollLeft: number, clientWidth: number, scrollWidth: number) {
  if (scrollWidth <= 0) return { left: 0, width: 100 };
  const width = Math.min(100, (clientWidth / scrollWidth) * 100);
  const left = Math.min(100 - width, Math.max(0, (scrollLeft / scrollWidth) * 100));
  return { left, width };
}

/** Click on the track (ratio 0..1 along it) -> scrollLeft centring the window there. */
export function trackClickToScrollLeft(ratio: number, clientWidth: number, scrollWidth: number) {
  const max = Math.max(0, scrollWidth - clientWidth);
  return Math.min(max, Math.max(0, ratio * scrollWidth - clientWidth / 2));
}
