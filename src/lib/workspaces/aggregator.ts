/**
 * Workspace aggregator , per-agent scratch directory listing.
 *
 * Track B3 (Operator Console Workspace sub-module, PRD Section 4.4).
 *
 * The Operator Console Workspace presents a unified "By Agent" view that
 * spans every operator-level CLI scratch root. This module owns the
 * cross-agent file discovery; the "By Type" buckets view (Addition 2)
 * is built on top of this aggregator in `./buckets.ts`.
 *
 * Scratch roots come from `operatorScratchRoot()` in `src/lib/platform.ts`.
 * Each agent gets its own subdirectory underneath that root.
 *
 * Security: every read goes through `resolveSafe()` which hard-restricts
 * paths to the scratch root for the requested agent (catch-all "..", symlink
 * escape, and absolute-path escape are all rejected).
 */

import { readdir, readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { operatorScratchRoot } from '@/lib/platform';

export const OPERATOR_AGENTS = [
  'claude',
  'codex',
  'antigravity',
  'hermes',
  'gemini',
  'fcc',
  'openclaw',
] as const;

export type OperatorAgent = (typeof OPERATOR_AGENTS)[number];

export type WorkspaceFileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'markdown'
  | 'text'
  | 'code'
  | 'app'
  | 'binary';

export interface WorkspaceFile {
  /** Bare filename, used as a display label. */
  name: string;
  /** Path relative to the agent's scratch root (forward slashes on every OS). */
  relPath: string;
  /** Absolute path on disk (only used server-side; never returned to clients). */
  absPath: string;
  /** Owning agent slug. */
  agent: OperatorAgent;
  /** Size in bytes. */
  bytes: number;
  /** Last-modified time in ms since epoch. */
  mtime: number;
  /** Categorized file kind for the preview/buckets layer. */
  kind: WorkspaceFileKind;
  /** Lowercase extension including the leading dot (".png", ".md", ""). */
  ext: string;
}

export interface AgentScratch {
  agent: OperatorAgent;
  root: string;
  exists: boolean;
  fileCount: number;
  files: WorkspaceFile[];
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.sh', '.bash', '.zsh',
  '.json', '.yaml', '.yml', '.toml',
  '.css', '.scss', '.less',
  '.rs', '.go', '.rb', '.java', '.c', '.cpp', '.h', '.hpp',
  '.sql',
]);
const TEXT_EXTS = new Set(['.txt', '.log', '.csv', '.tsv', '.env', '.xml']);
const MARKDOWN_EXTS = new Set(['.md', '.markdown']);
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', '__pycache__', '.next',
  'dist', 'build', '.cache', '.turbo',
]);

const MAX_FILES_PER_AGENT = 500;
const MAX_WALK_DEPTH = 6;

export function classifyFile(filename: string): { kind: WorkspaceFileKind; ext: string } {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return { kind: 'image', ext };
  if (VIDEO_EXTS.has(ext)) return { kind: 'video', ext };
  if (AUDIO_EXTS.has(ext)) return { kind: 'audio', ext };
  if (ext === '.pdf') return { kind: 'pdf', ext };
  if (MARKDOWN_EXTS.has(ext)) return { kind: 'markdown', ext };
  if (CODE_EXTS.has(ext)) return { kind: 'code', ext };
  if (TEXT_EXTS.has(ext)) return { kind: 'text', ext };
  if (ext === '.html' || ext === '.htm') return { kind: 'code', ext };
  return { kind: 'binary', ext };
}

function isOperatorAgent(slug: string): slug is OperatorAgent {
  return (OPERATOR_AGENTS as readonly string[]).includes(slug);
}

export function agentScratchRoot(agent: OperatorAgent): string {
  return path.join(operatorScratchRoot(), agent);
}

