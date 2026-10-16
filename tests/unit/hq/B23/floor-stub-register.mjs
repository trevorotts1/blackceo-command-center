/**
 * Installs B23's test resolver hook. Loaded with `--import` so the mapping is in
 * place before the first import of `Floor.tsx`. Same mechanism B07 uses for its
 * two un-landed neighbors.
 */
import { register, registerHooks } from 'node:module';

if (typeof registerHooks === 'function') {
  const hooks = await import('./floor-stub-hooks.mjs');
  registerHooks({
    resolve: (specifier, context, nextResolve) => hooks.resolve(specifier, context, nextResolve),
  });
} else {
  register('./floor-stub-hooks.mjs', import.meta.url);
}
