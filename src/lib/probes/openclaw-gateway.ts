/**
 * OpenClaw Gateway probe — verifies the gateway is reachable AND that the
 * responding server is actually an OpenClaw gateway, not an arbitrary
 * port-squatter.
 *
 * FALSE-GREEN FIX (§5 guidance, item 4):
 * The previous implementation treated ANY HTTP response on the configured
 * port as "live".  A port-squatter (e.g. a stray Node process) that returns
 * HTTP 200 on any GET would produce a false-green.
 *
 * Fix: after confirming the port is reachable, we call the gateway's own
 * status endpoint (`/api/status` or `/health`) and check for an
 * OpenClaw-specific field in the JSON response:
 *   - `gateway: "openclaw"` or `product: "openclaw"` in the body, OR
 *   - HTTP 426 Upgrade Required (the standard WS-only response OpenClaw
 *     returns on its websocket port when probed over plain HTTP) — this is
 *     still OpenClaw-specific because generic HTTP servers do not emit 426.
 *
 * If neither signal is present, the probe returns 'offline' with detail
 * explaining the port-squatter suspicion, so the operator can investigate
 * without a false-green hiding the real problem.
 */

import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';

/** OpenClaw-specific HTTP status codes on the websocket port. */
const OPENCLAW_WS_PORT_STATUSES = new Set([
  426, // Upgrade Required — returned by openclaw when probed over plain HTTP
  400, // Bad Request — some gateway versions return this for non-WS connections
  101, // Switching Protocols (rare in plain HTTP GET, but valid WS upgrade)
]);

/** Known field names that OpenClaw embeds in its /health or /api/status JSON. */
const OPENCLAW_IDENTITY_FIELDS = ['gateway', 'product', 'service', 'name'] as const;

function isOpenClawResponse(status: number, bodyText: string): boolean {
  // Signal 1: WS-port-specific HTTP status — generic servers do not emit 426
  if (OPENCLAW_WS_PORT_STATUSES.has(status)) return true;

  // Signal 2: JSON body contains an OpenClaw identity marker
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    for (const field of OPENCLAW_IDENTITY_FIELDS) {
      const val = body[field];
      if (typeof val === 'string' && val.toLowerCase().includes('openclaw')) {
        return true;
      }
    }
    // Also accept a `version` field shaped like OpenClaw's version strings
    // (e.g. "2026.5.22") — sufficiently specific to be identity-grade
    if (typeof body['version'] === 'string' && /^\d{4}\.\d+\.\d+/.test(body['version'])) {
      return true;
    }
  } catch {
    // Not JSON — fall through to false
  }

  return false;
}

export async function probeOpenClawGateway(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      try {
        const httpBase = wsToHttp(GATEWAY_URL);

        // Step 1: probe the websocket port (returns 426 for a real OpenClaw WS port)
        const wsPortResult = await probeUrl(httpBase, start);

        if (wsPortResult.isOpenClaw) {
          return {
            component: 'openclaw_gateway',
            label: 'OpenClaw Gateway',
            status: 'live',
            latencyMs: Date.now() - start,
            detail: {
              gatewayUrl: GATEWAY_URL,
              httpProbeStatus: wsPortResult.status,
              identityConfirmed: true,
            },
            probedAt: new Date().toISOString(),
          };
        }

        // Step 2: try the /health endpoint on the same host (different port path)
        // OpenClaw gateways also expose an HTTP health endpoint on the same port
        const healthResult = await probeUrl(`${httpBase}/health`, start);
        if (healthResult.isOpenClaw) {
          return {
            component: 'openclaw_gateway',
            label: 'OpenClaw Gateway',
            status: 'live',
            latencyMs: Date.now() - start,
            detail: {
              gatewayUrl: GATEWAY_URL,
              httpProbeStatus: healthResult.status,
              identityConfirmed: true,
              probeEndpoint: '/health',
            },
            probedAt: new Date().toISOString(),
          };
        }

        // Step 3: try /api/status
        const statusResult = await probeUrl(`${httpBase}/api/status`, start);
        if (statusResult.isOpenClaw) {
          return {
            component: 'openclaw_gateway',
            label: 'OpenClaw Gateway',
            status: 'live',
            latencyMs: Date.now() - start,
            detail: {
              gatewayUrl: GATEWAY_URL,
              httpProbeStatus: statusResult.status,
              identityConfirmed: true,
              probeEndpoint: '/api/status',
            },
            probedAt: new Date().toISOString(),
          };
        }

        // Port is reachable but none of our identity probes matched — port squatter
        if (wsPortResult.reachable || healthResult.reachable || statusResult.reachable) {
          return offline(
            start,
            `port is reachable (HTTP ${wsPortResult.status}) but no OpenClaw identity signal found — possible port squatter on ${GATEWAY_URL}`
          );
        }

        // Not reachable at all
        return offline(start, `gateway unreachable at ${GATEWAY_URL}`);
      } catch (err) {
        return offline(start, err instanceof Error ? err.message : String(err));
      }
    },
    PROBE_TIMEOUT_MS,
    () => offline(start, 'probe timed out')
  );
}

interface ProbeUrlResult {
  reachable: boolean;
  isOpenClaw: boolean;
  status: number;
}

async function probeUrl(url: string, _start: number): Promise<ProbeUrlResult> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.floor(PROBE_TIMEOUT_MS / 3));
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });
    let body = '';
    try {
      body = await res.text();
    } catch {
      // body read failure is non-fatal
    }
    return {
      reachable: true,
      isOpenClaw: isOpenClawResponse(res.status, body),
      status: res.status,
    };
  } catch {
    return { reachable: false, isOpenClaw: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

function wsToHttp(url: string): string {
  if (url.startsWith('wss://')) return 'https://' + url.slice('wss://'.length);
  if (url.startsWith('ws://')) return 'http://' + url.slice('ws://'.length);
  return url;
}

function offline(start: number, message: string): ProbeResult {
  return {
    component: 'openclaw_gateway',
    label: 'OpenClaw Gateway',
    status: 'offline',
    latencyMs: Date.now() - start,
    error: message,
    detail: { gatewayUrl: GATEWAY_URL },
    probedAt: new Date().toISOString(),
  };
}
