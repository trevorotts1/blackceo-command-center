/**
 * winner-harvest.ts — A-U11 (master unit U11) CC-repo half: the live
 * operator-approval leg of the winner-harvest flywheel.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * `shared-utils/winner_harvest.py` (ONB, commit 89414746e68e) ships a
 * complete, offline, client-scoped library that proposes an operator
 * approval card for every build clearing Quality Control at >= 9.0 — but
 * its own module docstring says outright:
 *
 *   "The live leg — an actual operator clicking 'approve' on a real
 *    Command Center board card that flips this same ledger record — is
 *    the CC-repo half of A-U11 and is OWED separately (not built here;
 *    this is the ONB-only leg)."
 *
 * This module IS that owed half. It never proposes a card and never writes
 * the exemplar pack (`harvest_into_library` stays entirely ONB-owned) — it
 * only (1) surfaces pending cards as an idempotent board signal (the sweep,
 * wired into board-hygiene.ts) and (2) lets an operator flip ONE card to
 * approved via a deliberate action (the approve API route).
 *
 * ── THE LEDGER CONTRACT (mirrored, not reinvented) ──────────────────────
 * `<workspace_base>/<client_id>/routing/harvest-cards.json`, shape
 * `{cards: [...], generated_at}`. Every field name, the card id format
 * (`harvest-<first16 hex of candidate_id>`), and the UTC timestamp format
 * (`%Y-%m-%dT%H:%M:%SZ`) are read verbatim off winner_harvest.py so a card
 * this module writes is byte-compatible with what ONB's own
 * `approve_card()` would have written, and a subsequent ONB
 * `run_harvest_sweep` on the SAME ledger harvests it correctly.
 *
 * ── CLIENT-ID CORRESPONDENCE — DISCLOSED, NOT PROVED ─────────────────────
 * ONB's `client_id` is the literal directory name under
 * `client-workspaces/`. Nothing in this repo (pre-existing or added by this
 * unit) independently confirms what string ONB's provisioning writes there
 * for a given box. `resolveHarvestClientId()` below is the BEST AVAILABLE
 * candidate — `slugify(resolveClientName())`, reusing box-identity.ts's own
 * slug convention rather than inventing a second one — and is pinned by a
 * test so any future drift is caught, but this correspondence is UNVERIFIED
 * against a real ONB box and should be confirmed before this leg is relied
 * on in production. It NEVER resolves under the `unknown-client` placeholder
 * — an unbranded box has no client-local library to harvest into.
 *
 * ── WRITE RACE — CLOSED ──────────────────────────────────────────────────
 * ONB's own `_save_ledger` is a plain, non-atomic `json.load` then
 * `open(w)+json.dump` — a CC approve landing mid-ONB-sweep-write (or vice
 * versa) can silently clobber either side. This module's write path is
 * atomic (temp file + rename, the SAME pattern
 * `src/app/api/company/config/route.ts` already uses) so at least the
 * CC-side half of that race is closed; the ONB-side half is that repo's own
 * open item.
 *
 * ── READ RAIL ─────────────────────────────────────────────────────────────
 * Reads go through `safeReadFileUtf8` (src/lib/fs/safe-fs.ts), which
 * classifies `~/clawd` as NON-TCC-protected and takes the direct fast path
 * there — this module never risks the TCC-hang class of incident on a Mac
 * operator box. Writes use plain `fs` (the ~/clawd write path is not a TCC
 * hang risk — TCC gates `open()`/`opendir()` under Downloads/Desktop/
 * Documents/iCloud, never a workspace directory the operator's own tooling
 * created).
 */
import fs from 'fs';
import path from 'path';

import { safeReadFileUtf8 } from '@/lib/fs/safe-fs';
import { resolveClientName, slugify, UNKNOWN_CLIENT } from '@/lib/box-identity';

export const WINNER_HARVEST_CARDS_FILENAME = 'harvest-cards.json';
export const WINNER_HARVEST_ROUTING_SUBDIR = 'routing';

export interface HarvestCard {
  card_id: string;
  candidate_id: string;
  client_id: string;
  skill: string;
  deliverable_type: string;
  slug: string;
  qc_score: number | null;
  source_task_id: string | null;
  status: string; // 'pending_approval' | 'approved' (ONB may add states later)
  proposed_at: string;
  approved_by: string | null;
  approved_at: string | null;
  harvested: boolean;
  harvested_at: string | null;
  // Forward-compat with ONB-added fields (e.g. `library_path`) this module
  // never reads/writes but must carry through unmodified on approval.
  [extra: string]: unknown;
}

interface HarvestLedger {
  cards: HarvestCard[];
  generated_at?: string;
}

/**
 * Resolve the client-workspaces base directory. MIRRORS
 * `shared-utils/winner_harvest.py::resolve_workspace_base` EXACTLY —
 * same ladder, same precedence, same "never fabricate a repo-relative
 * fallback" contract:
 *   1. `CLIENT_WORKSPACE_BASE_DIR` env override (what every test uses).
 *   2. `$HOME/clawd/client-workspaces` — the operator-box convention.
 *   3. `''` — not applicable (CI / no HOME); callers must treat this as
 *      "nothing to harvest," never invent a path under the repo tree.
 *
 * Deliberately reads `env.HOME` only (no `os.homedir()` fallback) to stay
 * byte-identical to the ONB ladder this mirrors.
 */
