/**
 * B25 focused checks — SPEC S4 camera + movement truth, S11 reduced motion.
 *
 * Owned behavior only: the gate that decides whether a figure may move, the
 * four-overlay bound with aggregated count, the pure camera math, and both
 * render modes. No database, no live data, no fixtures outside this file.
 *
 * tsx (esbuild) compiles JSX to the classic `React.createElement` factory here,
 * so the render checks install the React namespace on `globalThis` before
 * rendering. Nothing in `src/` depends on that shim — Next/tsc compile with the
 * automatic runtime (`tsconfig.json` "jsx": "react-jsx").
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h } from 'react';
import * as ReactNamespace from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HqLayout } from '@/lib/hq/types';
import {
  HQ_CAMERA_KEYBOARD_PAN_STEP,
  applyCamera,
  fitCompany,
  focusDepartment,
  panBy,
  panForKeyboardKey,
  projectWorld,
  worldToScreen,
  zoomBy,
} from '@/components/hq/useHqViewport';
import HandoffOverlay, {
  HQ_MAX_ACTIVE_OVERLAYS,
  HQ_OVERLAY_LABEL_CHAR_CEILING_PX,
  HQ_OVERLAY_LABEL_GAP_PX,
  HQ_OVERLAY_LABEL_HEIGHT_PX,
  deriveHandoffLedger,
  isEvidenceLinkedHandoff,
  overlayBox,
  type HqHandoffEvidence,
} from '@/components/hq/HandoffOverlay';

(globalThis as Record<string, unknown>).React = ReactNamespace;

/* SPEC S4 geometry constants, verbatim: width 480, four columns at 96 units. */
function layoutFixture(): HqLayout {
  return {
    revision: 'rev-fixture',
    rooms: [
      { workspaceId: 'w1', world: { x: 0, y: 0 }, width: 480, height: 320, seats: [] },
      { workspaceId: 'w2', world: { x: 560, y: 0 }, width: 480, height: 320, seats: [] },
      { workspaceId: 'w3', world: { x: 1120, y: 0 }, width: 480, height: 320, seats: [] },
    ],
  };
}

function evidence(overrides: Partial<HqHandoffEvidence> = {}): HqHandoffEvidence {
  return {
    activityId: 'act-1',
    actorAgentId: 'rt-1',
    actorLabel: 'Ada',
    fromWorkspaceId: 'w1',
    toWorkspaceId: 'w2',
    label: 'Sent request',
    ...overrides,
  };
}

/* ---------------------------------------------------------------- gate */

test('B25: a fact without both workspace endpoints or an actor never moves a figure', () => {
  assert.equal(isEvidenceLinkedHandoff(evidence()), true);
  assert.equal(isEvidenceLinkedHandoff(evidence({ actorAgentId: '' })), false);
  assert.equal(isEvidenceLinkedHandoff(evidence({ fromWorkspaceId: '' })), false);
  assert.equal(isEvidenceLinkedHandoff(evidence({ toWorkspaceId: '' })), false);
  assert.equal(isEvidenceLinkedHandoff(evidence({ toWorkspaceId: 'w1' })), false);
  assert.equal(isEvidenceLinkedHandoff(evidence({ historical: true })), false);

  const silent = deriveHandoffLedger(layoutFixture(), [evidence({ actorAgentId: '' })]);
  assert.deepEqual(silent.overlays, []);
  assert.equal(silent.counts.total, 0, 'unvalidated row is not counted as a handoff');
});

test('B25: a fact naming a workspace outside the layout is not animated', () => {
  const result = deriveHandoffLedger(layoutFixture(), [evidence({ toWorkspaceId: 'gone' })]);
  assert.deepEqual(result.overlays, []);
  assert.equal(result.counts.total, 0);
});

test('B25: historical/backfilled events populate history without replaying old walks', () => {
  const result = deriveHandoffLedger(layoutFixture(), [
    evidence({ activityId: 'old-1', historical: true }),
    evidence({ activityId: 'new-1' }),
  ]);
  assert.equal(result.overlays.length, 1);
  assert.equal(result.overlays[0].activityId, 'new-1');
  assert.equal(result.counts.aggregated, 0);
  assert.equal(result.counts.total, 1);
});

