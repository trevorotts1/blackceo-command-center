/**
 * JGT105 — CC's only caller of the decision-engine bridge.
 *
 * jevMode() resolves the standing kill switch (env, then the onboarding
 * config file, re-read on every call so `off` takes effect with no restart).
 * jevDecide() spawns the installed core at most once per unique
 * (text, department-slugs) key per process and NEVER throws — every failure
 * (absent core, incompatible core, timeout, bad JSON, an old core missing
 * intent/route) degrades to `null` so callers keep their existing no-JEV
 * path. liveJevResponder adapts jevDecide to classify.ts's JevResponder shape
 * for the ingest raw door.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import {
  buildRequest,
  type DecisionDepartment,
  type DecisionResponse,
  type DecisionRoute,
} from './contract';
import { evaluateDecision, resolveCorePath } from './bridge';
import { probeInstalledCore, type CapabilityState } from './capability';
import { parseConfiguredMode, type DecisionEngineMode } from './modes';
import { stampRootDeadline, type BridgeDeadline } from './deadline';
import { classifyLexical, type Intent, type IntakeContext, type JevResponder } from '@/lib/intake';

const VALID_INTENTS: ReadonlySet<string> = new Set<Intent>([
  'answer_only',
  'task_request',
  'mixed_answer_and_task',
  'existing_task_control',
  'clarification_response',
  'social_conversation',
  'unresolved',
]);

const VALID_MODES: ReadonlySet<string> = new Set(['auto', 'shadow', 'legacy', 'off']);
const VALID_ROUTE_ACTIONS: ReadonlySet<string> = new Set(['answer', 'route', 'none']);
const VALID_CATALOGS: ReadonlySet<string> = new Set(['request', 'standard-floor', 'empty']);

/** The onboarding-installed bridge script; overridden by DECISION_ENGINE_CORE_PATH. */
function defaultCorePath(): string | null {
  const p = path.join(os.homedir(), '.openclaw', 'skills', 'shared-utils', 'decision-engine.py');
  return existsSync(p) ? p : null;
}

/** Read the first whitespace-delimited word of the mode file, or undefined. */
function readModeFileWord(): string | undefined {
  const base = (process.env.OC_CONFIG && process.env.OC_CONFIG.trim()) || path.join(os.homedir(), '.openclaw');
  try {
    const raw = readFileSync(path.join(base, 'decision-engine-mode.conf'), 'utf8');
    const word = raw.trim().split(/\s+/)[0];
    return word || undefined;
  } catch {
    return undefined;
  }
}

let warnedInvalidMode = false;

/**
 * Resolve the standing kill switch. Checked fresh on every call (no caching)
 * so flipping the file or env takes effect immediately, with no restart.
 */
export function jevMode(): DecisionEngineMode {
  const envMode = process.env.DECISION_ENGINE_MODE?.trim() || process.env.OPENCLAW_DECISION_ENGINE_MODE?.trim();
  const raw = envMode || readModeFileWord();
  if (!raw) return 'auto';
  const normalized = raw.trim().toLowerCase();
  if (!VALID_MODES.has(normalized)) {
    if (!warnedInvalidMode) {
      warnedInvalidMode = true;
      console.warn(`[JEV live] invalid decision-engine mode ${JSON.stringify(raw)} — treating as off`);
    }
    return 'off';
  }
  return parseConfiguredMode(normalized, 'auto');
}

// probeInstalledCore is JEV traffic too: spawn it at most once per process,
// regardless of how many distinct task texts jevDecide is asked to evaluate.
let capabilityPromise: Promise<CapabilityState> | null = null;
function getCapabilityOnce(corePath: string, deadline: BridgeDeadline): Promise<CapabilityState> {
  if (!capabilityPromise) {
    capabilityPromise = probeInstalledCore(deadline, { corePath });
  }
  return capabilityPromise;
}

export interface JevDecision {
  intent: Intent;
  route: DecisionRoute;
}

function validateDecision(response: DecisionResponse): JevDecision | null {
  const intent = response.intent;
  const route = response.route;
  if (typeof intent !== 'string' || !VALID_INTENTS.has(intent)) return null;
  if (!route || typeof route !== 'object') return null;
  if (!VALID_ROUTE_ACTIONS.has(route.action)) return null;
  if (typeof route.confidence !== 'number') return null;
  if (typeof route.fallback !== 'boolean') return null;
  if (!VALID_CATALOGS.has(route.catalog)) return null;
  if (route.department !== null && typeof route.department !== 'string') return null;
  return { intent: intent as Intent, route };
}

// ponytail: unbounded growth per unique (text, dept-set) pair — a FIFO cap
// (insertion order, not recency) keeps memory bounded for the life of the
// process. Upgrade to a real LRU if hot keys get evicted before cold ones.
const MEMO_LIMIT = 500;
const memo = new Map<string, JevDecision>();

function memoKeyFor(text: string, departments?: DecisionDepartment[]): string {
  const slugs = (departments ?? []).map((d) => d.slug).join(',');
  return createHash('sha1').update(`${text}|${slugs}`).digest('hex');
}

function memoSet(key: string, value: JevDecision): void {
  if (memo.size >= MEMO_LIMIT && !memo.has(key)) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
  memo.set(key, value);
}

let lastWarnAtMs = 0;
const WARN_INTERVAL_MS = 60_000;
function warnRateLimited(message: string): void {
  const now = Date.now();
  if (now - lastWarnAtMs > WARN_INTERVAL_MS) {
    lastWarnAtMs = now;
    console.warn(`[JEV live] ${message}`);
  }
}

/**
 * Ask the installed core to classify `text` and, optionally, rank it against
 * `departments`. Returns null on the kill switch, an absent/incompatible/old
 * core, a timeout, or any other failure — never throws.
 */
export async function jevDecide(
  text: string,
  departments?: DecisionDepartment[],
): Promise<JevDecision | null> {
  const mode = jevMode();
  if (mode === 'off' || mode === 'legacy') return null;

  const key = memoKeyFor(text, departments);
  if (mode === 'auto') {
    const cached = memo.get(key);
    if (cached) return cached;
  }

  try {
    const corePath = resolveCorePath({ resolve: defaultCorePath });
    if (!corePath) return null;

    const deadline = stampRootDeadline(3000);
    const capability = await getCapabilityOnce(corePath, deadline);
    if (!capability.compatible) return null;

    const request = buildRequest({
      configRevision: 'cc-live-1',
      taskId: createHash('sha1').update(text).digest('hex').slice(0, 16),
      taskDescription: text,
      departments,
    });
    const response = await evaluateDecision(request, { deadline, corePath });
    const decision = validateDecision(response);
    if (!decision) return null;

    if (mode === 'shadow') {
      console.log('[JEV shadow]', JSON.stringify(decision));
      return null;
    }

    memoSet(key, decision);
    return decision;
  } catch (err) {
    warnRateLimited(`jevDecide failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * classify.ts JevResponder adapter for the ingest raw door. JEV's intent
 * wins except that the lexical path's existing_task_control and
 * clarification_response calls always win — those never need a live model
 * to recognize, and misreading them risks reopening a resolved task.
 */
export const liveJevResponder: JevResponder = async ({ message, context }: { message: string; context: IntakeContext }) => {
  const decision = await jevDecide(message);
  if (!decision) throw new Error('JEV live decision unavailable');
  const lex = classifyLexical(message, context);
  const intent =
    lex.intent === 'existing_task_control' || lex.intent === 'clarification_response'
      ? lex.intent
      : decision.intent;
  return {
    intent,
    executionPreference: lex.executionPreference,
    executorName: lex.executorName,
  };
};
