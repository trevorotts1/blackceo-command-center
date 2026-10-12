/**
 * kie-live-adapter.ts — server-only.
 *
 * CC-KIE-3 (joint plan line 1069). The ONE KIE path for Operator Studio is
 * skill 74's `scripts/kie_live_adapter.py run`. This module locates the
 * installed skill on the box and drives its `run` command as a child process.
 *
 * WHY A CHILD PROCESS (not a fetch):
 *   CC-KIE-1 switched Studio's DIRECT KIE HTTP path OFF (decision 16). The
 *   fleet KIE contract is the skill 74 adapter: it owns validate -> createTask
 *   -> poll -> save, the paid door, the per-call mode gate, the credit check
 *   and the redaction. Studio must go THROUGH it, never reimplement it. A
 *   second KIE client in Studio is exactly the drift the adapter exists to
 *   prevent.
 *
 * LOCATING THE SKILL: a client box installs skills under its own skills root,
 * which differs per platform — the resolver below MIRRORS the existing
 * `podcastSkillRoots()` in `src/lib/capability-manifest.ts` (the way Command
 * Center already resolves an installed skill's path). There is NO hard-coded
 * operator path.
 *
 * SAFETY (all fail-closed):
 *   - the child is spawned with `execFile('python3', argv)` — an ARGV ARRAY,
 *     never a shell, so the prompt/model can never be interpreted as shell.
 *   - the key is passed by ENVIRONMENT ONLY (`KIE_API_KEY`), never on argv,
 *     never in the request file, never logged.
 *   - a missing adapter or a missing key is a REFUSAL, not a live attempt.
 *   - a non-zero exit or a non-success JSON state is a REFUSAL — a partial or
 *     skipped run is never reported as a produced asset.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { detectPlatform } from '@/lib/platform';

/** Installed skill folder name (onboarding + 999-setup both use this name). */
export const KIE_SKILL_DIR = '74-kie-live-adapter';

/** The adapter entrypoint, relative to the skill folder. */
export const KIE_ADAPTER_REL = path.join('scripts', 'kie_live_adapter.py');

/**
 * On-box skill-install roots for skill 74, per platform. Mirrors
 * `podcastSkillRoots()` (src/lib/capability-manifest.ts) so every installed
 * skill resolves through the same layout — never a hard-coded operator path.
 */
export function kieSkill74Roots(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (detectPlatform() === 'vps-docker') {
    return [
      '/data/.openclaw/skills/' + KIE_SKILL_DIR,
      '/data/.openclaw/workspace/openclaw-onboarding/skills/' + KIE_SKILL_DIR,
      path.join('/data/.openclaw', 'skills', KIE_SKILL_DIR),
    ];
  }
  return [
    path.join(home, '.openclaw', 'skills', KIE_SKILL_DIR),
    path.join(home, '.claude', 'skills', KIE_SKILL_DIR),
    path.join(home, 'clawd', 'skills', KIE_SKILL_DIR),
    path.join(home, '.openclaw', 'workspace', 'openclaw-onboarding', KIE_SKILL_DIR),
    path.join(home, '.openclaw', 'workspace', 'openclaw-onboarding', 'skills', KIE_SKILL_DIR),
  ];
}

/**
 * Absolute path to the installed `kie_live_adapter.py`, or null when skill 74
 * is not installed on this box. Probe only — no execution, never throws.
 */
export function findKieLiveAdapterPath(): string | null {
  for (const root of kieSkill74Roots()) {
    const candidate = path.join(root, KIE_ADAPTER_REL);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* probe best-effort */
    }
  }
  return null;
}

/**
 * The KIE key, from the environment. Mirrors `hasApiKey('kie.ai')` in
 * generators.ts: the box uses `KIE_API_KEY`; the historical spellings are
 * accepted. NEVER logged or returned to a caller outside this module.
 */
export function kieApiKey(): string | undefined {
  return (
    process.env.KIE_API_KEY ||
    process.env.KIEAI_API_KEY ||
    process.env.KIE_AI_API_KEY ||
    undefined
  );
}

/** Adapter file present AND key present — the exact two conditions CC-KIE-3 names. */
export function kieStudioAvailable(): boolean {
  return findKieLiveAdapterPath() !== null && Boolean(kieApiKey());
}

/**
 * The fail-closed reason Studio KIE cannot run, or null when it can. Used by
 * `createJob()` and the adapter call site so availability is decided the same
 * way in both places.
 */