/* ------------------------------------------------- bound + identity */

test('B25: at most four moving overlays, remainder aggregated with a count', () => {
  const many: HqHandoffEvidence[] = [];
  for (let index = 0; index < 6; index += 1) {
    many.push(
      evidence({
        activityId: `act-${index}`,
        actorAgentId: `rt-${index}`,
        toWorkspaceId: index % 2 === 0 ? 'w2' : 'w3',
      }),
    );
  }
  const result = deriveHandoffLedger(layoutFixture(), many);
  assert.equal(result.overlays.length, HQ_MAX_ACTIVE_OVERLAYS);
  assert.equal(result.counts.shown, 4);
  assert.equal(result.counts.aggregated, 2);
  assert.equal(result.counts.total, 6, 'aggregated handoffs are counted, not discarded');
});

test('B25: simultaneous work keeps one employee identity, newest fact wins', () => {
  const result = deriveHandoffLedger(layoutFixture(), [
    evidence({ activityId: 'first', toWorkspaceId: 'w2' }),
    evidence({ activityId: 'second', toWorkspaceId: 'w3' }),
  ]);
  assert.equal(result.overlays.length, 1, 'one home figure, never a clone');
  assert.equal(result.overlays[0].activityId, 'second');
  assert.equal(result.counts.aggregated, 1);
  assert.equal(result.counts.total, 2);
});

test('B25: validated overlays carry the receipt label and both endpoints as-is', () => {
  const result = deriveHandoffLedger(layoutFixture(), [
    evidence({ label: 'Handoff accepted', fromWorkspaceId: 'w3', toWorkspaceId: 'w2' }),
  ]);
  assert.equal(result.overlays[0].label, 'Handoff accepted');
  assert.equal(result.overlays[0].fromWorkspaceId, 'w3');
  assert.equal(result.overlays[0].toWorkspaceId, 'w2');
  // Room centre of w3 (480×320 at world x=1120) — the overlay never invents a location.
  assert.deepEqual(result.overlays[0].from, { x: 1360, y: 160 });
});

/* -------------------------------------------------------------- camera */

test('B25: projection and camera application match SPEC S4 screenX/screenY', () => {
  assert.deepEqual(projectWorld({ x: 100, y: 40 }), { x: 60, y: 70 });
  assert.deepEqual(worldToScreen({ x: 0, y: 0, zoom: 1 }, { x: 100, y: 40 }), { x: 60, y: 70 });
  assert.deepEqual(applyCamera({ x: 10, y: 20, zoom: 2 }, { x: 30, y: 40 }), { x: 40, y: 40 });
});

