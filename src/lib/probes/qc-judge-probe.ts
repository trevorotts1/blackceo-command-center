/**
 * QC Judge probe (P1-05) — proves whether a box's QC judge can actually score
 * a task, not merely that a model name is configured.
 *
 * Context (SUPER-SPEC-2026-07-11, P1-05): 0/290 fleet agents had a judge
 * model provisioned, so `qc-scorer.ts`'s heuristic path clamped every score to
 * 8.0 against the 8.5 gate — nothing has ever legitimately passed QC on a
 * client box. The v19.48.0 onboarding installer now provisions
 * `QC_JUDGE_MODEL` from the client's own Ollama Cloud text models where
 * possible, but provisioning the NAME alone does not prove the box can CALL
 * it: on the operator box, `GET /v1/models` (unauthenticated) returned 200 +
 * the full catalog while every stored key 401'd on the real chat-completion
 * path — "the mirage". `probes/model-providers.ts`'s `provider_ollama-cloud`
 * component pings exactly that mirage-prone `/v1/models` endpoint, so it
 * CANNOT be trusted as proof the judge works; this probe exists precisely
 * because that check is insufficient for QC's fail-closed contract.
 *
 * What this probe actually does (spec (c)1, verbatim):
 *   (i)  assert `QC_JUDGE_MODEL` is set in the box's CC env (or record that it
 *        is legitimately unprovisioned — and WHICH of the possible reasons);
 *   (ii) fire ONE real chat-completion call to the judge model through the
 *        box's configured Ollama Cloud endpoint with a short prompt and
 *        assert an HTTP 200 WITH an actual completion body — never trust
 *        `/v1/models` alone.
 *
 * Verdict vocabulary (fleet rollout ledger, per spec):
 *   - judge_ok            — model configured, key resolved, live call
 *                            returned a real completion.
 *   - judge_auth_dead     — model configured, but the live call failed
 *                            (401/5xx/timeout/empty body) despite a key being
 *                            present — this is the "mirage" case.
 *   - judge_unprovisioned — no client Ollama Cloud judge model/key configured
 *                            at all (mirrors qc-scorer.ts's own `failClosed`
 *                            reasons) — a legitimate, logged state, not a
 *                            failure of this probe.
 *
 * This module intentionally does NOT wire into `runAllProbes()` /
 * `GET /api/system/status` (the 30-second-cache dashboard panel that every
 * client page load can trigger) — a live chat-completion call spends the
 * client's own Ollama Cloud GPU-seconds, and section 2's autonomy protocol
 * forbids incurring that cost on a passive polling cadence. Instead it is
 * exposed as an explicit, single-shot check via `GET /api/system/qc-judge-
 * probe`, which the P6-01 fleet rollout script calls ONCE per box per wave
 * and records into the per-box rollout ledger.
 */

import { getProvider } from '@/lib/model-providers';
import { resolveProviderApiKey } from '@/lib/provider-key-detection';
import { chatCompletion as ollamaCloudChat } from '@/lib/model-providers/ollama-cloud';
import { isOllamaCloudModel } from '@/lib/qc-scorer';
import {
  ProbeResult,
  SystemStatus,
  withTimeout,
} from './types';

export const QC_JUDGE_COMPONENT = 'qc_judge';
export const QC_JUDGE_LABEL = 'QC Judge';

/** The exact 3 verdicts the P6-01 rollout ledger records per box. */
export type JudgeVerdict = 'judge_ok' | 'judge_auth_dead' | 'judge_unprovisioned';

export interface JudgeProbeOutcome {
  verdict: JudgeVerdict;
  /** The raw QC_JUDGE_MODEL value, or null when unset. Never a secret. */
  judgeModel: string | null;
  /** Human-readable evidence for the rollout ledger / operator report. */
  reason: string;
}

/**
 * A live LLM round trip needs more budget than the local diagnostics the
 * other probes in this directory perform (PROBE_TIMEOUT_MS = 3000 there is
 * deliberately tight for non-blocking dashboard polling). This probe is
 * invoked on demand, not on the polling cadence (see module doc), so a wider
 * timeout is safe and necessary — a 401/slow-provider round trip commonly
 * takes several seconds.
 */
const JUDGE_PROBE_TIMEOUT_MS = 10_000;

/**
 * Core judge-provisioning check — no HTTP framing, directly unit-testable.
 * Never throws; every failure mode resolves to a JudgeProbeOutcome.
 */
