/**
 * _winner-harvest-fixtures.ts — shared fixture builders for the A-U11
 * CC-repo-half test suite. Builds ledger cards byte-shape-identical to
 * ONB's shared-utils/winner_harvest.py (candidate_id = sha256 of the
 * identity tuple, card_id = `harvest-<first16 hex>`), so these fixtures are
 * exactly what a real ONB `propose_harvest_card()` call would have written
 * to `<workspace_base>/<client_id>/routing/harvest-cards.json` — this test
 * suite never runs ONB's code, but it seeds what ONB's code produces.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FixtureCandidate {
  client_id: string;
  skill: string;
  deliverable_type: string;
  slug: string;
  source_task_id: string;
  qc_score: number;
}

/** Mirrors winner_harvest.py::candidate_id() exactly. */
export function candidateId(c: FixtureCandidate): string {
  const parts = [c.client_id, c.skill, c.deliverable_type, c.slug, c.source_task_id ?? ''];
  return crypto.createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

/** Mirrors winner_harvest.py::_card_id() exactly. */
export function cardIdFor(cid: string): string {
  return `harvest-${cid.slice(0, 16)}`;
}

export interface FixtureCardOverrides {
  status?: string;
  approved_by?: string | null;
  approved_at?: string | null;
  harvested?: boolean;
  harvested_at?: string | null;
}

/** A ledger card exactly matching propose_harvest_card()'s written shape. */
export function fixtureCard(c: FixtureCandidate, overrides: FixtureCardOverrides = {}) {
  const cid = candidateId(c);
  return {
    card_id: cardIdFor(cid),
    candidate_id: cid,
    client_id: c.client_id,
    skill: c.skill,
    deliverable_type: c.deliverable_type,
    slug: c.slug,
    qc_score: c.qc_score,
    source_task_id: c.source_task_id,
    status: 'pending_approval',
    proposed_at: '2026-07-16T00:00:00Z',
    approved_by: null,
    approved_at: null,
    harvested: false,
    harvested_at: null,
    ...overrides,
  };
}

/** Writes a ledger for one client directly onto disk (bypassing CC/ONB code —
 * this IS the seed, standing in for a prior ONB run, per the from-SEED
 * offline doctrine). */
export function seedLedger(workspaceBase: string, clientId: string, cards: unknown[]): string {
  const routingDir = path.join(workspaceBase, clientId, 'routing');
  fs.mkdirSync(routingDir, { recursive: true });
  const file = path.join(routingDir, 'harvest-cards.json');
  fs.writeFileSync(file, JSON.stringify({ cards, generated_at: '2026-07-16T00:00:00Z' }, null, 2), 'utf-8');
  return file;
}
