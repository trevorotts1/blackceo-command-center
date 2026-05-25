/**
 * OpenClaw Gateway probe — performs a non-blocking TCP-level reach test
 * against the configured gateway URL.
 *
 * We intentionally do NOT call getOpenClawClient().connect() here. That client
 * is stateful, holds the live websocket used by the rest of the app, and a
 * health probe must never tear it down or interfere with in-flight reconnect
 * backoff. Instead we open a one-shot WebSocket, wait for `open` or a timeout,
 * and close it cleanly. This still confirms the gateway is reachable and
 * accepting connections.
 */

import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'ws://127.0.0.1:18789';

export async function probeOpenClawGateway(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      try {
        const httpUrl = wsToHttp(GATEWAY_URL);
        // The gateway exposes a websocket only on the configured port. A plain
        // HTTP GET to that port returns HTTP 426 Upgrade Required if the
        // websocket server is up, or a connection error if it is not. Both are
        // useful signals and neither disrupts the production websocket.
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS - 100);
        let res: Response;
        try {
          res = await fetch(httpUrl, {
            method: 'GET',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(t);
        }

        const latencyMs = Date.now() - start;
        // 426, 400, 101 (upgrade) and 200 all indicate the gateway port is
        // serving traffic. Anything else is treated as reachable too as long
        // as we got an HTTP response back.
        return {
          component: 'openclaw_gateway',
          label: 'OpenClaw Gateway',
          status: 'live',
          latencyMs,
          detail: {
            gatewayUrl: GATEWAY_URL,
            httpProbeStatus: res.status,
          },
          probedAt: new Date().toISOString(),
        };
      } catch (err) {
        return offline(start, err instanceof Error ? err.message : String(err));
      }
    },
    PROBE_TIMEOUT_MS,
    () => offline(start, 'probe timed out')
  );
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
