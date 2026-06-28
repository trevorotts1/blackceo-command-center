/**
 * context-pack.ts — Server-only.  W4.2 (ZHE spec §4: FULL-CONTEXT HANDOFF).
 *
 * "When the CEO routes a task to a department/specialist, it MUST hand over
 *  everything needed to do the job in excellence — the specific bits from
 *  AGENTS.md / TOOLS.md / MEMORY.md the receiving agent needs, AND pointer
 *  references to specialized documentation: *here is WHERE the documentation you
 *  need lives*."  (spec §4)
 *
 * This module assembles a typed `ContextPack` from:
 *   • task-targeted EXCERPTS of the receiving department/specialist's core
 *     files (AGENTS.md / TOOLS.md / MEMORY.md) — never a whole-file re-dump.
 *   • POINTER references resolved per-platform to where the docs actually live:
 *       - the dept's `how-to-use-this-department.md` + the role `how-to.md`
 *       - the OpenClaw master files (AGENTS/TOOLS/MEMORY) on THIS box
 *       - the teach-yourself protocol doc
 *       - the resolved SOP (+ any SOP `references`/`doc_index` once W4.3 lands)
 *       - research sources keyed by specialist type / department domain
 *   • the optional `context_refs` carried on the ingest payload (W4.1).
 *
 * The receiving agent therefore never starts blind: it is told what the routing
 * agent knows AND where to read the rest.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTEGRATION POINTS (wired in at integration time — this file is net-new):
 *
 *   1. src/lib/task-dispatcher.ts  →  autoDispatchTask()
 *        Call `buildContextPack({...})` BETWEEN the SOP block assembly
 *        (task-dispatcher.ts:427-457, after `sopBlock` is built) and the
 *        `taskMessage` template assembly (task-dispatcher.ts:474). Then splice
 *        `renderContextPackSection(pack)` into `taskMessage` immediately after
 *        the `${artifactFragment}` line (task-dispatcher.ts:501). Locals already
 *        in scope at that point: `task`, `agent`, `specialistType` (line 311),
 *        `settings`, the resolved `sop` (line 429) / `resolvedSopId`.
 *
 *   2. src/app/api/tasks/[id]/dispatch/route.ts  →  POST handler
 *        Same call, for MANUAL-dispatch parity. Locals in scope mirror the
 *        auto path: `task`, `agent`, `specialistType` (route.ts:resolveSpecialistType),
 *        `sop`. Append `renderContextPackSection(pack)` to that route's
 *        `taskMessage` so an operator-clicked dispatch carries the same pointers.
 *
 *   3. src/app/api/tasks/ingest/route.ts  →  IngestPayload (route.ts:50-72)
 *        Add an optional `context_refs?: unknown` field to `IngestPayload`,
 *        validate it to `string[]` next to the other field parsers
 *        (route.ts:263-272), persist via `tasks.ts createTaskCore`, and pass it
 *        through here as `input.contextRefs` so CEO-supplied doc pointers ride
 *        the handoff. (W4.1 — not built by this file; consumed here if present.)
 *
 * This file is STANDALONE and integration-ready: it imports only real modules
 * (@/lib/db, @/lib/platform, @/lib/sops, @/lib/types) with their current
 * signatures, never throws (degrades to a general index — W4 edge case: a custom
 * dept with no canonical SOP still gets teach-yourself + master-file pointers),
 * and is synchronous so it adds no await latency on the dispatch hot path.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { queryOne } from '@/lib/db';
import { detectPlatform, vaultRoot, zhcLibraryBaseDirs } from '@/lib/platform';
import type { SOP } from '@/lib/sops';
import type { Agent, Task } from '@/lib/types';

/** Bump when the ContextPack shape changes (mirrors the *_V1 marker convention). */
export const CONTEXT_PACK_VERSION = 1;