export function kieStudioRefusalReason(): string | null {
  if (!findKieLiveAdapterPath()) {
    return (
      'KIE Studio is unavailable: skill 74 (' +
      KIE_SKILL_DIR +
      '/scripts/kie_live_adapter.py) is not installed on this box. ' +
      'Nothing is submitted, polled or spent.'
    );
  }
  if (!kieApiKey()) {
    return (
      'KIE Studio is unavailable: no KIE API key is set (KIE_API_KEY). ' +
      'Nothing is submitted, polled or spent.'
    );
  }
  return null;
}

export interface KieLiveAdapterResult {
  /** Adapter `state`: success | fail | skipped | validated | queued | running. */
  state: string;
  taskId: string | null;
  modelId: string | null;
  resultUrls: string[];
  savedPaths: string[];
  creditsConsumed: number | null;
  warnings: string[];
  fallbackUsed: boolean;
  /** Human-readable failure text (redacted by the adapter). */
  error: string | null;
  /** The child's exit code (-1 when the process could not be spawned). */
  exitCode: number;
  raw: Record<string, unknown>;
}

export interface KieLiveAdapterRunInput {
  /** Absolute path to kie_live_adapter.py (from findKieLiveAdapterPath()). */
  adapterPath: string;
  /** The KIE key. Passed BY ENVIRONMENT ONLY. */
  key: string;
  /** `{"model": "<exact id>", "input": {...}}` — the adapter's request contract. */
  request: Record<string, unknown>;
  /** Directory the adapter saves produced files into (real output tree). */
  saveDir: string;
  /** Adapter poll timeout, seconds (passed as --timeout). */
  runTimeoutSec: number;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
}

/**
 * Run skill 74's adapter: `python3 <adapter> run --request <file> --save-dir
 * <dir> --mode active --timeout <s> --json`.
 *
 * argv array (no shell), key by environment only. Returns the parsed JSON
 * result plus the child's exit code; never throws for a non-zero exit so the
 * caller decides the refusal (fail-closed) from `state`/`exitCode`.
 */
export async function runKieLiveAdapter(input: KieLiveAdapterRunInput): Promise<KieLiveAdapterResult> {
  const reqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kie74-'));
  const reqFile = path.join(reqDir, 'request.json');
  const request = input.request;
  await fs.promises.writeFile(reqFile, JSON.stringify(request), 'utf8');

  const argv = [
    input.adapterPath,
    'run',
    '--request',
    reqFile,
    '--save-dir',
    input.saveDir,
    // Active mode: Studio is the operator's explicit paid entry, and
    // availability (adapter + key, checked by the caller) is the fail-closed
    // gate. The adapter's default `shadow` would return `skipped` and never
    // produce an asset, so an "available" Studio KIE would be a lie.
    '--mode',
    'active',
    '--timeout',
    String(input.runTimeoutSec),
    '--json',
  ];

  const execTimeoutMs = (input.runTimeoutSec + 120) * 1000;
  const outcome = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'python3',
      argv,
      {
        // Key BY ENVIRONMENT ONLY — never argv, never the request file.
        env: { ...process.env, KIE_API_KEY: input.key },
        timeout: execTimeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === 'string'
            ? -1
            : ((err as { code?: number } | null)?.code ?? 0);
        resolve({ code: typeof code === 'number' ? code : -1, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });

  try {
    await fs.promises.rm(reqDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }

  let parsed: Record<string, unknown> = {};
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(outcome.stdout.trim()) as Record<string, unknown>;
  } catch {
    parseError = 'adapter returned no parseable JSON result';
  }

  const state = typeof parsed.state === 'string' ? parsed.state : parseError ? 'fail' : 'unknown';
  const warnings = asStringArray(parsed.warnings);
  const errObj = toRecord(parsed.error);
  const errMsg =
    typeof errObj.msg === 'string'
      ? errObj.msg
      : parseError ?? (outcome.stderr.trim().slice(0, 400) || null);

  return {
    state,
    taskId: typeof parsed.task_id === 'string' ? parsed.task_id : null,
    modelId: typeof parsed.model_id === 'string' ? parsed.model_id : null,
    resultUrls: asStringArray(parsed.result_urls),
    savedPaths: asStringArray(parsed.saved_paths),
    creditsConsumed: typeof parsed.credits_consumed === 'number' ? parsed.credits_consumed : null,
    warnings,
    fallbackUsed: parsed.fallback_used === true,
    error: errMsg,
    exitCode: outcome.code,
    raw: parsed,
  };
}
