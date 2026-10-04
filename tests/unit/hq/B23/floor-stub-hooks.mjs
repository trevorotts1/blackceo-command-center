/**
 * Synchronous module-resolution hook (Node `module.registerHooks`, which sees
 * both `require` and `import`). It maps the three sibling modules unit B23 does
 * NOT own — they do not exist in this worktree yet — onto local test-only stubs,
 * so `Floor.tsx` keeps its real static imports and real declared specifiers
 * instead of being refactored for testability.
 *
 * Scope: loaded only by B23's test file through `floor-stub-register.mjs`.
 * Product code ships no stub and resolves these names from the real modules in
 * the integration base where B04/B24/B25 have landed.
 *
 * FOLLOW-UP (recorded, not hidden): the integration candidate must re-run this
 * unit's checks against the real B24/B25 modules and delete this stub mapping —
 * a stub proves the seam, never the neighbor.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

const MAP = new Map([
  ['./DepartmentRoom', path.join(ROOT, 'tests/unit/hq/B23/stubs/DepartmentRoom.tsx')],
  ['./HandoffOverlay', path.join(ROOT, 'tests/unit/hq/B23/stubs/HandoffOverlay.tsx')],
  ['./useHqViewport', path.join(ROOT, 'tests/unit/hq/B23/stubs/useHqViewport.ts')],
]);

export function resolve(specifier, context, nextResolve) {
  // Only requesters INSIDE the Floor module may be remapped: a bare `./` from
  // anywhere else in the tree would otherwise be hijacked.
  const fromFloor = typeof context?.parentURL === 'string' && context.parentURL.endsWith('/hq/Floor.tsx');
  if (fromFloor) {
    const target = MAP.get(specifier);
    if (target) return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
