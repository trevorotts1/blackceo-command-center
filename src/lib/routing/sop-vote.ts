/**
 * Nearest-SOP vote — a department picker that asks "which department's SOPs
 * look most like this task?" (Trevor 2026-10-07, routing accuracy).
 *
 * It embeds the task with the box's OWN SOP-index provider and model (local
 * Ollama on a local box, Gemini or OpenAI on a keyed box: the same
 * `resolveEmbeddingProvider()` the SOP index was built with), takes the K most
 * similar live SOPs of the company's departments, and lets them vote by
 * department, weighted by similarity.
 *
 * Returns null whenever it cannot answer (no provider, empty or foreign-model
 * index, embed error): the caller moves to its next picker. It never throws and
 * never calls any provider other than the resolved one (a Google/OpenAI box
 * never touches Ollama; a local box never touches Google/OpenAI).
 *
 * SOP department values are free text: `Presentations`, `Sales`, `billing`,
 * `legal-compliance`. They are mapped to router department ids through
 * canonicalDeptSlug on BOTH sides, then matched against the company's own
 * catalog, so a SOP whose department the client does not have never votes.
 *
 * General Task and the CEO lane never vote: General Task's own SOPs are role
 * boilerplate ("QC Specialist - General Task"), not task-shaped, so a vote for
 * it would be noise. General Task is reached by the model pick's positive
 * decision or as the last resort.
 */

import { queryAll } from '@/lib/db';
import {
  bufferToFloat32,
  cosineSimilarity,
  fetchEmbeddingsFor,
  isEmbeddingAvailable,
  localEmbedText,
  resolveEmbeddingProvider,
  withEmbeddingFallback,
  type EmbeddingProvider,
} from '@/lib/sop-embeddings';
import { canonicalDeptSlug } from './canonical-slug';
import type { DepartmentConfig } from './departments.config';

/**
 * Tuned on the 169-case JEV-502 fixture (embeddinggemma-2:740m); see the
 * CHANGELOG for the measurements. Env overrides exist for calibration only.
 */
export const SOP_VOTE = {
  /** Nearest SOPs that vote. */
  k: Number(process.env.SOP_VOTE_K) || 10,
  /** Winner's share lead over the runner-up, as a fraction of all vote weight. */
  margin: process.env.SOP_VOTE_MARGIN ? Number(process.env.SOP_VOTE_MARGIN) : 0.4,
  /** The single most similar SOP must be at least this similar for the vote to route. */
  minSim: process.env.SOP_VOTE_MIN_SIM ? Number(process.env.SOP_VOTE_MIN_SIM) : 0.72,
};

/**
 * Gemini's similarities sit on a different scale than local embeddinggemma's, so
 * a Gemini box (primary) and the Ollama-down fallback use their own gate.
 */
export const SOP_VOTE_GEMINI = { k: 10, margin: 0.2, minSim: 0.6 };
const paramsFor = (p: EmbeddingProvider) => (p.name === 'ollama' ? SOP_VOTE : SOP_VOTE_GEMINI);

/**
 * Where the Gemini vectors live when the box's own index is LOCAL: a separate table
 * (never the local sop_embeddings), filled from the shipped Gemini SOP asset by
 * scripts/provision-gemini-fallback-sop-set.ts, keyed to this box's sops.id. Local
 * mode never writes it; the Ollama-down fallback only reads it. The two vector
 * sets are never compared in one query.
 */
export const GEMINI_FALLBACK_TABLE = 'sop_embeddings_gemini_fallback';

const NON_VOTING = new Set(['general-task', 'general', 'master-orchestrator', 'default', '']);

export interface SopVoteRanking {
  /** Departments by vote weight, best first (config objects from the caller's catalog). */
  ranked: { department: DepartmentConfig; weight: number; share: number }[];
  /** Cosine of the single most similar SOP (of the voting departments). */
  topSimilarity: number;
  /** The embedding provider that produced these similarities (selects the gate). */
  provider: EmbeddingProvider;
}

