/**
 * Authoritative 401 counter — NODE RUNTIME ONLY (FLEET-FIX 2.3 / AUD-71).
 *
 * Written by the sink route `src/app/api/internal/auth-rejected/route.ts` (the
 * rewrite target the Edge middleware sends every credential-failure 401 to) and
 * read by `probeUnauthorized401()` in `unauthorized-401-probe.ts`, which
 * `runAllProbes()` publishes on `/api/system/status`. Both of those are Node
 * routes in the same `next start` process, so this state is genuinely shared
 * between the producer and the consumer. See `unauthorized-401-contract.ts` for
 * why the counter cannot live in the middleware's own (Edge) module scope.
 *
 * The slot is hung off `globalThis` behind a Symbol rather than kept in plain
 * module scope. Next.js compiles each route into its own server bundle, so two
 * Node routes importing the same module are not guaranteed to share a module
 * instance; `globalThis` in a single Node process unconditionally is. (Same
 * reasoning as the well-known `globalThis.prisma` singleton pattern.)
 *
 * Lifetime: in-memory, per process. A restart zeroes it — exactly like the
 * sibling `cloudflare-access-probe.ts` observation map. The probe's ProbeResult
 * IS persisted to `system_status_snapshots` by `persistSnapshot()` on every
 * run, so the historical series survives even though the live counter does not.
 */

import type { CredentialFailureReason, Unauthorized401Event } from './unauthorized-401-contract';
import { CREDENTIAL_FAILURE_REASONS } from './unauthorized-401-contract';

/**
 * Recent-event window. A credential failure inside this window is a LIVE
 * problem (something is being turned away right now — the write-back trap
 * AUD-71 exists to surface); older ones are history. Mirrors the windowed
 * design of cloudflare-access-probe.ts, so the signal self-clears instead of
 * pinning the status pill forever after one stray scanner request.
 */
export const UNAUTHORIZED_401_WINDOW_MS = 5 * 60 * 1000;

/** Cap on retained recent timestamps — bounds memory under a 401 flood. */
const MAX_RECENT = 500;

export interface Unauthorized401Counters {
  /** Lifetime credential-failure 401s counted in this process. */
  total: number;
  /** Lifetime breakdown per discriminated reason. */
  byReason: Record<CredentialFailureReason, number>;
  /** Credential failures observed within UNAUTHORIZED_401_WINDOW_MS. */
  recentCount: number;
  /** The most recent credential-failure 401, or null if none. */
  lastEvent: Unauthorized401Event | null;
}

interface Unauthorized401State {
  total: number;
  byReason: Record<CredentialFailureReason, number>;
  recentTimestamps: number[];
  lastEvent: Unauthorized401Event | null;
}

const STATE_KEY = Symbol.for('blackceo.cc.unauthorized401.v1');

type GlobalWithState = typeof globalThis & {
  [STATE_KEY]?: Unauthorized401State;
};

function emptyByReason(): Record<CredentialFailureReason, number> {
  const out = {} as Record<CredentialFailureReason, number>;
  for (const r of CREDENTIAL_FAILURE_REASONS) out[r] = 0;
  return out;
}

function state(): Unauthorized401State {
  const g = globalThis as GlobalWithState;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      total: 0,
      byReason: emptyByReason(),
      recentTimestamps: [],
      lastEvent: null,
    };
  }
  return g[STATE_KEY]!;
}

/**
 * Record ONE credential-failure 401 and return the new authoritative total.
 * Called only by the sink route. Misconfiguration rejections never get here —
 * the middleware filters on signal type before rewriting (see the contract
 * module) and the route re-validates the reason, so an unknown/forged reason is
 * rejected rather than counted.
 */
export function recordUnauthorized401(event: Unauthorized401Event): number {
  const s = state();
  const now = Date.parse(event.ts);
  const at = Number.isFinite(now) ? now : Date.now();

  s.total += 1;
  s.byReason[event.reason] = (s.byReason[event.reason] ?? 0) + 1;
  s.lastEvent = event;

  s.recentTimestamps.push(at);
  if (s.recentTimestamps.length > MAX_RECENT) {
    s.recentTimestamps.splice(0, s.recentTimestamps.length - MAX_RECENT);
  }

  return s.total;
}

/** Snapshot for the probe. Prunes the recent window as a side effect. */
export function readUnauthorized401Counters(now = Date.now()): Unauthorized401Counters {
  const s = state();
  const cutoff = now - UNAUTHORIZED_401_WINDOW_MS;
  s.recentTimestamps = s.recentTimestamps.filter((t) => t >= cutoff);

  return {
    total: s.total,
    byReason: { ...s.byReason },
    recentCount: s.recentTimestamps.length,
    lastEvent: s.lastEvent,
  };
}

/** Test-only: zero the store. */
export function __resetUnauthorized401Store(): void {
  const g = globalThis as GlobalWithState;
  delete g[STATE_KEY];
}