/** How a pointer should be read by the receiving agent. */
export type DocPointerKind =
  | 'dept-how-to'        // how-to-use-this-department.md for the routed dept
  | 'role-how-to'        // the specialist role's how-to.md
  | 'sop'                // the resolved SOP (full structured steps live in the DB / SOP doc)
  | 'master-file'        // OpenClaw core file on THIS box (AGENTS/TOOLS/MEMORY)
  | 'teach-yourself'     // the teach-yourself protocol
  | 'research-source'    // where to research for this specialist type
  | 'context-ref';       // an explicit pointer the CEO attached to the task

/** A "here is WHERE the documentation lives" pointer. */
export interface DocPointer {
  kind: DocPointerKind;
  label: string;          // human-readable name
  location: string;       // absolute path, URL, or a stable descriptor
  why?: string;           // why it matters for THIS task
  /** true when `location` is a filesystem path that exists on this box right now. */
  resolvable: boolean;
}

/** A task-targeted excerpt from one of the receiving agent's core files. */
export interface CoreFileExcerpt {
  source: 'AGENTS.md' | 'TOOLS.md' | 'MEMORY.md';
  /** Short, keyword-targeted snippet — NOT the whole file. */
  excerpt: string;
  /** Where the FULL file lives, so the agent can read past the excerpt. */
  pointer: string;
  /** true when `pointer` resolves on disk. */
  pointerResolvable: boolean;
}

/** The typed handoff the dispatcher attaches so a receiving agent never starts blind. */
export interface ContextPack {
  version: number;
  task_id: string;
  department: string | null;
  specialist_type: string;
  platform: string;
  generated_at: string;
  /** Relevant specifics pulled from the box's AGENTS.md / TOOLS.md / MEMORY.md. */
  core_excerpts: CoreFileExcerpt[];
  /** Pointer references — where the documentation the agent needs lives. */
  doc_pointers: DocPointer[];
  /** Research sources keyed by specialist type / department domain. */
  research_sources: DocPointer[];
  /** At least one doc pointer resolved on disk (the §4 DONE acceptance condition). */
  has_resolvable_pointer: boolean;
  /** Non-fatal degradations (missing dept dir, no SOP, etc.) for observability. */
  notes: string[];
}

