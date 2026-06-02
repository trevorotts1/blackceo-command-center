/**
 * Cheap Ollama planner for the Web Agent (E22).
 *
 * The Web Agent's per-step vision loop runs on an Anthropic computer-use model
 * (it needs screenshots). That is the expensive part. To keep cost down, E22
 * adds a CHEAP up-front planning pass on a local Ollama model: before the
 * vision loop starts we ask Ollama to turn the operator's free-text task into a
 * short, ordered, text-only plan. The plan is injected into the vision model's
 * first prompt so it spends fewer expensive turns figuring out what to do.
 *
 * This is strictly best-effort and OPTIONAL:
 *   - If `OLLAMA_BASE_URL` (or the default loopback) is unreachable, or the
 *     model is not pulled, `planWithOllama` returns `null` and the runner
 *     proceeds exactly as before. It NEVER throws.
 *   - The planner does no vision; it only structures the task text.
 *
 * Model + endpoint are env-overridable per the cost policy:
 *   - `WEB_AGENT_PLANNER_MODEL` (default `llama3.2`) — a small local model.
 *   - `OLLAMA_BASE_URL`         (default `http://127.0.0.1:11434`).
 *
 * NOTE on Ollama Cloud: a `:cloud`-tagged model id is routed through Ollama
 * Cloud by the local daemon, so the same loopback base URL still works for a
 * cloud-backed planner — no special-casing here.
 */

const DEFAULT_PLANNER_MODEL = process.env.WEB_AGENT_PLANNER_MODEL || 'llama3.2';
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const PLANNER_TIMEOUT_MS = 15_000;

export interface PlannerResult {
  /** Ordered, plain-text plan steps. */
  steps: string[];
  /** The model id that produced the plan. */
  model: string;
}

interface OllamaGenerateResponse {
  response?: string;
  error?: string;
}

/**
 * Ask a cheap local Ollama model to draft an ordered plan for a browser task.
 * Returns null on any failure (planner is optional). Never throws.
 */
export async function planWithOllama(
  task: string,
  opts: { model?: string; signal?: AbortSignal } = {}
): Promise<PlannerResult | null> {
  const model = opts.model || DEFAULT_PLANNER_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLANNER_TIMEOUT_MS);
  // Chain the caller's signal if provided.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const prompt =
    'You are planning a web automation task that another agent will execute in ' +
    'a headless browser. Break the task into a short ordered list of concrete, ' +
    'observable browser steps (navigate, click, type, read). Reply with ONLY the ' +
    'numbered steps, one per line, no preamble, no markdown, no em dashes.\n\n' +
    `Task: ${task}`;

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as OllamaGenerateResponse;
    if (json.error || !json.response) return null;
    const steps = json.response
      .split('\n')
      .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').replace(/^[-*]\s*/, '').trim())
      .filter((l) => l.length > 0)
      .slice(0, 20);
    if (steps.length === 0) return null;
    return { steps, model };
  } catch {
    // Unreachable Ollama, aborted, or bad JSON — planner is optional.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
