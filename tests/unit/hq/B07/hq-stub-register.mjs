/**
 * Installs the HQ test resolver hook. Loaded with `--import` so the mapping is
 * in place before the first import of a route module.
 *
 * `module.registerHooks` (synchronous, same-thread) is preferred because the
 * routes reach their imports through tsx's CommonJS path as well as ESM;
 * `module.register` (loader thread, ESM only) is the fallback for older Node.
 */
import { register, registerHooks } from 'node:module';

if (typeof registerHooks === 'function') {
  const hooks = await import('./hq-stub-hooks.mjs');
  registerHooks({
    resolve: (specifier, context, nextResolve) => hooks.resolve(specifier, context, nextResolve),
  });
} else {
  register('./hq-stub-hooks.mjs', import.meta.url);
}
