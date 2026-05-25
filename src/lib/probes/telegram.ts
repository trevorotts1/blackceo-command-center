/**
 * Telegram probe — confirms the configured bot token is valid by calling
 * the public getMe endpoint. Never sends a message.
 *
 * Per the OpenClaw protocol (MEMORY.md) production Telegram sends MUST go
 * through `openclaw message send`. This probe ONLY uses the getMe read-only
 * endpoint as a reachability check, never to deliver content.
 */

import {
  PROBE_TIMEOUT_MS,
  ProbeResult,
  withTimeout,
} from './types';

export async function probeTelegram(): Promise<ProbeResult> {
  const start = Date.now();
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (!token) {
    return {
      component: 'telegram',
      label: 'Telegram',
      status: 'unknown',
      latencyMs: null,
      detail: { configured: false },
      probedAt: new Date().toISOString(),
    };
  }

  return withTimeout<ProbeResult>(
    async () => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS - 100);
        let res: Response;
        try {
          // getMe is a read-only API call. It does NOT bypass the OpenClaw
          // send pipeline; it is the documented health check endpoint.
          res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
            method: 'GET',
            signal: controller.signal,
          });
        } finally {
          clearTimeout(t);
        }

        const latencyMs = Date.now() - start;
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          result?: { username?: string };
          description?: string;
        };

        if (!res.ok || !data.ok) {
          return {
            component: 'telegram',
            label: 'Telegram',
            status: 'degraded',
            latencyMs,
            error: data.description || `HTTP ${res.status}`,
            detail: { configured: true },
            probedAt: new Date().toISOString(),
          };
        }

        return {
          component: 'telegram',
          label: 'Telegram',
          status: 'live',
          latencyMs,
          detail: {
            configured: true,
            botUsername: data.result?.username || null,
          },
          probedAt: new Date().toISOString(),
        };
      } catch (err) {
        return {
          component: 'telegram',
          label: 'Telegram',
          status: 'offline',
          latencyMs: Date.now() - start,
          error: err instanceof Error ? err.message : String(err),
          detail: { configured: true },
          probedAt: new Date().toISOString(),
        };
      }
    },
    PROBE_TIMEOUT_MS,
    () => ({
      component: 'telegram',
      label: 'Telegram',
      status: 'offline',
      latencyMs: Date.now() - start,
      error: 'probe timed out',
      detail: { configured: true },
      probedAt: new Date().toISOString(),
    })
  );
}