test('B25: fit company centres the whole floor inside the viewport', () => {
  const layout = layoutFixture();
  const viewport = { width: 1000, height: 600 };
  const camera = fitCompany(layout, viewport);
  const bounds = layout.rooms.reduce(
    (acc, room) => {
      const corners = [
        { x: room.world.x, y: room.world.y },
        { x: room.world.x + room.width, y: room.world.y },
        { x: room.world.x, y: room.world.y + room.height },
        { x: room.world.x + room.width, y: room.world.y + room.height },
      ].map(projectWorld);
      return corners.reduce((inner, point) => ({
        minX: Math.min(inner.minX, point.x),
        minY: Math.min(inner.minY, point.y),
        maxX: Math.max(inner.maxX, point.x),
        maxY: Math.max(inner.maxY, point.y),
      }), acc);
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  assert.ok(camera.zoom > 0 && Number.isFinite(camera.zoom));
  // `bounds` is already projected; the camera maps projected -> layer pixels.
  const topLeft = applyCamera(camera, { x: bounds.minX, y: bounds.minY });
  const bottomRight = applyCamera(camera, { x: bounds.maxX, y: bounds.maxY });
  assert.ok(topLeft.x >= 0 && topLeft.y >= 0, 'floor starts inside the viewport');
  assert.ok(bottomRight.x <= viewport.width && bottomRight.y <= viewport.height, 'floor ends inside the viewport');
});

test('B25: empty layout and unmeasured viewport do not produce a NaN camera', () => {
  const empty: HqLayout = { revision: 'rev-empty', rooms: [] };
  assert.deepEqual(fitCompany(empty, { width: 800, height: 600 }), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(fitCompany(layoutFixture(), { width: 0, height: 0 }), { x: 0, y: 0, zoom: 1 });
});

test('B25: focus department centres a room and returns null for a removed room', () => {
  const layout = layoutFixture();
  const camera = focusDepartment(layout, 'w2', { width: 800, height: 600 }, 1);
  assert.ok(camera);
  const centre = worldToScreen(camera!, { x: 560 + 240, y: 160 });
  assert.deepEqual(centre, { x: 400, y: 300 });
  assert.equal(focusDepartment(layout, 'gone', { width: 800, height: 600 }, 1), null);
});

test('B25: pan moves the camera, zoom keeps the anchored point fixed and clamps', () => {
  const panned = panBy({ x: 5, y: 6, zoom: 2 }, -10, 3);
  assert.deepEqual(panned, { x: -5, y: 9, zoom: 2 });

  // Anchor is a layer pixel; camera fields are projected-space offsets. The
  // world point currently under that pixel must land back on the same pixel.
  const camera = { x: 40, y: 60, zoom: 1 };
  const anchorPixel = { x: 300, y: 200 };
  const worldUnderAnchor = { x: anchorPixel.x / camera.zoom + camera.x, y: anchorPixel.y / camera.zoom + camera.y };
  const zoomed = zoomBy(camera, 1.5, anchorPixel);
  const landed = applyCamera(zoomed, worldUnderAnchor);
  assert.ok(Math.abs(landed.x - anchorPixel.x) < 1e-9 && Math.abs(landed.y - anchorPixel.y) < 1e-9,
    'the point under the cursor stays put');

  assert.equal(zoomBy({ x: 0, y: 0, zoom: 2.4 }, 10).zoom, 2.5);
  assert.equal(zoomBy({ x: 0, y: 0, zoom: 0.3 }, 0.1).zoom, 0.25);
});

test('B25: keyboard pan owns the four arrow keys and nothing else (no trap)', () => {
  assert.deepEqual(panForKeyboardKey('ArrowLeft'), { deltaX: -HQ_CAMERA_KEYBOARD_PAN_STEP, deltaY: 0 });
  assert.deepEqual(panForKeyboardKey('ArrowDown', 10), { deltaX: 0, deltaY: 10 });
  assert.equal(panForKeyboardKey('Escape'), null);
  assert.equal(panForKeyboardKey('Tab'), null);
  assert.equal(panForKeyboardKey('Enter'), null);
  assert.equal(panForKeyboardKey('a'), null);
});

/* ------------------------------------------------------------- render */

test('B25: reduced motion renders the final static arrow/label for the same records', () => {
  const html = renderToStaticMarkup(
    h(HandoffOverlay, {
      layout: layoutFixture(),
      evidence: [evidence()],
      camera: { x: 0, y: 0, zoom: 1 },
      reducedMotion: true,
    }),
  );
  assert.match(html, /data-overlay-count="1"/);
  assert.match(html, /data-reduced-motion="true"/);
  assert.match(html, /data-testid="hq-handoff-static-act-1"/);
  assert.match(html, /Sent request/);
  assert.ok(!html.includes('hq-handoff-moving-act-1'), 'no motion group while reduced');
  assert.match(html, /data-actor-id="rt-1"/);
  assert.match(html, /data-from-workspace="w1"/);
  assert.match(html, /data-to-workspace="w2"/);
});

test('B25: the overlay box reserves its receipt label on every side', () => {
  /*
   * The outermost SVG clips to its viewBox (computed overflow: hidden; no repo
   * rule overrides it), so anything drawn outside `overlayBox` is cut. The
   * label is the only element that overruns the endpoint pad: it is drawn
   * `HQ_OVERLAY_LABEL_GAP_PX` right of and above its anchor.
   *
   * `pad` is swept over the real caller's range, `24 * camera.zoom` for zoom
   * 0.25-2.5, because the clip has two regimes: at normal zoom the label runs
   * off the right edge (measured 13% visible at fit zoom, 0% at minimum), and
   * when the pad shrinks below the label's own extent the top edge cuts too.
   * Before the reservation every direction failed one or both.
   * Labels are bounded here, so the assertion is arithmetic over exported
   * constants — the geometry is what the browser clipped, not bespoke markup.
   */
  const pads = [24 * 0.25, 24 * 0.687, 24 * 1, 24 * 2.5];
  for (const label of ['Sent request', 'Handoff accepted', 'Reply received']) {
    const labelWidth = label.length * HQ_OVERLAY_LABEL_CHAR_CEILING_PX;
    for (const pad of pads) {
      // Every direction the projection produces: right, left, down and up.
      const ends = [
        { x: 320, y: 160 },
        { x: 0, y: 160 },
        { x: 160, y: 480 },
        { x: 160, y: 0 },
      ];
      for (const end of ends) {
        const start = { x: 160, y: 160 };
        const box = overlayBox(start, end, pad, label);
        // The label hangs off the endpoint the arrow points at, right and above.
        const anchorX = Math.max(start.x, end.x);
        const anchorY = Math.min(start.y, end.y);
        const labelLeft = anchorX + HQ_OVERLAY_LABEL_GAP_PX - box.left;
        const labelRight = labelLeft + labelWidth;
        const labelBottom = anchorY - HQ_OVERLAY_LABEL_GAP_PX - box.top;
        const labelTop = labelBottom - HQ_OVERLAY_LABEL_HEIGHT_PX;
        const where = `${label} at (${end.x},${end.y}) pad ${pad}`;
        assert.ok(labelRight <= box.width, `${where} overruns the box right edge`);
        assert.ok(labelLeft >= 0, `${where} starts left of the box`);
        assert.ok(labelTop >= 0, `${where} is clipped off the top edge`);
        assert.ok(labelBottom <= box.height, `${where} overruns the box bottom edge`);
      }
    }
  }
});

test('B25: no validated handoff renders no overlay layer at all', () => {
  const html = renderToStaticMarkup(
    h(HandoffOverlay, {
      layout: layoutFixture(),
      evidence: [evidence({ actorAgentId: '' }), evidence({ activityId: 'hist', historical: true })],
      camera: { x: 0, y: 0, zoom: 1 },
    }),
  );
  assert.equal(html, '', 'a quiet floor renders nothing; the activity row stays in the feed');
});

test('B25: an animated overlay names its actor, endpoints and phase for Q09 ID mapping', () => {
  const html = renderToStaticMarkup(
    h(HandoffOverlay, {
      layout: layoutFixture(),
      evidence: [evidence({ label: 'Reply received' })],
      camera: { x: 0, y: 0, zoom: 1 },
    }),
  );
  assert.match(html, /data-testid="hq-handoff-act-1"/);
  assert.match(html, /data-label="Reply received"/);
  assert.match(html, /data-actor-id="rt-1"/);
  assert.match(html, /hq-handoff-moving-act-1/);
  assert.match(html, /hq-handoff-aggregate/);
});

test('B25: over-bound handoffs are announced as one aggregate count', () => {
  const many: HqHandoffEvidence[] = [];
  for (let index = 0; index < 6; index += 1) {
    many.push(evidence({ activityId: `act-${index}`, actorAgentId: `rt-${index}` }));
  }
  const html = renderToStaticMarkup(
    h(HandoffOverlay, { layout: layoutFixture(), evidence: many, camera: { x: 0, y: 0, zoom: 1 }, reducedMotion: true }),
  );
  assert.match(html, /data-overlay-count="4"/);
  assert.match(html, /data-aggregated-count="2"/);
  assert.match(html, /4 moving · 2 more handoffs in activity/);
  assert.equal((html.match(/data-testid="hq-handoff-act-/g) ?? []).length, 4);
});