/** Input shape — matches the locals available at the dispatch call sites. */
export interface BuildContextPackInput {
  task: Pick<Task, 'id' | 'title' | 'description' | 'department' | 'workspace_id'>;
  /**
   * The receiving specialist/department-head agent row. `*_md` columns are the
   * dept's mirrored core files; when present we excerpt them directly (no I/O).
   */
  agent: Pick<Agent, 'id' | 'name' | 'role'> &
    Partial<Pick<Agent, 'agents_md' | 'tools_md' | 'memory_md' | 'workspace_id'>>;
  /** From resolveSpecialistType(agent) — 'permanent' | 'on-call' or a type string. */
  specialistType: string;
  /** The SOP already resolved at dispatch (task-dispatcher.ts:429). Optional. */
  sop?: Pick<SOP, 'id' | 'name' | 'department' | 'role'> & {
    /** W4.3 — optional doc-location pointers carried on the SOP once that lands. */
    references?: string | string[] | null;
    doc_index?: string | string[] | null;
  } | null;
  /** W4.1 — optional doc pointers the CEO attached to the ingest payload. */
  contextRefs?: string[] | string | null;
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

/** OpenClaw agents root, mirroring task-dispatcher.ts:87-91. */
function agentsRoot(): string {
  if (detectPlatform() === 'vps-docker') return '/data/.openclaw/agents';
  return path.join(homeDir(), '.openclaw', 'agents');
}

/** Slugify the same way the dispatcher does (task-dispatcher.ts:127,137). */
function slugify(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** First existing path among candidates, else the first candidate (best-effort pointer). */
function firstExisting(candidates: string[]): { path: string; resolvable: boolean } {
  for (const c of candidates) {
    if (c && existsSafe(c)) return { path: c, resolvable: true };
  }
  return { path: candidates.find(Boolean) ?? '', resolvable: false };
}

/**
 * Resolve the receiving agent's OpenClaw runtime directory on THIS box, using
 * the SAME probe order as task-dispatcher.ts resolveSpecialistSessionKey
 * (workspace slug → dept-<slug> / bare, role slug → dept-<role>, name slug).
 * Returns the dir + whether it exists, so master-file pointers land on the
 * agent's actual symlinked AGENTS/TOOLS/MEMORY.
 */
function resolveAgentRuntimeDir(
  agent: BuildContextPackInput['agent'],
  workspaceId: string | null | undefined,
): { dir: string; resolvable: boolean } {
  const root = agentsRoot();
  const candidates: string[] = [];

  if (workspaceId) {
    try {
      const ws = queryOne<{ slug: string }>(
        'SELECT slug FROM workspaces WHERE id = ? LIMIT 1',
        [workspaceId],
      );
      if (ws?.slug) {
        const s = ws.slug.toLowerCase();
        candidates.push(path.join(root, `dept-${s}`));
        candidates.push(path.join(root, s));
      }
    } catch {
      /* non-fatal — fall through to role/name slugs */
    }
  }
  if (agent.role) candidates.push(path.join(root, `dept-${slugify(agent.role)}`));
  if (agent.name) candidates.push(path.join(root, slugify(agent.name)));

  return { dir: firstExisting(candidates).path, resolvable: firstExisting(candidates).resolvable };
}

/**
 * Probe the per-company ZHC library for this department's dir (where
 * how-to-use-this-department.md + role how-to.md are materialized). Uses
 * zhcLibraryBaseDirs() (platform.ts) so it resolves per-platform.
 */
function resolveDeptLibraryDir(deptSlug: string | null): { dir: string; resolvable: boolean } {
  if (!deptSlug) return { dir: '', resolvable: false };
  const slug = deptSlug.toLowerCase();
  const candidates: string[] = [];
  for (const base of zhcLibraryBaseDirs()) {
    // v9.6.0+ per-company layout and legacy flat layout both probed.
    candidates.push(path.join(base, 'departments', slug));
    candidates.push(path.join(base, 'departments', `dept-${slug}`));
    candidates.push(path.join(base, 'role-library', slug));
    candidates.push(path.join(base, slug));
  }
  const hit = firstExisting(candidates);
  return { dir: hit.path, resolvable: hit.resolvable };
}

// ── Core-file excerpting (task-targeted; NOT a whole-file re-dump) ────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'this',
  'that', 'your', 'you', 'it', 'is', 'are', 'be', 'do', 'does', 'task', 'new',
]);

function keywordsFromTask(task: BuildContextPackInput['task']): string[] {
  const haystack = `${task.title ?? ''} ${task.description ?? ''} ${task.department ?? ''}`;
  return Array.from(
    new Set(
      haystack
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
    ),
  );
}

/**
 * Pull the most task-relevant short blocks out of a core-file string. Splits on
 * blank lines, scores each block by keyword overlap, returns the top blocks
 * (capped) so we hand a curated excerpt — never the whole symlinked file
 * (W4 edge case: must NOT re-dump shared files).
 */
function excerptCoreFile(
  content: string | null | undefined,
  keywords: string[],
  maxBlocks = 2,
  maxCharsPerBlock = 600,
): string {
  if (!content || !content.trim()) return '';
  const blocks = content
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
  if (blocks.length === 0) return '';

  const scored = blocks.map((block) => {
    const lower = block.toLowerCase();
    let score = 0;
    for (const kw of keywords) if (lower.includes(kw)) score += 1;
    // Prefer headed sections slightly so the excerpt is self-describing.
    if (/^#{1,6}\s/.test(block)) score += 0.25;
    return { block, score };
  });

  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxBlocks)
    // Fall back to the leading block when nothing matched, so there is always
    // some grounding context rather than an empty excerpt.
    .map((s) => s.block);

  const chosen = top.length > 0 ? top : [scored[0].block];
  return chosen
    .map((b) => (b.length > maxCharsPerBlock ? `${b.slice(0, maxCharsPerBlock)}…` : b))
    .join('\n\n');
}

