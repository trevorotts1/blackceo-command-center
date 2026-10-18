import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  COUNCIL_SEAT_IDS,
  COUNCIL_SEAT_ROSTER,
} from '../../src/components/council/council-room-types';

const repo = process.cwd();
const python = readFileSync(resolve(repo, 'scripts/council/build_portrait_assets.py'), 'utf8');
const medallions = readFileSync(resolve(repo, 'src/components/council/medallions.ts'), 'utf8');
const approvedRoster = [
  ['simon-sinek', 'Simon Sinek'],
  ['td-jakes', 'T. D. Jakes'],
  ['oprah-winfrey', 'Oprah Winfrey'],
  ['tiffany-aliche', 'Tiffany Aliche'],
  ['russell-brunson', 'Russell Brunson'],
  ['michelle-obama', 'Michelle Obama'],
  ['brene-brown', 'Brené Brown'],
  ['dennis-kimbro', 'Dr. Dennis Kimbro'],
  ['les-brown', 'Les Brown'],
] as const;

function portraitBuilderSeats() {
  const block = python.match(/SEATS\s*=\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'portrait builder must retain an explicit closed roster');
  return [...block[1]!.matchAll(/^\s+"([a-z-]+)":\s+"([^"]+)",?$/gm)]
    .map((x) => [x[1], x[2]]);
}

function mappedSeatIds(map: string) {
  const block = medallions.match(
    new RegExp('const ' + map + ': Readonly<Record<string, AssetImport>> = \\{([\\s\\S]*?)\\n\\};'),
  );
  assert.ok(block, 'medallion map ' + map + ' must exist');
  return [...block[1]!.matchAll(/'([a-z-]+)':/g)].map((x) => x[1]);
}

test('frontend canonical Council data has the nine owner-selected people and no substitutions', () => {
  assert.deepEqual(COUNCIL_SEAT_ROSTER.map((x) => [x.seatId, x.displayName]), approvedRoster);
  assert.deepEqual(COUNCIL_SEAT_IDS, approvedRoster.map((x) => x[0]));
  assert.equal(COUNCIL_SEAT_ROSTER.length, 9);
});

test('the original portrait renderer has exactly the same nine identities and matching labels', () => {
  assert.deepEqual(portraitBuilderSeats(), approvedRoster);
  assert.equal(portraitBuilderSeats().some((x) => /steve.harvey/i.test(x.join(' '))), false);
});

test('both medallion maps and all vendored SVG filenames are exactly the nine approved IDs', () => {
  const seatIds = approvedRoster.map((x) => x[0]).slice().sort();
  assert.deepEqual(mappedSeatIds('LARGE_BY_SEAT').sort(), seatIds);
  assert.deepEqual(mappedSeatIds('SMALL_BY_SEAT').sort(), seatIds);
  const existing = readdirSync(resolve(repo, 'src/components/council/portraits'))
    .filter((f) => f.endsWith('.svg'))
    .sort();
  const expected = seatIds.flatMap((id) => [id + '.svg', id + '-sm.svg']).sort();
  assert.deepEqual(existing, expected, 'no extra or substituted Council image asset');
});
