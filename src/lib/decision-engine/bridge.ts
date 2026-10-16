/**
 * JEV-009 CC bridge — single-spawn stdin/stdout JSON invocation.
 *
 * ONE spawn per evaluate call (no retry loop — the persona-selector
 * per-retry anti-pattern must not move here). The caller stamps ONE root
 * BridgeDeadline; each call takes only its remaining budget as the spawn
 * timeout. A kill for deadline expiry surfaces as typed DeadlineExceeded.
 *
 * Transport: `spawn(python, [corePath, '--evaluate'])`, request JSON on
 * stdin, response JSON on stdout. No shell, no string command line
 * (paths with spaces work unquoted). No home-directory literals anywhere:
 * the core path comes from explicit input, DECISION_ENGINE_CORE_PATH env,
 * or an injected resolver (e.g. platform-derived). Absent all three ->
 * CoreAbsent.
 */

import { spawn } from 'child_process';
import {
  assertAssignmentReadOnly,
  assertRevisionEcho,
  DECISION_SCHEMA_VERSION,
  schemaMajor,
  type DecisionRequest,
  type DecisionResponse,
} from './contract';
import { systemClock, type BridgeDeadline, type Clock } from './deadline';
import {
  BridgeFailedError,
  CoreAbsentError,
  DeadlineExceededError,
  DecisionEngineError,
  IncompatibleRevisionError,
} from './errors';

export const CORE_PATH_ENV = 'DECISION_ENGINE_CORE_PATH';
export const DEFAULT_PYTHON_BIN = 'python3';

export interface CorePathSource {
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected resolver, e.g. derived from platform helpers. Called last. */
  resolve?: () => string | null;
}

export function resolveCorePath(source: CorePathSource = {}): string | null {
  const env = source.env ?? process.env;
  if (source.explicit && source.explicit.trim()) return source.explicit.trim();
  const fromEnv = env[CORE_PATH_ENV];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (source.resolve) {
    try {
      const resolved = source.resolve();
      if (resolved && resolved.trim()) return resolved.trim();
    } catch {
      return null;
    }
  }
  return null;
}

export interface EvaluateOptions {
  deadline: BridgeDeadline;
  corePath?: string;
  corePathSource?: CorePathSource;
  pythonBin?: string;
  clock?: Clock;
}

function isTimeoutKill(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ETIMEDOUT' || code === 'ERR_CHILD_PROCESS_TIMEOUT';
}

export async function evaluateDecision(
  request: DecisionRequest,
  options: EvaluateOptions,
): Promise<DecisionResponse> {
  const clock: Clock = options.clock ?? systemClock;
  const source = options.corePathSource ?? {};
  const corePath = options.corePath ?? resolveCorePath(source);
  if (!corePath) {
    throw new CoreAbsentError('decision-engine core path unresolved (explicit/env/resolver all empty)');
  }
  const spawnEnv = source.env ?? process.env;
  const budgetMs = options.deadline.remainingMs(clock);
  if (budgetMs <= 0) {
    throw new DeadlineExceededError(
      `root deadline already exhausted before spawn (remaining ${budgetMs}ms)`,
    );
  }
  const pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
  const payload = await runCoreOnce(pythonBin, corePath, request, budgetMs, spawnEnv);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new BridgeFailedError('decision-engine core returned non-JSON stdout');
  }
  assertAssignmentReadOnly(parsed);
  const response = parsed as DecisionResponse;
  if (typeof response.schemaVersion !== 'string' || response.schemaVersion.length === 0) {
    throw new IncompatibleRevisionError('decision-engine response absent schemaVersion');
  }
  if (schemaMajor(response.schemaVersion) !== schemaMajor(DECISION_SCHEMA_VERSION)) {
    throw new IncompatibleRevisionError(
      `decision-engine schema major mismatch: core ${response.schemaVersion}, bridge ${DECISION_SCHEMA_VERSION}`,
    );
  }
  try {
    assertRevisionEcho(request, response);
  } catch (err) {
    if (err instanceof DecisionEngineError) throw err;
    throw new IncompatibleRevisionError((err as Error).message);
  }
  return response;
}

function runCoreOnce(
  pythonBin: string,
  corePath: string,
  request: DecisionRequest,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // No `shell: true` — argv array goes straight to execvp.
      child = spawn(pythonBin, [corePath, '--evaluate'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    } catch (err) {
      reject(new CoreAbsentError(`decision-engine spawn failed: ${(err as Error).message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
      reject(err);
    };
    const timer = setTimeout(() => {
      fail(new DeadlineExceededError(`decision-engine killed after ${timeoutMs}ms root-budget timeout`));
    }, timeoutMs);
    // Unref so a hung child cannot hold the event loop past process exit.
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      if (isTimeoutKill(err)) {
        fail(new DeadlineExceededError(`decision-engine timed out: ${err.message}`));
      } else if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        fail(new CoreAbsentError(`decision-engine binary absent: ${(err as Error).message}`));
      } else {
        fail(new BridgeFailedError(`decision-engine spawn error: ${(err as Error).message}`));
      }
    });
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal === 'SIGKILL' || signal === 'SIGTERM') {
        reject(new DeadlineExceededError(`decision-engine killed by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new BridgeFailedError(`decision-engine exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });
    try {
      child.stdin?.write(JSON.stringify(request));
      child.stdin?.end();
    } catch (err) {
      clearTimeout(timer);
      reject(new BridgeFailedError(`decision-engine stdin write failed: ${(err as Error).message}`));
    }
  });
}
