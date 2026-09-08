/**
 * provider-budget.ts — per-cycle budget reservation with settle (F33, CC half).
 *
 * Same contract as ONB shared-utils/social_execution_policy.py: a step's
 * estimated_cost is RESERVED at claim and SETTLED (deducted, kept as spend)
 * or RELEASED (returned) on completion; a reservation that would exceed the
 * cycle cap is refused, never overspent. Pure bookkeeping — no provider calls.
 */

export interface BudgetLedgerEntry {
  stepId: string;
  amount: number;
  reservedAt: number;
  settled: boolean;
}

export class ProviderBudget {
  private reserved = 0;
  private settledTotal = 0;
  private readonly entries = new Map<string, BudgetLedgerEntry>();

  constructor(readonly cap: number) {}

  get reservedAmount(): number {
    return this.reserved;
  }

  get settledAmount(): number {
    return this.settledTotal;
  }

  get spent(): number {
    return this.settledTotal;
  }

  /** True when cap > 0 and remaining headroom is below `amount`. Settled
   * spend binds the cap CUMULATIVELY (D-F33-03 repair: settle() used to
   * subtract the estimate and free headroom, so the cap never bound across
   * steps); only release() refunds. */
  wouldExceed(amount: number): boolean {
    if (this.cap <= 0) return false; // no cap → unlimited (caller's choice)
    return this.reserved + this.settledTotal + amount > this.cap;
  }

  /** Reserve `amount` for `stepId`. Returns false when over cap or already reserved. */
  reserve(stepId: string, amount: number, now: number): boolean {
    if (this.entries.has(stepId)) return false;
    if (this.wouldExceed(amount)) return false;
    this.entries.set(stepId, { stepId, amount, reservedAt: now, settled: false });
    this.reserved += amount;
    return true;
  }

  /** Settle a reservation: convert reserved cost into permanent spend. */
  settle(stepId: string): boolean {
    const entry = this.entries.get(stepId);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    this.reserved -= entry.amount;
    this.settledTotal += entry.amount;
    return true;
  }

  /** Release a reservation without spending (step failed before side effects). */
  release(stepId: string): boolean {
    const entry = this.entries.get(stepId);
    if (!entry || entry.settled) return false;
    this.entries.delete(stepId);
    this.reserved = Math.max(0, this.reserved - entry.amount);
    return true;
  }

  /** Read one entry (tests + the orchestrator's status view). */
  entry(stepId: string): BudgetLedgerEntry | undefined {
    return this.entries.get(stepId);
  }
}