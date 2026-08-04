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

/** Path of the gate-status Node endpoint (appended to the internal loopback URL). */
const GATE_STATUS_PATH = '/api/interview/gate-status';

interface GateStatusResponse {
  interviewComplete?: boolean;
  buildCompleted?: boolean;
}

/**
 * Call the Node-runtime gate-status endpoint as a fallback when the signed
 * `mc_interview_complete` cookie is absent, expired, or fails verification.
 *
 * ROUTING: this is an internal same-process call. It MUST use the internal
 * loopback URL (http://127.0.0.1:PORT), NOT the public request origin.
 * Behind a Cloudflare tunnel, `request.nextUrl.origin` resolves to
 * `https://0.0.0.0:PORT` (or the https public host), and fetching that would
 * attempt a TLS handshake against the plain-HTTP Next server — failing in
 * milliseconds and fail-closing the middleware even when the interview is
 * complete. 127.0.0.1 is used over `localhost` to avoid any IPv6 `::1`
 * ambiguity.
 *
 * @returns true if the canonical files say the interview is complete;
 *   false on any failure (network error, timeout, non-OK status, bad JSON)
 *   so the middleware can fail closed to /interview.
 */
export async function checkInterviewCompleteViaFallback(): Promise<boolean> {
  try {
    const port = process.env.CC_PORT || process.env.PORT || '4000';
    const url = `http://127.0.0.1:${port}${GATE_STATUS_PATH}`;
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
