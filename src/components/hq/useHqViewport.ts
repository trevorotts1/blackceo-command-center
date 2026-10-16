'use client';

/**
 * B25 — Headquarters camera: fit / focus / pan (SPEC S4 "Navigation and actions").
 *
 * Camera pan/zoom is LOCAL viewing state: it never reassigns tasks and never
 * moves anyone in storage. "Fit company" and "Focus department" exist as
 * explicit actions so navigation is never gesture-only (S11), and the pan
 * surface must not trap the keyboard (S11) — the keyboard mapping offered here
 * owns exactly four keys and returns null for everything else, so the caller
 * leaves Escape/Tab and every other key alone.
 *
 * Geometry is read from the frozen B04 contract (`HqLayout`) and the SPEC's
 * isometric projection. This module writes no layout, no storage and no DOM.
 */
import { useCallback, useState } from 'react';
import type { HqLayout, HqWorldPoint } from '@/lib/hq/types';

export type HqCamera = { x: number; y: number; zoom: number };
export type HqViewportSize = { width: number; height: number };

/**
 * SPEC S4 projection — the single definition shared by camera and overlays.
 * screenX = x - y, screenY = (x + y) / 2.
 */
export function projectWorld(world: HqWorldPoint): HqWorldPoint {
  return { x: world.x - world.y, y: (world.x + world.y) / 2 };
}

/** Projected point -> layer pixels under `camera`. */
export function applyCamera(camera: HqCamera, point: HqWorldPoint): HqWorldPoint {
  return { x: (point.x - camera.x) * camera.zoom, y: (point.y - camera.y) * camera.zoom };
}

/** World point -> layer pixels under `camera`. */
export function worldToScreen(camera: HqCamera, world: HqWorldPoint): HqWorldPoint {
  return applyCamera(camera, projectWorld(world));
}

// SPEC S4 fixes the geometry model but not these camera constants; the SPEC
// explicitly allows recording chosen constants without changing the model.
export const HQ_CAMERA_DEFAULT: HqCamera = { x: 0, y: 0, zoom: 1 };
export const HQ_CAMERA_FIT_PADDING = 48;
export const HQ_CAMERA_MIN_ZOOM = 0.25;
export const HQ_CAMERA_MAX_ZOOM = 2.5;
export const HQ_CAMERA_ZOOM_STEP = 1.25;
export const HQ_CAMERA_KEYBOARD_PAN_STEP = 48;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roomCorners(room: HqLayout['rooms'][number]): HqWorldPoint[] {
  const { x, y } = room.world;
  return [
    { x, y },
    { x: x + room.width, y },
    { x, y: y + room.height },
    { x: x + room.width, y: y + room.height },
  ];
}

