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
 * Verdict vocabulary (fleet rollout ledger) — see the JudgeVerdict type for why
 * `judge_auth_dead` was narrowed to mean ONLY what it can prove:
 *   - judge_ok             — model configured, key resolved, live call
 *                             returned a real completion.
 *   - judge_auth_dead      — HTTP 401/403 on the real call path despite a key
 *                             being present — the "mirage" case.
 *   - judge_empty_response — HTTP 200 with no content: the key WORKED and the
 *                             provider is UP, but nothing was scored (typically
 *                             a reasoning model starved of completion budget).
 *   - judge_unreachable    — nothing answered, or a non-auth HTTP error. Says
 *                             nothing about the key.
 *   - judge_unprovisioned  — no client Ollama Cloud judge model/key configured
 *                             at all (mirrors qc-scorer.ts's own `failClosed`
 *                             reasons) — a legitimate, logged state, not a
 *                             failure of this probe.
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
import {
  chatCompletion as ollamaCloudChat,
  OllamaCloudHttpError,
  isAuthStatus,
} from '@/lib/model-providers/ollama-cloud';
import { isOllamaCloudModel, resolveJudgeMaxTokens } from '@/lib/qc-scorer';
import {
  ProbeResult,
  SystemStatus,
  withTimeout,
} from './types';

export const QC_JUDGE_COMPONENT = 'qc_judge';
export const QC_JUDGE_LABEL = 'QC Judge';

/**
 * The verdicts the P6-01 rollout ledger records per box.
 *
 * `judge_auth_dead` USED TO mean "the live call failed for any reason at all" —
 * 401, 5xx, timeout, or an empty body. That is a borrowed diagnosis, and it made
 * this probe actively dangerous: combined with its old `max_tokens: 5` budget, a
 * REASONING judge (whose hidden reasoning field is billed against the same
 * budget) was GUARANTEED to return empty content, and this probe would have
 * reported a perfectly valid credential as DEAD. The one instrument a human
 * trusts to tell them the truth would have pointed them at the wrong thing —
 * the exact six-day story, reproduced inside the tool built to prevent it.
 *
 * So the verdicts are split, and each one now means only what it can prove:
 *   - judge_ok             — live call returned a real completion.
 *   - judge_auth_dead      — HTTP 401/403. The credential is dead. ONLY this.
 *   - judge_empty_response — HTTP 200, no content. The provider is UP and the
 *                            key worked; the budget (or the model) is at fault.
 *   - judge_unreachable    — nothing answered, or a non-auth HTTP error (5xx,
 *                            timeout, DNS, refused). Says nothing about the key.
 *   - judge_unprovisioned  — no client judge model/key configured at all.
 */
export type JudgeVerdict =
  | 'judge_ok'
  | 'judge_auth_dead'
  | 'judge_empty_response'
  | 'judge_unreachable'
  | 'judge_unprovisioned';

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

  // The budget is the SAME resolver the scorer uses. This probe shipped with
  // `max_tokens: 5`, which cannot fit a reasoning model's hidden reasoning field
  // — it would return empty content 100% of the time and this probe would call
  // the credential dead. A validator that fails the thing it validates is worse
  // than no validator.
  const maxTokens = resolveJudgeMaxTokens();

  try {
    const resp = await ollamaCloudChat(keyRes.value, {
      model: rawJudgeId,
      messages: [{ role: 'user', content: 'Reply with one word: OK' }],
      max_tokens: maxTokens,
      temperature: 0,
    });

    const choice = resp?.choices?.[0];
    const content = choice?.message?.content?.trim();
    if (content) {
      return {
        verdict: 'judge_ok',
        judgeModel,
        reason:
          `Live ${maxTokens}-token chat-completion call to "${judgeModel}" via ${keyRes.source}` +
          ` (${keyRes.envVar}) returned HTTP 200 with a real completion.`,
      };
    }

    // HTTP 200 with no content. The request was ACCEPTED — the key worked and
    // the provider answered — so this is emphatically NOT auth-dead, which is
    // what it used to be called. It is the model or the budget.
    const finishReason = choice?.finish_reason ?? '(none)';
    const completionTokens = resp?.usage?.completion_tokens;
    const reasoningChars =
      (choice?.message as { reasoning?: string } | undefined)?.reasoning?.length ?? 0;
    return {
      verdict: 'judge_empty_response',
      judgeModel,
      reason:
        `Chat-completion call to "${judgeModel}" returned HTTP 200 (so the key WORKED and the ` +
        `provider is UP) but no completion content (finish_reason=${finishReason}, ` +
        `completion_tokens=${completionTokens ?? 'unknown'}, max_tokens=${maxTokens}, ` +
        `reasoning_chars=${reasoningChars}). This is NOT an auth failure — do not rotate the key. ` +
        `On a REASONING model the hidden reasoning field is billed against the same completion ` +
        `budget and can consume all of it: raise QC_JUDGE_MAX_TOKENS, or choose a non-reasoning ` +
        `judge. The judge still cannot score in this state.`,
    };
  } catch (err) {
    // ONLY 401/403 establishes a dead credential. Everything else — 5xx, a
    // timeout, DNS, a refused connection — says nothing about the key, and
    // saying "auth dead" would be guessing.
    if (err instanceof OllamaCloudHttpError && isAuthStatus(err.status)) {
      return {
        verdict: 'judge_auth_dead',
        judgeModel,
        reason:
          `Live chat-completion call to "${judgeModel}" returned HTTP ${err.status} ` +
          `${err.statusText} via ${keyRes.source} (${keyRes.envVar}) — the credential is dead ` +
          `on the real call path, whatever GET /v1/models may report (the mirage).`,
      };
    }
    if (err instanceof OllamaCloudHttpError) {
      return {
        verdict: 'judge_unreachable',
        judgeModel,
        reason:
          `Live chat-completion call to "${judgeModel}" returned HTTP ${err.status} ` +
          `${err.statusText}. This is a server-side/transport failure, NOT an auth failure — ` +
          `the key is not implicated and must not be rotated on this evidence alone.`,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verdict: 'judge_unreachable',
      judgeModel,
      reason:
        `Live chat-completion call to "${judgeModel}" never completed: ${msg}. Nothing answered, ` +
        `so this says NOTHING about the key — check reachability of OLLAMA_CLOUD_BASE_URL first.`,
    };
  }
}

function statusForVerdict(verdict: JudgeVerdict): SystemStatus {
  switch (verdict) {
    case 'judge_ok':
      return 'live';
    // All three are "the judge cannot score right now" — the CAUSES differ
    // sharply (dead key vs starved budget vs nothing answering) and the reason
    // string says which, but the board-level health is the same: degraded.
    case 'judge_auth_dead':
    case 'judge_empty_response':
    case 'judge_unreachable':
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
      error: `judge probe exceeded its ${JUDGE_PROBE_TIMEOUT_MS}ms budget (treated as judge_unreachable — a timeout says nothing about the key)`,
      detail: { verdict: 'judge_unreachable' as JudgeVerdict, judgeModel: process.env.QC_JUDGE_MODEL || null },
      probedAt: new Date().toISOString(),
    })
  );
}