async function safeStat(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/**
 * Resolve a relative path under an agent's scratch root, rejecting any
 * attempt to escape via ".." or absolute paths. Returns null on rejection.
 */
export function resolveSafe(agent: OperatorAgent, relPath: string): string | null {
  const base = agentScratchRoot(agent);
  // Reject empty, absolute, or NUL-containing inputs outright.
  if (!relPath || relPath.includes('\0')) return null;
  const abs = path.resolve(base, relPath);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/**
 * Walk an agent's scratch directory and return every file (capped).
 *
 * Directories containing `index.html` are flagged as "apps" in the buckets
 * aggregation step; the per-file classification in this function only sees
 * one file at a time, so the app detection runs in `buckets.ts`.
 */
export async function walkAgentScratch(agent: OperatorAgent): Promise<AgentScratch> {
  const root = agentScratchRoot(agent);
  if (!existsSync(root)) {
    return { agent, root, exists: false, fileCount: 0, files: [] };
  }

  const files: WorkspaceFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (files.length >= MAX_FILES_PER_AGENT || depth > MAX_WALK_DEPTH) return;
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (files.length >= MAX_FILES_PER_AGENT) break;
      if (SKIP_DIRS.has(it.name)) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) {
        await walk(full, depth + 1);
      } else if (it.isFile()) {
        const st = await safeStat(full);
        if (!st) continue;
        const { kind, ext } = classifyFile(it.name);
        const rel = path.relative(root, full).split(path.sep).join('/');
        files.push({
          name: it.name,
          relPath: rel,
          absPath: full,
          agent,
          bytes: st.size,
          mtime: st.mtimeMs,
          kind,
          ext,
        });
      }
    }
  }
  await walk(root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return { agent, root, exists: true, fileCount: files.length, files };
}

export async function ensureAgentScratch(agent: OperatorAgent): Promise<string> {
  const root = agentScratchRoot(agent);
  if (!existsSync(root)) await mkdir(root, { recursive: true });
  return root;
}

/**
 * Walk every operator agent's scratch root in parallel.
 */
export async function walkAllAgents(): Promise<AgentScratch[]> {
  const out = await Promise.all(OPERATOR_AGENTS.map((a) => walkAgentScratch(a)));
  return out;
}

/**
 * Read a single file under an agent's scratch root. Refuses to read files
 * larger than `maxBytes` (default 2MB) to keep the preview API responsive.
 */
export async function readAgentFile(
  agent: OperatorAgent,
  relPath: string,
  maxBytes = 2_000_000
): Promise<
  | {
      ok: true;
      relPath: string;
      absPath: string;
      bytes: number;
      mtime: number;
      content: string;
      truncated: boolean;
      kind: WorkspaceFileKind;
      ext: string;
    }
  | { ok: false; reason: 'forbidden' | 'not_found' | 'not_a_file' }
> {
  const abs = resolveSafe(agent, relPath);
  if (!abs) return { ok: false, reason: 'forbidden' };
  const st = await safeStat(abs);
  if (!st) return { ok: false, reason: 'not_found' };
  if (!st.isFile()) return { ok: false, reason: 'not_a_file' };
  const { kind, ext } = classifyFile(path.basename(abs));
  const truncated = st.size > maxBytes;
  const buf = await readFile(abs);
  const trimmed = truncated ? buf.subarray(0, maxBytes) : buf;
  // Only stringify text-like formats; binary kinds get an empty body and the
  // caller is expected to fall back to a streaming preview endpoint.
  const isTextLike =
    kind === 'markdown' || kind === 'text' || kind === 'code' || ext === '.html' || ext === '.htm' || ext === '.svg';
  const content = isTextLike ? trimmed.toString('utf8') : '';
  return {
    ok: true,
    relPath,
    absPath: abs,
    bytes: st.size,
    mtime: st.mtimeMs,
    content,
    truncated,
    kind,
    ext,
  };
}

/** Narrow a raw string into an `OperatorAgent` or return null. */
export function parseAgentSlug(input: string | null | undefined): OperatorAgent | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  return isOperatorAgent(lower) ? lower : null;
}
