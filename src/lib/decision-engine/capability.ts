/**
 * JEV-009 CC bridge — installed-core capability detection.
 *
 * probeInstalledCore returns {compatible:true} ONLY on a successful version
 * handshake with the installed core. Every incompatible case returns a typed
 * CapabilityState plus a machine-readable reason; callers keep the existing
 * no-JEV selection path (this module detects, never removes the fallback).
 */

import { spawn } from 'child_process';
import { DECISION_SCHEMA_VERSION, schemaMajor } from './contract';
import { type BridgeDeadline, systemClock, type Clock } from './deadline';
import { CORE_PATH_ENV, DEFAULT_PYTHON_BIN, resolveCorePath, type CorePathSource } from './bridge';

export type CapabilityReason =
  | 'core_absent'
  | 'schema_major_mismatch'
  | 'handshake_failed';

export interface CapabilityState {
  compatible: boolean;
  coreVersion?: string;
  reason?: CapabilityReason;
  detail?: string;
}

export interface ProbeOptions {
  corePath?: string;
  corePathSource?: CorePathSource;
  pythonBin?: string;
  clock?: Clock;
  /** Cap on the probe spawn; defaults to remaining root budget. */
  timeoutMs?: number;
}

const PROBE_FLAG = '--capability';

export async function probeInstalledCore(
  deadline: BridgeDeadline,
  options: ProbeOptions = {},
): Promise<CapabilityState> {
  const clock: Clock = options.clock ?? systemClock;
  const source = options.corePathSource ?? {};
  const corePath = options.corePath ?? resolveCorePath(source);
  if (!corePath) {
    return { compatible: false, reason: 'core_absent', detail: 'core path unresolved' };
  }
  const spawnEnv = source.env ?? process.env;
  const budgetMs = options.timeoutMs ?? deadline.remainingMs(clock);
  if (budgetMs <= 0) {
    return { compatible: false, reason: 'handshake_failed', detail: 'root deadline exhausted before probe' };
  }
  const pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
  let payload: string;
  try {
    payload = await runProbeOnce(pythonBin, corePath, budgetMs, spawnEnv);
  } catch (err) {
    const message = (err as Error).message;
    if (/ENOENT|spawn|absent|can't open file|no such file/i.test(message)) {
      return { compatible: false, reason: 'core_absent', detail: message.slice(0, 300) };
    }
    return { compatible: false, reason: 'handshake_failed', detail: message.slice(0, 300) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { compatible: false, reason: 'handshake_failed', detail: 'core capability reply not JSON' };
  }
  const version =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (typeof version !== 'string' || version.length === 0) {
    return { compatible: false, reason: 'handshake_failed', detail: 'core capability reply absent schemaVersion' };
  }
  if (schemaMajor(version) !== schemaMajor(DECISION_SCHEMA_VERSION)) {
    return {
      compatible: false,
      reason: 'schema_major_mismatch',
      detail: `core ${version}, bridge ${DECISION_SCHEMA_VERSION}`,
    };
  }
  return { compatible: true, coreVersion: version };
}

/**
 * Typed capability-or-fallback carrier. JEV callers branch on `state`;
 * the no-JEV path (`fallback: true`) is the preserved existing selector.
 */
export interface SelectionPath {
  state: CapabilityState;
  useJev: boolean;
}

export function requiresNoJevFallback(state: CapabilityState): SelectionPath {
  return { state, useJev: state.compatible };
}

function runProbeOnce(pythonBin: string, corePath: string, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(pythonBin, [corePath, PROBE_FLAG], { stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch (err) {
      reject(err);
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
      fail(new Error(`capability probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
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
      if (signal) {
        reject(new Error(`capability probe killed by ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`capability probe exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export { CORE_PATH_ENV };
