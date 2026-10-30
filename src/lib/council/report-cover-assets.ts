/**
 * Cover imagery for the council report (CTR-163; audit rows
 * FX-033/FX-036/FX-048).
 *
 * The PDF/print cover must show the same nine seated chamber portraits
 * the chamber page serves — one per seat, in the canonical roster order,
 * no duplicate strip and no empty-table hero. The print document is
 * offline and deterministic, so the images are embedded as data URIs
 * read from this host's own `public/council/portraits` directory. The
 * existing portrait-release validator is applied first: unless the
 * manifest is a complete nine-seat cohort with the exact expected room
 * variants, no image is embedded and the cover prints an explicit
 * unavailable sentence instead of a fabricated portrait.
 *
 * Node-only. Import this from server code (report-downloads), never
 * from a client bundle.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEAT_ROSTER } from './contracts';
import {
  CouncilPortraitManifestError,
  validateApprovedCouncilPortraitManifest,
} from '../../components/council/council-portrait-manifest';

export interface ReportCoverPortrait {
  seat_id: string;
  display_name: string;
  path: string;
  data_uri: string;
}

export type ReportCoverAssets =
  | { status: 'ready'; portraits: ReportCoverPortrait[] }
  | { status: 'unavailable'; reason: string };

/** Total embedded portrait bytes are already bounded by the validator. */
export function loadReportCoverAssets(
  publicRoot: string = join(process.cwd(), 'public'),
): ReportCoverAssets {
  try {
    const manifestPath = join(publicRoot, 'council', 'portraits', 'manifest.json');
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const maps = validateApprovedCouncilPortraitManifest(manifest);
    const portraits: ReportCoverPortrait[] = [];
    for (const seat of SEAT_ROSTER) {
      const src = maps.roomSrcBySeat[seat.seat_id];
      if (typeof src !== 'string' || !src.startsWith('/council/portraits/')) {
        return {
          status: 'unavailable',
          reason: `The portrait release has no room image for ${seat.display_name}.`,
        };
      }
      const bytes = readFileSync(join(publicRoot, src.replace(/^\//, '')));
      portraits.push({
        seat_id: seat.seat_id,
        display_name: seat.display_name,
        path: src,
        data_uri: `data:image/webp;base64,${bytes.toString('base64')}`,
      });
    }
    if (portraits.length !== SEAT_ROSTER.length) {
      return {
        status: 'unavailable',
        reason: 'The portrait release did not resolve to exactly nine seats.',
      };
    }
    return { status: 'ready', portraits };
  } catch (error) {
    if (error instanceof CouncilPortraitManifestError) {
      return { status: 'unavailable', reason: error.message };
    }
    return {
      status: 'unavailable',
      reason:
        'No complete Council portrait cohort could be read from this host, so the cover prints no portraits.',
    };
  }
}