// ── Research-source map (keyed by specialist type / dept domain) ──────────────

/**
 * Deterministic, honest research-source pointers keyed by department-domain
 * keywords. No fabrication — these point at protocols/files that ship with the
 * workforce. The teach-yourself protocol is always included as the baseline
 * "learn what you don't know" source.
 */
function researchSourcesFor(
  deptSlug: string | null,
  specialistType: string,
  teachYourself: DocPointer,
): DocPointer[] {
  const sources: DocPointer[] = [teachYourself];
  const hay = `${deptSlug ?? ''} ${specialistType}`.toLowerCase();

  const add = (label: string, why: string) =>
    sources.push({
      kind: 'research-source',
      label,
      location: 'see dept TOOLS.md "Research" section + Command Center research store',
      why,
      resolvable: false,
    });

  if (/research|analyst|intelligence|data/.test(hay)) {
    add('Deep-research protocol', 'this is a research-led specialty — verify across multiple sources before writing.');
  }
  if (/engineer|develop|app|web|systems|qa|qc/.test(hay)) {
    add('Library/API docs (context7 + TOOLS.md)', 'fetch current docs for any library/API before coding — do not rely on memory.');
  }
  if (/market|content|social|copy|brand|communications/.test(hay)) {
    add('Brand voice + persona-matching protocol', 'match message/voice to the audience; the persona match guides tone.');
  }
  return sources;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Assemble the full-context handoff pack for a routed task. Never throws.
 */
export function buildContextPack(input: BuildContextPackInput): ContextPack {
  const notes: string[] = [];
  const generated_at = new Date().toISOString();
  const platform = detectPlatform();
  const deptSlug = (input.task.department ?? input.agent.role ?? null) || null;
  const keywords = keywordsFromTask(input.task);

  const doc_pointers: DocPointer[] = [];
  const core_excerpts: CoreFileExcerpt[] = [];

  try {
    // 1) Receiving agent's OpenClaw runtime dir → master-file pointers on THIS box.
    const runtime = resolveAgentRuntimeDir(input.agent, input.agent.workspace_id ?? input.task.workspace_id);
    const runtimeDir = runtime.dir || path.join(agentsRoot(), 'dept-' + slugify(deptSlug ?? input.agent.name));
    if (!runtime.resolvable) {
      notes.push(`agent runtime dir not found on disk (probed under ${agentsRoot()}); master-file pointers are best-effort`);
    }

    const masterFiles: Array<CoreFileExcerpt['source']> = ['AGENTS.md', 'TOOLS.md', 'MEMORY.md'];
    const dbContent: Record<CoreFileExcerpt['source'], string | null | undefined> = {
      'AGENTS.md': input.agent.agents_md,
      'TOOLS.md': input.agent.tools_md,
      'MEMORY.md': input.agent.memory_md,
    };

    for (const file of masterFiles) {
      const filePath = path.join(runtimeDir, file);
      const fileResolvable = existsSafe(filePath);

      // Master-file POINTER (always emitted — "the full file lives here").
      doc_pointers.push({
        kind: 'master-file',
        label: `${file} (your department core file)`,
        location: filePath,
        why:
          file === 'TOOLS.md'
            ? 'which tools/integrations you may use and how'
            : file === 'MEMORY.md'
              ? 'standing context, decisions, and lessons for this department'
              : 'your operating doctrine: routing, reporting, persona reflex, platform facts',
        resolvable: fileResolvable,
      });

      // Task-targeted EXCERPT from the mirrored DB copy, when present.
      const excerpt = excerptCoreFile(dbContent[file], keywords);
      if (excerpt) {
        core_excerpts.push({
          source: file,
          excerpt,
          pointer: filePath,
          pointerResolvable: fileResolvable,
        });
      }
    }

    // 2) Dept how-to + role how-to from the ZHC library (per-platform).
    const deptLib = resolveDeptLibraryDir(deptSlug);
    if (deptSlug) {
      const deptHowTo = firstExisting([
        path.join(deptLib.dir, 'how-to-use-this-department.md'),
        path.join(deptLib.dir, 'HOW-TO-USE-THIS-DEPARTMENT.md'),
      ]);
      doc_pointers.push({
        kind: 'dept-how-to',
        label: 'how-to-use-this-department.md',
        location: deptHowTo.path || `${deptLib.dir || '<zhc-library>/departments/' + deptSlug}/how-to-use-this-department.md`,
        why: 'how this department operates end-to-end and when to use each role',
        resolvable: deptHowTo.resolvable,
      });

      // Role-specific how-to.md (specialist playbook), if the role is known.
      if (input.agent.role) {
        const roleHowTo = firstExisting([
          path.join(deptLib.dir, slugify(input.agent.role), 'how-to.md'),
          path.join(deptLib.dir, 'how-to.md'),
        ]);
        doc_pointers.push({
          kind: 'role-how-to',
          label: `${input.agent.role} — how-to.md`,
          location: roleHowTo.path || `${deptLib.dir || '<zhc-library>'}/${slugify(input.agent.role)}/how-to.md`,
          why: 'the specialist playbook for your exact role',
          resolvable: roleHowTo.resolvable,
        });
      }
      if (!deptLib.resolvable) {
        notes.push(`ZHC library dir for "${deptSlug}" not resolved on disk; dept/role how-to pointers are descriptors`);
      }
    } else {
      notes.push('no department/role on task — emitting general index only (custom-dept / bare-task edge case)');
    }

    // 3) The resolved SOP pointer + any SOP-carried references (W4.3, optional).
    if (input.sop) {
      doc_pointers.push({
        kind: 'sop',
        label: `SOP: ${input.sop.name}`,
        location: `Command Center sops table (id: ${input.sop.id})`,
        why: 'the exact procedure + success criteria for this task (steps embedded in the dispatch)',
        resolvable: true, // the SOP is in the DB and its steps are inlined in the message
      });
      for (const ref of normalizeRefs(input.sop.references)) {
        doc_pointers.push(makeRefPointer('sop', `SOP reference: ${path.basename(ref)}`, ref, 'doc the SOP says you need'));
      }
      for (const ref of normalizeRefs(input.sop.doc_index)) {
        doc_pointers.push(makeRefPointer('sop', `SOP doc-index: ${path.basename(ref)}`, ref, 'indexed doc location for this SOP'));
      }
    } else {
      notes.push('no SOP resolved for this task — general index emitted so the specialist still has pointers');
    }

    // 4) Teach-yourself protocol — always available baseline.
    const teachYourself = resolveTeachYourselfPointer();
    doc_pointers.push(teachYourself);

    // 5) CEO-attached context_refs (W4.1).
    for (const ref of normalizeRefs(input.contextRefs)) {
      doc_pointers.push(makeRefPointer('context-ref', `Owner/CEO ref: ${path.basename(ref) || ref}`, ref, 'extra pointer the CEO attached'));
    }

    // 6) Research sources keyed by specialist type / dept domain.
    const research_sources = researchSourcesFor(deptSlug, input.specialistType, teachYourself);

    const has_resolvable_pointer =
      doc_pointers.some((p) => p.resolvable) || research_sources.some((p) => p.resolvable);
    if (!has_resolvable_pointer) {
      notes.push('WARNING: no doc pointer resolved on disk — handoff carries descriptors only (W4.5 would flag this)');
    }

    return {
      version: CONTEXT_PACK_VERSION,
      task_id: input.task.id,
      department: deptSlug,
      specialist_type: input.specialistType,
      platform,
      generated_at,
      core_excerpts,
      doc_pointers,
      research_sources,
      has_resolvable_pointer,
      notes,
    };
  } catch (err) {
    // Never throw on the dispatch hot path — return a minimal but valid pack.
    notes.push(`buildContextPack degraded: ${(err as Error).message}`);
    const teachYourself = resolveTeachYourselfPointer();
    return {
      version: CONTEXT_PACK_VERSION,
      task_id: input.task.id,
      department: deptSlug,
      specialist_type: input.specialistType,
      platform,
      generated_at,
      core_excerpts,
      doc_pointers: doc_pointers.length ? doc_pointers : [teachYourself],
      research_sources: [teachYourself],
      has_resolvable_pointer: teachYourself.resolvable,
      notes,
    };
  }
}

/**
 * Render the ContextPack as the "Reference Docs / Where to find what you need"
 * section spliced into the dispatch message (task-dispatcher.ts:501 / the manual
 * dispatch route). Deterministic markdown; safe to concatenate into `taskMessage`.
 */
export function renderContextPackSection(pack: ContextPack): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('**📚 REFERENCE DOCS — where the documentation you need lives:**');

  // Core-file excerpts first (the bits the routing agent knows you need).
  if (pack.core_excerpts.length > 0) {
    lines.push('');
    lines.push('_Relevant from your department core files:_');
    for (const ex of pack.core_excerpts) {
      lines.push(`- **${ex.source}** (full file: \`${ex.pointer}\`):`);
      for (const l of ex.excerpt.split('\n')) lines.push(`  > ${l}`);
    }
  }

  // Pointers.
  if (pack.doc_pointers.length > 0) {
    lines.push('');
    lines.push('_Pointers (read these where indicated):_');
    for (const p of pack.doc_pointers) {
      const mark = p.resolvable ? '✓' : '→';
      lines.push(`- ${mark} **${p.label}** — \`${p.location}\`${p.why ? ` — ${p.why}` : ''}`);
    }
  }

  // Research sources.
  if (pack.research_sources.length > 0) {
    lines.push('');
    lines.push('_If you need to research:_');
    for (const r of pack.research_sources) {
      lines.push(`- **${r.label}** — ${r.location}${r.why ? ` — ${r.why}` : ''}`);
    }
  }

  if (pack.notes.length > 0) {
    lines.push('');
    lines.push(`_(context-pack notes: ${pack.notes.join('; ')})_`);
  }

  lines.push('');
  return lines.join('\n');
}

