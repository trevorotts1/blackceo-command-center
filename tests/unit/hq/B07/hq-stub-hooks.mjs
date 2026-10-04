/**
 * Synchronous module-resolution hook (Node `module.registerHooks`, which sees
 * BOTH `require` and `import`). It maps the two HQ modules this unit does NOT
 * own — and which do not exist in this worktree yet — onto local test-only
 * stubs, so the routes under test keep their real static imports at the real
 * declared specifiers instead of being refactored for testability.
 *
 * Scope: loaded only by this unit's test file through hq-stub-register.mjs.
 * Product code ships no stub and resolves these names from the real modules.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const MAP = new Map([
  ['@/lib/hq/activity', path.join(ROOT, 'tests/unit/hq/B07/stubs/hq-activity.ts')],
  ['@/lib/hq/context', path.join(ROOT, 'tests/unit/hq/B07/stubs/hq-context.ts')],
]);

export function resolve(specifier, context, nextResolve) {
  const target = MAP.get(specifier);
  if (target) return { url: pathToFileURL(target).href, shortCircuit: true, format: 'module' };
  return nextResolve(specifier, context);
}
