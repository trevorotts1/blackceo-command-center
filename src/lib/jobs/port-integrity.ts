/**
 * Port-integrity self-check — P1-02 Unit B, item 5.
 *
 * Registered in scheduler.ts as a daily job. Belt-and-suspenders alongside
 * the launch-time ACK guard in `scripts/cc-start.sh`: that guard stops a NEW
 * drift from ever booting, but does nothing for a process that is ALREADY
 * running and drifted after boot — e.g. someone bypassed cc-start.sh entirely
 * and ran `next start -p 3000` directly (the residual bypass risk P1-02(b).3
 * names explicitly: "nothing physically stops a human/agent invoking `next
 * start -p 3000` directly").
 *
 * Two independent assertions, both surfaced through the same alert:
 *   1. The server's ACTUAL listen port is the canonical 4000. "Actual" means
 *      empirically confirmed via a live self-probe of our own /api/health —
 *      not just trusting the env var, which could be set without the process
 *      actually being bound there.
 *   2. WHEN the Cloudflare tunnel ingress is readable on this box (API
 *      credentials + this box's hostname are configured — never guessed, per
 *      the P1-05 lesson: an unprovisioned check must say so, not fabricate a
 *      result), the ingress rule for this box's CC hostname targets :4000.
 *
 * On ANY mismatch: notifySystem() — SYSTEM audience only (MOVE-IN-SILENCE).
 * This is an operator concern; it must NEVER reach the client's Telegram.
 */

import { notifySystem } from '@/lib/notify';

/** The one canonical CC port, fleet-wide (P1-02). */
export const CANONICAL_CC_PORT = 4000;

export interface PortIntegrityDeps {
  /** Injectable for tests; defaults to the real notifySystem(). */
  notify?: typeof notifySystem;
}

export interface PortIntegrityResult {
  listenPort: number | null;
  listenPortOk: boolean;
  listenProbeError: string | null;
  tunnelChecked: boolean;
  tunnelOk: boolean | null;
  tunnelDetail: string | null;
  alerted: boolean;
}

/**
 * Resolve the port this process believes it is bound to. cc-start.sh always
 * exports both CC_PORT and PORT to the SAME value before `exec`-ing
 * `next start -p $CC_PORT`, so either env var reflects the real bind.
 * CC_PORT is preferred — it is the one the env-bleed guard protects (never
 * silently overridden by an ambient gateway/Hostinger-injected PORT).
 */
function resolveDeclaredPort(): number | null {
  const raw = process.env.CC_PORT ?? process.env.PORT ?? null;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Empirically confirm the server is actually reachable on the declared port
 * — trusting the env var alone would miss a process that set the variable
 * but bound elsewhere (or never bound at all). A 401 counts as "alive" (a
 * CF-Access-guarded box correctly rejects an unauthenticated same-origin
 * probe without the app being down).
 */
async function probeListening(port: number, timeoutMs = 3000): Promise<{ ok: boolean; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    return { ok: res.ok || res.status === 401, error: null };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * When Cloudflare tunnel API credentials AND this box's CC hostname are
 * configured (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID +
 * CLOUDFLARE_TUNNEL_ID + CC_TUNNEL_HOSTNAME), read the tunnel's live ingress
 * configuration and confirm the entry for this box's CC hostname targets
 * :4000. Returns `checked: false` when ANY credential is missing — this half
 * of the check is DELIBERATELY silent on a box that never provisioned it
 * (the P1-05 lesson: never guess/fabricate an unprovisioned result).
 */
async function checkTunnelIngress(): Promise<{ checked: boolean; ok: boolean | null; detail: string | null }> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const tunnelId = process.env.CLOUDFLARE_TUNNEL_ID;
  const hostname = process.env.CC_TUNNEL_HOSTNAME;

  if (!apiToken || !accountId || !tunnelId || !hostname) {
    return {
      checked: false,
      ok: null,
      detail: 'tunnel API credentials/hostname not configured on this box — skipped',
    };
  }

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
      { headers: { Authorization: `Bearer ${apiToken}` } },
    );
    if (!res.ok) {
      return { checked: true, ok: null, detail: `Cloudflare API returned ${res.status} — could not read ingress` };
    }
    const body = (await res.json()) as {
      result?: { config?: { ingress?: Array<{ hostname?: string; service?: string }> } };
    };
    const ingress = body.result?.config?.ingress ?? [];
    const entry = ingress.find((e) => e.hostname === hostname);
    if (!entry) {
      return { checked: true, ok: false, detail: `no ingress rule found for hostname ${hostname} (CLOBBERED)` };
    }
    const targetsCanonical = /:4000\b/.test(entry.service ?? '');
    return {
      checked: true,
      ok: targetsCanonical,
      detail: `ingress mismatch for ${hostname} -> ${entry.service ?? '(none)'}`,
    };
  } catch (err) {
    return { checked: true, ok: null, detail: `tunnel ingress fetch failed: ${(err as Error).message}` };
  }
}

/**
 * Run the daily port-integrity self-check. Never throws — mirrors the
 * `wrap()` contract every other scheduler.ts job relies on — and is directly
 * unit-testable via the `deps.notify` injection point (never mocks the real
 * network / Telegram in tests).
 */
export async function runPortIntegrityCheck(deps: PortIntegrityDeps = {}): Promise<PortIntegrityResult> {
  const notify = deps.notify ?? notifySystem;

  const listenPort = resolveDeclaredPort();
  let listenPortOk = false;
  let listenProbeError: string | null = null;

  if (listenPort === null) {
    listenProbeError = 'CC_PORT/PORT env var not set — cannot determine declared listen port';
  } else {
    const probe = await probeListening(listenPort);
    listenProbeError = probe.error;
    listenPortOk = listenPort === CANONICAL_CC_PORT && probe.ok;
  }

  const tunnel = await checkTunnelIngress();

  const problems: string[] = [];
  if (!listenPortOk) {
    if (listenPort === null) {
      problems.push('listen port unresolvable (CC_PORT/PORT unset)');
    } else if (listenPort !== CANONICAL_CC_PORT) {
      problems.push(`listening on port ${listenPort}, expected ${CANONICAL_CC_PORT}`);
    } else {
      problems.push(
        `declared port ${listenPort} did not answer /api/health${listenProbeError ? ` (${listenProbeError})` : ''}`,
      );
    }
  }
  if (tunnel.checked && tunnel.ok === false) {
    problems.push(`tunnel ingress mismatch: ${tunnel.detail}`);
  }

  let alerted = false;
  if (problems.length > 0) {
    notify(`port-integrity: CC port/ingress drift detected — ${problems.join('; ')}`, {
      agent: 'port-integrity',
      action: 'escalate',
    });
    alerted = true;
  }

  return {
    listenPort,
    listenPortOk,
    listenProbeError,
    tunnelChecked: tunnel.checked,
    tunnelOk: tunnel.ok,
    tunnelDetail: tunnel.detail,
    alerted,
  };
}