interface IndexRow { department: string | null; embedding: Buffer | null }
interface IndexCache { key: string; slugs: string[]; vecs: Float32Array[] }
const _indexes = new Map<string, IndexCache>();

/** Live SOP vectors of `table` in the (model, dims) space, decoded once per index version. null = absent or empty. */
function loadIndex(table: string, model: string, dims: number): IndexCache | null {
  try {
    const f = queryAll<{ n: number; last: string | null }>(
      `SELECT COUNT(*) AS n, MAX(e.embedded_at) AS last FROM ${table} e JOIN sops s ON s.id = e.sop_id
        WHERE s.deleted_at IS NULL AND e.embedding IS NOT NULL AND e.embedding_model = ? AND e.embedding_dims = ?`,
      [model, dims],
    )[0];
    if (!f || f.n === 0) return null;
    const key = `${model}|${dims}|${f.n}|${f.last}`;
    const hit = _indexes.get(table);
    if (hit?.key === key) return hit;
    const rows = queryAll<IndexRow>(
      `SELECT s.department AS department, e.embedding AS embedding FROM ${table} e JOIN sops s ON s.id = e.sop_id
        WHERE s.deleted_at IS NULL AND e.embedding IS NOT NULL AND e.embedding_model = ? AND e.embedding_dims = ?`,
      [model, dims],
    );
    const slugs: string[] = [];
    const vecs: Float32Array[] = [];
    for (const r of rows) {
      const v = bufferToFloat32(r.embedding);
      if (v) { slugs.push(canonicalDeptSlug(r.department)); vecs.push(v); }
    }
    const built = { key, slugs, vecs };
    _indexes.set(table, built);
    return built;
  } catch {
    return null; // table missing (pre-migration box, or no fallback set provisioned)
  }
}

/** Test seam: drop the decoded index. */
export function __resetSopVoteIndex(): void { _indexes.clear(); }

/**
 * Vote the K nearest SOPs of `departments` by department. null = cannot answer
 * (no provider, index empty/absent/in another model's space, embed failure).
 */
export async function rankDepartmentsBySops(
  taskText: string,
  departments: DepartmentConfig[],
  k?: number,
): Promise<SopVoteRanking | null> {
  try {
    if (!isEmbeddingAvailable() || departments.length === 0) return null;
    const primary = resolveEmbeddingProvider();
    const byCanon = new Map<string, DepartmentConfig>();
    for (const d of departments) {
      const c = canonicalDeptSlug(d.slug || d.id);
      if (!NON_VOTING.has(c) && !byCanon.has(c)) byCanon.set(c, d);
    }
    // Local Ollama down -> the box's own Gemini key, voting against the SEPARATE Gemini set.
    const done = await withEmbeddingFallback(async (p): Promise<SopVoteRanking | null> => {
      const fallback = primary.name === 'ollama' && p.name !== 'ollama';
      const index = loadIndex(fallback ? GEMINI_FALLBACK_TABLE : 'sop_embeddings', p.model, p.dims);
      if (!index) return null; // nothing to compare against: no embedding call is made
      const results = await fetchEmbeddingsFor(p, [localEmbedText(taskText, 'query', p)]);
      if (!results || results.length < 1) throw new Error('task embedding unavailable');
      const q = results[0].embedding;
      const near: { slug: string; sim: number }[] = [];
      for (let i = 0; i < index.vecs.length; i++) {
        if (byCanon.has(index.slugs[i])) near.push({ slug: index.slugs[i], sim: cosineSimilarity(q, index.vecs[i]) });
      }
      if (near.length === 0) return null;
      near.sort((a, b) => b.sim - a.sim);
      const weight = new Map<string, number>();
      for (const h of near.slice(0, k ?? paramsFor(p).k)) weight.set(h.slug, (weight.get(h.slug) ?? 0) + h.sim);
      const total = [...weight.values()].reduce((x, y) => x + y, 0);
      const ranked = [...weight.entries()]
        .sort((x, y) => y[1] - x[1])
        .map(([slug, w]) => ({ department: byCanon.get(slug)!, weight: w, share: w / total }));
      return { ranked, topSimilarity: near[0].sim, provider: p };
    });
    return done?.value ?? null;
  } catch (err) {
    console.warn(`[DepartmentRouter] SOP vote unavailable: ${(err as Error).message}`);
    return null;
  }
}