/** Projected bounding box over every room rectangle; null when there is no room. */
export function layoutScreenBounds(
  layout: HqLayout,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (layout.rooms.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const room of layout.rooms) {
    for (const corner of roomCorners(room)) {
      const point = projectWorld(corner);
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/**
 * "Fit company": centre the whole projected floor inside the viewport. An empty
 * layout or an unmeasured viewport returns the default camera rather than a
 * NaN/Infinity camera.
 */
export function fitCompany(layout: HqLayout, viewport: HqViewportSize): HqCamera {
  const bounds = layoutScreenBounds(layout);
  if (!bounds || viewport.width <= 0 || viewport.height <= 0) return { ...HQ_CAMERA_DEFAULT };
  const width = bounds.maxX - bounds.minX + HQ_CAMERA_FIT_PADDING * 2;
  const height = bounds.maxY - bounds.minY + HQ_CAMERA_FIT_PADDING * 2;
  const zoom = clamp(
    Math.min(viewport.width / width, viewport.height / height),
    HQ_CAMERA_MIN_ZOOM,
    HQ_CAMERA_MAX_ZOOM,
  );
  return {
    x: (bounds.minX + bounds.maxX) / 2 - viewport.width / (2 * zoom),
    y: (bounds.minY + bounds.maxY) / 2 - viewport.height / (2 * zoom),
    zoom,
  };
}

/**
 * "Focus department": centre a room, keeping the current zoom. Returns null when
 * the room is not in the layout so the caller can show its notice and keep the
 * previous camera (SPEC S4: removed entity shows a notice, no silent jump).
 */
export function focusDepartment(
  layout: HqLayout,
  workspaceId: string,
  viewport: HqViewportSize,
  zoom: number,
): HqCamera | null {
  const room = layout.rooms.find((candidate) => candidate.workspaceId === workspaceId);
  if (!room) return null;
  const centre = projectWorld({
    x: room.world.x + room.width / 2,
    y: room.world.y + room.height / 2,
  });
  const applied = clamp(zoom, HQ_CAMERA_MIN_ZOOM, HQ_CAMERA_MAX_ZOOM);
  return { x: centre.x - viewport.width / (2 * applied), y: centre.y - viewport.height / (2 * applied), zoom: applied };
}

/**
 * Move the camera by `deltaX`/`deltaY` world units. A drag handler converts a
 * screen drag (sx, sy) with `panBy(camera, -sx / camera.zoom, -sy / camera.zoom)`
 * so the floor follows the finger; keyboard pan passes the step directly.
 */
export function panBy(camera: HqCamera, deltaX: number, deltaY: number): HqCamera {
  return { x: camera.x + deltaX, y: camera.y + deltaY, zoom: camera.zoom };
}

/**
 * Zoom by `factor`, clamped. When `anchor` (a layer pixel, e.g. the pointer or
 * the focused room) is given, the world point under it stays put.
 */
export function zoomBy(camera: HqCamera, factor: number, anchor?: HqWorldPoint): HqCamera {
  const zoom = clamp(camera.zoom * factor, HQ_CAMERA_MIN_ZOOM, HQ_CAMERA_MAX_ZOOM);
  if (!anchor) return { ...camera, zoom };
  const worldX = anchor.x / camera.zoom + camera.x;
  const worldY = anchor.y / camera.zoom + camera.y;
  return { x: worldX - anchor.x / zoom, y: worldY - anchor.y / zoom, zoom };
}

/**
 * Arrow keys -> camera step. Anything else (Escape, Tab, letters, IME keys)
 * returns null so the pan surface cannot become a keyboard trap.
 */
export function panForKeyboardKey(
  key: string,
  step: number = HQ_CAMERA_KEYBOARD_PAN_STEP,
): { deltaX: number; deltaY: number } | null {
  if (key === 'ArrowLeft') return { deltaX: -step, deltaY: 0 };
  if (key === 'ArrowRight') return { deltaX: step, deltaY: 0 };
  if (key === 'ArrowUp') return { deltaX: 0, deltaY: -step };
  if (key === 'ArrowDown') return { deltaX: 0, deltaY: step };
  return null;
}

export type HqViewport = {
  camera: HqCamera;
  setCamera: (camera: HqCamera) => void;
  /** Returns the new camera so a caller can size overlays in the same frame. */
  fit: (layout: HqLayout, viewport: HqViewportSize) => HqCamera;
  /** False when the room is gone: caller shows the removal notice, camera unchanged. */
  focus: (layout: HqLayout, workspaceId: string, viewport: HqViewportSize) => boolean;
  pan: (deltaX: number, deltaY: number) => void;
  zoom: (factor: number, anchor?: HqWorldPoint) => void;
  /** Arrow-key handling; true when the key was consumed. */
  handleKey: (key: string) => boolean;
};

export function useHqViewport(initial?: HqCamera): HqViewport {
  const [camera, setCamera] = useState<HqCamera>(initial ?? { ...HQ_CAMERA_DEFAULT });

  const fit = useCallback((layout: HqLayout, viewport: HqViewportSize) => {
    const next = fitCompany(layout, viewport);
    setCamera(next);
    return next;
  }, []);

  const focus = useCallback(
    (layout: HqLayout, workspaceId: string, viewport: HqViewportSize) => {
      const next = focusDepartment(layout, workspaceId, viewport, camera.zoom);
      if (next) setCamera(next);
      return next !== null;
    },
    [camera.zoom],
  );

  const pan = useCallback((deltaX: number, deltaY: number) => {
    setCamera((current) => panBy(current, deltaX, deltaY));
  }, []);

  const zoom = useCallback((factor: number, anchor?: HqWorldPoint) => {
    setCamera((current) => zoomBy(current, factor, anchor));
  }, []);

  const handleKey = useCallback(
    (key: string) => {
      const step = panForKeyboardKey(key);
      if (!step) return false;
      setCamera((current) => panBy(current, step.deltaX, step.deltaY));
      return true;
    },
    [],
  );

  return { camera, setCamera, fit, focus, pan, zoom, handleKey };
}
