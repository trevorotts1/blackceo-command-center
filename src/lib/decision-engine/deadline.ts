/**
 * JEV-009 CC bridge — caller-stamped root deadline.
 *
 * ONE budget covers the whole preparation path (retrieval, process startup,
 * retries, settlement). The caller stamps it once; every subprocess call
 * reads the same root and takes only what remains. Never reset per call.
 */

export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
};

export interface BridgeDeadline {
  /** Absolute epoch-ms when the whole root budget expires. */
  readonly rootDeadlineMs: number;
  remainingMs(clock?: Clock): number;
  isExpired(clock?: Clock): boolean;
}

class StampedDeadline implements BridgeDeadline {
  readonly rootDeadlineMs: number;
  constructor(rootDeadlineMs: number) {
    this.rootDeadlineMs = rootDeadlineMs;
  }
  remainingMs(clock: Clock = systemClock): number {
    return this.rootDeadlineMs - clock.nowMs();
  }
  isExpired(clock: Clock = systemClock): boolean {
    return this.remainingMs(clock) <= 0;
  }
}

/**
 * Stamp ONE root deadline. `budgetMs` counts from stamp time. Same clock
 * instance should be threaded into every downstream call (tests inject a fake).
 */
export function stampRootDeadline(budgetMs: number, clock: Clock = systemClock): BridgeDeadline {
  return new StampedDeadline(clock.nowMs() + budgetMs);
}
