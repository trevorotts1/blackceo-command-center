/**
 * medallions.ts (CWE-033, Skill 77)
 *
 * Resolves the nine seats' medallion URLs from the CWE-031 portrait
 * manifest as vendored into this folder by CWE-032 (byte-identical
 * SVGs under ./portraits, named by the manifest: portraits/<seat>.svg
 * and portraits/<seat>-sm.svg). The journey pages pass these maps to
 * CWE-032's CouncilShell; nothing here redraws or substitutes a
 * medallion.
 */

import { COUNCIL_SEAT_ROSTER } from './council-room-types';

import simonSinek from './portraits/simon-sinek.svg';
import simonSinekSm from './portraits/simon-sinek-sm.svg';
import tdJakes from './portraits/td-jakes.svg';
import tdJakesSm from './portraits/td-jakes-sm.svg';
import oprahWinfrey from './portraits/oprah-winfrey.svg';
import oprahWinfreySm from './portraits/oprah-winfrey-sm.svg';
import tiffanyAliche from './portraits/tiffany-aliche.svg';
import tiffanyAlicheSm from './portraits/tiffany-aliche-sm.svg';
import russellBrunson from './portraits/russell-brunson.svg';
import russellBrunsonSm from './portraits/russell-brunson-sm.svg';
import michelleObama from './portraits/michelle-obama.svg';
import michelleObamaSm from './portraits/michelle-obama-sm.svg';
import breneBrown from './portraits/brene-brown.svg';
import breneBrownSm from './portraits/brene-brown-sm.svg';
import dennisKimbro from './portraits/dennis-kimbro.svg';
import dennisKimbroSm from './portraits/dennis-kimbro-sm.svg';
import lesBrown from './portraits/les-brown.svg';
import lesBrownSm from './portraits/les-brown-sm.svg';

/** Static asset imports resolve to a URL string or a { src } object. */
type AssetImport = string | { src: string };

function assetUrl(asset: AssetImport): string {
  return typeof asset === 'string' ? asset : asset.src;
}

const LARGE_BY_SEAT: Readonly<Record<string, AssetImport>> = {
  'simon-sinek': simonSinek,
  'td-jakes': tdJakes,
  'oprah-winfrey': oprahWinfrey,
  'tiffany-aliche': tiffanyAliche,
  'russell-brunson': russellBrunson,
  'michelle-obama': michelleObama,
  'brene-brown': breneBrown,
  'dennis-kimbro': dennisKimbro,
  'les-brown': lesBrown,
};

const SMALL_BY_SEAT: Readonly<Record<string, AssetImport>> = {
  'simon-sinek': simonSinekSm,
  'td-jakes': tdJakesSm,
  'oprah-winfrey': oprahWinfreySm,
  'tiffany-aliche': tiffanyAlicheSm,
  'russell-brunson': russellBrunsonSm,
  'michelle-obama': michelleObamaSm,
  'brene-brown': breneBrownSm,
  'dennis-kimbro': dennisKimbroSm,
  'les-brown': lesBrownSm,
};

/** seatId -> master medallion URL, keyed by the manifest's seat ids. */
export const COUNCIL_MEDALLION_LARGE_SRC: Readonly<Record<string, string>> = Object.fromEntries(
  COUNCIL_SEAT_ROSTER.map((seat) => [seat.seatId, assetUrl(LARGE_BY_SEAT[seat.seatId])]),
);

/** seatId -> small medallion URL, keyed by the manifest's seat ids. */
export const COUNCIL_MEDALLION_SMALL_SRC: Readonly<Record<string, string>> = Object.fromEntries(
  COUNCIL_SEAT_ROSTER.map((seat) => [seat.seatId, assetUrl(SMALL_BY_SEAT[seat.seatId])]),
);