/**
 * The vote routes only when the nearest SOP is similar enough AND the winner
 * leads the runner-up by SOP_VOTE_MARGIN of the total weight. Anything else is
 * "uncertain" (the caller goes on to the model pick), never an automatic General.
 */
export function decideSopVote(r: SopVoteRanking | null): { department: DepartmentConfig; share: number } | null {
  if (!r || r.ranked.length === 0) return null;
  const gate = paramsFor(r.provider);
  if (r.topSimilarity < gate.minSim) return null;
  const [a, b] = r.ranked;
  if (b && a.share - b.share < gate.margin) return null;
  return { department: a.department, share: a.share };
}

// ---------------------------------------------------------------------------
// JEV department profiles from the box's own SOPs (routing accuracy, step 3)
// ---------------------------------------------------------------------------

const PROFILE_MAX_TOKENS = 10;
/** A word must appear in at least this many of the department's SOPs. */
const PROFILE_MIN_SOPS = 4;
/** A word that names more than this many departments says nothing about which one owns a task. */
const PROFILE_MAX_DEPARTMENTS = 2;
let _profiles: { key: string; byDept: Map<string, string[]> } | null = null;

/** Test seam: drop the cached profiles. */
export function __resetSopProfiles(): void { _profiles = null; }

/**
 * Words that distinguish each department, taken from the titles (`name`) and
 * `task_keywords` of its live SOPs: a word must appear in at least PROFILE_MIN_SOPS of the
 * department's SOPs and name at most PROFILE_MAX_DEPARTMENTS departments (role
 * boilerplate such as "specialist" names them all, so it drops out). Rebuilt
 * whenever the SOP table changes (cheap count + latest-update fingerprint), so a
 * new or edited SOP reaches JEV on the next task. Returns an empty map when the
 * SOP table is missing, empty, or JEV_SOP_PROFILES=0.
 */
export function sopProfileKeywords(): Map<string, string[]> {
  if (process.env.JEV_SOP_PROFILES === '0') return new Map();
  try {
    const f = queryAll<{ n: number; last: string | null }>(
      'SELECT COUNT(*) AS n, MAX(updated_at) AS last FROM sops WHERE deleted_at IS NULL', [],
    )[0];
    if (!f || f.n === 0) return new Map();
    const key = `${f.n}|${f.last}`;
    if (_profiles?.key === key) return _profiles.byDept;
    const rows = queryAll<{ department: string | null; name: string; task_keywords: string | null }>(
      'SELECT department, name, task_keywords FROM sops WHERE deleted_at IS NULL', [],
    );
    const perDept = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const slug = canonicalDeptSlug(r.department);
      if (NON_VOTING.has(slug)) continue;
      const words = new Set(`${r.name} ${r.task_keywords ?? ''}`.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []);
      const m = perDept.get(slug) ?? new Map<string, number>();
      for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
      perDept.set(slug, m);
    }
    const owners = new Map<string, number>();
    for (const m of perDept.values()) for (const [w, n] of m) if (n >= PROFILE_MIN_SOPS) owners.set(w, (owners.get(w) ?? 0) + 1);
    const byDept = new Map<string, string[]>();
    for (const [slug, m] of perDept) {
      const words = [...m.entries()]
        .filter(([w, n]) => n >= PROFILE_MIN_SOPS && (owners.get(w) ?? 0) <= PROFILE_MAX_DEPARTMENTS)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, PROFILE_MAX_TOKENS)
        .map(([w]) => w);
      if (words.length) byDept.set(slug, words);
    }
    _profiles = { key, byDept };
    return byDept;
  } catch {
    return new Map(); // pre-SOP-table box: JEV runs on the catalog alone
  }
}
