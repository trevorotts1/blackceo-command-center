/**
 * JEV-014 — Single authorized non-JEV tie-break adapter (spec section 6.5).
 *
 * WHY THIS EXISTS
 * ---------------
 * department-router.ts used to own an autonomous tie-break: it read a provider
 * API key from the process environment itself, called a chat-completions
 * endpoint directly, and set its own 10-second timeout — a free-standing
 * key/time-budget bypass reachable from every department path, including
 * beside an accepted JEV judgment. Spec section 6.5 forbids that: no required
 * department path may retain a free-standing key/time bypass, and an accepted
 * JEV department judgment is final for that stage (zero secondary judge calls).
 *
 * This module is the ONE place a non-JEV tie-break may run, and only with an
 * explicit config: a model from TIEBREAK_MODEL (or approved client config), an
 * inherited remaining preparation budget (never its own clock reset), an
 * explicit credential plus endpoint from approved client configuration, and a
 * company-bound permission context. Anything missing resolves to a
 * deterministic evidence-only fallback with zero network calls and a truthful
 * provenance string.
 *
 * WHAT IT NEVER DOES
 * ------------------
 * - Never reads a provider API key from the environment. The only env var read
 *   here is TIEBREAK_MODEL (model selection, never a credential).
 * - Never hardcodes a provider URL or a default model. No endpoint/credential
 *   passed in means no call happens, by construction.
 * - Never throws: every failure resolves to { decided: false } with a
 *   machine-greppable provenance string so the router falls back honestly.
 *
 * Edge-safe: fetch plus AbortSignal only, no node builtins (department-router
 * ships in the Next.js edge instrumentation bundle, so this file must too).
 *
 * ponytail: production credential plumbing stops at the explicit apiKey plus
 * endpoint parameters. A future provider-key unit may resolve those from
 * approved client configuration and pass them in; this adapter needs no change
 * when that lands (its no-credential evidence-only branch is already the
 * spec-mandated behavior until then).
 */

export interface TiebreakCandidate {
  id: string;
  name: string;
  purpose: string;
}

export interface TiebreakPermission {
  permitted: boolean;
  companyId?: string;
  reason: string;
}

export interface TiebreakRequest {
  taskText: string;
  /** Already-ranked close candidates, closest first. Capped to 5 inside. */
  candidates: TiebreakCandidate[];
  companyId?: string;
  /** Explicit model from TIEBREAK_MODEL or approved client config. Null means none. */
  model: string | null;
  /** Explicit credential from approved client configuration. Never env-read here. */
  apiKey?: string | null;
  /** Explicit chat-completions endpoint from approved client configuration. */
  endpoint?: string | null;
  /** Inherited remaining preparation budget in ms. Never reset per call. */
  deadlineMs?: number;
  permission: TiebreakPermission;
  /**
   * The box's own LLM path (see model-pick-llm.ts: the same provider connectors and client-owned keys the
   * QC judge uses). When given, it carries the call and `apiKey`/`endpoint` are not needed. It receives the
   * messages and the time budget and returns the model's reply text (null = no reply). It may throw.
   */
  complete?: (args: { model: string; messages: { role: 'system' | 'user'; content: string }[]; maxTokens: number; budgetMs: number }) => Promise<string | null>;
}

export interface TiebreakResult {
  decided: boolean;
  departmentId?: string;
  /** Truthful machine-greppable account of what happened. */
  provenance: string;
}

export type TiebreakFn = (req: TiebreakRequest) => Promise<TiebreakResult>;

/** Legacy ceiling preserved as a cap, never as an owned budget. */
export const TIEBREAK_TIMEOUT_CAP_MS = 10_000;

/** Legacy candidate window preserved: judge at most the top 5. */
export const TIEBREAK_MAX_CANDIDATES = 5;

const TIEBREAK_MODEL_ENV = 'TIEBREAK_MODEL';

/**
 * Preserve the explicitly valid TIEBREAK_MODEL mapping: an operator-set model
 * name selects the tie-break model, otherwise there is no permitted model and
 * the router must use semantic/lexical/rule evidence only. No hardcoded
 * default model — an unset variable means no tie-break, not a silent vendor.
 */
export function resolveTiebreakModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[TIEBREAK_MODEL_ENV];
  if (!raw) return null;
  const model = raw.trim();
  return model.length > 0 ? model : null;
}

