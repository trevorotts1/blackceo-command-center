/**
 * ts-register.mjs — registers ts-resolve-hook.mjs as an ESM loader hook.
 *
 * Passed via `--import ./tests/e2e/ts-register.mjs` for the dependency-free local
 * run of the prove-zhe web e2e. Resolve hooks must be registered through
 * module.register (they run on a dedicated thread), which `--import` alone does
 * not do. Not used in CI (tsx resolves natively).
 */
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);
