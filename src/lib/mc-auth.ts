/**
 * Mission Control task-API write-back auth (CANONICAL).
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 * Department agents finish work and write results BACK to the task API:
 *   POST  /api/tasks/:id/activities
 *   POST  /api/tasks/:id/deliverables
 *   PATCH /api/tasks/:id                 (status → review)
 *   POST  /api/tasks/:id/status          (Skill-6 / board producers)
 *
 * `src/middleware.ts` Gate B requires an `Authorization: Bearer <MC_API_TOKEN>`
 * on every EXTERNAL (non-same-origin) `/api/*` caller — anything without a
 * matching same-origin Origin/Referer. A curling dept agent (no Origin header)
 * and a CC server-side `fetch()` to the loopback are BOTH "external", so BOTH
 * must present the bearer or the write-back is rejected 401 `{"error":
 * "Unauthorized"}`. When the write-back 401s, the finished task never advances
 * to `review`; it freezes `in_progress` until the stuck-in-progress sweep blocks
 * it — the "carded-but-trapped" failure. The gateway token
 * (`OPENCLAW_GATEWAY_TOKEN`) is the WRONG credential for this API (it is the
 * OpenClaw bridge handshake token) and also 401s.
 *
 * This module is the ONE canonical place that:
 *   1. builds those write-back headers from MC_API_TOKEN (never re-invented or
 *      omitted per-caller), and
 *   2. provides the ONE fail-loud dispatch-time guard so a missing/wrong token
 *      is surfaced BEFORE work is dispatched, never silently after it is done.
 *
 * It NEVER logs, returns, or embeds the token value in any field other than the
 * Authorization header it hands directly to fetch().
 */

/** Canonical env var name for the task-API bearer token. */
export const MC_API_TOKEN_ENV = 'MC_API_TOKEN';

/** The configured task-API bearer token, trimmed, or undefined when unset/blank. */
export function getMcApiToken(): string | undefined {
  const raw = process.env.MC_API_TOKEN;
  const t = typeof raw === 'string' ? raw.trim() : '';
  return t ? t : undefined;
}

/**
 * Is the deployment in the dev/test-only insecure-open bridge, where external
 * `/api/*` writes pass WITHOUT a token? Mirrors `src/middleware.ts`
 * `ALLOW_INSECURE_OPEN_API` EXACTLY (hard-gated off in production).
 */
export function isInsecureOpenApi(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_INSECURE_OPEN_API === 'true'
  );
}

/**
 * Canonical write-back auth headers.
 * `{ Authorization: 'Bearer <token>' }` when MC_API_TOKEN is set, else `{}`
 * (dev / same-origin / insecure-open). Spread into a fetch() headers object.
 */
export function missionControlAuthHeaders(): Record<string, string> {
  const token = getMcApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export interface WriteAuthCheck {
  ok: boolean;
  /** Operator-facing reason (never contains the token value). */
  reason: string;
}

/**
 * FAIL-LOUD dispatch guard. Answers "can a dispatched agent authenticate its
 * write-backs?" — call it BEFORE flipping a task to `in_progress`.
 *
 * Returns `ok:false` with a clear, operator-facing reason when MC_API_TOKEN is
 * missing on a box that will reject the agent's external write-back, so the
 * caller BLOCKS the task loudly at dispatch instead of shipping work that
 * silently 401s after it is finished. On a dev box in insecure-open mode
 * (external writes pass without a token) it returns `ok:true` with a note.
 */
export function checkTaskWriteAuth(): WriteAuthCheck {
  if (getMcApiToken()) {
    return { ok: true, reason: 'MC_API_TOKEN present — agent write-backs will authenticate.' };
  }
  if (isInsecureOpenApi()) {
    return {
      ok: true,
      reason:
        'MC_API_TOKEN is unset but ALLOW_INSECURE_OPEN_API=true (dev/test open mode) — ' +
        'external /api writes pass without a token. NOT a production posture.',
    };
  }
  return {
    ok: false,
    reason:
      'MC_API_TOKEN is not set. A dispatched agent cannot authenticate its task ' +
      'write-backs (POST /api/tasks/:id/activities, /deliverables, PATCH status), so ' +
      'every write-back would 401 and the finished task would freeze in_progress. ' +
      'Provision MC_API_TOKEN in the Command Center AND the dept-agent runtime env ' +
      'before dispatching (or set ALLOW_INSECURE_OPEN_API=true on a dev box).',
  };
}

/** True for the statuses the task API returns on an AUTH rejection. */
export function isAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * Thrown by server-side write-back helpers when the task API rejects the call —
 * surfaced LOUDLY instead of the old silent `console.error` swallow, so the
 * misconfiguration (a missing/wrong MC_API_TOKEN) is visible at the moment of
 * the bad write rather than 45 minutes later when the stuck sweep blocks the
 * finished task.
 */
export class MissionControlWriteError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(status: number, endpoint: string, body: string) {
    const authHint = isAuthFailureStatus(status)
      ? ' This is an AUTH failure — the caller did not present a valid ' +
        'Authorization: Bearer $MC_API_TOKEN (see src/lib/mc-auth.ts). Verify ' +
        'MC_API_TOKEN is set in this process AND matches the Command Center; do ' +
        'NOT use OPENCLAW_GATEWAY_TOKEN (bridge token, always 401s this API).'
      : '';
    super(`Mission Control write-back to ${endpoint} failed ${status}: ${body}.${authHint}`);
    this.name = 'MissionControlWriteError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

/**
 * The exact write-back instruction block handed to a dispatched agent, telling
 * it to authenticate every task-API call with the canonical bearer. Shared by
 * BOTH dispatch paths (src/app/api/tasks/[id]/dispatch/route.ts and
 * src/lib/task-dispatcher.ts) so the two stay in lockstep and neither can drift
 * back to the no-auth form that caused the 401 defect.
 *
 * @param missionControlUrl base URL, e.g. http://localhost:4000
 * @param taskId            the task id
 * @param deliverableType   'file' (manual dispatch) | 'artifact' (fast-loop)
 * @param outputPathHint    example deliverable path shown in the body
 */
export function renderWriteBackInstructions(
  missionControlUrl: string,
  taskId: string,
  deliverableType: 'file' | 'artifact',
  outputPathHint: string,
): string {
  return `**IMPORTANT:** After completing work, you MUST call these APIs. Every
call MUST authenticate with the Command Center bearer token from your
environment — send the header \`-H "Authorization: Bearer $MC_API_TOKEN"\` on
EVERY request below (it is the same token the box was provisioned with; do NOT
use OPENCLAW_GATEWAY_TOKEN — that is the bridge token and will 401). Omitting
the header returns 401 Unauthorized and your finished work never leaves
in_progress.
1. Log activity: POST ${missionControlUrl}/api/tasks/${taskId}/activities
   Header: Authorization: Bearer $MC_API_TOKEN
   Body: {"activity_type": "completed", "message": "Description of what was done"}
2. Register deliverable: POST ${missionControlUrl}/api/tasks/${taskId}/deliverables
   Header: Authorization: Bearer $MC_API_TOKEN
   Body: {"deliverable_type": "${deliverableType}", "title": "File name", "path": "${outputPathHint}"}
3. Update status: PATCH ${missionControlUrl}/api/tasks/${taskId}
   Header: Authorization: Bearer $MC_API_TOKEN
   Body: {"status": "review"}

If any call returns 401/403, STOP and report a BLOCKED status with the reason
"task-API write-back auth failed (MC_API_TOKEN)" instead of silently finishing —
the work is not delivered until these calls return 2xx.`;
}