// ── Small internal helpers ───────────────────────────────────────────────────

function normalizeRefs(refs: string | string[] | null | undefined): string[] {
  if (!refs) return [];
  if (Array.isArray(refs)) return refs.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
  if (typeof refs === 'string') {
    const s = refs.trim();
    if (!s) return [];
    // Accept a JSON-encoded array (the likely DB column shape) or a bare string.
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
    } catch {
      /* not JSON — treat as a single ref */
    }
    return [s];
  }
  return [];
}

function makeRefPointer(kind: DocPointerKind, label: string, location: string, why: string): DocPointer {
  // A ref is resolvable only if it is an existing absolute filesystem path.
  const resolvable = path.isAbsolute(location) ? existsSafe(location) : false;
  return { kind, label, location, why, resolvable };
}

/**
 * Resolve the teach-yourself protocol doc pointer per-platform, probing the
 * common install locations under the box's vault/home. Always returned so the
 * pack has a baseline "learn what you don't know" source.
 */
function resolveTeachYourselfPointer(): DocPointer {
  const home = homeDir();
  const candidates = [
    path.join(vaultRoot(), 'openclaw-onboarding', '01-teach-yourself-protocol', 'teach-yourself-protocol-full.md'),
    path.join(home, 'clawd', 'openclaw-onboarding', '01-teach-yourself-protocol', 'teach-yourself-protocol-full.md'),
    path.join(home, '.openclaw', 'workspace', 'openclaw-onboarding', '01-teach-yourself-protocol', 'teach-yourself-protocol-full.md'),
  ];
  const hit = firstExisting(candidates);
  return {
    kind: 'teach-yourself',
    label: 'Teach-Yourself Protocol',
    location: hit.path || candidates[0],
    why: 'when you hit something you do not know, follow this to learn it before acting',
    resolvable: hit.resolvable,
  };
}