export async function checkJudgeProvisioning(): Promise<JudgeProbeOutcome> {
  const raw = process.env.QC_JUDGE_MODEL;
  if (!raw || !raw.trim()) {
    return {
      verdict: 'judge_unprovisioned',
      judgeModel: null,
      reason:
        'QC_JUDGE_MODEL is unset in this box\'s CC env — no client Ollama Cloud judge ' +
        'configured. scoreTaskForQC() fails closed to human review (QC-08); this is a ' +
        'legitimate unprovisioned state, not an error.',
    };
  }

  const judgeModel = raw.trim();

  // Mirrors qc-scorer.ts's resolveClientJudgeModel() gate: only an Ollama
  // Cloud model id is a sanctioned judge — never an operator/shared paid key.
  if (!isOllamaCloudModel(judgeModel)) {
    return {
      verdict: 'judge_unprovisioned',
      judgeModel,
      reason:
        `QC_JUDGE_MODEL="${judgeModel}" is not an Ollama Cloud model id ` +
        '(must be "ollama-cloud/<m>" or a bare "<m>:cloud" tag) — scoreTaskForQC() fails ' +
        'closed on this box exactly as if no judge were configured.',
    };
  }

  const provider = getProvider('ollama-cloud');
  if (!provider) {
    // Should be unreachable (the connector is always registered), but fail
    // closed with a distinct reason rather than throwing.
    return {
      verdict: 'judge_unprovisioned',
      judgeModel,
      reason: 'the ollama-cloud provider connector is not registered on this build.',
    };
  }

  const keyRes = resolveProviderApiKey(provider);
  if (!('found' in keyRes) || !keyRes.found) {
    return {
      verdict: 'judge_unprovisioned',
      judgeModel,
      reason:
        'QC_JUDGE_MODEL is set, but no Ollama Cloud API key was found in any store ' +
        '(checked: process.env, .env files, openclaw.json, OpenClaw auth store — never ' +
        `logs the value). Candidates checked: ${'checked' in keyRes ? keyRes.checked.join(', ') : 'n/a'}.`,
    };
  }

  // (ii) THE ACTUAL PROOF — one real chat-completion call. Never trust
  // GET /v1/models alone: it is documented (v19.48.0 A-FINDING) to return 200
  // + the full catalog even when every stored key is dead on the real call
  // path — the mirage that this probe exists to see through.
  const rawJudgeId = judgeModel.startsWith('ollama-cloud/')
    ? judgeModel.slice('ollama-cloud/'.length)
    : judgeModel;

  try {
    const resp = await ollamaCloudChat(keyRes.value, {
      model: rawJudgeId,
      messages: [{ role: 'user', content: 'Reply with one word: OK' }],
      max_tokens: 5,
      temperature: 0,
    });

    const content = resp?.choices?.[0]?.message?.content?.trim();
    if (content) {
      return {
        verdict: 'judge_ok',
        judgeModel,
        reason:
          `Live 5-token chat-completion call to "${judgeModel}" via ${keyRes.source}` +
          ` (${keyRes.envVar}) returned HTTP 200 with a real completion.`,
      };
    }

    // HTTP 200 but an empty/unparseable body is functionally the same failure
    // mode as the /v1/models mirage: a 2xx that proves nothing was actually
    // scored. Treat it as auth-dead, not ok.
    return {
      verdict: 'judge_auth_dead',
      judgeModel,
      reason:
        `Chat-completion call to "${judgeModel}" returned HTTP 200 but no completion ` +
        'content — an endpoint 200 alone never proves the box can call the model ' +
        '(the /v1/models mirage). Treated as auth-dead.',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verdict: 'judge_auth_dead',
      judgeModel,
      reason: `Live chat-completion call to "${judgeModel}" failed: ${msg}`,
    };
  }
}

function statusForVerdict(verdict: JudgeVerdict): SystemStatus {
  switch (verdict) {
    case 'judge_ok':
      return 'live';
    case 'judge_auth_dead':
      return 'degraded';
    case 'judge_unprovisioned':
      return 'unknown';
  }
}

/**
 * ProbeResult-shaped wrapper around checkJudgeProvisioning(), for callers
 * that want the same shape as the other components in this directory (e.g.
 * the on-demand `/api/system/qc-judge-probe` route). Deliberately NOT
 * registered in `runAllProbes()` — see module doc.
 */
export async function probeQCJudge(): Promise<ProbeResult> {
  const start = Date.now();

  return withTimeout<ProbeResult>(
    async () => {
      const outcome = await checkJudgeProvisioning();
      return {
        component: QC_JUDGE_COMPONENT,
        label: QC_JUDGE_LABEL,
        status: statusForVerdict(outcome.verdict),
        latencyMs: Date.now() - start,
        error: outcome.verdict === 'judge_ok' ? undefined : outcome.reason,
        detail: { verdict: outcome.verdict, judgeModel: outcome.judgeModel, reason: outcome.reason },
        probedAt: new Date().toISOString(),
      };
    },
    JUDGE_PROBE_TIMEOUT_MS,
    () => ({
      component: QC_JUDGE_COMPONENT,
      label: QC_JUDGE_LABEL,
      status: 'degraded',
      latencyMs: Date.now() - start,
      error: `judge probe exceeded its ${JUDGE_PROBE_TIMEOUT_MS}ms budget (treated as judge_auth_dead)`,
      detail: { verdict: 'judge_auth_dead' as JudgeVerdict, judgeModel: process.env.QC_JUDGE_MODEL || null },
      probedAt: new Date().toISOString(),
    })
  );
}
