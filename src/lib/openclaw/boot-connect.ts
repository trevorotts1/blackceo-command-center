/**
 * Boot-time Bridge connect with bounded backoff (FXCC-1 / D09).
 *
 * pm2 starts the Command Center before the OpenClaw gateway is ready (about
 * 45 s vs 70 s on a Hostinger/Contabo box). The one boot connect then closes
 * with 1013 "gateway starting", and OpenClawClient only auto-reconnects a
 * socket that was connected before — so the bridge stayed down and the boot
 * agent sync was lost. Retry the boot connect on a bounded backoff until it
 * succeeds (default 10 tries, 2s doubling to a 60s cap, ~5 minutes in total),
 * then let the caller run the agent sync. Once connected, the client's own
 * auto-reconnect takes over.
 */
export interface BootConnectOptions {
  /** Total connect attempts, first one included. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/** Resolves once connected; rejects with the last error after the final attempt. */
export async function connectWithBootRetry(
  client: { connect(): Promise<void> },
  opts: BootConnectOptions = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 10;
  const base = opts.baseDelayMs ?? 2000;
  const cap = opts.maxDelayMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      await client.connect();
      return;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(cap, base * 2 ** (attempt - 1));
      opts.onRetry?.(attempt, delay, err);
      await sleep(delay);
    }
  }
}
