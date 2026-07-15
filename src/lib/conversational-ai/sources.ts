/**
 * Conversational-AI (Feature 52) data-source discovery + safe readers.
 *
 * The Round-3 OpenClaw skills emit per-client JSONL / Markdown logs into the
 * client's own OpenClaw workspace. Those skills land in parallel with this
 * dashboard, so EVERY reader here must degrade gracefully:
 *
 *   - source dir missing      -> empty result, `available: false`
 *   - file missing            -> empty result, `available: false`
 *   - file present but empty  -> empty result, `available: true`
 *   - malformed line          -> skipped (never throws)
 *
 * We NEVER fabricate numbers. An absent source yields an empty-state, not a
 * synthetic value.
 *
 * Discovery mirrors the candidate-root strategy already used by
 * src/app/api/onboarding/build-status/route.ts and src/lib/db/migrations.ts
 * so a client install resolves to exactly one workspace regardless of host
 * (Mac brew install vs Hostinger Docker vs bare VPS).
 */

import fs from 'fs';
import { safeReadFileUtf8, safeReaddirNames } from '@/lib/fs/safe-fs';
import path from 'path';
import os from 'os';

/**
 * Candidate roots that may contain the OpenClaw workspace for THIS client.
 * Order matters: the first existing root wins. Env override is always first.
 */
export function candidateWorkspaceRoots(): string[] {
  const roots: string[] = [];
  if (process.env.OPENCLAW_COMPANY_ROOT) roots.push(process.env.OPENCLAW_COMPANY_ROOT);
  if (process.env.OPENCLAW_WORKSPACE_ROOT) roots.push(process.env.OPENCLAW_WORKSPACE_ROOT);
  roots.push('/data/.openclaw/workspace');
  roots.push(path.join(os.homedir(), '.openclaw', 'workspace'));
  roots.push(path.join(os.homedir(), 'clawd'));
  roots.push(path.join(os.homedir(), 'Downloads', 'openclaw-master-files'));
  return roots;
}

/**
 * Relative locations (under a workspace root) where Round-3 skills write
 * their analytics logs. Each metric reader probes these subpaths in order.
 */
const SKILL_LOG_SUBDIRS = [
  '.', // root of workspace
  'company-discovery',
  'conversational-ai',
  'analytics',
  'skills/round-3',
];

/**
 * Resolve the first existing absolute path for a given relative log file by
 * probing every candidate root × every known subdir. Returns null if none
 * exist anywhere — callers MUST treat null as "source not present yet".
 */
