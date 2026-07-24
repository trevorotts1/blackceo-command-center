/**
 * Interview-gate fallback (U010) — Edge-safe module that lets the middleware
 * check canonical interview-completion state when the signed cookie is absent
 * or expired.
 *
 * The Edge middleware (src/middleware.ts) cannot import better-sqlite3 or fs,
 * so it can't read .workforce-build-state.json directly. This module provides
 * a lightweight HTTP-based fallback: the middleware fetches a thin Node-runtime
 * endpoint that reads the canonical files and returns the completion signal.
 *
 * EDGE-SAFETY: imports NOTHING Node-only (no fs, no crypto, no seam.ts).
 * Only uses the Web-standard `fetch` API available in both Edge and Node.
 */

/** Path of the gate-status Node endpoint (relative to the origin). */
const GATE_STATUS_PATH = '/api/interview/gate-status';

interface GateStatusResponse {
  interviewComplete?: boolean;
  buildCompleted?: boolean;
}

/**
 * Call the Node-runtime gate-status endpoint as a fallback when the signed
 * `mc_interview_complete` cookie is absent, expired, or fails verification.
 *
 * @param origin - the request origin (e.g. "https://example.com") from the
 *   Edge middleware's `request.nextUrl.origin`.
 * @returns true if the canonical files say the interview is complete;
 *   false on any failure (network error, timeout, non-OK status, bad JSON)
 *   so the middleware can fail closed to /interview.
 */
export async function checkInterviewCompleteViaFallback(
  origin: string,
): Promise<boolean> {
  try {
    const url = `${origin}${GATE_STATUS_PATH}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000); // 3s timeout
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const body = (await res.json()) as GateStatusResponse;
    return body.interviewComplete === true || body.buildCompleted === true;
  } catch {
    // Any failure (network, timeout, bad JSON) → fail closed
    return false;
  }
}
