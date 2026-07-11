/**
 * presentations-cert-gate.ts — FIX C: enforce the deck no-skip proof at the board.
 *
 * The onboarding-side prove-deck.py emits a PROCESS-CERTIFICATE (a sha256) for a
 * deck run. This pure decision function is what makes that proof ENFORCED: a
 * presentations task can reach its terminal state (`done`) ONLY with a matching
 * `process_certificate_sha`. Extracted from the PATCH /api/tasks/[id] route so
 * it is unit-testable without spinning the full Next.js handler.
 *
 * CONTRACT (single-valued, self-consistent): a completed deck closes via task
 * `status='done'` + a matching `process_certificate_sha`. `'delivered'` is a
 * NOTE the onboarding caller may record, NOT a task status — it is deliberately
 * NOT a terminal status here, because it is NOT a member of the authoritative
 * TaskStatus enum in src/lib/validation.ts (a PATCH of status='delivered' is
 * rejected with a 400 by the schema before it ever reaches this gate). The
 * terminal-status set below MUST stay a SUBSET of that enum — enforced by
 * tests/unit/presentations-cert-contract.test.ts so no orphan can recur.
 *
 * Decision matrix (only when the task is presentations AND moving to a terminal
 * state it is not already in):
 *   • no stored cert AND none presented        → REQUIRED  (must run prove-deck.py)
 *   • a cert already registered on the task     → the mover MUST present the SAME
 *                                                 sha (anti-spoof) → else MISMATCH
 *                                                 / REQUIRED
 *   • a valid sha presented, none stored        → PASS, and persist it as the
 *                                                 certificate of record
 */

import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

/**
 * The terminal status(es) a presentations task may transition INTO under the
 * no-skip proof rule. SINGLE-VALUED by contract: a completed deck closes via
 * `status='done'` + a matching `process_certificate_sha`. This set MUST remain
 * a SUBSET of the authoritative TaskStatus enum in src/lib/validation.ts — the
 * subset invariant is asserted by tests/unit/presentations-cert-contract.test.ts
 * so an orphan status (e.g. the removed `'delivered'`, which the schema rejects
 * with a 400) can never recur and silently strand a card off any terminal state.
 * Exported for that contract test.
 */
export const PRESENTATIONS_TERMINAL_STATUSES = new Set(['done']);

export interface PresentationsGateInput {
  /** task.department (canonical or label) — canonicalized internally. */
  department: string | null | undefined;
  /** the task's CURRENT status. */
  currentStatus: string | null | undefined;
  /** the status the PATCH is trying to set. */
  targetStatus: string | null | undefined;
  /** the cert already registered on the task (tasks.process_certificate_sha). */
  storedCert: string | null | undefined;
  /** the cert presented in the PATCH body. */
  providedCert: string | null | undefined;
}

export interface PresentationsGateResult {
  /** true when this is a presentations terminal transition the gate governs. */
  applies: boolean;
  /** true when the transition is allowed. */
  ok: boolean;
  code?: 'process_certificate_required' | 'process_certificate_mismatch';
  error?: string;
  remediation?: string;
  /** a newly-presented cert to persist on the task when ok (null = nothing new). */
  persistCert?: string | null;
}

function normCert(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return t.length ? t : null;
}

/**
 * Decide whether a status change is allowed for a presentations task under the
 * no-skip proof rule. Pure: no I/O, no DB — the route maps the result to HTTP.
 */
export function evaluatePresentationsDoneGate(
  input: PresentationsGateInput,
): PresentationsGateResult {
  const target = (input.targetStatus ?? '').toString();
  const isTerminal = PRESENTATIONS_TERMINAL_STATUSES.has(target);
  const changing = input.currentStatus !== target;
  if (!isTerminal || !changing) return { applies: false, ok: true };

  const deptCanon =
    canonicalDeptSlug(input.department || '') || (input.department ?? '');
  if (deptCanon !== 'presentations') return { applies: false, ok: true };

  const stored = normCert(input.storedCert);
  const provided = normCert(input.providedCert);

  const remediation =
    `Generate the deck proof with prove-deck.py (it writes PROCESS-CERTIFICATE.json), then ` +
    `PATCH this task with {"status":"${target}","process_certificate_sha":"<sha256>"}. ` +
    `A presentations deck cannot be marked ${target} without its no-skip proof.`;

  if (!stored && !provided) {
    return {
      applies: true,
      ok: false,
      code: 'process_certificate_required',
      error: `Forbidden: a presentations task requires a process_certificate_sha to be marked ${target}`,
      remediation,
    };
  }
  if (stored && provided && provided !== stored) {
    return {
      applies: true,
      ok: false,
      code: 'process_certificate_mismatch',
      error: 'Forbidden: process_certificate_sha does not match the certificate registered for this deck',
      remediation,
    };
  }
  if (stored && !provided) {
    return {
      applies: true,
      ok: false,
      code: 'process_certificate_required',
      error: `Forbidden: present the registered process_certificate_sha to mark this deck ${target}`,
      remediation,
    };
  }

  // PASS. Persist the certificate of record when a new one was presented.
  return {
    applies: true,
    ok: true,
    persistCert: provided && provided !== stored ? provided : null,
  };
}
