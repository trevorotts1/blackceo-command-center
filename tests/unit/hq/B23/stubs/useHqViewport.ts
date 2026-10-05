/**
 * TEST-ONLY stub for `./useHqViewport` (B25's owned module, not on disk in the
 * B23 worktree). Loaded only through `floor-stub-register.mjs`; never shipped,
 * never imported by product code.
 *
 * It reproduces the one part of the real hook's surface B23 composes against —
 * the camera value and the four callbacks — so the wiring can be asserted
 * deterministically (a fixed camera, recorded calls). It deliberately does NOT
 * re-implement B25's camera math: that behavior is proved by B25's own tests
 * against the real module.
 */
import type { HqLayout } from '@/lib/hq/types';

export type HqCamera = { x: number; y: number; zoom: number };
export type HqViewportSize = { width: number; height: number };

export type HqStubViewportCalls = {
  fit: { layout: HqLayout; viewport: HqViewportSize }[];
  focus: { layout: HqLayout; workspaceId: string; viewport: HqViewportSize }[];
  pan: { deltaX: number; deltaY: number }[];
  zoom: { factor: number }[];
  keys: string[];
};

const calls: HqStubViewportCalls = { fit: [], focus: [], pan: [], zoom: [], keys: [] };

/** Fresh call log per test; the test file owns the reset. */
export function __resetHqViewportStub(): void {
  calls.fit.length = 0;
  calls.focus.length = 0;
  calls.pan.length = 0;
  calls.zoom.length = 0;
  calls.keys.length = 0;
}

export function __hqViewportStubCalls(): HqStubViewportCalls {
  return calls;
}

/** Test-controlled camera; default matches the real hook's default. */
export function __setHqViewportCamera(camera: HqCamera): void {
  (globalThis as unknown as { __B23_STUB_CAMERA__?: HqCamera }).__B23_STUB_CAMERA__ = camera;
}

function currentCamera(): HqCamera {
  return (
    (globalThis as unknown as { __B23_STUB_CAMERA__?: HqCamera }).__B23_STUB_CAMERA__ ?? {
      x: 0,
      y: 0,
      zoom: 1,
    }
  );
}

export function useHqViewport() {
  const camera = currentCamera();
  return {
    camera,
    setCamera: () => undefined,
    fit: (layout: HqLayout, viewport: HqViewportSize) => {
      calls.fit.push({ layout, viewport });
      return camera;
    },
    focus: (layout: HqLayout, workspaceId: string, viewport: HqViewportSize) => {
      calls.focus.push({ layout, workspaceId, viewport });
      return true;
    },
    pan: (deltaX: number, deltaY: number) => {
      calls.pan.push({ deltaX, deltaY });
    },
    zoom: (factor: number) => {
      calls.zoom.push({ factor });
    },
    handleKey: (key: string) => {
      if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'ArrowUp' && key !== 'ArrowDown') {
        return false;
      }
      calls.keys.push(key);
      return true;
    },
  };
}

/** Mirrors the SPEC S4 projection so chip/label placement can be asserted. */
export function worldToScreen(camera: HqCamera, world: { x: number; y: number }) {
  const projected = { x: world.x - world.y, y: (world.x + world.y) / 2 };
  return { x: (projected.x - camera.x) * camera.zoom, y: (projected.y - camera.y) * camera.zoom };
}

export function projectWorld(world: { x: number; y: number }) {
  return { x: world.x - world.y, y: (world.x + world.y) / 2 };
}
