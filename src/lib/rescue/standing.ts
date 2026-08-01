/**
 * Rescue Rangers ticket dashboard (P13): the standing-blocks panel source.
 *
 * WHY A SNAPSHOT FILE AND NOT A LIVE LOOKUP
 * -----------------------------------------
 * The fleet standing gate's verdicts live in n8n (the `fleet_standing`
 * datatable and the `rescue_request_ledger`), reachable only with the n8n API
 * credential. The Command Center is a FLEET-WIDE app that also runs on client
 * boxes; giving it that credential would put an operator-only secret on every
 * box and add a third-party network hop to a dashboard render. So this module
 * reads a LOCAL snapshot instead — the same pattern the box already uses for
 * the approvals invariant (`~/clawd/fleet-standing/approvals-snapshot.json`,
 * written by a secret-holding operator script and consumed by everything
 * else).
 *
 * ABSENCE IS REPORTED, NOT FAKED. With no snapshot on disk this returns
 * `available: false` and an empty list, and the panel says so. It never
 * renders "0 clients blocked", because "we cannot see the gate" and "the gate
 * is blocking nobody" are different facts and only one of them is true.
 *
 * ACCEPTED SHAPES (first match wins):
 *   1. { takenAt, source, blocks: [ { client, boxSlug, reason, since } ] }
 *   2. a bare array of those block objects
 *   3. a raw `fleet_standing` datatable dump — { rows: [...] } or a bare array
 *      of rows carrying `good_standing` — from which the rows with
 *      good_standing === false are extracted. This is the shape an operator
 *      is most likely to drop in by hand, so it is understood rather than
 *      rejected.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { RescueStandingBlock, RescueStandingView } from './types';

export function resolveStandingSnapshotPath(): string {
  const explicit = process.env.RESCUE_STANDING_SNAPSHOT;
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return path.join(os.homedir(), 'clawd', 'fleet-standing', 'standing-blocks.json');
}

export const EMPTY_STANDING_VIEW: RescueStandingView = {
  available: false,
  takenAt: null,
  source: null,
  blocks: [],
};

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isFalseFlag(value: unknown): boolean {
  if (value === false || value === 0) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'false' || v === '0' || v === 'no';
  }
  return false;
}

/**
 * Markers of a RAW fleet_standing datatable row (shape 3) as opposed to an
 * already-normalised block (shapes 1 and 2). Detection cannot key on
 * `good_standing` alone: a dump of the table lists EVERY client, and the rows
 * in good standing simply carry `good_standing: true` — or, in a partial
 * export, no flag at all. Treating a flagless raw row as a block would turn a
 * full-table dump into "every client is blocked", the exact inversion this
 * panel must never make. So any snake_case standing column identifies the
 * payload as a raw row, and a raw row is a block ONLY on an explicit false.
 */
const RAW_ROW_MARKERS = ['good_standing', 'box_slug', 'client_label', 'standing_reason'];

/** Normalise one entry of any accepted shape into a standing block, or null. */
function toBlock(raw: unknown): RescueStandingBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // Shape 3: a fleet_standing row. Only rows explicitly NOT in good standing
  // are blocks; an absent or true flag is not a block (fail open, like the
  // gate itself, which refuses only on an explicit "blocked" verdict).
  if (RAW_ROW_MARKERS.some((key) => key in r)) {
    if (!isFalseFlag(r.good_standing)) return null;
    return {
      client: str(r.client_label) ?? str(r.client) ?? str(r.box_slug),
      boxSlug: str(r.box_slug) ?? str(r.boxSlug),
      reason: str(r.standing_reason) ?? str(r.reason),
      since: str(r.updated_at) ?? str(r.since),
    };
  }

  // Shapes 1 and 2: an already-normalised block.
  const client = str(r.client) ?? str(r.client_label);
  const boxSlug = str(r.boxSlug) ?? str(r.box_slug);
  if (!client && !boxSlug) return null;
  return {
    client,
    boxSlug,
    reason: str(r.reason) ?? str(r.standing_reason),
    since: str(r.since) ?? str(r.blockedAt) ?? str(r.updated_at),
  };
}

/** Parse an already-read snapshot payload. Pure — exported for unit tests. */
export function parseStandingSnapshot(payload: unknown): RescueStandingView {
  if (!payload) return EMPTY_STANDING_VIEW;

  let entries: unknown[] = [];
  let takenAt: string | null = null;
  let source: string | null = null;

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    takenAt = str(p.takenAt) ?? str(p.taken_at) ?? str(p.generatedAt);
    source = str(p.source) ?? str(p.table);
    const candidate = p.blocks ?? p.rows ?? p.data ?? p.items;
    if (Array.isArray(candidate)) entries = candidate;
    else return { available: true, takenAt, source, blocks: [] };
  } else {
    return EMPTY_STANDING_VIEW;
  }

  const blocks = entries
    .map(toBlock)
    .filter((b): b is RescueStandingBlock => b !== null)
    .sort((a, b) => (a.client ?? a.boxSlug ?? '').localeCompare(b.client ?? b.boxSlug ?? ''));

  return { available: true, takenAt, source, blocks };
}

/**
 * Read the standing-blocks snapshot for this box. Never throws: a missing,
 * unreadable, or malformed file all degrade to the unavailable view so the
 * page renders.
 */
export function readStandingBlocks(): RescueStandingView {
  const snapshotPath = resolveStandingSnapshotPath();
  try {
    if (!fs.existsSync(snapshotPath)) return EMPTY_STANDING_VIEW;
    const raw = fs.readFileSync(snapshotPath, 'utf8');
    return parseStandingSnapshot(JSON.parse(raw));
  } catch {
    return EMPTY_STANDING_VIEW;
  }
}
