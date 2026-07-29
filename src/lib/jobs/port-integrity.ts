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
  /**
   * U068: injectable for tests; defaults to global fetch. The probe performs a
   * real HTTP request, so the ONLY way to test this job's decision logic is to
   * substitute the transport. Never mock notifySystem's network and never point
   * the real fetch at a live box from a test.
   */
  fetchImpl?: typeof fetch;
}

export interface PortIntegrityResult {
  listenPort: number | null;
  listenPortOk: boolean;
  listenProbeError: string | null;
  tunnelChecked: boolean;
  tunnelOk: boolean | null;
  tunnelDetail: string | null;
  alerted: boolean;
  canonicalPortAnswered: boolean | null;
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
async function probeListening(
  port: number,
  timeoutMs = 3000,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
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
  const fetchImpl = deps.fetchImpl ?? fetch;

  const listenPort = resolveDeclaredPort();
  let listenPortOk = false;
  let listenProbeError: string | null = null;

  if (listenPort === null) {
    listenProbeError = 'CC_PORT/PORT env var not set — cannot determine declared listen port';
  } else {
    const probe = await probeListening(listenPort, 3000, fetchImpl);
    listenProbeError = probe.error;
    listenPortOk = listenPort === CANONICAL_CC_PORT && probe.ok;
  }

  // U068: probe the CANONICAL port UNCONDITIONALLY, including when this process
  // declared a different one and including when it declared none at all. Before
  // this change the set of ports this job could ever look at had exactly one
  // member — the one this process declared — so a canonical process reported
  // all-clear while a drifted sibling served from the same working directory,
  // and with CC_PORT/PORT unset the job never probed 4000 at all. That is the
  // residual this module's own header (:7-10) says it exists to catch.
  const canonicalProbe =
    listenPort === CANONICAL_CC_PORT
      ? null                                    // already probed above; do not double-probe
      : await probeListening(CANONICAL_CC_PORT, 3000, fetchImpl);
  const canonicalPortAnswered: boolean | null =
    canonicalProbe === null ? listenPortOk || null : canonicalProbe.ok;

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

  // U068 stage 1. This is a REPORT, not a new hard failure: the job's contract is
  // that it never throws and only ever calls notifySystem(). Escalating this to a
  // different sink, or to a process action, is a SEPARATE unit.
  if (listenPort !== null && listenPort !== CANONICAL_CC_PORT && canonicalPortAnswered === true) {
    problems.push(
      `this process is bound to ${listenPort} while ${CANONICAL_CC_PORT} is ALSO answering — ` +
        `a second Command Center is serving from this box`,
    );
  }
  if (listenPort === null && canonicalPortAnswered === true) {
    problems.push(
      `CC_PORT/PORT unset, but ${CANONICAL_CC_PORT} is answering — this process cannot prove ` +
        `it is the process serving that port`,
    );
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
    canonicalPortAnswered,
  };
}
