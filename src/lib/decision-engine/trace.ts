/**
 * JEV-031 D31 runtime trace capture/assertion harness (spec section 16.5).
 *
 * Captures the task ID -> decision -> dispatch -> executor -> artifact ->
 * review -> board chain as ONE trace record and asserts its internal
 * consistency OFFLINE against isolated fixtures labelled simulated.
 *
 * - Pure functions. No DB, no network, no provider calls (C8-clean).
 * - Live proof is ALWAYS reported NOT_RUN by liveProofStatus(): real
 *   authorized runtime access (D25-D27, D30 gates) is pending, so this
 *   harness proves the ASSERTION LOGIC, never a live run.
 * - Hash mismatch (A39) is surfaced as a reported mismatch, never hidden.
 * - Owner-direct reroute (spec section 3 exception, A16/A64) gets its own
 *   explicit path: executorKind 'owner-direct' must carry the named target
 *   and bypass reason; a reroute that rewrites history fails.
 */

export type ExecutorKind = 'owner-direct' | 'delegated';

/**
 * One captured runtime chain. All IDs/hashes are caller-supplied strings;
 * this module never fetches them. Fixtures MUST be labelled simulated.
 */
export interface RuntimeTrace {
  /** Fixture provenance label. Live runs are rejected until authorized. */
  provenance: 'simulated';
  taskId: string;
  /** Committed decision revision + content hash (spec 10.3 single-writer). */
  decisionRevision: string;
  decisionHash: string;
  /** Snapshot the dispatcher handed the worker; must equal decision (10.3). */
  dispatchRevision: string;
  dispatchHash: string;
  executorId: string;
  executorKind: ExecutorKind;
  /** Owner-named target; required when executorKind is owner-direct. */
  ownerDirectTarget?: string | null;
  /** Reason recorded at reroute time (must name target for owner-direct). */
  rerouteReason?: string | null;
  /** Bundle identifiers the worker REPORTED using (11.2). */
  workerUsedBundleId?: string | null;
  workerUsedHash?: string | null;
  artifactId?: string | null;
  /** Independent review verdict; identity match alone is not proof (11.2). */
  reviewVerdict?: 'pass' | 'fail' | null;
  /** Board-facing assigned id + hash for mismatch check (A39). */
  boardAssignedId?: string | null;
  boardHash?: string | null;
}

export interface TraceMismatch {
  field: string;
  expected: string | null;
  actual: string | null;
}

export interface TraceAssertion {
  pass: boolean;
  failures: string[];
  /** Detected inconsistencies the caller must surface, not hide (A39). */
  mismatches: TraceMismatch[];
}

function fail(out: TraceAssertion, msg: string): void {
  out.pass = false;
  out.failures.push(msg);
}

/**
 * Assert one captured chain. Returns pass/fail plus surfaced mismatches.
 * Never throws for bad data: bad data is an ordinary failed assertion.
 */
export function assertTraceChain(trace: RuntimeTrace): TraceAssertion {
  const out: TraceAssertion = { pass: true, failures: [], mismatches: [] };
  if (trace.provenance !== 'simulated') {
    fail(out, 'provenance must be "simulated" until live access authorized');
  }
  if (!trace.taskId || !trace.taskId.trim()) fail(out, 'taskId empty');
  if (!trace.decisionRevision || !trace.decisionRevision.trim()) {
    fail(out, 'decisionRevision empty: no committed decision captured');
  }
  if (!trace.decisionHash || !trace.decisionHash.trim()) {
    fail(out, 'decisionHash empty');
  }
  // Spec 10.3: execution snapshot immutable; dispatch must carry the SAME revision.
  if (trace.dispatchRevision !== trace.decisionRevision) {
    out.mismatches.push({
      field: 'dispatchRevision',
      expected: trace.decisionRevision,
      actual: trace.dispatchRevision,
    });
    fail(out, 'dispatch snapshot revision differs from committed decision (history rewrite)');
  }
  if (trace.dispatchHash !== trace.decisionHash) {
    out.mismatches.push({
      field: 'dispatchHash',
      expected: trace.decisionHash,
      actual: trace.dispatchHash,
    });
    fail(out, 'dispatch snapshot hash differs from committed decision hash');
  }
  // Owner-direct reroute: explicit path with named target, no rescoring (A16/A64).
  if (trace.executorKind === 'owner-direct') {
    if (!trace.ownerDirectTarget || !trace.ownerDirectTarget.trim()) {
      fail(out, 'owner-direct reroute without named ownerDirectTarget');
    } else if (!trace.rerouteReason || !trace.rerouteReason.includes(trace.ownerDirectTarget.trim())) {
      fail(out, 'owner-direct reroute reason must name the pinned target');
    }
  }
  if (!trace.executorId || !trace.executorId.trim()) fail(out, 'executorId empty');
  // A39: board-assigned vs worker-used hash agreement is CHECKED and reported.
  if (
    trace.boardHash != null &&
    trace.workerUsedHash != null &&
    trace.boardHash !== trace.workerUsedHash
  ) {
    out.mismatches.push({
      field: 'workerUsedHash vs boardHash',
      expected: trace.boardHash,
      actual: trace.workerUsedHash,
    });
  }
  // 11.2: self-reported "followed" alone is not adherence proof; review required.
  if (trace.artifactId && trace.reviewVerdict == null) {
    fail(out, 'artifact present without independent review verdict');
  }
  return out;
}

export interface LiveProofGate {
  status: 'NOT_RUN';
  /** Concrete missing access / pending dependency behind the gate. */
  missing: string[];
}

/**
 * Live proof gate (spec 16.5). Always NOT_RUN until the owner authorizes a
 * representative runtime AND D25-D27 + D30 land. Callers report this object
 * verbatim instead of fictional success.
 */
export function liveProofStatus(): LiveProofGate {
  return {
    status: 'NOT_RUN',
    missing: [
      'owner authorization for a representative live installation (spec 16.5)',
      'D25 board-truth + D26 adherence-review + D27 installer-compat landings',
      'D30 baseline/shadow evaluation artifacts',
      'no live client task, database, or provider call performed by this harness',
    ],
  };
}

/** Minimal valid simulated fixture; override fields per case. */
export function makeSimulatedTrace(overrides: Partial<RuntimeTrace> = {}): RuntimeTrace {
  return {
    provenance: 'simulated',
    taskId: 'sim-task-001',
    decisionRevision: 'rev-7',
    decisionHash: 'sha256:dec0',
    dispatchRevision: 'rev-7',
    dispatchHash: 'sha256:dec0',
    executorId: 'agent-42',
    executorKind: 'delegated',
    workerUsedBundleId: 'bundle-9',
    workerUsedHash: 'sha256:dec0',
    artifactId: 'artifact-3',
    reviewVerdict: 'pass',
    boardAssignedId: 'agent-42',
    boardHash: 'sha256:dec0',
    ...overrides,
  };
}
