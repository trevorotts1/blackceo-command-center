/**
 * ts-resolve-hook.mjs — zero-dependency ESM resolve hook (P3-8 local run mode).
 *
 * Lets a plain `node --experimental-strip-types` process import the app's real
 * TypeScript modules with NO node_modules / bundler present, by:
 *   • mapping the "@/…" path alias (tsconfig paths) to <repo>/src/…, and
 *   • retrying an extensionless relative import against .ts / .tsx / index.ts.
 *
 * This is used ONLY by the local, dependency-free run of the prove-zhe web e2e
 * (see package.json `test:prove-zhe-web:local`). In CI the same harness runs
 * under `tsx` (deps installed), which resolves these natively — the hook is a
 * no-op there because it is not registered.
 *
 * It affects module RESOLUTION only; the actual TypeScript is compiled by Node's
 * built-in `--experimental-strip-types`. It touches no filesystem state.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

// <repo>/src — this file lives at <repo>/tests/e2e/, so src is two levels up.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

export async function resolve(specifier, context, nextResolve) {
  let spec = specifier;
  if (spec.startsWith('@/')) {
    spec = pathToFileURL(path.join(SRC, spec.slice(2))).href;
  }
  try {
    return await nextResolve(spec, context);
  } catch (err) {
    const base = spec.startsWith('file:')
      ? fileURLToPath(spec)
      : spec.startsWith('.') && context.parentURL
        ? path.resolve(path.dirname(fileURLToPath(context.parentURL)), spec)
        : null;
    if (base) {
      for (const cand of [base + '.ts', base + '.tsx', path.join(base, 'index.ts')]) {
        if (existsSync(cand)) return nextResolve(pathToFileURL(cand).href, context);
      }
    }
    throw err;
  }
}