export function resolveLogFile(relName: string): string | null {
  for (const root of candidateWorkspaceRoots()) {
    if (!safeExists(root)) continue;
    for (const sub of SKILL_LOG_SUBDIRS) {
      const candidate = path.join(root, sub, relName);
      if (safeExists(candidate) && safeIsFile(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the first existing directory (e.g. `pixel-events/`) across roots.
 */
export function resolveLogDir(relName: string): string | null {
  for (const root of candidateWorkspaceRoots()) {
    if (!safeExists(root)) continue;
    for (const sub of SKILL_LOG_SUBDIRS) {
      const candidate = path.join(root, sub, relName);
      if (safeExists(candidate) && safeIsDir(candidate)) return candidate;
    }
  }
  return null;
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function safeIsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface JsonlReadResult<T> {
  /** Whether the underlying source file/dir exists at all. */
  available: boolean;
  /** Parsed records (empty if unavailable or empty). */
  records: T[];
  /** Absolute path that was read (for debugging / the data-contract). */
  source: string | null;
  /** Count of lines that failed to parse and were skipped. */
  skipped: number;
}

/**
 * Read a newline-delimited JSON file safely. Never throws.
 *
 * @param relName  log file name, e.g. "interrupt-log.jsonl"
 * @param limit    optional cap on number of (most-recent) records returned
 */
export function readJsonl<T = Record<string, unknown>>(
  relName: string,
  limit?: number,
): JsonlReadResult<T> {
  const source = resolveLogFile(relName);
  if (!source) return { available: false, records: [], source: null, skipped: 0 };

  // safeReadFileUtf8 never blocks on a TCC-gated workspace root (~/Downloads is
  // a candidate): a raw open() there would hang forever. null → treat as the
  // prior catch branch (available but unreadable).
  const rawRead = safeReadFileUtf8(source);
  if (rawRead == null) {
    return { available: true, records: [], source, skipped: 0 };
  }
  const raw = rawRead;

  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const records: T[] = [];
  let skipped = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      skipped++;
    }
  }

  const out = limit && limit > 0 ? records.slice(-limit) : records;
  return { available: true, records: out, source, skipped };
}

/**
 * Read every *.jsonl file inside a directory (e.g. `pixel-events/`) and
 * concatenate their parsed records. Used for skills that shard their output
 * one file per day / per session. Never throws.
 */
export function readJsonlDir<T = Record<string, unknown>>(
  relDir: string,
  limit?: number,
): JsonlReadResult<T> {
  const dir = resolveLogDir(relDir);
  if (!dir) return { available: false, records: [], source: null, skipped: 0 };

  // safeReaddirNames never blocks on a TCC-gated workspace root; [] on absent/
  // blocked (matches the prior catch → available:true, records:[]).
  const entries = safeReaddirNames(dir).filter((f) => f.endsWith('.jsonl')).sort();

  const records: T[] = [];
  let skipped = 0;
  for (const file of entries) {
    const raw = safeReadFileUtf8(path.join(dir, file));
    if (raw == null) continue;
    for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        skipped++;
      }
    }
  }

  const out = limit && limit > 0 ? records.slice(-limit) : records;
  return { available: true, records: out, source: dir, skipped };
}

/**
 * Read a plain Markdown log (e.g. aggression-detection-log.md) and return its
 * line count + raw text. Round-3 emits some logs as Markdown append-lines.
 */
export function readMarkdownLog(relName: string): {
  available: boolean;
  source: string | null;
  lineCount: number;
  text: string;
} {
  const source = resolveLogFile(relName);
  if (!source) return { available: false, source: null, lineCount: 0, text: '' };
  // safeReadFileUtf8 never blocks on a TCC-gated workspace root.
  const textRead = safeReadFileUtf8(source);
  if (textRead == null) {
    return { available: true, source, lineCount: 0, text: '' };
  }
  const text = textRead;
  const lineCount = text.split('\n').filter((l) => l.trim()).length;
  return { available: true, source, lineCount, text };
}

/**
 * The canonical Round-3 data contract. Each entry is the file/dir name a
 * Round-3 skill emits, the metric family it feeds, and the reader to use.
 * This is the single source of truth documented in the card README.
 */
export const ROUND3_DATA_CONTRACT = [
  { name: 'pixel-events', kind: 'dir', metric: 'pixel-funnel', reader: 'readJsonlDir' },
  { name: 'aggression-detection-log.md', kind: 'md', metric: 'bot-spam-volume', reader: 'readMarkdownLog' },
  { name: 'interrupt-log.jsonl', kind: 'jsonl', metric: 'quiet-hours-impact', reader: 'readJsonl' },
  { name: 'geo-qualification-log.jsonl', kind: 'jsonl', metric: 'geo-qualification', reader: 'readJsonl' },
  { name: 'crm-field-writes-log.jsonl', kind: 'jsonl', metric: 'follow-up-performance', reader: 'readJsonl' },
  { name: 'faq-detour-log.jsonl', kind: 'jsonl', metric: 'kb-hit-rate', reader: 'readJsonl' },
  { name: 'real-estate-events.jsonl', kind: 'jsonl', metric: 'industry-funnel', reader: 'readJsonl' },
  { name: 'public-records-queries.jsonl', kind: 'jsonl', metric: 'public-records', reader: 'readJsonl' },
] as const;
