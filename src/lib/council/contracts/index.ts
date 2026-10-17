/**
 * @blackceo/wise-elders-core: canonical contracts package surface (CWE-003).
 *
 * Proposed internal package identity per directive Section 6.2; this is not
 * an assertion that the package exists on npm and it must not be published
 * publicly without authorization.
 *
 * The deterministic core contains no host, UI, network, filesystem, clock,
 * or random imports. Clock and ID generation reach the core only through
 * the Clock and IdSource seams in primitives.ts.
 */

export * from './errors';
export * from './enums';
export * from './primitives';
export * from './canonical-json';
export { sha256Hex } from './sha256';
export * from './schemas';
export * from './state-machine';
export * from './scoring';
export * from './diagnostic-retention';
export * from './golden-vectors';
// ./generate is intentionally not re-exported from this barrel: it is the
// server-side codegen script (its entry point loads node: builtins), and
// this surface is imported by client bundles. Consumers import it directly.
export type * from './types';