export function resolveWorkspaceBase(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.CLIENT_WORKSPACE_BASE_DIR ?? '').trim();
  if (explicit) return explicit;
  const home = (env.HOME ?? '').trim();
  if (home) return path.join(home, 'clawd', 'client-workspaces');
  return '';
}

/**
 * This box's client_id for winner-harvest purposes. See the module header's
 * CLIENT-ID CORRESPONDENCE note — this is the best available, pinned, but
 * UNVERIFIED-against-ONB candidate. Never returns a slug of the
 * `unknown-client` placeholder (an unbranded box has no workspace to
 * harvest into) or an empty slug.
 */
export function resolveHarvestClientId(): string | null {
  const name = resolveClientName();
  if (name === UNKNOWN_CLIENT) return null;
  const slug = slugify(name);
  return slug || null;
}

function clientRoutingDir(workspaceBase: string, clientId: string): string {
  return path.join(workspaceBase, clientId, WINNER_HARVEST_ROUTING_SUBDIR);
}

function ledgerPath(workspaceBase: string, clientId: string): string {
  return path.join(clientRoutingDir(workspaceBase, clientId), WINNER_HARVEST_CARDS_FILENAME);
}

/**
 * Read-only load of one client's own ledger. Never throws: an absent file,
 * an unreadable path, or a corrupt/malformed document all read as the empty
 * ledger `{cards: []}` — mirrors ONB's `_load_ledger`'s own fail-open
 * posture (OSError / JSONDecodeError -> `{"cards": []}`).
 */
export function loadHarvestLedger(workspaceBase: string, clientId: string): HarvestLedger {
  if (!workspaceBase || !clientId) return { cards: [] };
  const raw = safeReadFileUtf8(ledgerPath(workspaceBase, clientId));
  if (raw == null) return { cards: [] };
  try {
    const doc = JSON.parse(raw);
    if (doc && Array.isArray(doc.cards)) return doc as HarvestLedger;
  } catch {
    /* corrupt ledger — treat as empty, never throw (fail-open, matches ONB) */
  }
  return { cards: [] };
}

/**
 * Atomic write: temp file + rename, the SAME pattern already used by
 * `src/app/api/company/config/route.ts`. Closes the read-modify-write RACE
 * ONB's own plain `_save_ledger` has. Every write to a client's ledger goes
 * through this one function.
 */
function saveHarvestLedgerAtomic(workspaceBase: string, clientId: string, doc: HarvestLedger): void {
  const routingDir = clientRoutingDir(workspaceBase, clientId);
  fs.mkdirSync(routingDir, { recursive: true });
  const target = ledgerPath(workspaceBase, clientId);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stamped: HarvestLedger = { ...doc, generated_at: utcStamp() };
  fs.writeFileSync(tmp, JSON.stringify(stamped, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

/** UTC `%Y-%m-%dT%H:%M:%SZ` — byte-identical format to ONB's `_ts()`. */
function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Look up one card by id in this client's own ledger. Read-only. */
export function findHarvestCard(workspaceBase: string, clientId: string, cardId: string): HarvestCard | null {
  const doc = loadHarvestLedger(workspaceBase, clientId);
  return doc.cards.find((c) => c.card_id === cardId) ?? null;
}

/** Every `pending_approval` card in this client's own ledger. Read-only. */
export function listPendingHarvestCards(workspaceBase: string, clientId: string): HarvestCard[] {
  return loadHarvestLedger(workspaceBase, clientId).cards.filter((c) => c.status === 'pending_approval');
}

/**
 * Operator approve action — the ONLY function in this codebase that may set
 * a card's `status` to `'approved'`. Requires a non-empty operator identity
 * (mirrors ONB `approve_card()`'s `ValueError` on an empty `approved_by` —
 * never a silent no-op). Mutates ONLY `status` / `approved_by` /
 * `approved_at`; every other field on the record — including `harvested` /
 * `harvested_at`, which stay ONB's to set — is carried through unchanged.
 * Returns `null` (never fabricates a card) when no card with this id exists
 * in THIS client's own ledger — this can never reach across a client
 * boundary because the ledger it reads/writes is the one named by the
 * `clientId` the caller passed, never one derived from the request.
 */
export function approveHarvestCard(
  workspaceBase: string,
  clientId: string,
  cardId: string,
  approvedBy: string,
): HarvestCard | null {
  const trimmed = (approvedBy ?? '').trim();
  if (!trimmed) {
    throw new Error('approveHarvestCard requires a non-empty approvedBy (operator identity)');
  }
  const doc = loadHarvestLedger(workspaceBase, clientId);
  const idx = doc.cards.findIndex((c) => c.card_id === cardId);
  if (idx === -1) return null;

  const updated: HarvestCard = {
    ...doc.cards[idx],
    status: 'approved',
    approved_by: trimmed,
    approved_at: utcStamp(),
  };
  doc.cards[idx] = updated;
  saveHarvestLedgerAtomic(workspaceBase, clientId, doc);
  return updated;
}
