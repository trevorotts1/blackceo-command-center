/**
 * JEV-009 CC bridge — versioned request/response contract.
 *
 * Single JSON message each way over the core subprocess stdin/stdout.
 * Assignment-read-only: this response type MUST never gain assignment or
 * board-mutation fields. Enforced twice: compile-time (EnsureResponseReadOnly
 * below fails `tsc` if a forbidden key appears) and runtime
 * (assertAssignmentReadOnly walks the parsed payload).
 */

export const DECISION_SCHEMA_VERSION = '1.1.0';

export function schemaMajor(version: string): string {
  return version.split('.')[0];
}

export interface DecisionRequest {
  schemaVersion: typeof DECISION_SCHEMA_VERSION;
  /** Caller-owned config revision. Core echoes it back verbatim. */
  configRevision: string;
  taskId: string;
  taskDescription: string;
  department?: string;
}

export interface DecisionRecommendation {
  roleId: string;
  confidence: number;
  rationale: string;
}

export interface DecisionResponse {
  schemaVersion: string;
  configRevision: string;
  recommendation: DecisionRecommendation;
  evaluatedAt: string;
}

/** Keys that would mutate assignment/board state. Never legal in a response. */
const FORBIDDEN_ASSIGNMENT_KEYS = [
  'assigned_agent_id',
  'assignedAgentId',
  'assignment',
  'board',
  'task_card',
  'taskCard',
  'dispatch',
  'column',
  'status_transition',
  'statusTransition',
  'persona_pin',
  'personaPin',
] as const;

export type ForbiddenAssignmentKey = (typeof FORBIDDEN_ASSIGNMENT_KEYS)[number];

// Compile-time guard: resolves to `unknown` only while DecisionResponse shares
// zero keys with the forbidden set; otherwise `never` and tsc fails below.
// ponytail: structural check only; deep key renames still need the runtime scan.
export type EnsureResponseReadOnly =
  ForbiddenAssignmentKey & keyof DecisionResponse extends never ? unknown : never;

export const _responseReadOnlyGuard: EnsureResponseReadOnly = {};

export function assertAssignmentReadOnly(payload: unknown): void {
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
    } else if (current !== null && typeof current === 'object') {
      for (const [key, value] of Object.entries(current)) {
        if ((FORBIDDEN_ASSIGNMENT_KEYS as readonly string[]).includes(key)) {
          const err = new Error(
            `decision-engine response carries forbidden assignment field: ${key}`,
          );
          (err as { code?: string }).code = 'AssignmentMutation';
          err.name = 'AssignmentMutationError';
          throw err;
        }
        stack.push(value);
      }
    }
  }
}

export function assertRevisionEcho(
  request: DecisionRequest,
  response: DecisionResponse,
): void {
  if (!response.configRevision || response.configRevision !== request.configRevision) {
    const err = new Error(
      `decision-engine config revision mismatch: expected ${JSON.stringify(request.configRevision)}, got ${JSON.stringify(response.configRevision)}`,
    );
    (err as { code?: string }).code = 'IncompatibleRevision';
    err.name = 'IncompatibleRevisionError';
    throw err;
  }
}

export function buildRequest(input: {
  configRevision: string;
  taskId: string;
  taskDescription: string;
  department?: string;
}): DecisionRequest {
  return {
    schemaVersion: DECISION_SCHEMA_VERSION,
    configRevision: input.configRevision,
    taskId: input.taskId,
    taskDescription: input.taskDescription,
    ...(input.department ? { department: input.department } : {}),
  };
}