/**
 * Company-bound spending/data permission gate. A tie-break may run only when
 * the caller binds it to a company AND supplies an explicit model. An explicit
 * override (for tests or a future approval record) wins either way.
 */
export function resolveTiebreakPermission(input: {
  companyId?: string;
  model: string | null;
  override?: boolean;
}): TiebreakPermission {
  if (input.override !== undefined) {
    return {
      permitted: input.override,
      companyId: input.companyId,
      reason: input.override ? 'explicit-override-permitted' : 'explicit-override-denied',
    };
  }
  if (!input.companyId) {
    return { permitted: false, reason: 'tie-break-not-permitted:missing-company-scope' };
  }
  if (!input.model) {
    return {
      permitted: false,
      companyId: input.companyId,
      reason: 'tie-break-not-permitted:no-permitted-model',
    };
  }
  return {
    permitted: true,
    companyId: input.companyId,
    reason: `company-bound:model=${input.model}`,
  };
}

/**
 * The single authorized non-JEV tie-break. At most ONE network call per
 * invocation, bounded by the inherited budget capped at TIEBREAK_TIMEOUT_CAP_MS.
 * Every non-decision path returns decided:false with provenance and makes zero
 * network calls. Never throws.
 */
export async function authorizedTiebreak(
  req: TiebreakRequest,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TiebreakResult> {
  const candidates = req.candidates.slice(0, TIEBREAK_MAX_CANDIDATES);
  if (candidates.length === 0) {
    return { decided: false, provenance: 'evidence-only:no-candidates' };
  }
  if (!req.permission.permitted) {
    return { decided: false, provenance: `evidence-only:${req.permission.reason}` };
  }
  if (!req.model) {
    return { decided: false, provenance: 'evidence-only:no-permitted-model' };
  }
  if (!req.complete && (!req.apiKey || !req.endpoint)) {
    return {
      decided: false,
      provenance: 'evidence-only:no-credential-or-endpoint:tie-break-configured-without-approved-credential',
    };
  }

  const budgetMs =
    req.deadlineMs !== undefined && req.deadlineMs > 0
      ? Math.min(req.deadlineMs, TIEBREAK_TIMEOUT_CAP_MS)
      : TIEBREAK_TIMEOUT_CAP_MS;

  const deptList = candidates.map((c, i) => `${i + 1}. ${c.name} — ${c.purpose}`).join('\n');

  const messages = [
    {
      role: 'system' as const,
      content:
        'You are a task routing assistant. Given a task and a list of departments, ' +
        'reply with ONLY the exact department name (no other text) that best handles the task.',
    },
    {
      role: 'user' as const,
      content:
        `Task: "${req.taskText}"\n\nDepartments:\n${deptList}\n\n` +
        'Which single department should handle this task? Reply with only the department name.',
    },
  ];

  try {
    let picked: string;
    if (req.complete) {
      picked = ((await req.complete({ model: req.model, messages, maxTokens: 1500, budgetMs })) ?? '').trim();
    } else {
    const resp = await fetchImpl(req.endpoint as string, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      signal: AbortSignal.timeout(budgetMs),
      body: JSON.stringify({
        model: req.model,
        messages,
        // A reasoning model's hidden reasoning counts against this limit (50 left its content empty;
        // the QC judge needed 1500). The reply is one department name; the timeout still bounds the call.
        max_tokens: 1500,
        temperature: 0,
      }),
    });

    if (!resp.ok) {
      return { decided: false, provenance: `evidence-only:tie-break-http-${resp.status}` };
    }

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    picked = data.choices?.[0]?.message?.content?.trim() ?? '';
    }
    if (!picked) {
      return { decided: false, provenance: 'evidence-only:tie-break-empty-reply' };
    }

    const match = candidates.find(
      (c) =>
        c.name.toLowerCase() === picked.toLowerCase() ||
        picked.toLowerCase().includes(c.name.toLowerCase()),
    );
    if (!match) {
      return {
        decided: false,
        provenance: `evidence-only:tie-break-no-pick:${picked.slice(0, 80)}`,
      };
    }

    return {
      decided: true,
      departmentId: match.id,
      provenance: `authorized-tiebreak:model=${req.model} company=${req.companyId ?? 'unscoped'} selected=${match.name}`,
    };
  } catch (err) {
    return {
      decided: false,
      provenance: `evidence-only:tie-break-failed:${(err as Error).name ?? 'Error'}:${((err as Error).message ?? '').slice(0, 120)}`,
    };
  }
}
